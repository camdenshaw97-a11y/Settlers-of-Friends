'use strict';
/*
 * Settlers of Friends — the server.
 * One process holds every room in memory. A phone (or the TV page) creates a room, phones join it
 * with a 4-letter code, and the server is the single source of truth: it deals the island, rolls
 * the dice, hands out the harvest, keeps every hand secret, referees every trade and pushes a
 * fresh snapshot to every screen after each change.
 *
 * Built the same way as Friend Feud, Jeopardy, Wheel, Monopoly, Clue, Legendary Friends and
 * Bingo: the same join flow, reconnect and restart-survival tricks, bots, private chat, save and
 * resume. Two things are new here. The TV is optional: every phone carries the whole board, so a
 * phone can start a room and the game plays with no big screen at all. And because there may be
 * no TV to hold the room's sealed backup, every phone holds one too.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const R = require('./rules');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const PAGE_FILES = new Set(['index.html', 'tv.html', 'common.js', 'rules.js', 'style.css', 'germania.woff2', 'rubik-400.woff2', 'rubik-600.woff2', 'rubik-800.woff2']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json'
};

// A fingerprint of the pages as they are right now, so a screen left open across an update reloads itself.
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'tv.html', 'common.js', 'rules.js', 'style.css']) {
    try { h.update(fs.readFileSync(path.join(PUB, f))); } catch (e) { /* missing file: nothing to add */ }
  }
  return h.digest('hex').slice(0, 12);
})();

/* ---------------------------------------------------------------- settings */

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const COLORS = R.PALETTE.length;
const BOT_NAMES = ['SKIPPER', 'BARNACLE', 'COMPASS', 'ANCHOR', 'GALLEY', 'KEEL'];
const BOT_FACES = ['🤖', '👾', '🦾', '🛸', '📟', '🧠'];
const TARGET_CHOICES = [8, 10, 12];
const BOARD_CHOICES = ['starter', 'balanced', 'random'];
const TRADE_CHOICES = ['official', 'open'];
const DICE_CHOICES = ['random', 'balanced'];
const TURN_CHOICES = [0, 60, 90, 120, 180];     // seconds for a whole turn (0 = no clock)
const DEFAULT_SETTINGS = { target: 10, board: 'balanced', trading: 'official', friendly: false, dice: 'random', turn: 0, special: true };
const PHOTO_MAX = 60000;

const SPEED = Number(process.env.SPEED_UP) || 1;   // tests run the clocks faster
const ROLLOFF_MS = 5200;                   // the roll for who goes first plays out on screen
const BOT_MS = 1100;                       // a bot thinks about this long before each move
const BOT_ANSWER_MS = 1400;                // ...and this long before answering a trade
const BOT_OFFER_MS = 9000;                 // a bot leaves its own offer on the table this long
const AWAY_MS = Number(process.env.AWAY_MS) || 25000;   // a phone gone this long is played for
const SPECIAL_SECS = 30;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const BOOT = Date.now();
const RESTORE_WINDOW_MS = Number(process.env.RESTORE_WINDOW_MS) || 10 * 60 * 1000;
const RESTORE_GRACE_MS = 5000;
const SEAT_HOLD_MS = Number(process.env.SEAT_HOLD_MS) || 30000;
const STRAGGLER_MS = Number(process.env.STRAGGLER_MS) || 3 * 60 * 1000;
const BACKUP_V = 1;
const BACKUP_DELAY_MS = 350;
const BACKUP_MAX = 380 * 1024;
const BACKUP_KEY = (() => {
  let seed = process.env.BACKUP_KEY || process.env.RENDER_SERVICE_ID;
  if (!seed) {
    const file = path.join(__dirname, '.backup-key');
    try { seed = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* first run */ }
    if (!seed) {
      seed = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(file, seed + '\n', { mode: 0o600 }); } catch (e) { /* read-only disk */ }
    }
  }
  return crypto.createHash('sha256').update('settlers-of-friends room backup|' + seed).digest();
})();

const rooms = new Map();

