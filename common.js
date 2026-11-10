/* Shared by the phone page and the big-screen page: the connection, small helpers, dialogs,
   sounds, the icons, and the drawing of the island itself. */
(function () {
  'use strict';
  var F = window.Game = {};
  var R = window.Rules;

  // Change these to rename the game everywhere.
  F.TITLE = 'SETTLERS OF FRIENDS';
  F.SUB = 'BUILD · TRADE · SETTLE';
  // Shown small on the start screens. Goes up with every change; CHANGELOG.md says what each one was.
  F.VERSION = '1.0.0';

  F.$ = function (sel, root) { return (root || document).querySelector(sel); };
  F.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  F.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  F.clock = function (ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    s = s % 60; m = m % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  };
  F.ago = function (t) {
    var d = Math.max(0, Date.now() - t), m = Math.round(d / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 36) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  };

  F.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  /* ---- live connection with automatic reconnect ---- */
  F.connect = function (opts) {
    var ws = null, timer = null, tries = 0, stopped = false;
    var myBuild = document.documentElement.getAttribute('data-build');
    function freshCheck() {
      if (!myBuild || !window.fetch) return;
      fetch('/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (v) {
        if (!/^[0-9a-f]{12}$/.test(v) || v === myBuild) return;
        var last = Number(F.store.get('sof.reloadAt', 0));
        if (Date.now() - last < 30000) return;
        F.store.set('sof.reloadAt', Date.now());
        try { sessionStorage.setItem('sof.auto', '1'); } catch (e) { /* private mode */ }
        location.reload();
      }).catch(function () { /* offline: try again next time */ });
    }
    function open() {
      timer = null;
      if (stopped) return;
      try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { return retry(); }
      var mine = ws;
      mine.onopen = function () {
        tries = 0; freshCheck();
        if (opts.onStatus) opts.onStatus(true);
        var h = opts.hello && opts.hello();
        if (h) mine.send(JSON.stringify(h));
      };
      mine.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (err) { return; } opts.onMessage(m); };
      mine.onclose = function () { if (ws !== mine) return; if (opts.onStatus) opts.onStatus(false); retry(); };
      mine.onerror = function () { try { mine.close(); } catch (e) { /* ignore */ } };
    }
    function retry() { if (stopped || timer) return; timer = setTimeout(open, Math.min(4000, 300 + 500 * tries++)); }
    var api = {
      send: function (m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; },
      stop: function () { stopped = true; if (timer) clearTimeout(timer); try { ws.close(); } catch (e) { /* ignore */ } }
    };
    open();
    setInterval(function () { api.send({ t: 'ping' }); }, 20000);
    setInterval(function () { try { fetch('/health').catch(function () {}); freshCheck(); } catch (e) { /* ignore */ } }, 4 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !stopped && (!ws || ws.readyState > 1)) { if (timer) { clearTimeout(timer); timer = null; } tries = 0; open(); }
    });
    return api;
  };

  F.stayAwake = function () {
    var lock = null;
    function ask() {
      if (!navigator.wakeLock || document.hidden) return;
      try { navigator.wakeLock.request('screen').then(function (l) { lock = l; l.addEventListener('release', function () { lock = null; }); }).catch(function () {}); } catch (e) { /* not allowed here */ }
    }
    ask();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ask(); });
    document.addEventListener('click', function () { if (!lock) ask(); }, { passive: true });
  };

  F.fit = function (el, min) {
    el.style.fontSize = '';
    var size = parseFloat(getComputedStyle(el).fontSize), floor = min || size * 0.45, guard = 0;
    while ((el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) && size > floor && guard++ < 60) {
      size -= Math.max(1, size * 0.05);
      el.style.fontSize = size + 'px';
    }
  };

  var calm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  F.motionOK = function () { return !(calm && calm.matches); };
  F.anim = function (el, frames, opts) {
    if (!el || !el.animate || !F.motionOK()) return null;
    try { return el.animate(frames, opts); } catch (e) { return null; }
  };
  F.bump = function (el, scale) {
    return F.anim(el, [{ transform: 'scale(1)' }, { transform: 'scale(' + (scale || 1.2) + ')', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.3, 1.3, .5, 1)' });
  };
  F.shake = function (el) {
    return F.anim(el, [0, -6, 12, -18, 18, -14, 12, -8, 4, 0].map(function (x) { return { transform: 'translateX(' + x + 'px)' }; }), { duration: 480, easing: 'ease-out' });
  };

  /* ---- redraw a block of HTML without throwing away what is already on screen ---- */
  function keyOf(n) { return n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null; }
  function morphKids(from, to) {
    var want = {}, cur = from.firstChild, next = to.firstChild, n, k, hit, c, clear;
    function id(x) { var kk = keyOf(x); return kk ? x.nodeName + '|' + kk : null; }
    function drop(x) { if (x === cur) cur = cur.nextSibling; from.removeChild(x); }
    for (n = to.firstChild; n; n = n.nextSibling) if (id(n)) want[id(n)] = 1;
    while (next) {
      n = next; next = next.nextSibling;
      while (cur && id(cur) && !want[id(cur)]) drop(cur);
      k = id(n); hit = null;
      for (c = cur; c; c = c.nextSibling) if (k ? id(c) === k : (!id(c) && c.nodeName === n.nodeName)) { hit = c; break; }
      if (hit && hit !== cur) {
        clear = true;
        for (c = cur; c !== hit; c = c.nextSibling) if (id(c) && want[id(c)]) { clear = false; break; }
        if (clear) while (cur !== hit) drop(cur);
      }
      if (hit) { if (hit === cur) cur = cur.nextSibling; else from.insertBefore(hit, cur); morphNode(hit, n); }
      else from.insertBefore(n, cur);
    }
    while (cur) drop(cur);
  }
  function morphNode(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    var i, at, name;
    for (i = a.attributes.length - 1; i >= 0; i--) { name = a.attributes[i].name; if (!b.hasAttribute(name) && name.indexOf('data-fx-') !== 0) a.removeAttribute(name); }
    for (i = 0; i < b.attributes.length; i++) { at = b.attributes[i]; if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value); }
    if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA' || a.nodeName === 'SELECT') {
      if (document.activeElement !== a) { var v = b.getAttribute('value') || ''; if (a.value !== v) a.value = v; }
      return;
    }
    if (a.hasAttribute('data-live') || a.hasAttribute('data-static')) return;
    morphKids(a, b);
  }
  F.morph = function (root, html) { var t = document.createElement('template'); t.innerHTML = html; morphKids(root, t.content); };

  F.pressFx = function () {
    var held = null, t0 = 0;
    function release() { var b = held; held = null; if (b) setTimeout(function () { b.removeAttribute('data-fx-press'); }, Math.max(0, 110 - (performance.now() - t0))); }
    document.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('button, a.btn, .tap') : null;
      if (!b || b.disabled) return;
      if (held && held !== b) held.removeAttribute('data-fx-press');
      held = b; t0 = performance.now();
      b.setAttribute('data-fx-press', '');
    }, { passive: true });
    ['pointerup', 'pointercancel', 'blur'].forEach(function (ev) { addEventListener(ev, release, { passive: true }); });
    document.addEventListener('touchstart', function () {}, { passive: true });
  };

  /* ---- dialogs styled like the game ---- */
  F.dialog = function (o) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'dlg-back';
      var h = '<div class="dlg" role="dialog">' + (o.title ? '<h2>' + F.esc(o.title) + '</h2>' : '') + (o.text ? '<p>' + F.esc(o.text) + '</p>' : '') + (o.html || '');
      if (o.input) h += '<input class="dlg-in" maxlength="' + (o.input.maxlength || 40) + '" placeholder="' + F.esc(o.input.placeholder || '') + '" value="' + F.esc(o.input.value || '') + '"' + (o.input.caps ? ' autocapitalize="characters"' : '') + '>';
      h += '<div class="dlg-row">' + (o.buttons || [{ label: 'OK', kind: 'pri', value: true }]).map(function (b, i) { return '<button class="dlg-btn ' + (b.kind || '') + '" data-i="' + i + '">' + F.esc(b.label) + '</button>'; }).join('') + '</div></div>';
      back.innerHTML = h;
      document.body.appendChild(back);
      var inp = back.querySelector('.dlg-in');
      function done(v) { back.classList.add('out'); setTimeout(function () { back.remove(); }, 180); resolve(v); }
      back.addEventListener('click', function (e) {
        var b = e.target.closest('.dlg-btn');
        if (b) { var bt = (o.buttons || [{ value: true }])[Number(b.getAttribute('data-i'))]; done(inp ? { value: bt.value, text: inp.value } : bt.value); }
        else if (e.target === back && !o.input) done(o.cancel === undefined ? false : o.cancel);
      });
      if (inp) { setTimeout(function () { inp.focus(); inp.select(); }, 60); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var pri = (o.buttons || []).findIndex(function (b) { return b.kind === 'pri'; }); done({ value: pri >= 0 ? o.buttons[pri].value : true, text: inp.value }); } }); }
      addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && back.parentNode) { done(o.cancel === undefined ? false : o.cancel); removeEventListener('keydown', esc); } });
    });
  };
  F.confirm = function (title, text, okLabel, danger) {
    return F.dialog({ title: title, text: text, buttons: [{ label: okLabel || 'OK', kind: danger ? 'red' : 'pri', value: true }, { label: 'Cancel', kind: 'ghost', value: false }] });
  };

  /* ---- a photo from the camera roll, cropped square and shrunk before it is sent ---- */
  F.shrinkPhoto = function (file, size) {
    size = size || 160;
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || 'image/')) return reject(new Error('not an image'));
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h);
          var c = document.createElement('canvas'); c.width = size; c.height = size;
          var x = c.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, size, size);
          x.imageSmoothingQuality = 'high';
          x.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
          URL.revokeObjectURL(url);
          var q = 0.85, out = c.toDataURL('image/jpeg', q);
          while (out.length > 55000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
          resolve(out);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('could not read')); };
      img.src = url;
    });
  };

  /* ---- sound effects, synthesized so there are no audio files to load ---- */
  F.sfx = (function () {
    var ctx = null, muted = false, master = null;
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (C) { ctx = new C(); master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination); }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(o) {
      var c = ac(); if (!c || muted) return;
      var t = c.currentTime + (o.t || 0), d = o.d || 0.3;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(o.g || 0.3, t + (o.a || 0.012));
      if (o.hold) g.gain.setValueAtTime(o.g || 0.3, t + d - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + d + 0.05);
    }
    function noise(t, d, g, freq, q) {
      var c = ac(); if (!c || muted) return;
      var n = Math.floor(c.sampleRate * d), buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(), f = c.createBiquadFilter(), gn = c.createGain();
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq || 2500; f.Q.value = q || 1.2;
      gn.gain.value = g;
      src.connect(f); f.connect(gn); gn.connect(master);
      src.start(c.currentTime + (t || 0));
    }
    function bell(f, t, g) { tone({ f: f, t: t, d: 1.0, g: g }); tone({ f: f * 2, t: t, d: 0.6, g: g * 0.35 }); tone({ f: f * 3.01, t: t, d: 0.3, g: g * 0.15 }); }
    function knock(t, f, g) { noise(t, 0.05, g || 0.5, f || 900, 1.2); tone({ f: (f || 900) / 4, f2: (f || 900) / 8, type: 'sine', t: t, d: 0.12, g: (g || 0.5) * 0.5 }); }
    return {
      unlock: ac, ctx: ac,
      mute: function (v) { muted = v; if (master) master.gain.setTargetAtTime(v ? 0 : 1, ctx.currentTime, 0.03); },
      isMuted: function () { return muted; },
      tick: function () { tone({ f: 1000, type: 'square', d: 0.04, g: 0.06 }); },
      tap: function () { tone({ f: 880, type: 'triangle', d: 0.06, g: 0.1 }); },
      pick: function () { tone({ f: 620, type: 'triangle', d: 0.05, g: 0.09 }); },
      join: function () { tone({ f: 660, d: 0.09, g: 0.14 }); tone({ f: 990, t: 0.08, d: 0.2, g: 0.14 }); },
      ping: function () { tone({ f: 1760, d: 0.1, g: 0.12 }); tone({ f: 2349, t: 0.1, d: 0.25, g: 0.1 }); },
      nope: function () { tone({ f: 220, f2: 160, type: 'square', d: 0.12, g: 0.07 }); },
      // Two dice tumbling across a wooden table.
      dice: function () { for (var i = 0; i < 9; i++) knock(i * 0.075 + Math.random() * 0.03, 1100 + Math.random() * 900, 0.32); knock(0.78, 700, 0.5); knock(0.86, 620, 0.5); },
      // Cards landing in a hand.
      gain: function (n) { for (var i = 0; i < Math.min(5, n || 1); i++) { noise(i * 0.08, 0.05, 0.3, 3200, 2); tone({ f: 880 + i * 110, type: 'triangle', t: i * 0.08, d: 0.14, g: 0.09 }); } },
      // A wooden piece set down on the board.
      build: function () { knock(0, 520, 0.7); knock(0.07, 380, 0.35); },
      city: function () { knock(0, 420, 0.8); knock(0.1, 300, 0.5); bell(1319, 0.16, 0.08); },
      // The robber: two low, unfriendly notes.
      robber: function () { tone({ f: 147, type: 'sawtooth', d: 0.35, g: 0.12, hold: true }); tone({ f: 139, type: 'sawtooth', t: 0.36, d: 0.6, g: 0.12, hold: true }); tone({ f: 73, type: 'sine', t: 0, d: 1.0, g: 0.18 }); },
      seven: function () { [392, 370, 311].forEach(function (f, i) { tone({ f: f, type: 'square', t: i * 0.14, d: i === 2 ? 0.5 : 0.13, g: 0.08 }); }); },
      steal: function () { noise(0, 0.18, 0.4, 1800, 0.7); tone({ f: 900, f2: 300, type: 'sine', d: 0.2, g: 0.1 }); },
      // An offer slides across the table.
      offer: function () { tone({ f: 784, type: 'triangle', d: 0.07, g: 0.12 }); tone({ f: 1047, type: 'triangle', t: 0.09, d: 0.16, g: 0.12 }); },
      // A deal: two coins.
      trade: function () { bell(1568, 0, 0.12); bell(2093, 0.11, 0.12); noise(0, 0.05, 0.25, 5000, 3); noise(0.11, 0.05, 0.25, 5600, 3); },
      turn: function () { [659, 880, 1319].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.09, d: i === 2 ? 0.4 : 0.12, g: 0.16 }); }); },
      card: function () { noise(0, 0.09, 0.4, 2600, 1); tone({ f: 523, f2: 1047, type: 'sine', t: 0.03, d: 0.18, g: 0.08 }); },
      // Longest Road, Largest Army: a short herald's fanfare.
      crown: function () { [523, 523, 784, 1047].forEach(function (f, i) { tone({ f: f, type: 'sawtooth', t: [0, 0.12, 0.24, 0.42][i], d: i === 3 ? 0.9 : 0.11, g: 0.07 }); tone({ f: f / 2, type: 'triangle', t: [0, 0.12, 0.24, 0.42][i], d: i === 3 ? 0.9 : 0.11, g: 0.1 }); }); bell(2093, 0.5, 0.08); },
      win: function () {
        [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.14, d: i === 7 ? 2.0 : 0.2, g: 0.2 }); });
        [262, 330, 392, 523].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 1.1, d: 2.2, g: 0.05 }); });
        bell(2093, 1.2, 0.12); bell(2637, 1.5, 0.08);
      },
      sad: function () { [392, 370, 349, 311].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.22, d: i === 3 ? 1.0 : 0.24, g: 0.1 }); }); },
      start: function () { [[392, 0], [523, 0.16], [659, 0.32], [784, 0.48], [1047, 0.7]].forEach(function (n) { tone({ f: n[0], type: 'triangle', t: n[1], d: n[1] === 0.7 ? 1.1 : 0.18, g: 0.14 }); }); bell(2093, 0.9, 0.07); }
    };
  })();

  /* ---- pictures ---- */
  F.emo = function (e) { return '<span class="emo">' + F.esc(e || '❓') + '</span>'; };
  F.colorOf = function (p) { return R.PALETTE[(p && p.color) || 0] || R.PALETTE[0]; };
  // A player as a medallion in their colour, with their emoji or photo.
  F.med = function (p, cls) {
    var c = F.colorOf(p);
    return '<span class="med' + (cls ? ' ' + cls : '') + '" style="--c1:' + c.c1 + ';--c2:' + c.c2 + '">' + (p && p.photo ? '<img src="' + F.esc(p.photo) + '" alt="">' : F.emo(p ? p.face : '🙂')) + '</span>';
  };

  F.RES_COLOR = { wood: '#2f8f46', brick: '#d1622f', sheep: '#86c94a', wheat: '#eeb721', ore: '#7f8aa0' };
  var ICON = {
    wood: '<path d="M12 1.8l5.2 6.3h-2.9l4.4 5.5h-3.3L20 19H4l4.6-5.4H5.3l4.4-5.5H6.8z"/><rect x="10.6" y="18.6" width="2.8" height="3.9" rx=".7"/>',
    brick: '<rect x="2.2" y="5" width="9" height="5.8" rx="1.1"/><rect x="12.8" y="5" width="9" height="5.8" rx="1.1"/><rect x="7.5" y="12.6" width="9" height="5.8" rx="1.1"/><rect x="2.2" y="12.6" width="3.7" height="5.8" rx="1.1"/><rect x="18.1" y="12.6" width="3.7" height="5.8" rx="1.1"/>',
    sheep: '<path d="M8.2 8.2a3.2 3.2 0 015.2-1.6 3.3 3.3 0 015.3 1.9 3.3 3.3 0 01.9 6.2 3.2 3.2 0 01-3.1 2.4H9.7a3.6 3.6 0 01-3.2-5.3 2.9 2.9 0 011.7-3.6z"/><ellipse class="dk" cx="5.4" cy="11.4" rx="2.6" ry="3.1"/><rect class="dk" x="9.4" y="16.4" width="1.9" height="4.4" rx=".9"/><rect class="dk" x="14.6" y="16.4" width="1.9" height="4.4" rx=".9"/>',
    wheat: '<rect x="11.2" y="8" width="1.6" height="14.5" rx=".8"/><ellipse cx="12" cy="4.6" rx="1.9" ry="3.1"/><ellipse cx="8.9" cy="8.6" rx="1.8" ry="3.1" transform="rotate(-32 8.9 8.6)"/><ellipse cx="15.1" cy="8.6" rx="1.8" ry="3.1" transform="rotate(32 15.1 8.6)"/><ellipse cx="8.9" cy="12.9" rx="1.8" ry="3.1" transform="rotate(-32 8.9 12.9)"/><ellipse cx="15.1" cy="12.9" rx="1.8" ry="3.1" transform="rotate(32 15.1 12.9)"/><ellipse cx="9.1" cy="17.1" rx="1.7" ry="2.8" transform="rotate(-32 9.1 17.1)"/><ellipse cx="14.9" cy="17.1" rx="1.7" ry="2.8" transform="rotate(32 14.9 17.1)"/>',
    ore: '<path d="M2 19.5l5-10.2 3.4 4.2L14 5l8 14.5z"/><path class="dk" opacity=".3" d="M14 5l-1.6 7.8 4 3.2zM7 9.3l-.6 6 2.9 1.6z"/>',
    desert: '<circle cx="17.5" cy="6.5" r="3"/><path d="M1.5 20c3-5 6.5-5 9-1.5 2-3.5 6-4.5 12 1.5z"/>',
    any: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>'
  };
  // A resource as a small one-colour icon. It takes the text colour unless a colour is given.
  F.icon = function (res, cls) { return '<svg class="ri' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICON[res] || '') + '</svg>'; };
  // A resource as a little playing card with a count on it.
  F.card = function (res, n, cls, attrs) {
    return '<span class="rc ' + res + (cls ? ' ' + cls : '') + '"' + (attrs || '') + '>' + F.icon(res) + (n == null ? '' : '<b>' + n + '</b>') + '</span>';
  };
  // "2 wood + 1 ore" as a row of little cards.
  F.cards = function (x, cls) {
    var h = '';
    R.RES.forEach(function (r) { if (x && x[r]) h += F.card(r, x[r], cls); });
    return h || '<span class="rc none">–</span>';
  };
  F.DEV_ICON = { knight: '⚔️', road: '🛤️', plenty: '🧺', mono: '👑', vp: '⭐' };

  /* ---- the island ---- */
  var U = 100;       // one hex, corner to centre, in drawing units
  var TERR = {
    forest: ['#3a9a52', '#27763b'], hills: ['#de7a45', '#b8552c'], pasture: ['#a9e06e', '#7fc04b'],
    fields: ['#f8d552', '#e2ab1f'], mountains: ['#a4aec0', '#727d92'], desert: ['#efdcaa', '#d8bf84']
  };
  function hexPts(r) { var p = []; for (var k = 0; k < 6; k++) { var a = (-90 + 60 * k) * Math.PI / 180; p.push((Math.cos(a) * r).toFixed(1) + ',' + (Math.sin(a) * r).toFixed(1)); } return p.join(' '); }
  var HEX96 = hexPts(96), HEX86 = hexPts(84), HEX104 = hexPts(107);
  F.boardBox = function (kind) {
    var G = R.geo(kind), m = 1.08;
    return { x: (G.box.x0 - m) * U, y: (G.box.y0 - m) * U, w: (G.box.x1 - G.box.x0 + 2 * m) * U, h: (G.box.y1 - G.box.y0 + 2 * m) * U };
  };
  var SETTLE = '-17,17 -17,-3 0,-19 17,-3 17,17', CITY = '-26,19 -26,-3 -13,-14 0,-3 0,-15 13,-29 26,-15 26,19';
  function piece(what, c, x, y, cls, key) {
    var pts = what === 'city' ? CITY : SETTLE;
    return '<g class="bld ' + what + (cls ? ' ' + cls : '') + '"' + (key ? ' data-key="' + key + '"' : '') + ' transform="translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')"><g class="in">' +
      '<polygon points="' + pts + '" transform="translate(0,5)" fill="#000" opacity=".35"/>' +
      '<polygon points="' + pts + '" fill="' + c.c1 + '" stroke="#1b120a" stroke-width="5" stroke-linejoin="round"/>' +
      (what === 'city' ? '<path d="M-26,-3 L-13,-14 L0,-3 M0,-15 L13,-29 L26,-15" fill="none" stroke="' + c.c2 + '" stroke-width="4" stroke-linejoin="round"/><rect x="9" y="-6" width="8" height="10" rx="1.5" fill="' + c.c2 + '"/>' : '<path d="M-17,-3 L0,-19 L17,-3" fill="none" stroke="' + c.c2 + '" stroke-width="4" stroke-linejoin="round"/>') +
      '</g></g>';
  }
  function road(G, e, c, cls, key) {
    var E = G.edges[e], a = G.verts[E.a], b = G.verts[E.b], k = 0.2;
    var x1 = (a.x + (b.x - a.x) * k) * U, y1 = (a.y + (b.y - a.y) * k) * U, x2 = (b.x + (a.x - b.x) * k) * U, y2 = (b.y + (a.y - b.y) * k) * U;
    var d = 'x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"';
    return '<g class="road' + (cls ? ' ' + cls : '') + '"' + (key ? ' data-key="' + key + '"' : '') + '><line ' + d + ' stroke="#1b120a" stroke-width="19" stroke-linecap="round"/><line ' + d + ' stroke="' + c.c1 + '" stroke-width="10.5" stroke-linecap="round"/></g>';
  }
  var ROBBER = '<g class="in"><ellipse cx="0" cy="27" rx="20" ry="6" fill="#000" opacity=".35"/><path d="M-15,26 C-17,4 -9,-6 0,-6 C9,-6 17,4 15,26 Z" fill="#33333d" stroke="#0c0c10" stroke-width="4" stroke-linejoin="round"/><circle cx="0" cy="-17" r="12" fill="#33333d" stroke="#0c0c10" stroke-width="4"/><path d="M-6,-20 a7,7 0 0 1 8,-5" fill="none" stroke="#777786" stroke-width="3" stroke-linecap="round"/></g>';

  // Draws the island as SVG. g is the game as the server sends it; o says what to light up:
  //   colorOf(pid) → a palette entry        hi: { v: [...], e: [...], h: [...] } spots that can be tapped
  //   sel: { v } | { e } | { h } the spot picked, with ghost: 'settlement' | 'city' | 'road' | 'robber' and mine: a palette entry
  //   glow: { hexIndex: true } hexes that just paid out
  F.board = function (g, o) {
    o = o || {};
    var G = R.geo(g.board.kind), bx = F.boardBox(g.board.kind), i, h = '';
    var col = o.colorOf || function () { return R.PALETTE[0]; };
    h += '<svg class="isle ' + g.board.kind + '" viewBox="' + bx.x.toFixed(0) + ' ' + bx.y.toFixed(0) + ' ' + bx.w.toFixed(0) + ' ' + bx.h.toFixed(0) + '" style="aspect-ratio:' + bx.w.toFixed(0) + '/' + bx.h.toFixed(0) + '" xmlns="http://www.w3.org/2000/svg">';
    // The beach under everything, then the land.
    h += '<g class="beach">';
    for (i = 0; i < G.hexes.length; i++) h += '<polygon points="' + HEX104 + '" transform="translate(' + (G.hexes[i].x * U).toFixed(1) + ',' + (G.hexes[i].y * U).toFixed(1) + ')"/>';
    h += '</g>';
    // Ports: a badge out at sea with two piers to the corners it serves.
    h += '<g class="ports">';
    G.slots.forEach(function (s, k) {
      var t = g.board.ports[k], a = G.verts[s.a], b = G.verts[s.b];
      h += '<g class="port" data-key="p' + k + '"><line x1="' + (s.x * U).toFixed(1) + '" y1="' + (s.y * U).toFixed(1) + '" x2="' + (a.x * U).toFixed(1) + '" y2="' + (a.y * U).toFixed(1) + '"/><line x1="' + (s.x * U).toFixed(1) + '" y1="' + (s.y * U).toFixed(1) + '" x2="' + (b.x * U).toFixed(1) + '" y2="' + (b.y * U).toFixed(1) + '"/>' +
        '<g transform="translate(' + (s.x * U).toFixed(1) + ',' + (s.y * U).toFixed(1) + ')"><circle r="31" class="pb"/>' +
        (t === 'any' ? '<text y="9" class="pr big">3:1</text>' : '<g transform="translate(-13,-27) scale(1.08)" fill="' + F.RES_COLOR[t] + '" class="pic">' + ICON[t] + '</g><text y="21" class="pr">2:1</text>') + '</g></g>';
    });
    h += '</g><g class="land">';
    g.board.hexes.forEach(function (hx, k) {
      var c = TERR[hx.t], res = R.TERRAIN[hx.t], robbed = g.board.robber === k, red = hx.n === 6 || hx.n === 8;
      h += '<g class="hex t-' + hx.t + (robbed ? ' robbed' : '') + (o.glow && o.glow[k] ? ' prod' : '') + '" data-key="h' + k + '" transform="translate(' + (G.hexes[k].x * U).toFixed(1) + ',' + (G.hexes[k].y * U).toFixed(1) + ')">' +
        '<polygon points="' + HEX96 + '" fill="' + c[1] + '"/><polygon points="' + HEX86 + '" fill="' + c[0] + '"/>' +
        '<g class="motif" transform="translate(-22,-76) scale(1.85)">' + ICON[res || 'desert'] + '</g>';
      if (hx.n) {
        h += '<g class="tok' + (red ? ' red' : '') + '" transform="translate(0,22)"><circle r="33" cy="3" fill="#000" opacity=".25"/><circle r="33"/><text y="9">' + hx.n + '</text><g class="pips">';
        for (var q = 0; q < R.PIPS[hx.n]; q++) h += '<circle cx="' + ((q - (R.PIPS[hx.n] - 1) / 2) * 8.5).toFixed(1) + '" cy="21" r="3"/>';
        h += '</g></g>';
      }
      h += '</g>';
    });
    h += '</g><g class="roads">';
    Object.keys(g.r).forEach(function (e) { h += road(G, Number(e), col(g.r[e]), '', 'r' + e); });
    h += '</g>';
    // Where something can be tapped: glowing edges, corners or hexes.
    var hi = o.hi || {}, sel = o.sel || {};
    if (hi.h) { h += '<g class="spots">'; hi.h.forEach(function (k) { h += '<g class="spot-h' + (sel.h === k ? ' on' : '') + '" data-key="sh' + k + '" transform="translate(' + (G.hexes[k].x * U).toFixed(1) + ',' + (G.hexes[k].y * U).toFixed(1) + ')"><polygon points="' + HEX86 + '"/></g>'; }); h += '</g>'; }
    if (hi.e) {
      h += '<g class="spots">';
      hi.e.forEach(function (e) { if (sel.e === e) return; var E = G.edges[e], a = G.verts[E.a], b = G.verts[E.b], k = 0.24; h += '<line class="spot-e" data-key="se' + e + '" x1="' + ((a.x + (b.x - a.x) * k) * U).toFixed(1) + '" y1="' + ((a.y + (b.y - a.y) * k) * U).toFixed(1) + '" x2="' + ((b.x + (a.x - b.x) * k) * U).toFixed(1) + '" y2="' + ((b.y + (a.y - b.y) * k) * U).toFixed(1) + '"/>'; });
      h += '</g>';
    }
    if (sel.e != null && o.ghost) h += road(G, sel.e, o.mine || R.PALETTE[0], 'ghost', 'ghost');
    h += '<g class="blds">';
    Object.keys(g.b).forEach(function (v) {
      var bl = g.b[v], V = G.verts[v];
      if (sel.v === Number(v) && o.ghost === 'city') return;
      h += piece(bl.c ? 'city' : 'settlement', col(bl.p), V.x * U, V.y * U, '', 'b' + v + (bl.c ? 'c' : 's'));
    });
    h += '</g>';
    if (hi.v) { h += '<g class="spots">'; hi.v.forEach(function (v) { if (sel.v === v) return; var V = G.verts[v]; h += '<circle class="spot-v' + (g.b[v] ? ' up' : '') + '" data-key="sv' + v + '" cx="' + (V.x * U).toFixed(1) + '" cy="' + (V.y * U).toFixed(1) + '" r="' + (g.b[v] ? 30 : 17) + '"/>'; }); h += '</g>'; }
    if (sel.v != null && o.ghost) { var SV = G.verts[sel.v]; h += '<circle class="ring" cx="' + (SV.x * U).toFixed(1) + '" cy="' + (SV.y * U).toFixed(1) + '" r="34"/>' + piece(o.ghost, o.mine || R.PALETTE[0], SV.x * U, SV.y * U, 'ghost', 'ghost'); }
    // The robber stands beside the number he is blocking.
    var rh = G.hexes[sel.h != null && o.ghost === 'robber' ? sel.h : g.board.robber];
    h += '<g class="robber' + (sel.h != null && o.ghost === 'robber' ? ' ghost' : '') + '" data-key="robber" style="transform:translate(' + (rh.x * U - 50).toFixed(1) + 'px,' + (rh.y * U + 18).toFixed(1) + 'px)">' + ROBBER + '</g>';
    return h + '</svg>';
  };
  // Where on the island a tap landed, in hex units: { x, y }.
  F.boardPoint = function (svg, clientX, clientY) {
    var m = svg.getScreenCTM();
    if (!m) return null;
    var pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    var q = pt.matrixTransform(m.inverse());
    return { x: q.x / U, y: q.y / U };
  };
  // The nearest tappable spot to a point: { v } | { e } | { h } | null.
  F.nearest = function (kind, hi, pt) {
    var G = R.geo(kind), best = null, bd = 1e9, d;
    function d2(a) { return (a.x - pt.x) * (a.x - pt.x) + (a.y - pt.y) * (a.y - pt.y); }
    (hi.v || []).forEach(function (v) { d = d2(G.verts[v]); if (d < bd) { bd = d; best = { v: v }; } });
    (hi.e || []).forEach(function (e) { d = d2(G.edges[e]); if (d < bd) { bd = d; best = { e: e }; } });
    (hi.h || []).forEach(function (k) { d = d2(G.hexes[k]) * 0.55; if (d < bd) { bd = d; best = { h: k }; } });
    return best && bd < (best.h != null ? 0.55 : 0.5) ? best : null;
  };
  // A piece on its own, for menus: 'road' | 'settlement' | 'city'.
  F.pieceIcon = function (what, c) {
    c = c || R.PALETTE[0];
    if (what === 'road') return '<svg class="pi" viewBox="-36 -36 72 72"><line x1="-22" y1="14" x2="22" y2="-14" stroke="#1b120a" stroke-width="19" stroke-linecap="round"/><line x1="-22" y1="14" x2="22" y2="-14" stroke="' + c.c1 + '" stroke-width="10.5" stroke-linecap="round"/></svg>';
    return '<svg class="pi" viewBox="-36 -36 72 72">' + piece(what, c, 0, what === 'city' ? 5 : 1, 'still') + '</svg>';
  };
  // Two dice faces.
  F.die = function (n, cls) {
    var spots = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[n] || [];
    var h = '<span class="die' + (cls ? ' ' + cls : '') + '">';
    for (var i = 0; i < 9; i++) h += '<i' + (spots.indexOf(i) >= 0 ? ' class="on"' : '') + '></i>';
    return h + '</span>';
  };

  // The game's mark: a little island hex with a settlement on it.
  F.logo = function () {
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5" fill="#efdcaa"/><polygon points="50,10 85,30 85,70 50,90 15,70 15,30" fill="#2a8fd0"/><polygon points="50,20 76,35 76,65 50,80 24,65 24,35" fill="#7fc04b" stroke="#efdcaa" stroke-width="4"/><polygon points="38,62 38,46 50,35 62,46 62,62" fill="#e63946" stroke="#1b120a" stroke-width="4" stroke-linejoin="round"/><path d="M38,46 L50,35 L62,46" fill="none" stroke="#8f1220" stroke-width="3.5" stroke-linejoin="round"/></svg>';
  };
})();
