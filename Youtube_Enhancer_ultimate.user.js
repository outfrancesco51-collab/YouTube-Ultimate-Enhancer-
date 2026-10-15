// ==UserScript==
// @name         YouTube Ultimate Enhancer (Dislike + Boost 600% + 4:3 + Cel/FX + Upscaler)
// @namespace    https://github.com/outfrancesco51-collab
// @version      1.0.1 // <-- Aggiornato la versione!
// @description  Dislike (Return YouTube Dislike), volume fino a 600%, formato 4:3, effetti (cel shading, nitidezza, CRT...) e upscaler WebGL fino a 16x
// @author       outfrancesco51-collab
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      returnyoutubedislikeapi.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  CONFIG + STATO
   * ------------------------------------------------------------------ */
  const RYD_API = 'https://returnyoutubedislikeapi.com/votes?videoId=';
  const MAX_CANVAS_W = 7680; // limite di sicurezza per la GPU

  const DEFAULTS = {
    boost: 100,          // 100–600 (%)
    aspect: 'off',       // off | squeeze | stretch
    fx: false,           // motore WebGL attivo
    upscale: 1,          // 1–16x
    sharpen: 0.5,        // 0–1 (CAS)
    cel: false,
    celLevels: 6,
    edge: 0.5,
    sat: 1, contrast: 1, bright: 1,
    scan: 0,
    gray: false,
  };
  let S;
  try { S = Object.assign({}, DEFAULTS, JSON.parse(GM_getValue('yte', '{}'))); }
  catch (e) { S = Object.assign({}, DEFAULTS); }
  const save = () => { try { GM_setValue('yte', JSON.stringify(S)); } catch (e) {} };

  const $ = (s, r = document) => r.querySelector(s);
  const getVideo = () => $('#movie_player video.html5-main-video') || $('video');

  /* ------------------------------------------------------------------ *
   *  1) VOLUME BOOST (Web Audio: GainNode + compressore anti-clipping)
   * ------------------------------------------------------------------ */
  let actx = null, gainNode = null, audioVideo = null;

  function applyBoost() {
    const v = getVideo();
    if (!v) return;
    if (S.boost <= 100 && !audioVideo) return; // non tocco l'audio se non serve
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioVideo !== v) {
        const src = actx.createMediaElementSource(v);
        gainNode = actx.createGain();
        const comp = actx.createDynamicsCompressor();
        comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 6;
        comp.attack.value = 0.003; comp.release.value = 0.25;
        src.connect(gainNode); gainNode.connect(comp); comp.connect(actx.destination);
        audioVideo = v;
      }
      gainNode.gain.value = S.boost / 100;
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { console.warn('[YTE] boost error', e); }
  }
  // l'AudioContext parte solo dopo un gesto dell'utente
  document.addEventListener('click', () => { if (actx && actx.state === 'suspended') actx.resume(); }, true);

  /* ------------------------------------------------------------------ *
   *  2) FORMATO 4:3
   * ------------------------------------------------------------------ */
  function applyAspect() {
    const v = getVideo();
    if (!v || !v.parentNode) return;
    const c = v.parentNode; // .html5-video-container (contiene anche il canvas FX)
    const t = S.aspect === 'squeeze' ? 'scaleX(0.75)'      // 16:9 -> appare 4:3 (barre nere ai lati)
            : S.aspect === 'stretch' ? 'scaleX(1.33333)'   // video 4:3 -> riempie lo schermo 16:9
            : '';
    c.style.transform = t;
    c.style.transformOrigin = 'center center';
  }

  /* ------------------------------------------------------------------ *
   *  3) DISLIKE (Return YouTube Dislike API)
   * ------------------------------------------------------------------ */
  let lastId = null, ryd = null;
  const fmt = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

  function currentVideoId() {
    const q = new URLSearchParams(location.search).get('v');
    if (q) return q;
    const m = location.pathname.match(/^\/shorts\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function fetchRyd(id) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: RYD_API + encodeURIComponent(id),
      onload: r => {
        try { if (id === currentVideoId()) { ryd = JSON.parse(r.responseText); renderDislikes(); } }
        catch (e) { ryd = null; }
      },
      onerror: () => { ryd = null; },
    });
  }

  function renderDislikes() {
    if (!ryd || typeof ryd.dislikes !== 'number') return;
    const btn = $('dislike-button-view-model button') ||
                $('#segmented-dislike-button button') ||
                $('ytd-toggle-button-renderer:nth-of-type(2) button');
    if (btn) {
      let sp = btn.querySelector('.yte-dl');
      if (!sp) {
        sp = document.createElement('span');
        sp.className = 'yte-dl';
        sp.style.cssText = 'margin-left:6px;font-size:14px;font-weight:500;pointer-events:none';
        btn.appendChild(sp);
      }
      sp.textContent = fmt(ryd.dislikes);
    }
    const st = $('#yte-stats');
    if (st) st.textContent = `👍 ${fmt(ryd.likes)}   👎 ${fmt(ryd.dislikes)}   ⭐ ${Number(ryd.rating).toFixed(2)}/5`;
  }

  function watchVideoChange() {
    const id = currentVideoId();
    if (id && id !== lastId) {
      lastId = id; ryd = null;
      const st = $('#yte-stats'); if (st) st.textContent = '…';
      fetchRyd(id);
    }
    renderDislikes(); // YouTube ri-renderizza spesso i bottoni
  }

  /* ------------------------------------------------------------------ *
   *  4) MOTORE WEBGL: upscaler (Catmull-Rom + CAS) + effetti
   *     NB: non è DLSS (niente rete neurale): è ricostruzione bicubica
   *     + sharpening adattivo in stile FSR/CAS, eseguito sulla GPU.
   * ------------------------------------------------------------------ */
  const VS = `attribute vec2 p; varying vec2 uv;
    void main(){ uv = p*0.5+0.5; uv.y = 1.0-uv.y; gl_Position = vec4(p,0.0,1.0); }`;

  const FS = `precision highp float;
    varying vec2 uv;
    uniform sampler2D T;
    uniform vec2 px;           // 1 / dimensione video
    uniform float sharp, cel, levels, edge, sat, con, bri, scan, gray;

    vec3 tex(vec2 c){ return texture2D(T, c).rgb; }
    float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }

    // Catmull-Rom bicubico a 9 tap
    vec3 bicubic(vec2 c){
      vec2 pos = c/px;
      vec2 p1 = floor(pos-0.5)+0.5;
      vec2 f = pos-p1;
      vec2 w0 = f*(-0.5+f*(1.0-0.5*f));
      vec2 w1 = 1.0+f*f*(-2.5+1.5*f);
      vec2 w2 = f*(0.5+f*(2.0-1.5*f));
      vec2 w3 = f*f*(-0.5+0.5*f);
      vec2 w12 = w1+w2;
      vec2 t0 = (p1-1.0)*px, t3 = (p1+2.0)*px, t12 = (p1+w2/w12)*px;
      vec3 r = vec3(0.0);
      r += tex(vec2(t0.x ,t0.y ))*w0.x *w0.y;
      r += tex(vec2(t12.x,t0.y ))*w12.x*w0.y;
      r += tex(vec2(t3.x ,t0.y ))*w3.x *w0.y;
      r += tex(vec2(t0.x ,t12.y))*w0.x *w12.y;
      r += tex(vec2(t12.x,t12.y))*w12.x*w12.y;
      r += tex(vec2(t3.x ,t12.y))*w3.x *w12.y;
      r += tex(vec2(t0.x ,t3.y ))*w0.x *w3.y;
      r += tex(vec2(t12.x,t3.y ))*w12.x*w3.y;
      r += tex(vec2(t3.x ,t3.y ))*w3.x *w3.y;
      return clamp(r, 0.0, 1.0);
    }

    void main(){
      vec3 c = bicubic(uv);

      // Sharpening adattivo (CAS)
      if (sharp > 0.001) {
        vec2 d = px*0.75;
        vec3 a = tex(uv+vec2(0.0,-d.y)), b = tex(uv+vec2(-d.x,0.0));
        vec3 e = tex(uv+vec2( d.x,0.0)), f = tex(uv+vec2(0.0, d.y));
        vec3 mn = min(min(a,b), min(min(e,f), c));
        vec3 mx = max(max(a,b), max(max(e,f), c));
        vec3 amp = sqrt(clamp(min(mn, 1.0-mx)/max(mx, 0.0001), 0.0, 1.0));
        float peak = -1.0/mix(8.0, 5.0, sharp);
        vec3 w = amp*peak;
        c = clamp((c + (a+b+e+f)*w)/(1.0+4.0*w), 0.0, 1.0);
      }

      // Cel shading: posterizzazione + contorni (Sobel)
      if (cel > 0.5) {
        c = floor(c*levels+0.5)/levels;
        if (edge > 0.001) {
          vec2 d = px;
          float tl=lum(tex(uv+vec2(-d.x,-d.y))), t=lum(tex(uv+vec2(0.0,-d.y))), tr=lum(tex(uv+vec2(d.x,-d.y)));
          float l =lum(tex(uv+vec2(-d.x,0.0))),                                  r =lum(tex(uv+vec2(d.x,0.0)));
          float bl=lum(tex(uv+vec2(-d.x, d.y))), bo=lum(tex(uv+vec2(0.0, d.y))), br=lum(tex(uv+vec2(d.x, d.y)));
          float gx = -tl-2.0*l-bl+tr+2.0*r+br;
          float gy = -tl-2.0*t-tr+bl+2.0*bo+br;
          float g = length(vec2(gx,gy));
          float th = mix(0.6, 0.08, edge);
          c = mix(c, vec3(0.0), smoothstep(th, th+0.15, g));
        }
      }

      // Colore
      float g0 = lum(c);
      c = mix(vec3(g0), c, sat);
      c = (c-0.5)*con+0.5;
      c *= bri;
      if (gray > 0.5) c = vec3(lum(c));

      // Scanlines CRT (allineate alle righe del video sorgente)
      if (scan > 0.001) {
        float line = 0.5+0.5*sin(uv.y/px.y*6.2831853);
        c *= 1.0 - scan*0.55*line;
      }
      gl_FragColor = vec4(clamp(c,0.0,1.0), 1.0);
    }`;

  let cv = null, gl = null, prog = null, U = {};
  let running = false, dirty = true, lastT = -1, lastStyle = '';

  function initGL() {
    if (gl) return true;
    cv = document.createElement('canvas');
    cv.id = 'yte-canvas';
    cv.style.cssText = 'position:absolute;pointer-events:none;z-index:2;display:none;';
    gl = cv.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) { gl = null; return false; }
    try {
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      ['T', 'px', 'sharp', 'cel', 'levels', 'edge', 'sat', 'con', 'bri', 'scan', 'gray']
        .forEach(n => (U[n] = gl.getUniformLocation(prog, n)));
      gl.uniform1i(U.T, 0);
      return true;
    } catch (e) {
      console.error('[YTE] WebGL init error', e);
      gl = null; return false;
    }
  }

  function render(v) {
    if (!v.videoWidth || v.readyState < 2) return;
    const par = v.parentNode;
    if (cv.parentNode !== par) par.appendChild(cv);

    // il canvas copia posizione/dimensione del <video>
    const st = v.style.cssText;
    if (st !== lastStyle) {
      lastStyle = st;
      cv.style.left = v.style.left; cv.style.top = v.style.top;
      cv.style.width = v.style.width; cv.style.height = v.style.height;
    }

    // risoluzione interna = risoluzione sorgente × fattore upscale (limitata)
    const W = Math.min(Math.round(v.videoWidth * S.upscale), MAX_CANVAS_W);
    const H = Math.round(W * v.videoHeight / v.videoWidth);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; gl.viewport(0, 0, W, H); }

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
    } catch (e) {
      // video protetto (DRM) o contesto perso
      console.warn('[YTE] impossibile leggere il frame', e);
      S.fx = false; save(); stopFX(); syncPanel();
      return;
    }
    gl.uniform2f(U.px, 1 / v.videoWidth, 1 / v.videoHeight);
    gl.uniform1f(U.sharp, S.sharpen);
    gl.uniform1f(U.cel, S.cel ? 1 : 0);
    gl.uniform1f(U.levels, S.celLevels);
    gl.uniform1f(U.edge, S.edge);
    gl.uniform1f(U.sat, S.sat);
    gl.uniform1f(U.con, S.contrast);
    gl.uniform1f(U.bri, S.bright);
    gl.uniform1f(U.scan, S.scan);
    gl.uniform1f(U.gray, S.gray ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    cv.style.display = 'block';
  }

  function loop() {
    if (!S.fx) { running = false; return; }
    const v = getVideo();
    if (v && (dirty || v.currentTime !== lastT || v.style.cssText !== lastStyle)) {
      render(v); lastT = v.currentTime; dirty = false;
    }
    requestAnimationFrame(loop);
  }

  function startFX() {
    if (!initGL()) { S.fx = false; save(); alert('WebGL non disponibile: impossibile attivare gli effetti.'); syncPanel(); return; }
    dirty = true;
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  function stopFX() { if (cv) cv.style.display = 'none'; running = false; }

  /* ------------------------------------------------------------------ *
   *  5) PANNELLO DI CONTROLLO
   * ------------------------------------------------------------------ */
  const CTRL = [
    ['sect', '🔊 Audio'],
    ['range', 'boost', 'Volume boost', 100, 600, 5, '%'],
    ['sect', '🎞 Formato'],
    ['select', 'aspect', 'Aspect ratio', { off: 'Originale', squeeze: '4:3 (comprimi 16:9)', stretch: '4:3 → riempi 16:9' }],
    ['sect', '✨ FX / Upscaler (WebGL)'],
    ['check', 'fx', 'Attiva motore FX'],
    ['range', 'upscale', 'Upscale', 1, 16, 1, '×'],
    ['range', 'sharpen', 'Nitidezza (CAS)', 0, 1, 0.05, ''],
    ['check', 'cel', 'Cel shading'],
    ['range', 'celLevels', 'Livelli colore', 2, 12, 1, ''],
    ['range', 'edge', 'Contorni', 0, 1, 0.05, ''],
    ['range', 'sat', 'Saturazione', 0, 2.5, 0.05, ''],
    ['range', 'contrast', 'Contrasto', 0.5, 1.8, 0.05, ''],
    ['range', 'bright', 'Luminosità', 0.5, 1.6, 0.05, ''],
    ['range', 'scan', 'Scanlines CRT', 0, 1, 0.05, ''],
    ['check', 'gray', 'Bianco e nero'],
  ];

  const PRESETS = {
    '🎌 Anime / Cel': { fx: true, cel: true, celLevels: 6, edge: 0.5, sat: 1.25, sharpen: 0.6, upscale: 2, scan: 0, gray: false },
    '🔍 Nitido':      { fx: true, cel: false, sharpen: 0.8, upscale: 2, sat: 1.1, contrast: 1.05, scan: 0, gray: false },
    '📺 CRT retrò':   { fx: true, cel: false, sharpen: 0.2, upscale: 2, scan: 0.6, sat: 1.2, aspect: 'squeeze' },
    '↺ Reset':        Object.assign({}, DEFAULTS),
  };

  let panel = null, panelOpen = false;

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'yte-panel';
    panel.style.cssText = 'position:absolute;top:12px;right:12px;width:290px;max-height:85%;overflow:auto;z-index:99999;' +
      'background:rgba(18,18,18,.94);color:#fff;font:13px/1.35 Roboto,Arial,sans-serif;padding:12px;border-radius:12px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.6);display:none;';
    let h = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
            '<b style="font-size:14px">YouTube Enhancer</b><span id="yte-x" style="cursor:pointer;font-size:16px">✕</span></div>' +
            '<div id="yte-stats" style="opacity:.85;margin-bottom:8px">…</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">' +
            Object.keys(PRESETS).map(k => `<button data-preset="${k}" style="${btnCss()}">${k}</button>`).join('') + '</div>';
    for (const c of CTRL) {
      if (c[0] === 'sect') h += `<div style="margin:10px 0 4px;font-weight:600;color:#ff8a8a">${c[1}</div`;
      else if (c[0] === 'range') h += `<label style="display:block;margin:4px 0">${c[2]}: <b id="v-${c[1]}"></b>` +
        `<input data-k="${c[1]}" type="range" min="${c[3]}" max="${c[4]}" step="${c[5]}" data-u="${c[6]}" style="width:100%"></label>`;
      else if (c[0] === 'check') h += `<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input data-k="${c[1]}" type="checkbox">${c[2}</label>`;
      else if (c[0] === 'select') h += `<label style="display:block;margin:4px 0">${c[2]}<select data-k="${c[1]}" style="width:100%;margin-top:2px">` +
        Object.entries(c[3]).map(([k, v]) => `<option value="${k}">${v}</option>`).join('') + '</select></label>';
    }
    h += '<div style="opacity:.6;margin-top:8px;font-size:11px">Scorciatoia: Alt+V · Upscale limitato a ' + MAX_CANVAS_W + 'px di larghezza</div>';
    panel.innerHTML = h;

    // evita che click/tasti nel pannello arrivino al player
    ['click', 'dblclick', 'mousedown', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu']
      .forEach(ev => panel.addEventListener(ev, e => e.stopPropagation()));

    panel.querySelector('#yte-x').onclick = () => togglePanel(false);
    panel.querySelectorAll('[data-preset]').forEach(b => (b.onclick = () => {
      Object.assign(S, PRESETS[b.dataset.preset]); save(); applyAll(); syncPanel();
    }));
    panel.querySelectorAll('[data-k]').forEach(el => {
      const ev = el.type === 'range' ? 'input' : 'change';
      el.addEventListener(ev, () => {
        const k = el.dataset.k;
        S[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
        save(); onChange(k); syncPanel();
      });
    });
  }

  function btnCss() {
    return 'background:#3a3a3a;color:#fff;border:0;border-radius:8px;padding:5px 8px;cursor:pointer;font-size:12px';
  }

  function syncPanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k];
      const lab = panel.querySelector('#v-' + k);
      if (lab) lab.textContent = S[k] + (el.dataset.u || '');
    });
  }

  function onChange(k) {
    if (k === 'boost') applyBoost();
    else if (k === 'aspect') applyAspect();
    else if (k === 'fx') { S.fx ? startFX() : stopFX(); }
    else { dirty = true; if (S.fx) startFX(); }
  }

  function applyAll() {
    applyBoost(); applyAspect();
    if (S.fx) startFX(); else stopFX();
  }

  function mountPanel() {
    const player = $('#movie_player');
    if (!player) return;
    if (!panel) { buildPanel(); syncPanel(); }
    if (panel.parentNode !== player) player.appendChild(panel);
    panel.style.display = panelOpen ? 'block' : 'none';
    // bottone nella barra dei controlli
    const rc = $('.ytp-right-controls');
    if (rc && !$('#yte-btn')) {
      const b = document.createElement('button');
      b.id = 'yte-btn'; b.className = 'ytp-button'; b.title = 'YouTube Enhancer (Alt+V)';
      b.textContent = 'FX';
      b.style.cssText = 'font-weight:700;font-size:14px;color:#fff;vertical-align:top;';
      b.onclick = () => togglePanel();
      rc.insertBefore(b, rc.firstChild);
    }
  }

  function togglePanel(force) {
    panelOpen = typeof force === 'boolean' ? force : !panelOpen;
    mountPanel();
    if (panelOpen) { syncPanel(); renderDislikes(); }
  }

  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); togglePanel(); }
  });

  /* ------------------------------------------------------------------ *
   *  AVVIO
   * ------------------------------------------------------------------ */
  function tick() {
    mountPanel();
    watchVideoChange();
    const v = getVideo();
    if (v) {
      if (S.aspect !== 'off' && v.parentNode && !v.parentNode.style.transform) applyAspect();
      if (S.boost > 100 && audioVideo !== v) applyBoost();
      if (S.fx && !running) startFX();
    }
  }
  window.addEventListener('yt-navigate-finish', () => { lastId = null; setTimeout(tick, 300); });
  setInterval(tick, 1500);
  tick();
})();