/* ------------------------------------------------------------------ http */

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (p === '/version') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(BUILD); }
  if (p === '/uptime') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('started ' + new Date(BOOT).toISOString() + ' · up ' + Math.round((Date.now() - BOOT) / 1000) + 's');
  }
  if (p === '/qr.svg') {
    const text = (u.searchParams.get('u') || '').slice(0, 300);
    return QRCode.toString(text || ' ', { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }, (err, svg) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
      res.end(svg);
    });
  }
  const ph = /^\/photo\/([A-Z]{4})\/([\w-]{1,20})$/.exec(p);
  if (ph) {
    const room = rooms.get(ph[1]), pl = room && room.players.get(ph[2]);
    const m = pl && pl.photo && /^data:(image\/[a-z]+);base64,(.*)$/.exec(pl.photo);
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': m[1], 'cache-control': 'public, max-age=86400' });
    return res.end(Buffer.from(m[2], 'base64'));
  }
  if (p === '/') p = '/index.html';
  if (p === '/tv') p = '/tv.html';
  const rel = p.replace(/^\/+/, '');
  if (!PAGE_FILES.has(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const file = path.join(PUB, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    if (ext === '.html') data = Buffer.from(String(data).replace('<html lang="en">', '<html lang="en" data-build="' + BUILD + '">'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache' });
    res.end(data);
  });
});

/* --------------------------------------------------------------- helpers */

const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const pick = a => a[crypto.randomInt(a.length)];
const chance = p => crypto.randomInt(1000) < p * 1000;
const rand = () => crypto.randomInt(1 << 30) / (1 << 30);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function makeCode() {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function cleanSettings(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (!s || typeof s !== 'object') return out;
  if (TARGET_CHOICES.includes(s.target)) out.target = s.target;
  if (BOARD_CHOICES.includes(s.board)) out.board = s.board;
  if (TRADE_CHOICES.includes(s.trading)) out.trading = s.trading;
  if (DICE_CHOICES.includes(s.dice)) out.dice = s.dice;
  if (TURN_CHOICES.includes(s.turn)) out.turn = s.turn;
  if (typeof s.friendly === 'boolean') out.friendly = s.friendly;
  if (typeof s.special === 'boolean') out.special = s.special;
  return out;
}
// A face is one emoji: a single grapheme that is a pictograph (flags and skin tones welcome).
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
function cleanFace(s) {
  s = String(s == null ? '' : s).trim();
  if (!s || s.length > 24) return null;
  const parts = segmenter ? [...segmenter.segment(s)].map(x => x.segment) : [s];
  if (parts.length !== 1) return null;
  const g = parts[0];
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)) return null;
  if (/^[0-9#*]/.test(g) && g.length < 3) return null;
  return g;
}
// A photo arrives as a data URL. Keep it small and only allow plain image types.
function cleanPhoto(s) {
  s = String(s == null ? '' : s);
  if (!s || s.length > PHOTO_MAX) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  const ok = m[1] === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 : m[1] === 'png' ? bytes[0] === 0x89 && bytes[1] === 0x50 : bytes.slice(8, 12).toString() === 'WEBP';
  return ok ? s : null;
}
function setPhoto(p, s) { p.photo = s || null; p.photoV = s ? crypto.createHash('sha1').update(s).digest('hex').slice(0, 10) : null; }

/* ----------------------------------------------------------------- rooms */

function newRoom() {
  const room = {
    code: makeCode(), adminToken: rid(), touched: Date.now(), displays: new Set(), players: new Map(),
    order: [], settings: Object.assign({}, DEFAULT_SETTINGS), chats: {}, game: null, fx: [], fxSeq: 0, timer: null, botTimer: null
  };
  rooms.set(room.code, room);
  return room;
}
// Something for the screens to animate. `only` keeps it to those players' phones (a stolen card, say).
function fx(room, type, data, only) {
  room.fx.push(Object.assign({ seq: ++room.fxSeq, type }, data || {}, only ? { only } : null));
  if (room.fx.length > 30) room.fx.shift();
}
const pname = (room, id) => { const p = room.players.get(id); return p ? p.name : '?'; };
const seats = room => room.order.filter(id => room.players.has(id));
const isBot = (room, id) => { const p = room.players.get(id); return !!(p && p.bot); };
const captainId = room => {
  const ids = seats(room).filter(id => !room.players.get(id).bot && !(room.game && room.game.players[id] && room.game.players[id].auto));
  return ids.find(id => room.players.get(id).connected) || ids[0] || null;
};
const colorTaken = (room, n, except) => [...room.players.values()].some(x => x !== except && room.order.includes(x.id) && x.color === n);
function freeColor(room) {
  for (let n = 0; n < COLORS; n++) if (!colorTaken(room, n, null)) return n;
  return room.players.size % COLORS;
}
const faceTaken = (room, f, except) => [...room.players.values()].some(x => x !== except && room.order.includes(x.id) && x.face === f && !x.photo);
function freeFace(room, list) { return (list || R.FACES).find(f => !faceTaken(room, f, null)) || pick(list || R.FACES); }
function newPlayer(room, name, m) {
  const want = cleanFace(m && m.face), wc = m ? Number(m.color) : NaN;
  const p = {
    id: rid(6), token: rid(), name,
    color: Number.isInteger(wc) && wc >= 0 && wc < COLORS && !colorTaken(room, wc, null) ? wc : freeColor(room),
    face: want && !faceTaken(room, want, null) ? want : freeFace(room), connected: true, ws: null, hold: 0, goneAt: 0
  };
  setPhoto(p, cleanPhoto(m && m.photo));
  room.players.set(p.id, p);
  room.order.push(p.id);
  return p;
}

/* ---------------------------------------------------- surviving a restart */

function packRoom(room, lean, kind) {
  const data = {
    v: BACKUP_V, at: Date.now(), kind: kind || 'backup', code: room.code, adminToken: room.adminToken,
    players: [...room.players.values()].map(p => ({ id: p.id, token: p.token, name: p.name, color: p.color, face: p.face, photo: lean ? null : p.photo || null, bot: !!p.bot })),
    order: room.order, settings: room.settings, chats: lean ? {} : room.chats, game: room.game, fxSeq: room.fxSeq
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', BACKUP_KEY, iv);
  const body = Buffer.concat([c.update(zlib.deflateRawSync(JSON.stringify(data))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function unpackRoom(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 30) throw new Error('too short');
  const d = crypto.createDecipheriv('aes-256-gcm', BACKUP_KEY, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  return JSON.parse(zlib.inflateRawSync(body, { maxOutputLength: 16 * 1024 * 1024 }));
}
// The sealed copy goes to the TV that started the room and to every phone at the table. Nobody
// can read it (it is locked with a key only this server has); any one of them can hand it back.
function sendBackup(room) {
  if (rooms.get(room.code) !== room) return;
  const tvs = [...room.displays].filter(ws => ws.admin && ws.readyState === 1);
  const phones = [...room.players.values()].filter(p => !p.bot && p.ws && p.ws.readyState === 1).map(p => p.ws);
  if (!tvs.length && !phones.length) return;
  let blob;
  try { blob = packRoom(room, false); if (blob.length > BACKUP_MAX) blob = packRoom(room, true); } catch (e) { return console.error('backup error', e); }
  if (blob.length > BACKUP_MAX) return;
  const msg = JSON.stringify({ t: 'backup', code: room.code, blob, info: saveInfo(room) });
  for (const ws of tvs.concat(phones)) ws.send(msg);
}
function queueBackup(room) {
  if (room.backupTimer) return;
  room.backupTimer = setTimeout(() => { room.backupTimer = null; sendBackup(room); }, BACKUP_DELAY_MS);
}
// What a saved game looks like in a list.
function saveInfo(room) {
  const g = room.game;
  return {
    at: Date.now(), players: seats(room).map(id => pname(room, id)), phase: g ? g.phase : 'lobby', turns: g ? g.turnCount : 0, target: g ? g.target : room.settings.target,
    lead: g ? Math.max(0, ...g.order.map(id => R.points(g, id))) : 0
  };
}
function hydrateRoom(d, code, opts) {
  const room = {
    code, adminToken: opts.adminToken, touched: Date.now(), displays: new Set(), players: new Map(), order: d.order || [],
    settings: cleanSettings(d.settings), chats: d.chats && typeof d.chats === 'object' ? d.chats : {}, game: d.game, fx: [], fxSeq: (d.fxSeq || 0) + 50, timer: null, botTimer: null
  };
  const hold = Date.now() + SEAT_HOLD_MS;
  for (const p of d.players) {
    const base = { id: p.id, name: p.name, color: p.color, face: p.face, ws: null };
    if (p.bot) room.players.set(p.id, Object.assign(base, { token: p.token, bot: true, connected: true, hold: 0, goneAt: 0 }));
    else room.players.set(p.id, Object.assign(base, { token: opts.freshTokens ? rid() : p.token, connected: false, hold: opts.freshTokens ? 0 : hold, goneAt: Date.now(), waitingFor: true }));
    setPhoto(room.players.get(p.id), cleanPhoto(p.photo));
  }
  const g = room.game;
  if (g) {
    g.trades = [];
    for (const id of g.order) if (g.players[id]) g.players[id].bt = {};
    if (g.clock) {
      // The clock stood still while the server was away: give it back its time, plus a moment to reconnect.
      const used = Math.max(0, Math.min(Number(opts.idle) || 0, 10 * 60 * 1000));
      g.clock.at = Date.now() + Math.max(0, g.clock.at - d.at - used) + RESTORE_GRACE_MS;
      if (opts.freshTokens) g.clock.at = Date.now() + g.clock.len + 60000;
    }
    g.started = Date.now() - Math.max(0, d.at - g.started);
  }
  return room;
}
// A room the server forgot (it restarted) comes back with the same code. The TV that started it
// may hand it back, and so may any phone that was sitting at the table.
function restoreRoom(blob, code, token, idle) {
  let d;
  try { d = unpackRoom(blob); } catch (e) { return null; }
  if (!d || d.v !== BACKUP_V || d.code !== code || !token) return null;
  if (d.adminToken !== token && !d.players.some(p => !p.bot && p.token === token)) return null;
  if (!(Date.now() - d.at < ROOM_IDLE_MS) || rooms.has(code)) return null;
  const room = hydrateRoom(d, code, { adminToken: d.adminToken, idle });
  try { publicState(room); } catch (e) { console.error('restore error', e); return null; }
  rooms.set(code, room);
  armTimer(room); scheduleBots(room);
  room.tidyTimer = setTimeout(() => {
    room.tidyTimer = null;
    if (rooms.get(code) !== room || room.game) return;
    let gone = 0;
    for (const p of [...room.players.values()]) if (!p.connected && !p.bot) { room.players.delete(p.id); const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1); gone++; }
    if (gone) pushAll(room);
  }, STRAGGLER_MS);
  fx(room, 'restored');
  console.log('restored room ' + code + ' (' + room.players.size + ' players, ' + (room.game ? room.game.phase : 'lobby') + ')');
  return room;
}
// A saved game from another night comes back as a brand-new room. Everyone joins again with
// the same name and gets their seat back.
function loadRoom(blob) {
  let d;
  try { d = unpackRoom(blob); } catch (e) { return null; }
  if (!d || d.v !== BACKUP_V || !d.game || d.game.phase === 'gameOver') return null;
  const code = makeCode();
  const room = hydrateRoom(d, code, { adminToken: rid(), freshTokens: true });
  try { publicState(room); } catch (e) { console.error('load error', e); return null; }
  rooms.set(code, room);
  armTimer(room); scheduleBots(room);
  fx(room, 'loaded');
  console.log('loaded saved game as room ' + code);
  return room;
}

/* ------------------------------------------------------------ the clock */

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function setClock(room, what, ms, show) {
  ms = Math.round(ms / SPEED);
  room.game.clock = { what, at: Date.now() + ms, len: ms, show: !!show };
  armTimer(room);
}
function stopClock(room) { if (room.game) room.game.clock = null; clearTimer(room); }
function armTimer(room) {
  clearTimer(room);
  const g = room.game;
  if (!g || !g.clock) return;
  const c = g.clock;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.game !== g || g.clock !== c) return;
    g.clock = null;
    try { onClock(room, c.what); } catch (e) { console.error('clock error', e); }
    pushAll(room);
  }, Math.max(0, c.at - Date.now()));
}
function onClock(room, what) {
  if (what === 'rolloff') beginSetup(room);
  else if (what === 'turn') forceStep(room);
}
// The turn clock, if the table set one: it covers whatever the game is waiting on right now.
function turnClock(room, secs) {
  const g = room.game;
  if (g.turnSecs) setClock(room, 'turn', (secs || g.turnSecs) * 1000, true); else stopClock(room);
}

/* ------------------------------------------------------------ the game */

const P = (g, id) => g.players[id];
const total = (g, id) => R.total(P(g, id).res);
const vpCards = (g, id) => P(g, id).dev.filter(c => c.k === 'vp').length;
const score = (g, id) => R.points(g, id) + vpCards(g, id);
const active = g => g.turn ? g.turn.pid : null;

function log(room, text, kind, data) {
  const g = room.game;
  g.log.push(Object.assign({ n: ++g.logSeq, text, kind: kind || '' }, data || {}));
  if (g.log.length > 80) g.log.shift();
}
function err(p, msg) { if (p && p.ws) send(p.ws, { t: 'error', msg }); return false; }

// Who the game is waiting on right now.
function actors(g) {
  switch (g.phase) {
    case 'setup': return [g.setup.seq[g.setup.i]];
    case 'discard': return Object.keys(g.discard);
    case 'special': return [g.special.queue[g.special.i]];
    case 'roll': case 'main': case 'robber': case 'steal': case 'roads': return [g.turn.pid];
    default: return [];
  }
}

function startGame(room) {
  const ids = seats(room);
  if (ids.length < MIN_PLAYERS || ids.length > MAX_PLAYERS) return;
  const s = room.settings, kind = R.kindFor(ids.length), B = R.BOARDS[kind];
  const players = {};
  for (const id of ids) {
    players[id] = {
      res: R.empty(), dev: [], knights: 0, roadLen: 0, auto: false, bt: {},
      stats: { gained: 0, stole: 0, robbed: 0, discarded: 0, trades: 0, bank: 0, sevens: 0, blocked: 0, devs: 0, roads: 0 }
    };
  }
  const deck = [];
  for (const k of Object.keys(B.dev)) for (let i = 0; i < B.dev[k]; i++) deck.push(k);
  // Everyone rolls; the highest roll goes first and play runs round the table from there.
  const rolls = {};
  let tied = ids.slice(), first = null;
  for (let round = 0; round < 20 && !first; round++) {
    let best = 0;
    for (const id of tied) { const a = 1 + crypto.randomInt(6), b = 1 + crypto.randomInt(6); rolls[id] = [a, b]; best = Math.max(best, a + b); }
    tied = tied.filter(id => rolls[id][0] + rolls[id][1] === best);
    if (tied.length === 1) first = tied[0];
  }
  first = first || tied[0];
  const at = ids.indexOf(first), order = ids.slice(at).concat(ids.slice(0, at));
  const bank = {};
  for (const r of R.RES) bank[r] = B.bank;
  const hist = {};
  for (let n = 2; n <= 12; n++) hist[n] = 0;
  room.game = {
    phase: 'rolloff', started: Date.now(), played: 0, kind, board: R.makeBoard(kind, s.board, rand), b: {}, r: {},
    order, players, bank, deck: shuffle(deck), target: s.target, trading: s.trading, friendly: s.friendly, dice: s.dice, turnSecs: s.turn,
    specialOn: s.special && ids.length >= 5, rolloff: { rolls, first }, setup: null, turn: null, turnCount: 0, discard: null, steal: null, roads: null, special: null, ret: null,
    longest: null, army: null, trades: [], tradeSeq: 0, diceDeck: null, hist, log: [], logSeq: 0, clock: null, winner: null, awards: null
  };
  log(room, pname(room, first) + ' rolls highest and goes first.', 'turn');
  fx(room, 'start', { first });
  setClock(room, 'rolloff', ROLLOFF_MS);
}
// The opening: everyone places a settlement and a road, then again in reverse order.
function beginSetup(room) {
  const g = room.game;
  if (g.phase !== 'rolloff') return;
  g.setup = { seq: g.order.concat(g.order.slice().reverse()), i: 0, step: 'settle', v: null };
  g.phase = 'setup';
  fx(room, 'setup');
  turnClock(room);
}
function placeSetup(room, p, m) {
  const g = room.game, su = g.setup;
  if (g.phase !== 'setup' || su.seq[su.i] !== p.id) return;
  if (su.step === 'settle') {
    const v = Number(m.v);
    if (!R.canSettle(g, p.id, v, true)) return err(p, 'A settlement can’t go there: it must be two corners away from any other.');
    g.b[v] = { p: p.id, c: 0 };
    su.v = v; su.step = 'road';
    fx(room, 'build', { pid: p.id, what: 'settlement', at: v });
    if (su.i >= g.order.length) {
      // The second settlement pays one card for each hex it touches.
      const got = R.empty();
      for (const h of R.geo(g.kind).verts[v].h) { const res = R.TERRAIN[g.board.hexes[h].t]; if (res && g.bank[res] > 0) { got[res]++; g.bank[res]--; } }
      R.add(P(g, p.id).res, got);
      if (R.total(got)) { log(room, pname(room, p.id) + ' starts with ' + R.words(got) + '.', 'gain'); fx(room, 'gain', { gains: { [p.id]: got }, hexes: R.geo(g.kind).verts[v].h, setup: true }); }
    }
  } else {
    const e = Number(m.e);
    if (!R.canRoad(g, p.id, e, su.v)) return err(p, 'That road has to touch the settlement you just placed.');
    g.r[e] = p.id;
    fx(room, 'build', { pid: p.id, what: 'road', at: e });
    su.i++; su.step = 'settle'; su.v = null;
    if (su.i >= su.seq.length) { g.setup = null; updateLongest(room); log(room, 'The island is settled. Time to roll.', 'turn'); return startTurn(room, g.order[0]); }
  }
  turnClock(room);
}

function startTurn(room, pid) {
  const g = room.game;
  g.turnCount++;
  g.turn = { pid, n: g.turnCount, rolled: false, roll: null, devPlayed: false };
  g.phase = 'roll'; g.ret = null; g.discard = null; g.steal = null; g.roads = null; g.special = null;
  g.trades = [];
  P(g, pid).bt = {};
  fx(room, 'turn', { pid });
  turnClock(room);
  checkWin(room);
}
function nextTurn(room) {
  const g = room.game, i = g.order.indexOf(g.turn.pid);
  startTurn(room, g.order[(i + 1) % g.order.length]);
}
function rollDice(room, p) {
  const g = room.game;
  if (g.phase !== 'roll' || g.turn.pid !== p.id) return;
  let a, b;
  if (g.dice === 'balanced') {
    // A shuffled deck of all 36 rolls, so the numbers come up as often as they should. Reshuffled
    // with a few cards left, so nobody can count it down.
    if (!g.diceDeck || g.diceDeck.length <= 5) { g.diceDeck = []; for (let x = 1; x <= 6; x++) for (let y = 1; y <= 6; y++) g.diceDeck.push([x, y]); shuffle(g.diceDeck); }
    [a, b] = g.diceDeck.pop();
  } else { a = 1 + crypto.randomInt(6); b = 1 + crypto.randomInt(6); }
  applyRoll(room, a, b);
}
function applyRoll(room, a, b) {
  const g = room.game, pid = g.turn.pid, n = a + b;
  g.turn.rolled = true; g.turn.roll = [a, b];
  g.hist[n]++;
  fx(room, 'dice', { pid, a, b });
  if (n === 7) {
    P(g, pid).stats.sevens++;
    const need = {};
    for (const id of g.order) { const t = total(g, id); if (t > R.HAND_LIMIT) need[id] = Math.floor(t / 2); }
    log(room, pname(room, pid) + ' rolls a 7. The robber is loose.', 'seven');
    g.ret = 'main';
    if (Object.keys(need).length) { g.discard = need; g.phase = 'discard'; fx(room, 'discardCall', { pids: Object.keys(need) }); }
    else g.phase = 'robber';
    return;
  }
  const { gains, hexes } = R.harvest(g, n), short = [];
  // If the bank can't pay everyone a resource, nobody gets it (unless only one player is owed).
  for (const res of R.RES) {
    const owed = g.order.filter(id => gains[id] && gains[id][res]);
    const sum = owed.reduce((s, id) => s + gains[id][res], 0);
    if (sum <= g.bank[res]) continue;
    short.push(res);
    if (owed.length === 1) gains[owed[0]][res] = g.bank[res]; else for (const id of owed) gains[id][res] = 0;
  }
  const lines = [];
  for (const id of g.order) {
    const got = gains[id];
    if (!got || !R.total(got)) { delete gains[id]; continue; }
    R.add(P(g, id).res, got); R.add(g.bank, got, -1);
    P(g, id).stats.gained += R.total(got);
    lines.push(pname(room, id) + ' ' + R.words(got));
  }
  // What the robber kept out of everyone's hands this roll.
  const rh = g.board.hexes[g.board.robber];
  let blocked = false;
  if (rh.n === n) for (const v of R.geo(g.kind).hexes[g.board.robber].v) { const bl = g.b[v]; if (bl) { P(g, bl.p).stats.blocked += bl.c ? 2 : 1; blocked = true; } }
  log(room, pname(room, pid) + ' rolls ' + n + '. ' + (lines.length ? lines.join(', ') + '.' : 'Nobody collects.') + (short.length ? ' The bank ran short of ' + short.map(r => R.RES_NAME[r].toLowerCase()).join(' and ') + '.' : ''), 'roll', { roll: n });
  fx(room, 'gain', { roll: n, gains, hexes, short, blocked: blocked ? g.board.robber : null });
  g.phase = 'main';
}

/* -------- the robber */

function discard(room, p, m) {
  const g = room.game;
  if (g.phase !== 'discard' || !g.discard[p.id]) return;
  const cards = R.clean(m.cards, 30), me = P(g, p.id);
  if (R.total(cards) !== g.discard[p.id]) return err(p, 'Pick exactly ' + g.discard[p.id] + ' cards.');
  if (!R.has(me.res, cards)) return err(p, 'You don’t have those cards.');
  R.add(me.res, cards, -1); R.add(g.bank, cards);
  me.stats.discarded += R.total(cards);
  log(room, pname(room, p.id) + ' discards ' + R.total(cards) + ' cards.', 'seven');
  fx(room, 'discarded', { pid: p.id, n: R.total(cards) });
  delete g.discard[p.id];
  if (!Object.keys(g.discard).length) { g.discard = null; g.phase = 'robber'; }
}
function moveRobber(room, p, m) {
  const g = room.game;
  if (g.phase !== 'robber' || g.turn.pid !== p.id) return;
  const hex = Number(m.hex);
  if (!R.robberHexes(g, p.id, g.friendly).includes(hex)) return err(p, hex === g.board.robber ? 'The robber has to move to a different hex.' : 'The robber can’t go there.');
  g.board.robber = hex;
  const h = g.board.hexes[hex];
  log(room, pname(room, p.id) + ' moves the robber to the ' + (h.n ? h.n + ' ' : '') + R.TERRAIN_NAME[h.t].toLowerCase() + '.', 'robber');
  fx(room, 'robber', { pid: p.id, hex });
  const victims = R.playersOn(g, hex).filter(id => id !== p.id && total(g, id) > 0);
  if (!victims.length) return afterRobber(room);
  if (victims.length === 1) return stealFrom(room, p, victims[0]);
  g.steal = { victims }; g.phase = 'steal';
}
function steal(room, p, m) {
  const g = room.game;
  if (g.phase !== 'steal' || g.turn.pid !== p.id) return;
  const victim = String(m.pid || '');
  if (!g.steal.victims.includes(victim)) return;
  stealFrom(room, p, victim);
}
function stealFrom(room, p, victim) {
  const g = room.game, from = P(g, victim), bag = [];
  for (const r of R.RES) for (let i = 0; i < from.res[r]; i++) bag.push(r);
  if (bag.length) {
    const res = pick(bag);
    from.res[res]--; P(g, p.id).res[res]++;
    from.stats.robbed++; P(g, p.id).stats.stole++;
    log(room, pname(room, p.id) + ' steals a card from ' + pname(room, victim) + '.', 'robber');
    fx(room, 'steal', { from: victim, to: p.id });
    fx(room, 'stole', { res, who: victim }, [p.id]);
    fx(room, 'robbed', { res, who: p.id }, [victim]);
  }
  afterRobber(room);
}
function afterRobber(room) {
  const g = room.game;
  g.steal = null;
  g.phase = g.ret || 'main'; g.ret = null;
  checkWin(room);
}

/* -------- building */

const canBuildNow = (g, pid) => (g.phase === 'main' && g.turn.pid === pid) || (g.phase === 'special' && g.special.queue[g.special.i] === pid);
function build(room, p, m) {
  const g = room.game, pid = p.id, what = String(m.what), at = Number(m.at), me = P(g, pid);
  const free = g.phase === 'roads' && g.turn.pid === pid && what === 'road';
  if (!free && !canBuildNow(g, pid)) return;
  if (!R.COST[what] || what === 'dev') return;
  if (!(R.left(g, pid)[what] > 0)) return err(p, 'You have no ' + (what === 'city' ? 'cities' : what + 's') + ' left to place.');
  const ok = what === 'road' ? R.canRoad(g, pid, at) : what === 'settlement' ? R.canSettle(g, pid, at, false) : R.canCity(g, pid, at);
  if (!ok) return err(p, what === 'road' ? 'A road has to connect to one of your roads or buildings.' : what === 'settlement' ? 'A settlement needs one of your roads leading to it, two corners from any other building.' : 'Only one of your own settlements can become a city.');
  if (!free) {
    if (!R.has(me.res, R.COST[what])) return err(p, 'You can’t afford a ' + what + ' yet.');
    R.add(me.res, R.COST[what], -1); R.add(g.bank, R.COST[what]);
  }
  if (what === 'road') { g.r[at] = pid; me.stats.roads++; }
  else if (what === 'settlement') g.b[at] = { p: pid, c: 0 };
  else g.b[at].c = 1;
  log(room, pname(room, pid) + ' builds a ' + what + '.', 'build');
  fx(room, 'build', { pid, what, at });
  if (what !== 'city') updateLongest(room);
  if (free) {
    g.roads.left--;
    if (g.roads.left <= 0 || R.left(g, pid).road <= 0 || !R.legalRoads(g, pid).length) endRoads(room);
  }
  if (g.phase === 'special') specialCheck(room);
  checkWin(room);
}
function endRoads(room) {
  const g = room.game;
  if (g.phase !== 'roads') return;
  g.phase = g.roads.ret; g.roads = null;
}
function buyDev(room, p) {
  const g = room.game, me = P(g, p.id);
  if (!canBuildNow(g, p.id)) return;
  if (!g.deck.length) return err(p, 'The development cards are all gone.');
  if (!R.has(me.res, R.COST.dev)) return err(p, 'A development card costs 1 sheep, 1 wheat and 1 ore.');
  R.add(me.res, R.COST.dev, -1); R.add(g.bank, R.COST.dev);
  const k = g.deck.pop();
  me.dev.push({ k, n: g.turnCount });
  me.stats.devs++;
  log(room, pname(room, p.id) + ' buys a development card.', 'dev');
  fx(room, 'buyDev', { pid: p.id });
  fx(room, 'drew', { k }, [p.id]);
  if (g.phase === 'special') specialCheck(room);
  checkWin(room);
}
// One development card a turn, never the turn you bought it, before or after you roll.
function playDev(room, p, m) {
  const g = room.game, me = P(g, p.id), k = String(m.k);
  if (g.turn.pid !== p.id || (g.phase !== 'roll' && g.phase !== 'main')) return err(p, 'You can play a development card on your own turn, before or after you roll.');
  if (k === 'vp' || !R.DEV[k]) return;
  if (g.turn.devPlayed) return err(p, 'Only one development card a turn.');
  const i = me.dev.findIndex(c => c.k === k && c.n < g.turnCount);
  if (i < 0) return err(p, me.dev.some(c => c.k === k) ? 'You bought that this turn. It can be played from your next turn.' : 'You don’t have that card.');
  if (k === 'road') {
    const n = Math.min(2, R.left(g, p.id).road);
    if (!n || !R.legalRoads(g, p.id).length) return err(p, 'There’s nowhere for you to put a road right now.');
    me.dev.splice(i, 1); g.turn.devPlayed = true;
    g.roads = { left: n, ret: g.phase }; g.phase = 'roads';
    log(room, pname(room, p.id) + ' plays Road Building.', 'dev');
  } else if (k === 'plenty') {
    const a = String(m.a), b = String(m.b), want = R.empty();
    if (!R.RES.includes(a) || !R.RES.includes(b)) return;
    want[a]++; want[b]++;
    if (!R.has(g.bank, want)) return err(p, 'The bank doesn’t have those cards.');
    me.dev.splice(i, 1); g.turn.devPlayed = true;
    R.add(me.res, want); R.add(g.bank, want, -1);
    log(room, pname(room, p.id) + ' plays Year of Plenty and takes ' + R.words(want) + '.', 'dev');
  } else if (k === 'mono') {
    const res = String(m.a);
    if (!R.RES.includes(res)) return;
    me.dev.splice(i, 1); g.turn.devPlayed = true;
    let n = 0;
    const from = {};
    for (const id of g.order) { if (id === p.id) continue; const c = P(g, id).res[res]; if (c) { from[id] = c; n += c; P(g, id).res[res] = 0; } }
    me.res[res] += n;
    log(room, pname(room, p.id) + ' plays Monopoly on ' + R.RES_NAME[res].toLowerCase() + ' and collects ' + n + '.', 'dev');
    fx(room, 'mono', { pid: p.id, res, n, from });
  } else if (k === 'knight') {
    me.dev.splice(i, 1); g.turn.devPlayed = true;
    me.knights++;
    log(room, pname(room, p.id) + ' plays a Knight.', 'dev');
    if (me.knights >= R.ARMY_MIN && (!g.army || (g.army.pid !== p.id && me.knights > P(g, g.army.pid).knights))) {
      const from = g.army ? g.army.pid : null;
      g.army = { pid: p.id };
      log(room, pname(room, p.id) + ' takes the Largest Army.', 'crown');
      fx(room, 'army', { pid: p.id, from });
    }
    g.ret = g.phase; g.phase = 'robber';
  }
  fx(room, 'dev', { pid: p.id, k });
  checkWin(room);
}
function updateLongest(room) {
  const g = room.game, lens = {};
  let max = 0;
  for (const id of g.order) { lens[id] = P(g, id).roadLen = R.roadLength(g, id); max = Math.max(max, lens[id]); }
  const cur = g.longest ? g.longest.pid : null;
  let holder;
  if (max < R.LONGEST_MIN) holder = null;
  else if (cur && lens[cur] === max) holder = cur;          // the holder keeps it on a tie
  else { const tops = g.order.filter(id => lens[id] === max); holder = tops.length === 1 ? tops[0] : null; }
  if (holder === cur) { if (cur) g.longest.len = lens[cur]; return; }
  g.longest = holder ? { pid: holder, len: max } : null;
  log(room, holder ? pname(room, holder) + ' takes the Longest Road with ' + max + '.' : pname(room, cur) + ' loses the Longest Road. Nobody holds it.', 'crown');
  fx(room, 'longest', { pid: holder, from: cur, len: max });
}

/* -------- ending a turn */

function endTurn(room, p) {
  const g = room.game;
  if (g.phase === 'special' && g.special.queue[g.special.i] === p.id) { g.special.i++; return advanceSpecial(room); }
  if (g.phase !== 'main' || g.turn.pid !== p.id) return;
  g.trades = [];
  if (g.specialOn) {
    // Five or six at the table: before the dice move on, everyone else may build (no trading).
    const i = g.order.indexOf(p.id);
    g.special = { queue: g.order.slice(i + 1).concat(g.order.slice(0, i)), i: 0 };
    g.phase = 'special';
    return advanceSpecial(room);
  }
  nextTurn(room);
}
function canBuildAnything(g, pid) {
  const me = P(g, pid), left = R.left(g, pid);
  if (g.deck.length && R.has(me.res, R.COST.dev)) return true;
  if (left.city > 0 && R.has(me.res, R.COST.city) && R.legalCities(g, pid).length) return true;
  if (left.settlement > 0 && R.has(me.res, R.COST.settlement) && R.legalSettles(g, pid, false).length) return true;
  if (left.road > 0 && R.has(me.res, R.COST.road) && R.legalRoads(g, pid).length) return true;
  return false;
}
function advanceSpecial(room) {
  const g = room.game, sp = g.special;
  while (sp.i < sp.queue.length && !canBuildAnything(g, sp.queue[sp.i])) sp.i++;
  if (sp.i >= sp.queue.length) { g.special = null; return nextTurn(room); }
  fx(room, 'special', { pid: sp.queue[sp.i] });
  if (g.turnSecs) setClock(room, 'turn', SPECIAL_SECS * 1000, true); else stopClock(room);
}
function specialCheck(room) {
  const g = room.game;
  if (g.phase === 'special' && !canBuildAnything(g, g.special.queue[g.special.i])) { g.special.i++; advanceSpecial(room); }
}

// You can only win on your own turn: the moment you hold enough points, the game is yours.
function checkWin(room) {
  const g = room.game;
  if (!g.turn || ['gameOver', 'rolloff', 'setup', 'special'].includes(g.phase)) return;
  if (score(g, g.turn.pid) >= g.target) endGame(room, g.turn.pid);
}
function endGame(room, winner, why) {
  const g = room.game;
  stopClock(room);
  g.played = Date.now() - g.started;
  g.phase = 'gameOver'; g.trades = []; g.why = why || 'won';
  if (!winner) winner = g.order.slice().sort((a, b) => score(g, b) - score(g, a))[0];
  g.winner = winner;
  g.final = {};
  for (const id of g.order) g.final[id] = { pts: score(g, id), vp: vpCards(g, id), res: R.total(P(g, id).res) };
  g.awards = awards(room);
  log(room, pname(room, winner) + (why === 'early' ? ' is ahead when the game is called.' : ' wins with ' + score(g, winner) + ' points!'), 'end');
  fx(room, 'gameOver', { winner });
}
function awards(room) {
  const g = room.game, out = [];
  const most = (key, min, title, blurb) => {
    let best = null;
    for (const id of g.order) { const v = P(g, id).stats[key]; if (v >= min && (!best || v > P(g, best).stats[key])) best = id; }
    if (best) out.push({ id: best, title, blurb: blurb(P(g, best).stats[key]) });
  };
  most('trades', 2, 'MERCHANT PRINCE', n => n + ' trades with the table');
  most('stole', 2, 'HIGHWAYMAN', n => n + ' cards stolen');
  most('robbed', 2, 'ROBBER’S FAVORITE', n => 'Robbed ' + n + ' times');
  most('gained', 8, 'BREADBASKET', n => n + ' cards from the dice');
  most('sevens', 2, 'LUCKY SEVENS', n => 'Rolled ' + n + ' sevens');
  most('bank', 2, 'HARBORMASTER', n => n + ' trades with the bank');
  most('discarded', 4, 'TAXED', n => n + ' cards lost to sevens');
  most('blocked', 3, 'UNDER SIEGE', n => n + ' cards blocked by the robber');
  return out.slice(0, 6);
}

/* -------- trading */

// The official rule: every trade includes the player whose turn it is, after the dice are rolled.
// With open trading on, any two players can deal whenever the dice or a turn are in play.
const tradeOpen = g => g.trading === 'open' ? (g.phase === 'main' || g.phase === 'roll') : g.phase === 'main';
function mayOffer(g, from, to) {
  if (!tradeOpen(g)) return false;
  if (g.trading === 'open') return true;
  return from === g.turn.pid || to === g.turn.pid;
}
// Who an offer is in front of.
function askedOf(g, tr) {
  if (tr.to) return [tr.to];
  return g.order.filter(id => id !== tr.from);
}
function trade(room, a, b, give, want) {
  const g = room.game, A = P(g, a), B = P(g, b);
  if (!R.has(A.res, give) || !R.has(B.res, want)) return false;
  R.add(A.res, give, -1); R.add(B.res, give); R.add(B.res, want, -1); R.add(A.res, want);
  A.stats.trades++; B.stats.trades++;
  log(room, pname(room, a) + ' gives ' + pname(room, b) + ' ' + R.words(give) + ' for ' + R.words(want) + '.', 'trade');
  fx(room, 'trade', { a, b, give, want });
  return true;
}
function cleanTerms(p, give, want, ask) {
  give = R.clean(give, 9); want = R.clean(want, 9);
  if (!R.total(want)) return err(p, 'Say what you want in return.');
  if (!ask && !R.total(give)) return err(p, 'A trade needs something on both sides. No free gifts.');
  if (R.overlap(give, want)) return err(p, 'You can’t trade a resource for the same resource.');
  return { give, want };
}
function offer(room, p, m) {
  const g = room.game;
  const to = m.to ? String(m.to) : null;
  if (to && (to === p.id || !g.players[to])) return;
  if (!mayOffer(g, p.id, to)) return err(p, g.phase === 'roll' && g.trading !== 'open' ? 'Trading opens once the dice are rolled.' : g.trading === 'open' ? 'Trading is closed for a moment.' : 'Trades have to include ' + pname(room, g.turn.pid) + ' this turn.');
  const ask = !!m.ask, t = cleanTerms(p, ask ? null : m.give, m.want, ask);
  if (!t) return;
  if (!R.has(P(g, p.id).res, t.give)) return err(p, 'You don’t have those cards to give.');
  g.trades = g.trades.filter(x => x.from !== p.id);
  const tr = { id: ++g.tradeSeq, from: p.id, to, give: t.give, want: t.want, ask, at: Date.now(), re: {} };
  g.trades.push(tr);
  fx(room, 'offer', { id: tr.id, from: p.id, to, ask }, to ? [p.id, to] : null);
  if (!to) log(room, pname(room, p.id) + (ask ? ' is looking for ' + R.words(t.want) + '.' : ' offers ' + R.words(t.give) + ' for ' + R.words(t.want) + '.'), 'offer');
}
// m.s: 'yes', 'no' or 'counter'. A counter names its own terms, from the answerer's side:
// m.give is what they would hand over, m.want what they'd take.
function answer(room, p, m) {
  const g = room.game, tr = g.trades.find(x => x.id === Number(m.id));
  if (!tr) return err(p, 'That offer is gone.');
  if (!askedOf(g, tr).includes(p.id)) return;
  if (m.s === 'no') { tr.re[p.id] = { s: 'no' }; return; }
  if (m.s === 'reopen') { delete tr.re[p.id]; return; }
  if (m.s === 'yes') {
    if (tr.ask) return;
    if (!R.has(P(g, p.id).res, tr.want)) return err(p, 'You don’t have the cards for that.');
    if (tr.to) {
      // An offer made to one player is done the moment they say yes.
      if (!mayOffer(g, tr.from, p.id)) return err(p, 'Trading is paused for a moment. Try again when the robber is done.');
      if (trade(room, tr.from, p.id, tr.give, tr.want)) g.trades = g.trades.filter(x => x !== tr);
      return;
    }
    tr.re[p.id] = { s: 'yes' };
    fx(room, 'answer', { id: tr.id, pid: p.id, s: 'yes' }, [tr.from]);
    return;
  }
  if (m.s === 'counter') {
    const t = cleanTerms(p, m.give, m.want, false);
    if (!t) return;
    if (!R.has(P(g, p.id).res, t.give)) return err(p, 'You don’t have those cards to give.');
    // Stored from the offerer's side, like the offer itself.
    tr.re[p.id] = { s: 'counter', give: t.want, want: t.give };
    fx(room, 'answer', { id: tr.id, pid: p.id, s: 'counter' }, [tr.from]);
  }
}
// The offerer picks who to trade with: someone who said yes, or someone's counter.
function deal(room, p, m) {
  const g = room.game, tr = g.trades.find(x => x.id === Number(m.id));
  if (!tr || tr.from !== p.id) return err(p, 'That offer is gone.');
  const who = String(m.with || ''), re = tr.re[who];
  if (!re || (re.s !== 'yes' && re.s !== 'counter')) return;
  if (!mayOffer(g, p.id, who)) return err(p, 'That trade can’t happen right now.');
  const give = re.s === 'yes' ? tr.give : re.give, want = re.s === 'yes' ? tr.want : re.want;
  if (!R.has(P(g, p.id).res, give)) return err(p, 'You don’t have ' + R.words(give) + ' to give.');
  if (!trade(room, p.id, who, give, want)) { delete tr.re[who]; return err(p, pname(room, who) + ' no longer has those cards.'); }
  g.trades = g.trades.filter(x => x !== tr);
}
function cancelOffer(room, p, m) {
  const g = room.game, tr = g.trades.find(x => x.id === Number(m.id));
  if (!tr || tr.from !== p.id) return;
  g.trades = g.trades.filter(x => x !== tr);
}
function declineCounter(room, p, m) {
  const g = room.game, tr = g.trades.find(x => x.id === Number(m.id));
  const who = String(m.pid || '');
  if (!tr || tr.from !== p.id || !tr.re[who] || tr.re[who].s !== 'counter') return;
  tr.re[who] = { s: 'declined' };
  fx(room, 'countered', { id: tr.id, from: p.id }, [who]);
}
// Hands change all the time. An offer its maker can no longer cover is withdrawn; a yes or a
// counter its maker can no longer cover is wiped, so they can answer again.
function pruneTrades(room) {
  const g = room.game;
  if (!g || !g.trades.length) return;
  if (!tradeOpen(g) && g.phase !== 'robber' && g.phase !== 'steal' && g.phase !== 'roads' && g.phase !== 'discard') { g.trades = []; return; }
  g.trades = g.trades.filter(tr => {
    if (!R.has(P(g, tr.from).res, tr.give)) { fx(room, 'offerGone', { id: tr.id }, [tr.from]); return false; }
    for (const id of Object.keys(tr.re)) {
      const re = tr.re[id];
      if (re.s === 'yes' && !R.has(P(g, id).res, tr.want)) delete tr.re[id];
      else if (re.s === 'counter' && !R.has(P(g, id).res, re.want)) delete tr.re[id];
    }
    return true;
  });
}
// Trading with the bank: four of a kind for one card, or three or two with the right port.
function bankTrade(room, p, m) {
  const g = room.game, me = P(g, p.id);
  if (g.phase !== 'main' || g.turn.pid !== p.id) return err(p, 'You can trade with the bank on your own turn, after you roll.');
  const give = String(m.give), get = String(m.get), n = Math.max(1, Math.min(5, Math.floor(Number(m.n)) || 1));
  if (!R.RES.includes(give) || !R.RES.includes(get) || give === get) return;
  const rate = R.rate(g, p.id, give);
  if (me.res[give] < rate * n) return err(p, 'That takes ' + (rate * n) + ' ' + R.RES_NAME[give].toLowerCase() + '.');
  if (g.bank[get] < n) return err(p, 'The bank is out of ' + R.RES_NAME[get].toLowerCase() + '.');
  me.res[give] -= rate * n; g.bank[give] += rate * n; me.res[get] += n; g.bank[get] -= n;
  me.stats.bank++;
  log(room, pname(room, p.id) + ' trades ' + (rate * n) + ' ' + R.RES_NAME[give].toLowerCase() + ' to the ' + (rate < 4 ? 'port' : 'bank') + ' for ' + n + ' ' + R.RES_NAME[get].toLowerCase() + '.', 'trade');
  fx(room, 'bank', { pid: p.id, give, get, n, rate });
}

/* -------- private messages between two phones */

const chatKey = (a, b) => [a, b].sort().join('|');
function chat(room, p, m) {
  const to = String(m.to || ''), other = room.players.get(to);
  if (!other || other === p || other.bot) return;
  const text = clean(m.text, 240);
  if (!text) return;
  const k = chatKey(p.id, to);
  const list = room.chats[k] || (room.chats[k] = []);
  list.push({ from: p.id, text, at: Date.now() });
  if (list.length > 60) list.shift();
}
function chatsFor(room, pid) {
  const out = {};
  for (const k of Object.keys(room.chats)) {
    const [a, b] = k.split('|');
    if (a === pid || b === pid) out[a === pid ? b : a] = room.chats[k];
  }
  return out;
}

/* -------- bots, and playing for someone whose phone has gone quiet */

function addBot(room) {
  if (room.game || seats(room).length >= MAX_PLAYERS) return;
  const used = new Set([...room.players.values()].map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || ('BOT ' + crypto.randomInt(100, 999));
  const p = { id: rid(6), token: rid(), name, color: freeColor(room), face: freeFace(room, BOT_FACES), bot: true, connected: true, ws: null, hold: 0, goneAt: 0 };
  room.players.set(p.id, p);
  room.order.push(p.id);
  fx(room, 'joined', { name: p.name, pid: p.id, bot: true });
}
const nerve = (id, salt) => (crypto.createHash('sha1').update(id + '|' + (salt || '')).digest()[0] / 255);
// 'full': a bot, or a seat whose player left. 'away': a human whose phone has been gone a while;
// the game only does what it must for them (rolls, discards, ends the turn). null: leave them be.
function driver(room, id) {
  const p = room.players.get(id), g = room.game;
  if (!p) return 'full';
  if (p.bot || (g && g.players[id] && g.players[id].auto)) return 'full';
  if (!p.connected && Date.now() - (p.goneAt || 0) > AWAY_MS / SPEED) return 'away';
  return null;
}
const openSpot = (g, v) => !g.b[v] && R.geo(g.kind).verts[v].n.every(n => !g.b[n]);
function vertexScore(g, pid, v) {
  const G = R.geo(g.kind), y = R.yieldAt(g, v);
  let s = y.pips + Object.keys(y.res).length * 0.9;
  const mine = {};
  for (const k in g.b) if (g.b[k].p === pid) Object.assign(mine, R.yieldAt(g, Number(k)).res);
  for (const r of Object.keys(y.res)) if (!mine[r]) s += 1.2;
  if (G.vport[v] != null) s += 0.7;
  return s;
}
function botSettleSpot(g, pid, setup) {
  let best = null, bs = -1;
  for (const v of R.legalSettles(g, pid, setup)) { const s = vertexScore(g, pid, v) + rand() * 0.9; if (s > bs) { bs = s; best = v; } }
  return best;
}
function botRoadSpot(g, pid, fromVertex) {
  const G = R.geo(g.kind);
  let best = null, bs = -1;
  for (const e of R.legalRoads(g, pid, fromVertex)) {
    const E = G.edges[e];
    let s = rand() * 0.6;
    for (const far of [E.a, E.b]) {
      if (far === fromVertex || (g.b[far] && g.b[far].p === pid)) continue;
      if (openSpot(g, far)) s = Math.max(s, vertexScore(g, pid, far) + 1);
      for (const n of G.verts[far].n) if (openSpot(g, n)) s = Math.max(s, vertexScore(g, pid, n) * 0.6);
    }
    if (s > bs) { bs = s; best = e; }
  }
  return best;
}
// What a bot is working toward, most wanted first.
function botPlans(g, pid) {
  const left = R.left(g, pid), plans = [];
  const spots = left.settlement > 0 && R.legalSettles(g, pid, false).length > 0;
  const cities = left.city > 0 && R.legalCities(g, pid).length > 0;
  if (spots) plans.push('settlement');
  if (cities) plans.push('city');
  if (!spots && left.road > 0 && left.settlement > 0 && R.legalRoads(g, pid).length) plans.push('road');
  if (g.deck.length) plans.push('dev');
  if (R.has(P(g, pid).res, R.COST.city) && cities) { plans.splice(plans.indexOf('city'), 1); plans.unshift('city'); }
  return plans;
}
const missCount = (hand, cost) => R.total(R.missing(hand, cost));
// Would a bot swap `give` for `get`? Cards it needs for its plan are precious; spares are cheap.
function botLikes(g, pid, get, give, partner) {
  const me = P(g, pid);
  if (!R.has(me.res, give)) return false;
  if (partner && R.points(g, partner) >= g.target - 2) return false;
  const plans = botPlans(g, pid), goal = R.COST[plans[0] || 'dev'];
  const after = R.add(R.add(Object.assign({}, me.res), give, -1), get);
  const before = missCount(me.res, goal), then = missCount(after, goal);
  if (then < before) return R.total(give) <= R.total(get) + 1;
  if (then > before) return false;
  return R.total(get) > R.total(give) || (R.total(get) === R.total(give) && nerve(pid, 'easy') > 0.75 && R.total(me.res) < 7);
}
function botDiscard(room, id) {
  const g = room.game, me = P(g, id), n = g.discard[id], cards = R.empty();
  const goal = R.COST[botPlans(g, id)[0] || 'dev'], hand = Object.assign({}, me.res);
  for (let i = 0; i < n; i++) {
    // Throw away spares first, then whatever there is most of.
    let best = null, bs = -99;
    for (const r of R.RES) { if (!hand[r]) continue; const s = (hand[r] - (goal[r] || 0)) * 2 + hand[r] * 0.1 + rand() * 0.2; if (s > bs) { bs = s; best = r; } }
    hand[best]--; cards[best]++;
  }
  discard(room, { id, ws: null }, { cards });
}
function botRobber(room, id) {
  const g = room.game, G = R.geo(g.kind);
  const lead = Math.max(...g.order.filter(x => x !== id).map(x => R.points(g, x)));
  let best = null, bs = -99;
  for (const h of R.robberHexes(g, id, g.friendly)) {
    const hex = g.board.hexes[h];
    let s = rand() * 0.5;
    for (const v of G.hexes[h].v) {
      const bl = g.b[v];
      if (!bl) continue;
      const w = (R.PIPS[hex.n] || 0) * (bl.c ? 2 : 1);
      if (bl.p === id) s -= w * 3; else s += w * (R.points(g, bl.p) === lead ? 1.6 : 1) + (total(g, bl.p) ? 1 : 0);
    }
    if (s > bs) { bs = s; best = h; }
  }
  moveRobber(room, { id, ws: null }, { hex: best });
}
function botSteal(room, id) {
  const g = room.game;
  const v = g.steal.victims.slice().sort((a, b) => R.points(g, b) - R.points(g, a) || total(g, b) - total(g, a))[0];
  steal(room, { id, ws: null }, { pid: v });
}
function botSetup(room, id) {
  const g = room.game, me = { id, ws: null };
  if (g.setup.step === 'settle') placeSetup(room, me, { v: botSettleSpot(g, id, true) });
  else placeSetup(room, me, { e: botRoadSpot(g, id, g.setup.v) });
}
// One move of a bot's turn. Returns true if it did something (the next move comes a beat later).
function botMain(room, id, special) {
  const g = room.game, me = P(g, id), p = { id, ws: null }, now = Date.now();
  const bt = me.bt || (me.bt = {});
  if (!special) {
    // An offer of its own on the table: take a yes, weigh the counters, or give up after a while.
    const mine = g.trades.find(t => t.from === id);
    if (mine) {
      const yes = Object.keys(mine.re).filter(x => mine.re[x].s === 'yes').sort((a, b) => R.points(g, a) - R.points(g, b));
      if (yes.length) { deal(room, p, { id: mine.id, with: yes[0] }); return true; }
      const good = Object.keys(mine.re).find(x => mine.re[x].s === 'counter' && botLikes(g, id, mine.re[x].want, mine.re[x].give, x));
      if (good) { deal(room, p, { id: mine.id, with: good }); return true; }
      if (askedOf(g, mine).every(x => mine.re[x]) || now > (bt.until || 0)) { cancelOffer(room, p, { id: mine.id }); return true; }
      return false;
    }
    // Development cards.
    const can = k => !g.turn.devPlayed && me.dev.some(c => c.k === k && c.n < g.turnCount);
    if (can('road') && R.left(g, id).road > 0 && R.legalRoads(g, id).length) { playDev(room, p, { k: 'road' }); return true; }
    const plans0 = botPlans(g, id), goal0 = R.COST[plans0[0] || 'dev'], miss0 = R.missing(me.res, goal0);
    if (can('plenty') && R.total(miss0) >= 1 && R.total(miss0) <= 2) {
      const need = [];
      for (const r of R.RES) for (let i = 0; i < miss0[r]; i++) need.push(r);
      while (need.length < 2) need.push(pick(R.RES));
      if (g.bank[need[0]] > 0 && g.bank[need[1]] > (need[0] === need[1] ? 1 : 0)) { playDev(room, p, { k: 'plenty', a: need[0], b: need[1] }); return true; }
    }
    if (can('mono') && R.total(miss0) >= 1) {
      const res = R.RES.filter(r => miss0[r]).sort((a, b) => miss0[b] - miss0[a])[0];
      if (g.order.some(x => x !== id && P(g, x).res[res] > 0)) { playDev(room, p, { k: 'mono', a: res }); return true; }
    }
    if (can('knight') && (R.playersOn(g, g.board.robber).includes(id) || me.knights >= 2 || chance(0.3))) { playDev(room, p, { k: 'knight' }); return true; }
  }
  const plans = botPlans(g, id), goal = R.COST[plans[0] || 'dev'];
  for (const what of plans) {
    if (!R.has(me.res, R.COST[what])) continue;
    // Don't spend cards the main plan needs, unless the hand is getting dangerously big.
    if (what !== plans[0]) {
      const after = R.add(Object.assign({}, me.res), R.COST[what], -1);
      if (missCount(after, goal) > missCount(me.res, goal) && R.total(me.res) <= R.HAND_LIMIT) continue;
    }
    if (what === 'dev') buyDev(room, p);
    else if (what === 'city') build(room, p, { what, at: R.legalCities(g, id).sort((a, b) => R.yieldAt(g, b).pips - R.yieldAt(g, a).pips)[0] });
    else if (what === 'settlement') build(room, p, { what, at: botSettleSpot(g, id, false) });
    else build(room, p, { what, at: botRoadSpot(g, id) });
    return true;
  }
  if (special) return false;
  const miss = R.missing(me.res, goal), spare = r => me.res[r] - (goal[r] || 0);
  const wants = R.RES.filter(r => miss[r] > 0);
  if (!wants.length) return false;
  // The bank or a port, if there is a pile of something spare.
  for (const r of R.RES.slice().sort((a, b) => spare(b) - spare(a))) {
    const rate = R.rate(g, id, r);
    const get = wants.find(w => g.bank[w] > 0);
    if (get && spare(r) >= rate) { bankTrade(room, p, { give: r, get, n: 1 }); return true; }
  }
  // The table: one spare card for one it needs. A couple of tries a turn, no more.
  if ((bt.offers || 0) < 2 && R.total(miss) <= 2 && tradeOpen(g)) {
    const spares = R.RES.filter(r => spare(r) > 0).sort((a, b) => spare(b) - spare(a));
    if (spares.length) {
      const give = R.empty(), want = R.empty();
      give[spares[0]] = bt.offers && spare(spares[0]) >= 2 ? 2 : 1;
      want[wants[bt.offers ? wants.length - 1 : 0]] = 1;
      bt.offers = (bt.offers || 0) + 1; bt.until = now + BOT_OFFER_MS / SPEED;
      offer(room, p, { give, want });
      return true;
    }
  }
  return false;
}
// A bot answers an offer on the table.
function botAnswer(room, id, tr) {
  const g = room.game, me = P(g, id), p = { id, ws: null };
  const goal = R.COST[botPlans(g, id)[0] || 'dev'], miss = R.missing(me.res, goal);
  const spare = r => me.res[r] - (goal[r] || 0);
  if (!tr.ask && botLikes(g, id, tr.give, tr.want, tr.from)) return answer(room, p, { id: tr.id, s: 'yes' });
  // Not as offered. If it has a spare of what they want and needs something itself, name a price.
  const has = R.RES.find(r => tr.want[r] && spare(r) > 0), need = R.RES.filter(r => miss[r] > 0 && !tr.want[r]).sort((a, b) => miss[b] - miss[a])[0];
  if (has && need && R.points(g, tr.from) < g.target - 2 && (tr.ask || nerve(id + tr.id, 'haggle') > 0.45)) {
    const give = R.empty(), want = R.empty();
    give[has] = 1; want[need] = 1;
    return answer(room, p, { id: tr.id, s: 'counter', give, want });
  }
  answer(room, p, { id: tr.id, s: 'no' });
}

function botHasWork(room) {
  const g = room.game;
  if (!g || g.phase === 'gameOver' || g.phase === 'rolloff') return false;
  if (actors(g).some(id => driver(room, id))) return true;
  if (actors(g).some(id => { const p = room.players.get(id); return p && !p.bot && !p.connected; })) return true;   // they may turn 'away' soon
  return g.trades.some(tr => askedOf(g, tr).some(id => !tr.re[id] && driver(room, id) === 'full'));
}
function scheduleBots(room) {
  if (room.botTimer || !botHasWork(room)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (rooms.get(room.code) !== room) return;
    let changed = false;
    try { changed = botTick(room); } catch (e) { console.error('bot error', e); }
    if (changed) pushAll(room); else scheduleBots(room);
  }, (BOT_MS + crypto.randomInt(500)) / SPEED);
}
function botTick(room) {
  const g = room.game;
  if (!g) return false;
  const now = Date.now();
  // Offers waiting on a bot.
  for (const tr of g.trades.slice()) {
    if (now - tr.at < BOT_ANSWER_MS / SPEED) continue;
    for (const id of askedOf(g, tr)) {
      if (tr.re[id] || driver(room, id) !== 'full' || !g.trades.includes(tr)) continue;
      botAnswer(room, id, tr);
      return true;
    }
  }
  for (const id of actors(g)) {
    const how = driver(room, id);
    if (!how) continue;
    const p = { id, ws: null };
    switch (g.phase) {
      case 'setup': botSetup(room, id); return true;
      case 'discard': botDiscard(room, id); return true;
      case 'robber': botRobber(room, id); return true;
      case 'steal': botSteal(room, id); return true;
      case 'roads': { const e = botRoadSpot(g, id); if (e == null) endRoads(room); else build(room, p, { what: 'road', at: e }); return true; }
      case 'roll': {
        const me = P(g, id);
        if (how === 'away') log(room, pname(room, id) + ' is away: the game rolls.', 'auto');
        if (how === 'full' && !g.turn.devPlayed && me.dev.some(c => c.k === 'knight' && c.n < g.turnCount) && R.playersOn(g, g.board.robber).includes(id)) playDev(room, p, { k: 'knight' });
        else rollDice(room, p);
        return true;
      }
      case 'main':
        if (how === 'full') {
          if (botMain(room, id, false)) return true;
          if (g.trades.some(t => t.from === id)) continue;        // its offer is still out
        } else log(room, pname(room, id) + ' is away: the game ends the turn.', 'auto');
        endTurn(room, p);
        return true;
      case 'special':
        if (how === 'full' && botMain(room, id, true)) return true;
        endTurn(room, p);
        return true;
    }
  }
  return false;
}
// The turn clock ran out: do the least the game needs from whoever it is waiting on, and move along.
function forceStep(room) {
  const g = room.game, turn = g.turnCount;
  for (let guard = 0; guard < 12; guard++) {
    if (g.phase === 'gameOver' || g.turnCount !== turn) return;
    const who = actors(g);
    if (!who.length) return;
    const id = who[0], p = { id, ws: null };
    switch (g.phase) {
      case 'setup': botSetup(room, id); if (g.phase === 'setup' && g.setup.step === 'settle') return; break;
      case 'discard': for (const x of who) botDiscard(room, x); break;
      case 'robber': botRobber(room, id); break;
      case 'steal': botSteal(room, id); break;
      case 'roads': endRoads(room); break;
      case 'roll': log(room, pname(room, id) + ' is out of time: the game rolls.', 'auto'); rollDice(room, p); break;
      case 'main': log(room, 'Time’s up for ' + pname(room, id) + '.', 'auto'); endTurn(room, p); if (g.phase === 'special') return; break;
      case 'special': endTurn(room, p); return;
    }
  }
}

/* ----------------------------------------------------- lobby and captain actions */

function adminAction(room, m, ws) {
  const g = room.game;
  switch (m.a) {
    case 'start': if (!g) startGame(room); return;
    case 'again': if (g && g.phase === 'gameOver') { room.game = null; tidyLobby(room); startGame(room); if (!room.game) fx(room, 'lobby'); } return;
    case 'settings': if (!g) room.settings = cleanSettings(Object.assign({}, room.settings, m.settings || {})); return;
    case 'kick': { const x = room.players.get(m.id); if (x && x.id !== ws.pid) dropPlayer(room, x, true); return; }
    case 'addBot': addBot(room); return;
    case 'removeBot': {
      if (g) return;
      const bots = seats(room).map(id => room.players.get(id)).filter(x => x.bot);
      const x = m.id ? room.players.get(m.id) : bots[bots.length - 1];
      if (x && x.bot) dropPlayer(room, x, true);
      return;
    }
    case 'lobby': if (g) { stopClock(room); room.game = null; tidyLobby(room); fx(room, 'lobby'); } return;
    case 'endGame': if (g && g.phase !== 'gameOver') endGame(room, null, 'early'); return;
    case 'skipIntro': if (g && g.phase === 'rolloff') { stopClock(room); beginSetup(room); } return;
    case 'addTime': if (g && g.clock && g.clock.what === 'turn') { g.clock.at += 60000 / SPEED; g.clock.len += 60000 / SPEED; armTimer(room); } return;
    case 'save':
      if (!g || g.phase === 'gameOver') return;
      g.played = Date.now() - g.started;
      try { send(ws, { t: 'saved', blob: packRoom(room, false, 'save'), info: saveInfo(room) }); } catch (e) { console.error('save error', e); }
      return;
  }
}
// Back in the lobby, seats whose players have gone are cleared.
function tidyLobby(room) {
  for (const p of [...room.players.values()]) if (!p.bot && !p.connected) { room.players.delete(p.id); const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1); }
}

/* ----------------------------------------------------------------- state */

function publicState(room) {
  const g = room.game;
  const pl = id => { const p = room.players.get(id); return p ? { id: p.id, name: p.name, on: p.connected, color: p.color, face: p.face, photo: p.photoV ? '/photo/' + room.code + '/' + p.id + '?v=' + p.photoV : null, bot: !!p.bot } : null; };
  const s = {
    code: room.code, phase: g ? g.phase : 'lobby',
    players: (g ? g.order.filter(id => room.players.has(id)) : seats(room)).map(pl).filter(Boolean),
    captain: captainId(room), settings: room.settings, tv: room.displays.size > 0,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, choices: { target: TARGET_CHOICES, board: BOARD_CHOICES, trading: TRADE_CHOICES, dice: DICE_CHOICES, turn: TURN_CHOICES },
    fx: room.fx.filter(e => !e.only), game: null
  };
  if (g) {
    const over = g.phase === 'gameOver', players = {};
    for (const id of g.order) {
      const p = g.players[id];
      players[id] = { cards: R.total(p.res), devs: p.dev.length, knights: p.knights, pts: R.points(g, id), roadLen: p.roadLen, auto: !!p.auto, left: R.left(g, id) };
      if (over) { players[id].stats = p.stats; players[id].final = g.final[id]; }
    }
    s.game = {
      kind: g.kind, board: g.board, b: g.b, r: g.r, order: g.order, players, bank: g.bank, deckLeft: g.deck.length,
      target: g.target, trading: g.trading, friendly: g.friendly, dice: g.dice, turnSecs: g.turnSecs, specialOn: g.specialOn,
      turn: g.turn, turnCount: g.turnCount, rolloff: g.phase === 'rolloff' ? g.rolloff : null,
      setup: g.setup ? { pid: g.setup.seq[g.setup.i], step: g.setup.step, v: g.setup.v, round: g.setup.i < g.order.length ? 1 : 2 } : null,
      discard: g.discard, steal: g.steal, roads: g.roads ? { left: g.roads.left } : null, special: g.special ? { pid: g.special.queue[g.special.i] } : null,
      waiting: actors(g), longest: g.longest, army: g.army,
      // Offers made to the whole table are public, like talk across a real table. An offer made to
      // one player shows the rest only that the two are talking.
      trades: g.trades.map(tr => tr.to ? { id: tr.id, from: tr.from, to: tr.to, hidden: true } : tr),
      clock: g.clock && g.clock.show ? { what: g.clock.what, left: Math.max(0, g.clock.at - Date.now()), len: g.clock.len } : null,
      elapsed: over ? g.played : Date.now() - g.started,
      log: g.log.slice(-30), hist: g.hist, winner: g.winner, awards: g.awards || null, why: g.why || null
    };
  }
  return s;
}
function stateFor(room, pub, p) {
  const s = Object.assign({}, pub);
  const g = room.game;
  const playing = g ? !!g.players[p.id] && !g.players[p.id].auto : room.order.includes(p.id);
  s.me = { id: p.id, name: p.name, color: p.color, face: p.face, photo: p.photoV ? '/photo/' + room.code + '/' + p.id + '?v=' + p.photoV : null, isCaptain: pub.captain === p.id, playing };
  s.me.chats = chatsFor(room, p.id);
  s.fx = room.fx.filter(e => !e.only || e.only.includes(p.id));
  if (g && g.players[p.id]) {
    const me = g.players[p.id];
    const myTurn = g.turn && g.turn.pid === p.id && (g.phase === 'roll' || g.phase === 'main');
    s.me.res = me.res;
    s.me.dev = me.dev.map(c => ({ k: c.k, fresh: c.n >= g.turnCount, ok: c.k !== 'vp' && myTurn && !g.turn.devPlayed && c.n < g.turnCount }));
    s.me.score = score(g, p.id);
    // Offers made to me, or by me, in full.
    s.game = Object.assign({}, pub.game, { trades: g.trades.filter(tr => !tr.to || tr.to === p.id || tr.from === p.id) });
  }
  return s;
}
function pushAll(room) {
  room.touched = Date.now();
  pruneTrades(room);
  const pub = publicState(room);
  if (room.displays.size) {
    const d = JSON.stringify({ t: 'state', s: Object.assign({}, pub, { display: true }) });
    for (const ws of room.displays) if (ws.readyState === 1) ws.send(d);
  }
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'state', s: stateFor(room, pub, p) }));
  }
  queueBackup(room);
  scheduleBots(room);
}

