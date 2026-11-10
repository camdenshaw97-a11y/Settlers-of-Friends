/*
 * The rules of the island that the server and both pages share: the shape of the map (hexes,
 * corners and edges), how an island is laid out, what things cost, where you may build, how the
 * robber, ports and the Longest Road work, and the player colours. Works in Node and in the browser.
 *
 * Words used everywhere: a "hex" is a land tile, a "vertex" is a corner where settlements and
 * cities go, an "edge" is a side where roads go. All three are plain numbers (indexes).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  var RES_NAME = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
  var TERRAIN = { forest: 'wood', hills: 'brick', pasture: 'sheep', fields: 'wheat', mountains: 'ore', desert: null };
  var TERRAIN_NAME = { forest: 'Forest', hills: 'Hills', pasture: 'Pasture', fields: 'Fields', mountains: 'Mountains', desert: 'Desert' };
  var COST = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { wheat: 2, ore: 3 },
    dev: { sheep: 1, wheat: 1, ore: 1 }
  };
  var BUILD_NAME = { road: 'Road', settlement: 'Settlement', city: 'City', dev: 'Development card' };
  var PIECES = { road: 15, settlement: 5, city: 4 };
  // How many of the 36 dice combinations make each number: the dots under a number token.
  var PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
  var DEV = {
    knight: { name: 'Knight', about: 'Move the robber and steal a card. Three or more can win you the Largest Army.' },
    road: { name: 'Road Building', about: 'Place two roads for free.' },
    plenty: { name: 'Year of Plenty', about: 'Take any two resources from the bank.' },
    mono: { name: 'Monopoly', about: 'Name a resource. Every other player hands you all of theirs.' },
    vp: { name: 'Victory Point', about: 'Worth one point. Kept secret until it wins you the game.' }
  };
  var LONGEST_MIN = 5, ARMY_MIN = 3, HAND_LIMIT = 7;

  var BOARDS = {
    classic: {
      name: 'The Island', rows: [3, 4, 5, 4, 3],
      terrain: { forest: 4, pasture: 4, fields: 4, hills: 3, mountains: 3, desert: 1 },
      numbers: [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
      ports: ['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'],
      bank: 19, dev: { knight: 14, vp: 5, road: 2, plenty: 2, mono: 2 }
    },
    large: {
      name: 'The Big Island', rows: [3, 4, 5, 6, 5, 4, 3],
      terrain: { forest: 6, pasture: 6, fields: 6, hills: 5, mountains: 5, desert: 2 },
      numbers: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12],
      ports: ['any', 'any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'sheep', 'wheat', 'ore'],
      bank: 24, dev: { knight: 20, vp: 5, road: 3, plenty: 3, mono: 3 }
    }
  };
  function kindFor(players) { return players > 4 ? 'large' : 'classic'; }

  /* ------------------------------------------------------------ the shape of the map */

  var geoCache = {};
  // Hexes are pointy-topped with a corner-to-centre distance of 1, laid out in rows.
  function geo(kind) {
    if (geoCache[kind]) return geoCache[kind];
    var rows = BOARDS[kind].rows, S3 = Math.sqrt(3);
    var hexes = [], verts = [], edges = [], vkey = {}, ekey = {};
    function vid(x, y) {
      var k = Math.round(x * 1000) + ',' + Math.round(y * 1000);
      if (vkey[k] == null) { vkey[k] = verts.length; verts.push({ x: x, y: y, h: [], e: [], n: [] }); }
      return vkey[k];
    }
    rows.forEach(function (n, i) {
      for (var j = 0; j < n; j++) {
        var cx = (j - (n - 1) / 2) * S3, cy = (i - (rows.length - 1) / 2) * 1.5;
        var h = { x: cx, y: cy, v: [], e: [], n: [] };
        for (var k = 0; k < 6; k++) { var a = (-90 + 60 * k) * Math.PI / 180; h.v.push(vid(cx + Math.cos(a), cy + Math.sin(a))); }
        hexes.push(h);
      }
    });
    hexes.forEach(function (h, hi) {
      for (var k = 0; k < 6; k++) {
        var a = h.v[k], b = h.v[(k + 1) % 6], key = a < b ? a + '-' + b : b + '-' + a;
        if (ekey[key] == null) {
          ekey[key] = edges.length;
          edges.push({ a: Math.min(a, b), b: Math.max(a, b), x: (verts[a].x + verts[b].x) / 2, y: (verts[a].y + verts[b].y) / 2, h: [] });
          verts[a].e.push(ekey[key]); verts[b].e.push(ekey[key]);
          verts[a].n.push(b); verts[b].n.push(a);
        }
        edges[ekey[key]].h.push(hi); h.e.push(ekey[key]);
      }
      h.v.forEach(function (v) { verts[v].h.push(hi); });
    });
    edges.forEach(function (e) { if (e.h.length === 2) { hexes[e.h[0]].n.push(e.h[1]); hexes[e.h[1]].n.push(e.h[0]); } });

    // Walk the coastline once round, so ports can be spaced evenly along it.
    var isCoast = {}, coastN = 0;
    edges.forEach(function (e, i) { if (e.h.length === 1) { isCoast[i] = true; coastN++; } });
    var start = -1, bestA = 9;
    edges.forEach(function (e, i) { if (isCoast[i]) { var an = Math.abs(Math.atan2(e.y, e.x) + Math.PI / 2); if (an < bestA) { bestA = an; start = i; } } });
    var coast = [start], cur = start, at = verts[edges[start].a].x > verts[edges[start].b].x ? edges[start].a : edges[start].b;
    while (coast.length < coastN) {
      var next = -1;
      for (var q = 0; q < verts[at].e.length; q++) { var ce = verts[at].e[q]; if (isCoast[ce] && ce !== cur) { next = ce; break; } }
      if (next < 0 || next === start) break;
      coast.push(next); at = edges[next].a === at ? edges[next].b : edges[next].a; cur = next;
    }
    var P = BOARDS[kind].ports.length, slots = [], vport = {};
    for (var s = 0; s < P; s++) {
      var ei = coast[Math.floor(s * coast.length / P + 0.5) % coast.length], e = edges[ei], hx = hexes[e.h[0]];
      var dx = e.x - hx.x, dy = e.y - hx.y, len = Math.sqrt(dx * dx + dy * dy);
      slots.push({ e: ei, a: e.a, b: e.b, x: e.x + dx / len * 0.62, y: e.y + dy / len * 0.62 });
      vport[e.a] = s; vport[e.b] = s;
    }
    var minX = 9, maxX = -9, minY = 9, maxY = -9;
    verts.forEach(function (v) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });
    return (geoCache[kind] = { kind: kind, hexes: hexes, verts: verts, edges: edges, coast: coast, slots: slots, vport: vport, box: { x0: minX, x1: maxX, y0: minY, y1: maxY } });
  }

  /* ------------------------------------------------------------ laying out an island */

  function shuffled(a, rand) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function seeded(seed) {
    var s = seed >>> 0;
    return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function deal(kind, rand) {
    var B = BOARDS[kind], bag = [];
    Object.keys(B.terrain).forEach(function (t) { for (var i = 0; i < B.terrain[t]; i++) bag.push(t); });
    var terr = shuffled(bag, rand), nums = shuffled(B.numbers, rand), k = 0;
    return terr.map(function (t) { return { t: t, n: t === 'desert' ? 0 : nums[k++] }; });
  }
  // The two things a fair island never has: two red numbers (6 or 8) touching, or twin numbers touching.
  function fair(G, hexes) {
    for (var i = 0; i < hexes.length; i++) {
      var h = hexes[i];
      for (var q = 0; q < G.hexes[i].n.length; q++) {
        var o = hexes[G.hexes[i].n[q]];
        if (h.n && o.n === h.n) return false;
        if ((h.n === 6 || h.n === 8) && (o.n === 6 || o.n === 8)) return false;
      }
    }
    return true;
  }
  // Swap number tokens around until no red numbers or twins touch.
  function mend(G, hexes, rand) {
    function bad(i) {
      var h = hexes[i];
      if (!h.n) return false;
      for (var q = 0; q < G.hexes[i].n.length; q++) {
        var o = hexes[G.hexes[i].n[q]];
        if (o.n === h.n || ((h.n === 6 || h.n === 8) && (o.n === 6 || o.n === 8))) return true;
      }
      return false;
    }
    for (var step = 0; step < 300; step++) {
      var wrong = [];
      for (var i = 0; i < hexes.length; i++) if (bad(i)) wrong.push(i);
      if (!wrong.length) break;
      var a = wrong[Math.floor(rand() * wrong.length)], b = Math.floor(rand() * hexes.length);
      if (!hexes[b].n || b === a) continue;
      var t = hexes[a].n; hexes[a].n = hexes[b].n; hexes[b].n = t;
    }
    return hexes;
  }
  // How lopsided an island is (lower is better): clumps of one terrain, a 2 beside a 12, a resource
  // stuck with poor numbers or hogging the red ones.
  function lopsided(G, hexes) {
    var pips = {}, count = {}, reds = {}, score = 0;
    for (var i = 0; i < hexes.length; i++) {
      var h = hexes[i], same = 0;
      for (var q = 0; q < G.hexes[i].n.length; q++) {
        var o = hexes[G.hexes[i].n[q]];
        if ((h.n === 2 || h.n === 12) && (o.n === 2 || o.n === 12)) score += 1;
        if (o.t === h.t) same++;
      }
      score += same * same;
      var r = TERRAIN[h.t];
      if (r) { pips[r] = (pips[r] || 0) + PIPS[h.n]; count[r] = (count[r] || 0) + 1; if (h.n === 6 || h.n === 8) reds[r] = (reds[r] || 0) + 1; }
    }
    for (var k = 0; k < RES.length; k++) {
      var avg = pips[RES[k]] / count[RES[k]];
      score += Math.abs(avg - 3.2) * 4 + Math.max(0, (reds[RES[k]] || 0) - 2) * 6 + ((reds[RES[k]] || 0) ? 0 : 2);
    }
    return score;
  }
  // mode: 'starter' (the same fair island every time), 'balanced' (a new fair island), 'random' (anything goes).
  function makeBoard(kind, mode, rand) {
    var G = geo(kind), B = BOARDS[kind], hexes = null, ports, best = Infinity;
    if (mode === 'starter') rand = seeded(kind === 'large' ? 60606 : 31337);
    if (mode === 'random') hexes = deal(kind, rand);
    else {
      // Deal a few hundred islands and keep the most even one.
      for (var tries = 0, kept = 0; tries < 2000 && kept < 120; tries++) {
        var d = mend(G, deal(kind, rand), rand);
        if (!fair(G, d)) continue;
        kept++;
        var sc = lopsided(G, d);
        if (sc < best) { best = sc; hexes = d; }
      }
      if (!hexes) hexes = deal(kind, rand);
    }
    ports = shuffled(B.ports, rand);
    if (mode !== 'random') {
      // Keep twin two-for-one ports from sitting side by side.
      for (var t = 0; t < 200; t++) {
        var ok = true;
        for (var i = 0; i < ports.length; i++) if (ports[i] !== 'any' && ports[(i + 1) % ports.length] === ports[i]) ok = false;
        if (ok) break;
        ports = shuffled(B.ports, rand);
      }
    }
    var robber = -1;
    hexes.forEach(function (h, i) { if (h.t === 'desert' && robber < 0) robber = i; });
    return { kind: kind, hexes: hexes, ports: ports, robber: robber };
  }

  /* ------------------------------------------------------------ hands and costs */

  function empty() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }
  function total(h) { var n = 0; for (var i = 0; i < RES.length; i++) n += (h && h[RES[i]]) || 0; return n; }
  function has(hand, cost) { for (var i = 0; i < RES.length; i++) if (((cost && cost[RES[i]]) || 0) > ((hand && hand[RES[i]]) || 0)) return false; return true; }
  function missing(hand, cost) { var out = empty(); for (var i = 0; i < RES.length; i++) out[RES[i]] = Math.max(0, (cost[RES[i]] || 0) - ((hand && hand[RES[i]]) || 0)); return out; }
  function add(hand, x, sign) { for (var i = 0; i < RES.length; i++) hand[RES[i]] = (hand[RES[i]] || 0) + (sign || 1) * ((x && x[RES[i]]) || 0); return hand; }
  function clean(x, max) {
    var out = empty();
    if (!x || typeof x !== 'object') return out;
    for (var i = 0; i < RES.length; i++) { var n = Math.floor(Number(x[RES[i]])); out[RES[i]] = n > 0 ? Math.min(n, max || 20) : 0; }
    return out;
  }
  function overlap(a, b) { for (var i = 0; i < RES.length; i++) if (a[RES[i]] && b[RES[i]]) return true; return false; }
  // "2 wood + 1 ore"
  function words(x) {
    var parts = [];
    for (var i = 0; i < RES.length; i++) if (x && x[RES[i]]) parts.push(x[RES[i]] + ' ' + RES_NAME[RES[i]].toLowerCase());
    return parts.length ? parts.join(' + ') : 'nothing';
  }

  /* ------------------------------------------------------------ where you may build */
  // g carries: board { kind, hexes, ports, robber }, b { vertex: { p: playerId, c: 1 for a city } }, r { edge: playerId }

  function touchesRoad(G, g, pid, v) { var es = G.verts[v].e; for (var i = 0; i < es.length; i++) if (g.r[es[i]] === pid) return true; return false; }
  function canSettle(g, pid, v, setup) {
    var G = geo(g.board.kind), V = G.verts[v];
    if (!V || g.b[v]) return false;
    for (var i = 0; i < V.n.length; i++) if (g.b[V.n[i]]) return false;
    return setup ? true : touchesRoad(G, g, pid, v);
  }
  // A road must touch one of your own roads or buildings. Somebody else's building blocks the way through.
  function canRoad(g, pid, e, fromVertex) {
    var G = geo(g.board.kind), E = G.edges[e];
    if (!E || g.r[e] != null) return false;
    if (fromVertex != null) return E.a === fromVertex || E.b === fromVertex;
    var ends = [E.a, E.b];
    for (var i = 0; i < 2; i++) {
      var bl = g.b[ends[i]];
      if (bl) { if (bl.p === pid) return true; continue; }
      if (touchesRoad(G, g, pid, ends[i])) return true;
    }
    return false;
  }
  function canCity(g, pid, v) { var bl = g.b[v]; return !!(bl && bl.p === pid && !bl.c); }
  function count(g, pid) {
    var out = { road: 0, settlement: 0, city: 0 }, k;
    for (k in g.r) if (g.r[k] === pid) out.road++;
    for (k in g.b) if (g.b[k].p === pid) out[g.b[k].c ? 'city' : 'settlement']++;
    return out;
  }
  function left(g, pid) { var c = count(g, pid); return { road: PIECES.road - c.road, settlement: PIECES.settlement - c.settlement, city: PIECES.city - c.city }; }
  function legalSettles(g, pid, setup) { var G = geo(g.board.kind), out = []; for (var v = 0; v < G.verts.length; v++) if (canSettle(g, pid, v, setup)) out.push(v); return out; }
  function legalRoads(g, pid, fromVertex) { var G = geo(g.board.kind), out = []; for (var e = 0; e < G.edges.length; e++) if (canRoad(g, pid, e, fromVertex)) out.push(e); return out; }
  function legalCities(g, pid) { var out = []; for (var v in g.b) if (canCity(g, pid, Number(v))) out.push(Number(v)); return out; }

  // Public points: a settlement is 1, a city 2, Longest Road and Largest Army 2 each.
  function points(g, pid) {
    var c = count(g, pid), n = c.settlement + 2 * c.city;
    if (g.longest && g.longest.pid === pid) n += 2;
    if (g.army && g.army.pid === pid) n += 2;
    return n;
  }

  // The longest unbroken trail of one player's roads. Another player's building cuts a trail in two.
  function roadLength(g, pid) {
    var G = geo(g.board.kind), mine = [], best = 0, used = {}, k;
    for (k in g.r) if (g.r[k] === pid) mine.push(Number(k));
    function walk(v, len) {
      if (len > best) best = len;
      var bl = g.b[v];
      if (bl && bl.p !== pid) return;
      var es = G.verts[v].e;
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (g.r[e] !== pid || used[e]) continue;
        used[e] = true;
        walk(G.edges[e].a === v ? G.edges[e].b : G.edges[e].a, len + 1);
        used[e] = false;
      }
    }
    for (var i = 0; i < mine.length; i++) {
      var E = G.edges[mine[i]];
      used = {}; used[mine[i]] = true; walk(E.a, 1);
      used = {}; used[mine[i]] = true; walk(E.b, 1);
    }
    return best;
  }

  /* ------------------------------------------------------------ ports, the robber, the harvest */

  // What you pay the bank for one card: 4 of a kind, 3 with any port, 2 with that resource's port.
  function rate(g, pid, res) {
    var G = geo(g.board.kind), best = 4;
    for (var v in g.b) {
      if (g.b[v].p !== pid) continue;
      var s = G.vport[v];
      if (s == null) continue;
      var t = g.board.ports[s];
      if (t === res) return 2;
      if (t === 'any') best = 3;
    }
    return best;
  }
  function portsOf(g, pid) {
    var G = geo(g.board.kind), out = {};
    for (var v in g.b) if (g.b[v].p === pid && G.vport[v] != null) out[g.board.ports[G.vport[v]]] = true;
    return Object.keys(out);
  }
  function playersOn(g, hex) {
    var G = geo(g.board.kind), out = [], vs = G.hexes[hex].v;
    for (var i = 0; i < 6; i++) { var bl = g.b[vs[i]]; if (bl && out.indexOf(bl.p) < 0) out.push(bl.p); }
    return out;
  }
  // Where the robber may go. With the friendly robber on, he leaves anyone with 2 points or fewer alone.
  function robberHexes(g, pid, friendly) {
    var G = geo(g.board.kind), all = [], kind = [];
    for (var h = 0; h < G.hexes.length; h++) {
      if (h === g.board.robber) continue;
      all.push(h);
      var on = playersOn(g, h), ok = true;
      for (var i = 0; i < on.length; i++) if (on[i] !== pid && points(g, on[i]) <= 2) ok = false;
      if (ok) kind.push(h);
    }
    return friendly && kind.length ? kind : all;
  }
  // What a dice roll would pay each player, before the bank runs short: { playerId: { wood: 2 } }
  function harvest(g, roll) {
    var G = geo(g.board.kind), out = {}, hexes = [];
    g.board.hexes.forEach(function (h, i) {
      if (h.n !== roll || i === g.board.robber) return;
      var res = TERRAIN[h.t], vs = G.hexes[i].v, any = false;
      for (var k = 0; k < 6; k++) {
        var bl = g.b[vs[k]];
        if (!bl) continue;
        any = true;
        (out[bl.p] || (out[bl.p] = empty()))[res] += bl.c ? 2 : 1;
      }
      if (any) hexes.push(i);
    });
    return { gains: out, hexes: hexes };
  }
  // The hexes a vertex touches, as resources and numbers: used for hints and for bots.
  function yieldAt(g, v) {
    var G = geo(g.board.kind), pips = 0, res = {};
    G.verts[v].h.forEach(function (h) { var x = g.board.hexes[h]; if (x.n) { pips += PIPS[x.n]; res[TERRAIN[x.t]] = (res[TERRAIN[x.t]] || 0) + PIPS[x.n]; } });
    return { pips: pips, res: res };
  }

  // Eight player colours that stand out against every terrain. c1 is the piece, c2 its shadow, ink the text on it.
  var PALETTE = [
    { name: 'Red', c1: '#e63946', c2: '#8f1220', ink: '#fff' },
    { name: 'Blue', c1: '#2f7df6', c2: '#123f9c', ink: '#fff' },
    { name: 'White', c1: '#f7f3e8', c2: '#a59d86', ink: '#2d2014' },
    { name: 'Orange', c1: '#ff8a1f', c2: '#a34a00', ink: '#fff' },
    { name: 'Purple', c1: '#9b51e0', c2: '#4f1f8a', ink: '#fff' },
    { name: 'Pink', c1: '#ff5fa8', c2: '#a81d62', ink: '#fff' },
    { name: 'Teal', c1: '#14c2b2', c2: '#066b62', ink: '#fff' },
    { name: 'Black', c1: '#3a3a46', c2: '#0e0e14', ink: '#fff' }
  ];
  var FACES = ['🧭', '⚓', '🏰', '🐑', '🌲', '⛏️', '🌾', '🧱', '🦜', '🗺️', '🛶', '👑'];

  return {
    RES: RES, RES_NAME: RES_NAME, TERRAIN: TERRAIN, TERRAIN_NAME: TERRAIN_NAME, COST: COST, BUILD_NAME: BUILD_NAME, PIECES: PIECES, PIPS: PIPS, DEV: DEV,
    LONGEST_MIN: LONGEST_MIN, ARMY_MIN: ARMY_MIN, HAND_LIMIT: HAND_LIMIT, BOARDS: BOARDS, kindFor: kindFor,
    geo: geo, makeBoard: makeBoard, fair: fair, lopsided: lopsided, shuffled: shuffled, seeded: seeded,
    empty: empty, total: total, has: has, missing: missing, add: add, clean: clean, overlap: overlap, words: words,
    canSettle: canSettle, canRoad: canRoad, canCity: canCity, count: count, left: left,
    legalSettles: legalSettles, legalRoads: legalRoads, legalCities: legalCities,
    points: points, roadLength: roadLength, rate: rate, portsOf: portsOf, playersOn: playersOn, robberHexes: robberHexes, harvest: harvest, yieldAt: yieldAt,
    PALETTE: PALETTE, FACES: FACES
  };
});
