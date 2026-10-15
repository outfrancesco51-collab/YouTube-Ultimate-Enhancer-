// ==UserScript==
// @name         Photopea DrawBot
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Draws any image into Photopea as flat-color rectangles: color quantization, denoise, smart bridges, maximal-rectangle optimizer, live preview, draggable layout, pause/cancel and progress
// @author       you
// @match        https://www.photopea.com/*
// @match        https://photopea.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    //  Error logging helpers
    // =====================================================================
    function logToPanel(msg, isError = false) {
        try {
            const container = document.getElementById('pd-log-container');
            const content = document.getElementById('pd-log-content');
            if (!container || !content) return;
            container.style.display = 'block';
            const div = document.createElement('div');
            div.style.color = isError ? '#fca5a5' : '#cbd5e1';
            div.textContent = msg;
            content.appendChild(div);
            container.scrollTop = container.scrollHeight;
        } catch (e) { /* ignore */ }
    }

    // =====================================================================
    //  Settings
    // =====================================================================
    const SETTINGS_KEY = 'photopea_drawbot_v1';
    const S = Object.assign({
        scale: 6,            // grid cell size in document pixels
        colorsMode: '16',    // 'classic16' | number | 'infinite'
        denoise: 0,
        mode: 'rects',       // 'rects' (maximal rectangles + bridges) | 'runs' (row runs)
        batchSize: 400,      // rectangles per script
        bps: 4,              // scripts per second
        fillBg: true,
        useBridge: true,
        bridgeLen: 30,
        layout: 'stretch',   // 'stretch' | 'center' | 'custom'
        target: 'active',    // 'active' | 'new'
        newW: 1920,
        newH: 1080,
        newLayer: true,
        liveEvery: 0,
        customX: 0, customY: 0, customW: 960, customH: 540
    }, (function () { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; } })());

    function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) { } }

    const MAX_SCRIPT_CHARS = 150000;
    const CLASSIC16 = [
        [0, 0, 0], [128, 128, 128], [192, 192, 192], [255, 255, 255],
        [128, 0, 0], [255, 0, 0], [128, 128, 0], [255, 255, 0],
        [0, 128, 0], [0, 255, 0], [0, 128, 128], [0, 255, 255],
        [0, 0, 128], [0, 0, 255], [128, 0, 128], [255, 0, 255]
    ].map(c => ({ r: c[0], g: c[1], b: c[2] }));

    // =====================================================================
    //  State
    // =====================================================================
    let WORK = { w: 1920, h: 1080 };   // target canvas size in document pixels
    let isDrawing = false, cancelFlag = false, isPaused = false;
    let currentImageSrc = '';
    let draftImg = null;
    let isApplied = false;
    let plan = null;
    let previewTimer = null;
    let liveUrl = null;

    // drag state for the custom layout editor
    let isDraggingImage = false, activeDragAction = null;
    let dragStartX = 0, dragStartY = 0, imgStartX = 0, imgStartY = 0, imgStartW = 0, imgStartH = 0;

    const $ = id => document.getElementById(id);

    // =====================================================================
    //  Timers (Web Worker so they are not throttled in background tabs)
    // =====================================================================
    let timerWorker = null;
    const pendingSleeps = new Map();
    let sleepId = 0;
    try {
        const code = `self.onmessage=e=>{setTimeout(()=>self.postMessage({id:e.data.id}),e.data.ms)};`;
        timerWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
        timerWorker.onmessage = e => { const r = pendingSleeps.get(e.data.id); if (r) { pendingSleeps.delete(e.data.id); r(); } };
    } catch (e) { console.warn('[PhotopeaDrawBot] Worker timers unavailable', e); }
    const sleep = ms => new Promise(res => {
        if (timerWorker) { const id = sleepId++; pendingSleeps.set(id, res); timerWorker.postMessage({ id, ms }); }
        else setTimeout(res, ms);
    });
    async function checkPause() { while (isPaused && !cancelFlag) await sleep(100); }

    // =====================================================================
    //  Photopea bridge
    //  (window.parent === window on the main page, so our own message is
    //   echoed back to us: those echoes are filtered out.)
    // =====================================================================
    function pp(payload, timeout = 120000) {
        return new Promise((resolve, reject) => {
            const out = [];
            const sentIsBuffer = payload instanceof ArrayBuffer;
            const timer = setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error('Timeout: no reply from Photopea'));
            }, timeout);
            function handler(e) {
                if (e.source !== window) return;
                const d = e.data;
                if (typeof d === 'string') {
                    if (d === payload) return;
                    if (d === 'done') { clearTimeout(timer); window.removeEventListener('message', handler); resolve(out); return; }
                    out.push(d);
                } else if (d instanceof ArrayBuffer) {
                    if (sentIsBuffer) return;
                    out.push(d);
                }
            }
            window.addEventListener('message', handler);
            window.postMessage(sentIsBuffer ? payload.slice(0) : payload, '*');
        });
    }
    function scriptErrors(out) { return out.filter(o => typeof o === 'string' && o.startsWith('ERR:')); }

    // =====================================================================
    //  Color helpers
    // =====================================================================
    function rgbToHex(r, g, b) { return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase(); }
    function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }

    // Perceptual "redmean" distance
    function getDistance(c1, c2) {
        const rMean = (c1.r + c2.r) / 2;
        const r = c1.r - c2.r, g = c1.g - c2.g, b = c1.b - c2.b;
        return (2 + rMean / 256) * r * r + 4 * g * g + (2 + (255 - rMean) / 256) * b * b;
    }

    // Frequency-sorted clustering + 3 K-Means refinement passes
    function quantize(pixels, maxColors) {
        if (pixels.length <= maxColors) return pixels.map(p => ({ r: p.r, g: p.g, b: p.b }));
        pixels.sort((a, b) => b.count - a.count);

        const clusters = [];
        const threshold = 35 * 35 * 3;
        const absorb = (c, p) => {
            c.sumR += p.r * p.count; c.sumG += p.g * p.count; c.sumB += p.b * p.count; c.totalCount += p.count;
            c.center.r = Math.round(c.sumR / c.totalCount);
            c.center.g = Math.round(c.sumG / c.totalCount);
            c.center.b = Math.round(c.sumB / c.totalCount);
        };

        for (const p of pixels) {
            let added = false;
            for (const c of clusters) {
                if (getDistance(p, c.center) < threshold) { absorb(c, p); added = true; break; }
            }
            if (added) continue;
            if (clusters.length < maxColors) {
                clusters.push({ center: { r: p.r, g: p.g, b: p.b }, sumR: p.r * p.count, sumG: p.g * p.count, sumB: p.b * p.count, totalCount: p.count });
            } else {
                let closest = null, minDist = Infinity;
                for (const c of clusters) { const d = getDistance(p, c.center); if (d < minDist) { minDist = d; closest = c; } }
                absorb(closest, p);
            }
        }

        const centers = clusters.map(c => ({ r: c.center.r, g: c.center.g, b: c.center.b }));
        for (let iter = 0; iter < 3; iter++) {
            const sums = Array.from({ length: centers.length }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
            for (const p of pixels) {
                let idx = 0, min = Infinity;
                for (let i = 0; i < centers.length; i++) { const d = getDistance(p, centers[i]); if (d < min) { min = d; idx = i; } }
                const s = sums[idx];
                s.r += p.r * p.count; s.g += p.g * p.count; s.b += p.b * p.count; s.n += p.count;
            }
            for (let i = 0; i < centers.length; i++) {
                if (sums[i].n > 0) {
                    centers[i].r = Math.round(sums[i].r / sums[i].n);
                    centers[i].g = Math.round(sums[i].g / sums[i].n);
                    centers[i].b = Math.round(sums[i].b / sums[i].n);
                }
            }
        }
        return centers;
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Image loading error (CORS or invalid URL)'));
            img.src = url;
        });
    }

    // =====================================================================
    //  Geometry engine: maximal rectangles + DFS ordering
    // =====================================================================
    function findMaximalRectangleOpt(startX, startY, pixelSet, gridWidth, height) {
        if (pixelSet[startY * gridWidth + startX] !== 1) return null;

        // Strategy 1: expand RIGHT first, then DOWN (width may narrow for max area)
        let w1 = 0;
        while (startX + w1 < gridWidth && pixelSet[startY * gridWidth + startX + w1] === 1) w1++;
        let bestW1 = w1, bestH1 = 1, bestArea1 = w1, currW = w1;
        for (let dy = 1; startY + dy < height; dy++) {
            const rowBase = (startY + dy) * gridWidth + startX;
            let rowW = 0;
            while (rowW < currW && pixelSet[rowBase + rowW] === 1) rowW++;
            if (rowW < 1) break;
            currW = rowW;
            const area = currW * (dy + 1);
            if (area > bestArea1) { bestArea1 = area; bestW1 = currW; bestH1 = dy + 1; }
        }

        // Strategy 2: expand DOWN first, then RIGHT (height may narrow for max area)
        let h2 = 0;
        while (startY + h2 < height && pixelSet[(startY + h2) * gridWidth + startX] === 1) h2++;
        let bestW2 = 1, bestH2 = h2, bestArea2 = h2, currH = h2;
        for (let dx = 1; startX + dx < gridWidth; dx++) {
            let colH = 0;
            while (colH < currH && pixelSet[(startY + colH) * gridWidth + startX + dx] === 1) colH++;
            if (colH < 1) break;
            currH = colH;
            const area = (dx + 1) * currH;
            if (area > bestArea2) { bestArea2 = area; bestW2 = dx + 1; bestH2 = currH; }
        }

        const bestW = bestArea1 >= bestArea2 ? bestW1 : bestW2;
        const bestH = bestArea1 >= bestArea2 ? bestH1 : bestH2;

        let removed = 0;
        for (let dy = 0; dy < bestH; dy++) {
            const rowBase = (startY + dy) * gridWidth + startX;
            for (let dx = 0; dx < bestW; dx++) {
                if (pixelSet[rowBase + dx] === 1) { pixelSet[rowBase + dx] = 0; removed++; }
            }
        }
        return { x: startX, y: startY, w: bestW, h: bestH, removed };
    }

    // Rectangles are emitted in DFS order, so consecutive rectangles are spatially adjacent
    function buildRectangleTreeDFS(pixelSet, initialPixelCount, gridWidth, height) {
        const rects = [], stack = [];
        let pixelCount = initialPixelCount, lastSearchIdx = 0;

        while (pixelCount > 0) {
            while (lastSearchIdx < pixelSet.length && pixelSet[lastSearchIdx] !== 1) lastSearchIdx++;
            if (lastSearchIdx >= pixelSet.length) break;

            const root = findMaximalRectangleOpt(lastSearchIdx % gridWidth, Math.floor(lastSearchIdx / gridWidth), pixelSet, gridWidth, height);
            if (!root) break;
            pixelCount -= root.removed;
            root.parentRef = null;
            rects.push(root); stack.push(root);

            while (stack.length > 0) {
                const cur = stack.pop();
                const cand = [];
                if (cur.y > 0) {
                    const rb = (cur.y - 1) * gridWidth;
                    for (let px = cur.x; px < cur.x + cur.w; px++) if (pixelSet[rb + px] === 1) cand.push(px, cur.y - 1);
                }
                if (cur.y + cur.h < height) {
                    const rb = (cur.y + cur.h) * gridWidth + cur.x;
                    for (let px = cur.x; px < cur.x + cur.w; px++) if (pixelSet[rb + (px - cur.x)] === 1) cand.push(px, cur.y + cur.h);
                }
                if (cur.x > 0) {
                    const cx = cur.x - 1;
                    for (let py = cur.y; py < cur.y + cur.h; py++) if (pixelSet[py * gridWidth + cx] === 1) cand.push(cx, py);
                }
                if (cur.x + cur.w < gridWidth) {
                    const cx = cur.x + cur.w;
                    for (let py = cur.y; py < cur.y + cur.h; py++) if (pixelSet[py * gridWidth + cx] === 1) cand.push(cx, py);
                }
                for (let ci = 0; ci < cand.length; ci += 2) {
                    const cx = cand[ci], cy = cand[ci + 1];
                    if (pixelSet[cy * gridWidth + cx] !== 1) continue;
                    const nr = findMaximalRectangleOpt(cx, cy, pixelSet, gridWidth, height);
                    if (!nr) continue;
                    pixelCount -= nr.removed;
                    nr.parentRef = cur;
                    rects.push(nr); stack.push(nr);
                }
            }
        }
        return rects;
    }

    // Simpler alternative: horizontal runs merged vertically when identical
    function buildRuns(colorGrid, width, height) {
        const rects = [];
        let open = new Map();
        for (let y = 0; y < height; y++) {
            const next = new Map();
            let x = 0;
            while (x < width) {
                if (!colorGrid[y * width + x]) { x++; continue; }
                const sx = x;
                while (x < width && colorGrid[y * width + x]) x++;
                const key = sx + ',' + (x - sx);
                const prev = open.get(key);
                if (prev) { prev.h++; next.set(key, prev); }
                else { const r = { x: sx, y, w: x - sx, h: 1 }; rects.push(r); next.set(key, r); }
            }
            open = next;
        }
        return rects;
    }

    function countIslands(colorGrid, width, height) {
        const visited = new Uint8Array(width * height);
        const queue = new Int32Array(width * height);
        let count = 0;
        for (let start = 0; start < colorGrid.length; start++) {
            if (!colorGrid[start] || visited[start]) continue;
            count++;
            let head = 0, tail = 0;
            queue[tail++] = start; visited[start] = 1;
            while (head < tail) {
                const k = queue[head++];
                const cx = k % width, cy = (k / width) | 0;
                if (cx > 0 && colorGrid[k - 1] && !visited[k - 1]) { visited[k - 1] = 1; queue[tail++] = k - 1; }
                if (cx < width - 1 && colorGrid[k + 1] && !visited[k + 1]) { visited[k + 1] = 1; queue[tail++] = k + 1; }
                if (cy > 0 && colorGrid[k - width] && !visited[k - width]) { visited[k - width] = 1; queue[tail++] = k - width; }
                if (cy < height - 1 && colorGrid[k + width] && !visited[k + width]) { visited[k + width] = 1; queue[tail++] = k + width; }
            }
        }
        return count;
    }

    // Smart bridges: multi-source BFS + Union-Find join nearby islands of one color through
    // pixels belonging to colors that are painted LATER (they will cover the bridge).
    function applyBridging(colorGrid, orderGrid, width, height, orderPos, maxBridgeLength) {
        const size = width * height;
        const isBridgeable = new Uint8Array(size);
        for (let k = 0; k < size; k++) if (orderGrid[k] >= orderPos) isBridgeable[k] = 1;

        // connected components of the color
        const visited = new Uint8Array(size);
        const components = [];
        const q = new Int32Array(size);
        for (let s = 0; s < size; s++) {
            if (!colorGrid[s] || visited[s]) continue;
            const comp = [];
            let head = 0, tail = 0;
            q[tail++] = s; visited[s] = 1;
            while (head < tail) {
                const k = q[head++];
                comp.push(k);
                const cx = k % width, cy = (k / width) | 0;
                if (cx > 0 && colorGrid[k - 1] && !visited[k - 1]) { visited[k - 1] = 1; q[tail++] = k - 1; }
                if (cx < width - 1 && colorGrid[k + 1] && !visited[k + 1]) { visited[k + 1] = 1; q[tail++] = k + 1; }
                if (cy > 0 && colorGrid[k - width] && !visited[k - width]) { visited[k - width] = 1; q[tail++] = k - width; }
                if (cy < height - 1 && colorGrid[k + width] && !visited[k + width]) { visited[k + width] = 1; q[tail++] = k + width; }
            }
            components.push(comp);
        }
        if (components.length <= 1) return;

        const parent = components.map((_, i) => i);
        const find = i => { let r = i; while (parent[r] !== r) r = parent[r]; while (i !== r) { const n = parent[i]; parent[i] = r; i = n; } return r; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) { parent[ra] = rb; return true; } return false; };

        const bfs = new Int32Array(size);
        const dist = new Int16Array(size).fill(-1);
        const origin = new Int32Array(size).fill(-1);
        const prev = new Int32Array(size).fill(-1);
        let tail = 0;

        // seeds: boundary pixels of every component
        const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
        for (let c = 0; c < components.length; c++) {
            for (const key of components[c]) {
                const px = key % width, py = (key / width) | 0;
                let boundary = false;
                for (const [dx, dy] of DIRS) {
                    const nx = px + dx, ny = py + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height || !colorGrid[ny * width + nx]) { boundary = true; break; }
                }
                if (boundary) { bfs[tail++] = key; dist[key] = 0; origin[key] = c; }
            }
        }

        let head = 0;
        while (head < tail) {
            const curr = bfs[head++];
            const cd = dist[curr], co = origin[curr];
            if (cd >= maxBridgeLength) continue;
            const cx = curr % width, cy = (curr / width) | 0;
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const nk = ny * width + nx;
                if (!isBridgeable[nk]) continue;
                if (dist[nk] === -1) {
                    dist[nk] = cd + 1; origin[nk] = co; prev[nk] = curr; bfs[tail++] = nk;
                } else if (find(co) !== find(origin[nk]) && cd + dist[nk] <= maxBridgeLength) {
                    union(co, origin[nk]);
                    // Mark path pixels as bridged (colorGrid[k] = 1 means it's part of the current color)
                    // NOTE: This marking is slightly flawed as it only marks the path *to* the current pixel,
                    // but it's a good heuristic for the purpose of this function.
                    let k = curr;
                    while (k !== -1 && dist[k] > 0) { colorGrid[k] = 1; k = prev[k]; }
                    k = nk;
                    while (k !== -1 && dist[k] > 0) { colorGrid[k] = 1; k = prev[k]; }
                }
            }
        }
    }

    // =====================================================================
    //  Image preprocessing
    // =====================================================================
    function processImage(img, step, colorsMode, denoiseLevel) {
        const W = WORK.w, H = WORK.h;
        const w = Math.max(1, Math.round(W / step));
        const h = Math.max(1, Math.round(H / step));

        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        if (S.layout === 'stretch') {
            ctx.drawImage(img, 0, 0, w, h);
        } else if (S.layout === 'center') {
            const ir = img.width / img.height, cr = W / H;
            let dw, dh;
            if (ir > cr) { dw = w; dh = w / ir; } else { dh = h; dw = h * ir; }
            ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        } else {
            ctx.drawImage(img, S.customX / W * w, S.customY / H * h, S.customW / W * w, S.customH / H * h);
        }

        const data = ctx.getImageData(0, 0, w, h).data;

        const counts = new Map();
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 150) continue; // Ignore semi-transparent/transparent pixels
            const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            counts.set(k, (counts.get(k) || 0) + 1);
        }

        let palette;
        if (colorsMode === 'classic16') palette = CLASSIC16;
        else if (colorsMode === 'infinite') palette = Array.from(counts.keys()).map(k => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255 }));
        else {
            const uniq = Array.from(counts.entries()).map(([k, count]) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, count }));
            palette = quantize(uniq, parseInt(colorsMode, 10) || 8);
        }
        if (!palette.length) palette = [{ r: 0, g: 0, b: 0 }];
        const paletteHex = palette.map(c => rgbToHex(c.r, c.g, c.b));
        const whiteIdx = paletteHex.indexOf('#FFFFFF');

        const idxGrid = new Int16Array(w * h);
        for (let k = 0; k < w * h; k++) {
            const i = k * 4;
            if (data[i + 3] < 150) { idxGrid[k] = -1; continue; }
            const p = { r: data[i], g: data[i + 1], b: data[i + 2] };
            let best = 0, min = Infinity;
            for (let c = 0; c < palette.length; c++) { const d = getDistance(p, palette[c]); if (d < min) { min = d; best = c; } }
            idxGrid[k] = best;
        }

        if (denoiseLevel > 0) {
            const out = new Int16Array(idxGrid);
            const cnt = new Map();
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const k = y * w + x, ci = idxGrid[k];
                    if (ci === -1 || ci === whiteIdx) continue;
                    let same = 0;
                    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                        if (!dx && !dy) continue;
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h && idxGrid[ny * w + nx] === ci) same++;
                    }
                    if (same >= denoiseLevel) continue;
                    cnt.clear();
                    let maxC = 0, bestIdx = ci;
                    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                        if (!dx && !dy) continue;
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                        const ni = idxGrid[ny * w + nx];
                        if (ni === -1) continue;
                        const c = (cnt.get(ni) || 0) + 1;
                        cnt.set(ni, c);
                        if (c > maxC) { maxC = c; bestIdx = ni; }
                        else if (c === maxC && getDistance(palette[ni], palette[ci]) < getDistance(palette[bestIdx], palette[ci])) bestIdx = ni;
                    }
                    out[k] = bestIdx;
                }
            }
            idxGrid.set(out);
        }
        return { idxGrid, paletteHex, w, h };
    }

    // =====================================================================
    //  Drawing plan (computed once, used by preview stats and by the run)
    // =====================================================================
    function chunkRects(rects, maxRects, maxChars) {
        const chunks = [];
        let cur = [], len = 0;
        for (const r of rects) {
            const l = String(r.x).length + String(r.y).length + String(r.w).length + String(r.h).length + 4;
            if (cur.length >= maxRects || len + l > maxChars) { chunks.push(cur); cur = []; len = 0; }
            cur.push(r); len += l;
        }
        if (cur.length) chunks.push(cur);
        return chunks;
    }

    function buildPlan(proc) {
        const t0 = performance.now();
        const { idxGrid, paletteHex, w, h } = proc;
        const size = w * h;
        const W = WORK.w, H = WORK.h;

        const pixelCount = new Int32Array(paletteHex.length);
        for (let k = 0; k < size; k++) if (idxGrid[k] >= 0) pixelCount[idxGrid[k]]++;

        // background = most popular color (painted with one fill, then skipped)
        let bgIdx = -1;
        if (S.fillBg) {
            let max = 0;
            for (let i = 0; i < pixelCount.length; i++) if (pixelCount[i] > max) { max = pixelCount[i]; bgIdx = i; }
        }

        let used = [];
        for (let i = 0; i < pixelCount.length; i++) if (pixelCount[i] > 0 && i !== bgIdx) used.push(i);

        const gridOf = ci => { const g = new Uint8Array(size); for (let k = 0; k < size; k++) if (idxGrid[k] === ci) g[k] = 1; return g; };
        const rectsMode = S.mode === 'rects';

        // most fragmented colors first (they get bridged over later colors)
        if (rectsMode) {
            const islands = new Map();
            for (const ci of used) islands.set(ci, countIslands(gridOf(ci), w, h));
            used.sort((a, b) => islands.get(b) - islands.get(a));
        } else {
            used.sort((a, b) => pixelCount[b] - pixelCount[a]);
        }

        const orderPos = new Map(used.map((ci, i) => [ci, i]));
        const orderGrid = new Int32Array(size);
        for (let k = 0; k < size; k++) { const p = orderPos.get(idxGrid[k]); orderGrid[k] = p === undefined ? -1 : p; }

        const colors = [];
        let totalRects = 0, totalBatches = 0;

        for (let pos = 0; pos < used.length; pos++) {
            const ci = used[pos];
            const grid = gridOf(ci);
            let rects;
            if (rectsMode) {
                if (S.useBridge) applyBridging(grid, orderGrid, w, h, pos, S.bridgeLen);
                const set = new Uint8Array(grid);
                let cnt = 0; for (let k = 0; k < size; k++) if (set[k]) cnt++;
                rects = buildRectangleTreeDFS(set, cnt, w, h);
            } else {
                rects = buildRuns(grid, w, h);
            }

            // grid → document coordinates (edges snap exactly to the canvas border)
            const docRects = [];
            for (const r of rects) {
                const x1 = Math.round(r.x * W / w), y1 = Math.round(r.y * H / h);
                const x2 = (r.x + r.w >= w) ? W : Math.round((r.x + r.w) * W / w);
                const y2 = (r.y + r.h >= h) ? H : Math.round((r.y + r.h) * H / h);
                if (x2 > x1 && y2 > y1) docRects.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
            }
            const batches = chunkRects(docRects, Math.max(1, S.batchSize), MAX_SCRIPT_CHARS);
            totalRects += docRects.length;
            totalBatches += batches.length;
            colors.push({ hex: paletteHex[ci], batches });
        }

        const intervalMs = Math.max(50, Math.ceil(1000 / Math.max(1, S.bps)));
        return {
            colors, bgHex: bgIdx >= 0 ? paletteHex[bgIdx] : null,
            totalRects, totalBatches, intervalMs,
            totalSteps: totalBatches + (bgIdx >= 0 ? 1 : 0),
            buildMs: performance.now() - t0
        };
    }

    function batchScript(hex, rects) {
        const a = [];
        for (const r of rects) a.push(r.x, r.y, r.w, r.h);
        return 'app.preferences.rulerUnits=Units.PIXELS;' +
            `var d=app.activeDocument,s=d.selection,a=[${a.join(',')}];` +
            'try{for(var i=0;i<a.length;i+=4){var x=a[i],y=a[i+1],X=x+a[i+2],Y=y+a[i+3];' +
            's.select([[x,y],[X,y],[X,Y],[x,Y]],i?SelectionType.EXTEND:SelectionType.REPLACE,0,false);}' +
            `var c=new SolidColor();c.rgb.hexValue="${hex.slice(1)}";s.fill(c);s.deselect();}` +
            'catch(e){app.echoToOE("ERR:draw "+e);}';
    }

    function bgScript(hex) {
        return 'app.preferences.rulerUnits=Units.PIXELS;var d=app.activeDocument,s=d.selection;' +
            `try{var c=new SolidColor();c.rgb.hexValue="${hex.slice(1)}";s.selectAll();s.fill(c);s.deselect();}` +
            'catch(e){app.echoToOE("ERR:background "+e);}';
    }

    // =====================================================================
    //  Preview
    // =====================================================================
    function clampCustomBounds() {
        S.customW = Math.max(10, Math.min(WORK.w, S.customW));
        S.customH = Math.max(10, Math.min(WORK.h, S.customH));
        S.customX = Math.max(0, Math.min(WORK.w - S.customW, S.customX));
        S.customY = Math.max(0, Math.min(WORK.h - S.customH, S.customY));
    }

    function updateSliders() {
        const set = (id, val, max) => { const el = $(id); if (!el) return; if (max !== undefined) el.max = max; el.value = val; };
        set('pd-custom-w', S.customW, WORK.w);
        set('pd-custom-h', S.customH, WORK.h);
        set('pd-custom-x', S.customX, WORK.w - S.customW);
        set('pd-custom-y', S.customY, WORK.h - S.customH);
        $('pd-val-w').textContent = Math.round(S.customW);
        $('pd-val-h').textContent = Math.round(S.customH);
        $('pd-val-x').textContent = Math.round(S.customX);
        $('pd-val-y').textContent = Math.round(S.customY);
    }

    function drawDraftPreview() {
        const pCanvas = $('pd-preview-canvas');
        if (!pCanvas || !currentImageSrc) return;
        $('pd-preview-container').style.display = 'flex';
        const w = Math.max(1, Math.round(WORK.w / S.scale)), h = Math.max(1, Math.round(WORK.h / S.scale));
        pCanvas.width = w; pCanvas.height = h;
        const ctx = pCanvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1; ctx.strokeRect(0, 0, w, h);

        if (draftImg && draftImg.complete) {
            const k = w / WORK.w;
            const cx = S.customX * k, cy = S.customY * k, cw = S.customW * k, ch = S.customH * k;
            ctx.drawImage(draftImg, cx, cy, cw, ch);
            ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5; ctx.strokeRect(cx, cy, cw, ch);
            ctx.fillStyle = '#38bdf8';
            const rect = pCanvas.getBoundingClientRect();
            const hs = rect.width ? (6 * w) / rect.width : 2;
            [[cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch]].forEach(([x, y]) => ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2));
        }
        $('pd-preview-info').innerHTML = '<span style="color:#fbbf24;font-weight:bold;">[Draft] Drag corners to resize, body to move.<br>Press "Apply & Render Preview" to verify.</span>';
    }

    function canvasPoint(e) {
        const pCanvas = $('pd-preview-canvas');
        const rect = pCanvas.getBoundingClientRect();
        return { rect, x: ((e.clientX - rect.left) / rect.width) * WORK.w, y: ((e.clientY - rect.top) / rect.height) * WORK.h };
    }
    function hitTest(wx, wy, rect) {
        const th = 24 * (WORK.w / rect.width);
        const { customX: x, customY: y, customW: w, customH: h } = S;
        if (Math.hypot(wx - x, wy - y) < th) return 'resize-TL';
        if (Math.hypot(wx - (x + w), wy - y) < th) return 'resize-TR';
        if (Math.hypot(wx - x, wy - (y + h)) < th) return 'resize-BL';
        if (Math.hypot(wx - (x + w), wy - (y + h)) < th) return 'resize-BR';
        if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) return 'move';
        return null;
    }

    function handleCanvasMouseDown(e) {
        if (S.layout !== 'custom' || !draftImg) return;
        const p = canvasPoint(e);
        activeDragAction = hitTest(p.x, p.y, p.rect);
        if (!activeDragAction) return;
        dragStartX = e.clientX; dragStartY = e.clientY;
        imgStartX = S.customX; imgStartY = S.customY; imgStartW = S.customW; imgStartH = S.customH;
        isDraggingImage = true;
        document.addEventListener('mousemove', handleCanvasMouseMove);
        document.addEventListener('mouseup', handleCanvasMouseUp);
    }
    function handleCanvasMouseMove(e) {
        if (!isDraggingImage || !activeDragAction) return;
        const rect = $('pd-preview-canvas').getBoundingClientRect();
        const dX = ((e.clientX - dragStartX) / rect.width) * WORK.w;
        const dY = ((e.clientY - dragStartY) / rect.height) * WORK.h;
        const m = 10;
        switch (activeDragAction) {
            case 'move':
                S.customX = Math.max(0, Math.min(WORK.w - S.customW, imgStartX + dX));
                S.customY = Math.max(0, Math.min(WORK.h - S.customH, imgStartY + dY)); break;
            case 'resize-BR':
                S.customW = Math.max(m, Math.min(WORK.w - S.customX, imgStartW + dX));
                S.customH = Math.max(m, Math.min(WORK.h - S.customY, imgStartH + dY)); break;
            case 'resize-BL':
                S.customX = Math.max(0, Math.min(imgStartX + imgStartW - m, imgStartX + dX));
                S.customW = imgStartX + imgStartW - S.customX;
                S.customH = Math.max(m, Math.min(WORK.h - S.customY, imgStartH + dY)); break;
            case 'resize-TR':
                S.customY = Math.max(0, Math.min(imgStartY + imgStartH - m, imgStartY + dY));
                S.customH = imgStartY + imgStartH - S.customY;
                S.customW = Math.max(m, Math.min(WORK.w - S.customX, imgStartW + dX)); break;
            case 'resize-TL':
                S.customX = Math.max(0, Math.min(imgStartX + imgStartW - m, imgStartX + dX));
                S.customY = Math.max(0, Math.min(imgStartY + imgStartH - m, imgStartY + dY)); break;
            case 'move':
                // Already handled above, but for completeness:
                S.customX = Math.max(0, Math.min(WORK.w - S.customW, imgStartX + dX));
                S.customY = Math.max(0, Math.min(WORK.h - S.customH, imgStartY + dY)); break;
        }
        updateSliders();
        drawDraftPreview();
    }
    function handleCanvasMouseUp() {
        isDraggingImage = false;
        activeDragAction = null;
        document.removeEventListener('mousemove', handleCanvasMouseMove);
        document.removeEventListener('mouseup', handleCanvasMouseUp);
        updateSliders();
        drawDraftPreview();
    }

    // =====================================================================
    //  Main Logic & Initialization
    // =====================================================================
    function initializeDrawBot() {
        // 1. Setup Listeners
        document.addEventListener('DOMContentLoaded', () => {
            // Check if Photopea is loaded and ready
            if (window.parent === window) {
                logToPanel("Photopea DrawBot Initialized.", false);
                setupEventListeners();
                updateSliders();
                drawDraftPreview();
            } else {
                logToPanel("Photopea DrawBot: Running in iframe context.", false);
                setupEventListeners();
                updateSliders();
                drawDraftPreview();
            }
        });

        function setupEventListeners() {
            // Image Source Change Listener (e.g., when user pastes or loads an image)
            document.addEventListener('paste', handlePaste);
            document.addEventListener('click', handleCanvasMouseDown);

            // Global controls
            document.getElementById('pd-btn-apply').addEventListener('click', handleApply);
            document.getElementById('pd-btn-cancel').addEventListener('click', handleCancel);
            document.getElementById('pd-btn-pause').addEventListener('click', togglePause);
            document.getElementById('pd-btn-load-img').addEventListener('click', handleLoadImage);
            document.getElementById('pd-btn-toggle-preview').addEventListener('click', () => {
                const container = $('pd-preview-container');
                container.style.display = container.style.display === 'none' ? 'flex' : 'none';
                drawDraftPreview();
            });

            // Settings change listeners (delegation)
            document.getElementById('pd-settings-panel').addEventListener('change', (e) => {
                if (e.target.id.startsWith('pd-setting-')) {
                    const key = e.target.id.replace('pd-setting-', '');
                    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                    S[key] = value;
                    saveSettings();
                    if (key === 'scale' || key === 'mode' || key === 'colorsMode' || key === 'denoise') {
                        // Re-process if core settings change
                        if (currentImageSrc) {
                            processAndPreview();
                        }
                    }
                    if (key.startsWith('custom')) {
                        clampCustomBounds();
                        updateSliders();
                    }
                }
            });
        }

        function handlePaste(e) {
            if (S.layout !== 'custom' || !currentImageSrc) return;
            const items = (e.clipboardData || window.clipboardData).items;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.type.indexOf('image') === 0) {
                    const blob = item.getAsFile();
                    const url = URL.createObjectURL(blob);
                    currentImageSrc = url;
                    logToPanel("Image pasted successfully. Ready to process.", false);
                    processAndPreview();
                    return;
                }
            }
        }

        async function handleLoadImage() {
            const url = prompt("Enter Image URL (e.g., https://example.com/image.png):");
            if (url) {
                currentImageSrc = url;
                logToPanel(`Loading image from: ${url}`, false);
                await loadImage(url);
                processAndPreview();
            }
        }

        async function processAndPreview() {
            if (!currentImageSrc) {
                logToPanel("No image source set. Please paste an image or load one.", true);
                return;
            }
            try {
                logToPanel("Starting image processing...", false);
                const img = await loadImage(currentImageSrc);
                const proc = processImage(img, S.scale, S.colorsMode, S.denoise);
                plan = buildPlan(proc);
                logToPanel(`Processing complete. Total Rects: ${plan.totalRects}, Total Batches: ${plan.totalBatches}. Build Time: ${plan.buildMs.toFixed(2)}ms.`, false);
                updateSliders();
                drawDraftPreview();
            } catch (e) {
                logToPanel(`FATAL ERROR during processing: ${e.message}`, true);
            }
        }

        function handleApply() {
            if (!plan) {
                logToPanel("Error: No processing plan found. Please load/paste an image first.", true);
                return;
            }
            if (S.target === 'new') {
                // Create new document
                pp(S.newW, S.newH, S.newLayer ? 'newLayer' : 'active', 'new');
                logToPanel(`Creating new document (${S.newW}x${S.newH}) on layer: ${S.newLayer ? 'New' : 'Active'}.`, false);
            } else { // 'active'
                // Ensure active document is selected
                pp(S.newW, S.newH, 'active', 'active');
                logToPanel(`Targeting active document.`, false);
            }

            // 1. Apply Background Fill
            if (plan.bgHex) {
                logToPanel(`Applying background fill (${plan.bgHex})...`, false);
                const bgScriptCode = bgScript(plan.bgHex);
                pp(bgScriptCode);
            }

            // 2. Apply Rectangles in Batches
            let currentBatchIndex = 0;
            let currentColorIndex = 0;
            let totalSteps = plan.totalSteps;

            function runNextStep() {
                if (cancelFlag) {
                    logToPanel("Drawing cancelled by user.", true);
                    return;
                }
                if (currentBatchIndex >= totalSteps) {
                    logToPanel("✅ Drawing complete!", false);
                    // Finalize: Ensure selection is cleared and drawing is finished
                    pp('app.preferences.rulerUnits=Units.PIXELS;var d=app.activeDocument,s=d.selection;s.deselect();', 5000);
                    return;
                }

                const colorData = plan.colors[currentColorIndex];
                if (!colorData) {
                    logToPanel("Error: Color data missing for current step.", true);
                    return;
                }

                const batch = colorData.batches[currentBatchIndex];
                if (!batch) {
                    // Move to next color
                    currentColorIndex++;
                    currentBatchIndex = 0;
                    logToPanel(`--- Moving to next color (${currentColorIndex + 1}/${plan.colors.length}) ---`, false);
                    runNextStep();
                    return;
                }

                // Execute batch script
                const scriptCode = batchScript(colorData.hex, batch);
                pp(scriptCode);

                // Schedule next step
                const interval = plan.intervalMs;
                previewTimer = setTimeout(runNextStep, interval);
            }

            // Start the sequence
            runNextStep();
        }

        function handleCancel() {
            cancelFlag = true;
            if (previewTimer) clearTimeout(previewTimer);
            logToPanel("Drawing cancelled. Waiting for current script to finish...", true);
        }

        function togglePause() {
            isPaused = !isPaused;
            const btn = document.getElementById('pd-btn-pause');
            btn.textContent = isPaused ? '⏸️ Pause' : '▶️ Resume';
            if (!isPaused) {
                logToPanel("Drawing resumed.", false);
                // If paused, we need to re-run the step logic to check the flag
                if (plan) {
                    // This is a bit hacky, but it forces the loop to check the flag immediately
                    // If we are in the middle of a batch, the next setTimeout will check it.
                    // If we are waiting for a PP call, the PP callback will check it.
                    // For immediate feedback, we just rely on the next scheduled step.
                }
            } else {
                logToPanel("Drawing paused.", true);
            }
        }

        // Initial setup call
        processAndPreview();
    }

    // Run the main initialization function
    initializeDrawBot();
})();