/* -------------------------------------------------------------- messages */

function dropPlayer(room, p, kicked) {
  const g = room.game;
  if (g && g.players[p.id]) {
    // Mid-game, a bot keeps the seat warm so the island stays balanced. Joining again with the
    // same name takes the seat back.
    if (!p.bot && !g.players[p.id].auto && g.phase !== 'gameOver') {
      g.players[p.id].auto = true;
      g.trades = g.trades.filter(t => t.from !== p.id);
      log(room, p.name + ' leaves the table. A bot keeps the seat warm.', 'left');
      fx(room, 'leftGame', { pid: p.id });
    }
    p.connected = false; p.goneAt = Date.now();
    if (!g.order.some(id => { const x = room.players.get(id); return x && !x.bot && !g.players[id].auto; })) { stopClock(room); room.game = null; tidyLobby(room); fx(room, 'lobby'); }
  } else {
    const i = room.order.indexOf(p.id);
    if (i >= 0) room.order.splice(i, 1);
    room.players.delete(p.id);
  }
  if (p.ws) { send(p.ws, { t: 'left', kicked: !!kicked }); p.ws.room = null; p.ws.pid = null; p.ws = null; }
}
function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) {
    send(p.ws, { t: 'left', replaced: true });
    p.ws.room = null; p.ws.pid = null;
    try { p.ws.close(); } catch (e) { /* ignore */ }
  }
  p.ws = ws; p.connected = true; p.hold = 0; p.goneAt = 0; p.waitingFor = false;
  ws.room = room; ws.pid = p.id;
}
const justStarted = () => Date.now() - BOOT < RESTORE_WINDOW_MS;
function showOn(ws, room, admin) {
  if (ws.display && ws.room && ws.room !== room) ws.room.displays.delete(ws);
  ws.room = room; ws.display = true; ws.admin = admin;
  room.displays.add(ws);
}

function onMessage(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return;

  // The TV page starts a room: it becomes that room's big screen.
  if (m.t === 'create') {
    const room = newRoom();
    room.settings = cleanSettings(m.settings);
    showOn(ws, room, true);
    send(ws, { t: 'created', code: room.code, token: room.adminToken });
    return pushAll(room);
  }
  // A phone starts a room: no TV needed. Whoever starts it is the first captain.
  if (m.t === 'host') {
    const name = clean(m.name, 12).toUpperCase();
    if (!name) return send(ws, { t: 'error', msg: 'Enter your name.' });
    const room = newRoom();
    room.settings = cleanSettings(m.settings);
    const p = newPlayer(room, name, m);
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id, hosted: true });
    return pushAll(room);
  }
  if (m.t === 'load') {
    if (typeof m.blob !== 'string' || m.blob.length > BACKUP_MAX) return send(ws, { t: 'error', msg: 'That saved game can’t be read.' });
    const room = loadRoom(m.blob);
    if (!room) return send(ws, { t: 'error', msg: 'That saved game can’t be opened here. It was saved by a different server.' });
    if (m.tv) { showOn(ws, room, true); send(ws, { t: 'created', code: room.code, token: room.adminToken, loaded: true }); return pushAll(room); }
    return send(ws, { t: 'loaded', code: room.code });
  }
  if (m.t === 'watch' || m.t === 'restore') {
    const code = clean(m.code, 4).toUpperCase();
    let room = rooms.get(code), restored = false;
    if (!room && m.t === 'restore' && typeof m.blob === 'string' && m.blob.length <= BACKUP_MAX) { room = restoreRoom(m.blob, code, m.token, m.idle); restored = !!room; }
    if (m.phone) return send(ws, { t: 'restoreDone', ok: !!room });      // a phone handed the room back; it rejoins next
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: m.t === 'watch' && !m.token ? 'Can’t find that room. Check the 4-letter code.' : 'That game is no longer running.', wait: m.t === 'watch' && !!m.token && justStarted() });
    showOn(ws, room, !!m.token && m.token === room.adminToken);
    send(ws, { t: 'watching', code: room.code, admin: ws.admin, restored });
    return pushAll(room);
  }
  if (m.t === 'join') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'Can’t find that room. Check the 4-letter code.', wait: justStarted() });
    const name = clean(m.name, 12).toUpperCase();
    if (!name) return send(ws, { t: 'error', msg: 'Enter your name.' });
    let p = [...room.players.values()].find(x => x.name === name);
    const g = room.game;
    if (p) {
      if (p.bot) return send(ws, { t: 'error', msg: name + ' is a bot’s name. Pick another name.' });
      if (p.connected) return send(ws, { t: 'error', msg: 'Someone is already playing as ' + name + '. Pick another name.' });
      if (p.hold && Date.now() < p.hold) return send(ws, { t: 'error', msg: name + ' is still reconnecting. Try again in a few seconds, or pick another name.' });
      p.token = rid();
      if (g && g.players[p.id] && g.players[p.id].auto) { g.players[p.id].auto = false; log(room, name + ' is back at the table.', 'join'); }
    } else {
      if (g) return send(ws, { t: 'error', msg: 'That game is already under way. You can watch it from the big-screen page, or join the next one.' });
      if (room.order.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'This room is full: ' + MAX_PLAYERS + ' players.' });
      p = newPlayer(room, name, m);
      fx(room, 'joined', { name: p.name, pid: p.id });
    }
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    const p = room && [...room.players.values()].find(x => x.token === m.token);
    if (!p) return send(ws, { t: 'error', code: 'noroom', msg: 'That game has ended.', wait: !room && justStarted() });
    if (room.game && room.game.players[p.id] && room.game.players[p.id].auto) { room.game.players[p.id].auto = false; log(room, p.name + ' is back at the table.', 'join'); }
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }

  const room = ws.room;
  if (!room) return;
  if (ws.display) {
    if (!ws.admin) return;
    if (m.t === 'h') { adminAction(room, m, ws); return pushAll(room); }
    return;
  }
  const p = room.players.get(ws.pid);
  if (!p) return;
  const g = room.game;
  if (g && g.players[p.id] && g.players[p.id].auto) g.players[p.id].auto = false;

  switch (m.t) {
    case 'face': {
      if (g) break;
      const f = cleanFace(m.f);
      if (!f) { send(ws, { t: 'error', msg: 'Pick one emoji.' }); break; }
      p.face = f; setPhoto(p, null);
      break;
    }
    case 'photo': {
      if (g) break;
      if (m.data == null) { setPhoto(p, null); break; }
      const ph = cleanPhoto(m.data);
      if (!ph) { send(ws, { t: 'error', msg: 'That photo didn’t work. Try another one.' }); break; }
      setPhoto(p, ph);
      break;
    }
    case 'color': {
      if (g) break;
      const n = Number(m.n);
      if (!Number.isInteger(n) || n < 0 || n >= COLORS) break;
      if (colorTaken(room, n, p)) { send(ws, { t: 'error', msg: 'Someone already has that color.' }); break; }
      p.color = n;
      break;
    }
    case 'chat': chat(room, p, m); break;
    case 'h': if (captainId(room) === p.id) adminAction(room, m, ws); break;
    case 'leave': dropPlayer(room, p, false); break;
    default:
      if (!g || !g.players[p.id] || g.phase === 'gameOver') return;
      switch (m.t) {
        case 'place': placeSetup(room, p, m); break;
        case 'roll': rollDice(room, p); break;
        case 'discard': discard(room, p, m); break;
        case 'robber': moveRobber(room, p, m); break;
        case 'steal': steal(room, p, m); break;
        case 'build': build(room, p, m); break;
        case 'buyDev': buyDev(room, p); break;
        case 'dev': playDev(room, p, m); break;
        case 'roadsDone': if (g.phase === 'roads' && g.turn.pid === p.id) endRoads(room); break;
        case 'bank': bankTrade(room, p, m); break;
        case 'offer': offer(room, p, m); break;
        case 'answer': answer(room, p, m); break;
        case 'deal': deal(room, p, m); break;
        case 'cancelOffer': cancelOffer(room, p, m); break;
        case 'declineCounter': declineCounter(room, p, m); break;
        case 'end': endTurn(room, p); break;
        default: return;
      }
  }
  pushAll(room);
}
function onClose(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.display) { room.displays.delete(ws); return pushAll(room); }
  const p = room.players.get(ws.pid);
  if (p && p.ws === ws) {
    p.connected = false; p.ws = null; p.goneAt = Date.now();
    if (!room.game) { const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1); room.players.delete(p.id); }
    pushAll(room);
  }
}

/* ------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { onMessage(ws, m); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => { try { onClose(ws); } catch (e) { console.error('close error', e); } });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) { clearTimer(room); clearTimeout(room.backupTimer); clearTimeout(room.tidyTimer); clearTimeout(room.botTimer); rooms.delete(code); }
  }
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Settlers of Friends on port ' + PORT + ' (build ' + BUILD + ')'));
}
module.exports = { server, rooms, packRoom, unpackRoom, restoreRoom, loadRoom, pushAll, score, _t: { R, applyRoll, updateLongest, startTurn, endGame, botLikes, forceStep, actors } };
