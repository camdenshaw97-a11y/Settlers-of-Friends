'use strict';
/*
 * Plays the game against a real server with scripted screens: a TV and phones that settle the
 * island, roll, build, trade, rob and win. Checks the rules of the map on their own first, then
 * the turn order, the secrecy of every hand, each kind of trade, the development cards, the
 * robber, Longest Road and Largest Army, winning, a room surviving the server forgetting it
 * (handed back by the TV or by a phone), saving and loading, a player leaving and coming back,
 * and whole games played by bots on both islands.
 * The clocks run 60 times faster than in a real game.   Run with: npm test
 */
process.env.RESTORE_WINDOW_MS = '600000';
process.env.SPEED_UP = '60';
process.env.AWAY_MS = '9000';
const WebSocket = require('ws');
const R = require('../rules');
const { server, rooms, score, _t } = require('../server');

const PORT = 3996;
let failures = 0, passed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

class Screen {
  constructor(name) {
    this.name = name; this.state = null; this.msgs = []; this.last = {}; this.errors = [];
    this.ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    this.ready = new Promise(res => this.ws.on('open', res));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'state') this.state = m.s;
      if (m.t === 'error') this.errors.push(m.msg);
      this.last[m.t] = m;
      this.msgs.push(m);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(fn, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn(this.state, this.last)) return true; } catch (e) { /* not there yet */ } await wait(5); }
    return false;
  }
  // Send something and wait for the server's next snapshot (or its complaint).
  async act(m) { const n = this.msgs.length; this.send(m); await this.until(() => this.msgs.length > n, 1500); await wait(4); }
  get id() { return this.state.me.id; }
  get me() { return this.state.me; }
  get g() { return this.state.game; }
  close() { this.ws.close(); }
}
async function phone(code, name, extra) { const p = new Screen(name); await p.ready; p.send(Object.assign({ t: 'join', code, name }, extra || {})); await p.until(s => s && s.me); return p; }
async function tvRoom(settings) { const tv = new Screen('tv'); await tv.ready; tv.send({ t: 'create', settings }); await tv.until((s, l) => s && l.created); return tv; }
// Set a hand exactly, keeping the bank honest.
function hand(room, id, h) { const g = room.game, me = g.players[id]; for (const r of R.RES) { g.bank[r] += me.res[r]; me.res[r] = h[r] || 0; g.bank[r] -= me.res[r]; } }
function conserved(room) {
  const g = room.game, B = R.BOARDS[g.kind];
  for (const r of R.RES) { let n = g.bank[r]; for (const id of g.order) { if (g.players[id].res[r] < 0) return 'negative ' + r; n += g.players[id].res[r]; } if (n !== B.bank) return r + ' adds up to ' + n; }
  return null;
}
const sync = async (room, ...screens) => { const { pushAll } = require('../server'); pushAll(room); await wait(25); void screens; };
// Everyone places their opening pieces the way a careful player would.
async function settle(room, phones) {
  const order = [];
  for (let guard = 0; guard < 60 && room.game.phase === 'setup'; guard++) {
    const su = room.game.setup, p = phones.find(x => x.id === su.seq[su.i]);
    await p.until(s => s.phase === 'setup' && s.game.setup.pid === p.id && s.game.setup.step === su.step);
    if (su.step === 'settle') {
      const v = R.legalSettles(p.g, p.id, true).sort((a, b) => R.yieldAt(p.g, b).pips - R.yieldAt(p.g, a).pips)[0];
      order.push(p.name);
      await p.act({ t: 'place', v });
    } else await p.act({ t: 'place', e: R.legalRoads(p.g, p.id, p.g.setup.v)[0] });
  }
  return order;
}

async function rulesOfTheMap() {
  console.log('\nThe map');
  const C = R.geo('classic'), L = R.geo('large');
  check('the classic island has 19 hexes, 54 corners and 72 edges', C.hexes.length === 19 && C.verts.length === 54 && C.edges.length === 72);
  check('the big island has 30 hexes, 80 corners and 109 edges', L.hexes.length === 30 && L.verts.length === 80 && L.edges.length === 109);
  for (const G of [C, L]) {
    const seen = new Set(); let clash = false;
    G.slots.forEach(s => { if (seen.has(s.a) || seen.has(s.b)) clash = true; seen.add(s.a); seen.add(s.b); });
    check(G.kind + ': ' + G.slots.length + ' ports on the coast, none sharing a corner', !clash && G.slots.every(s => G.edges[s.e].h.length === 1));
  }
  let fair = true, counts = true;
  for (const kind of ['classic', 'large']) for (const mode of ['starter', 'balanced', 'random']) for (let i = 0; i < 25; i++) {
    const b = R.makeBoard(kind, mode, Math.random), B = R.BOARDS[kind];
    if (mode !== 'random' && !R.fair(R.geo(kind), b.hexes)) fair = false;
    const terr = {}; b.hexes.forEach(h => { terr[h.t] = (terr[h.t] || 0) + 1; });
    if (Object.keys(B.terrain).some(t => terr[t] !== B.terrain[t])) counts = false;
    if (b.hexes.filter(h => h.n).map(h => h.n).sort((x, y) => x - y).join() !== B.numbers.slice().sort((x, y) => x - y).join()) counts = false;
    if (b.hexes[b.robber].t !== 'desert' || b.ports.slice().sort().join() !== B.ports.slice().sort().join()) counts = false;
  }
  check('every island has the right tiles, numbers and ports, with the robber in the desert', counts);
  check('starter and balanced islands never put two red numbers or twin numbers side by side', fair);
  const a = R.makeBoard('classic', 'starter', Math.random), b = R.makeBoard('classic', 'starter', Math.random);
  check('the starter island is the same every time', JSON.stringify(a) === JSON.stringify(b));

  const g = { board: R.makeBoard('classic', 'starter', Math.random), b: {}, r: {}, longest: null, army: null };
  const v0 = C.hexes[9].v[0];
  g.b[v0] = { p: 'a', c: 0 };
  check('no settlement right next to another', C.verts[v0].n.every(n => !R.canSettle(g, 'b', n, true)) && !R.canSettle(g, 'b', v0, true));
  check('a settlement needs your own road once the opening is over', R.legalSettles(g, 'a', false).length === 0);
  // a trail of five roads from v0
  let at = v0, prev = -1;
  const trail = [];
  for (let i = 0; i < 5; i++) { const e = C.verts[at].e.find(x => x !== prev && !g.r[x] && R.canRoad(g, 'a', x)); g.r[e] = 'a'; trail.push(e); prev = e; at = C.edges[e].a === at ? C.edges[e].b : C.edges[e].a; }
  check('a road has to join your own network', R.legalRoads(g, 'b').length === 0 && R.legalRoads(g, 'a').length > 0);
  check('five roads in a row measure five', R.roadLength(g, 'a') === 5);
  check('a settlement two roads out is allowed', R.canSettle(g, 'a', at, false));
  // someone else settles in the middle of the trail
  const mid = [C.edges[trail[2]].a, C.edges[trail[2]].b].find(v => [C.edges[trail[1]].a, C.edges[trail[1]].b].includes(v));
  g.b[mid] = { p: 'b', c: 0 };
  check('another player’s settlement cuts a road in two', R.roadLength(g, 'a') === 3, 'got ' + R.roadLength(g, 'a'));
  check('...and blocks building on through it', !R.canRoad(Object.assign({}, g, { r: { [trail[0]]: 'a', [trail[1]]: 'a' } }), 'a', trail[2]));
  // harvest
  const g2 = { board: R.makeBoard('classic', 'starter', Math.random), b: {}, r: {} };
  const hx = g2.board.hexes.findIndex(h => h.n === 6), res = R.TERRAIN[g2.board.hexes[hx].t];
  g2.b[C.hexes[hx].v[0]] = { p: 'a', c: 1 }; g2.b[C.hexes[hx].v[3]] = { p: 'b', c: 0 };
  const hv = R.harvest(g2, 6).gains;
  check('a city collects two, a settlement one', hv.a[res] >= 2 && hv.b[res] >= 1);
  g2.board.robber = hx;
  const hv2 = R.harvest(g2, 6).gains;
  check('the robber’s hex pays nobody', !(hv2.a && hv2.a[res] >= 2 && R.harvest(Object.assign({}, g2, { board: Object.assign({}, g2.board, { robber: -1 }) }), 6).gains.a[res] === hv2.a[res]));
  // ports
  const g3 = { board: R.makeBoard('classic', 'starter', Math.random), b: {}, r: {} };
  const any = g3.board.ports.indexOf('any'), two = g3.board.ports.findIndex(p => p !== 'any');
  check('the bank asks four of a kind', R.rate(g3, 'a', 'wood') === 4);
  g3.b[C.slots[any].a] = { p: 'a', c: 0 };
  check('a 3:1 port makes it three', R.rate(g3, 'a', 'wood') === 3);
  g3.b[C.slots[two].b] = { p: 'a', c: 0 };
  check('a 2:1 port makes its own resource two', R.rate(g3, 'a', g3.board.ports[two]) === 2 && R.rate(g3, 'a', R.RES.find(r => r !== g3.board.ports[two])) === 3);
}

async function scriptedGame() {
  console.log('\nA scripted game: a TV and three phones');
  const tv = await tvRoom({ target: 10, board: 'starter' });
  const code = tv.state.code, room = rooms.get(code);
  const A = await phone(code, 'Anna'), B = await phone(code, 'Bo', { color: 0 }), C = await phone(code, 'Cy');
  const P = [A, B, C];
  await A.until(s => s.players.length === 3);
  check('three phones join; the first one in is the captain', A.state.players.length === 3 && A.me.isCaptain && !B.me.isCaptain);
  check('two players never share a colour', new Set(A.state.players.map(p => p.color)).size === 3);
  await B.act({ t: 'color', n: A.me.color });
  check('a taken colour is refused', B.errors.some(e => /already has that color/.test(e)));
  await B.act({ t: 'h', a: 'settings', settings: { target: 8 } });
  check('only the captain (or the TV) changes the settings', A.state.settings.target === 10);
  await A.act({ t: 'h', a: 'settings', settings: { target: 12, friendly: true } });
  check('the captain’s phone changes the settings', B.state.settings.target === 12 && B.state.settings.friendly === true);
  tv.send({ t: 'h', a: 'settings', settings: { target: 10, friendly: false } });
  await A.until(s => s.settings.target === 10);
  tv.send({ t: 'h', a: 'start' });
  await A.until(s => s.phase === 'rolloff');
  const g = room.game;
  const ro = A.g.rolloff, sums = id => ro.rolls[id][0] + ro.rolls[id][1];
  check('everyone rolls and the highest roll goes first', A.g.order[0] === ro.first && A.g.order.every(id => sums(id) <= sums(ro.first)));
  check('three or four players get the classic island', A.g.kind === 'classic');
  const late = new Screen('late'); await late.ready; late.send({ t: 'join', code, name: 'Dee' });
  await late.until(() => late.errors.length > 0);
  check('nobody new can join once the game is under way', /already under way/.test(late.errors[0] || ''));
  late.close();
  await A.until(s => s.phase === 'setup', 3000);

  // the opening
  const first = P.find(p => p.id === g.order[0]), close = R.legalSettles(first.g, first.id, true)[0];
  const wrong = P.find(p => p.id !== first.id);
  await wrong.act({ t: 'place', v: close });
  check('you can only place on your own turn', Object.keys(g.b).length === 0);
  const placed = await settle(room, P);
  const names = g.order.map(id => P.find(p => p.id === id).name);
  check('the opening goes round the table and back again', placed.join() === names.concat(names.slice().reverse()).join(), placed.join());
  await A.until(s => s.phase === 'roll');
  check('everyone has two settlements and two roads', g.order.every(id => { const c = R.count(g, id); return c.settlement === 2 && c.road === 2; }));
  check('the second settlement pays a card for each hex it touches', g.order.every(id => R.total(g.players[id].res) >= 1 && R.total(g.players[id].res) <= 3));
  check('cards are conserved', !conserved(room), conserved(room));
  check('no phone is ever sent another player’s hand', P.every(p => Object.keys(p.g.players).every(id => !('res' in p.g.players[id]) && !('dev' in p.g.players[id])) && p.me.res) && !('me' in tv.state));
  check('the TV knows how many cards each player holds, never which', tv.g.players[A.id].cards === R.total(g.players[A.id].res) && !JSON.stringify(tv.state).includes('"res"'));

  // the first turn
  const t1 = P.find(p => p.id === g.turn.pid), o1 = P.filter(p => p !== t1);
  await o1[0].act({ t: 'roll' });
  check('only the player whose turn it is can roll', !g.turn.rolled);
  for (const id of g.order) hand(room, id, {});
  _t.applyRoll(room, 2, 4); await sync(room);
  const exp = R.harvest(g, 6).gains;
  check('a roll pays every player built on that number', g.order.every(id => R.RES.every(r => g.players[id].res[r] === ((exp[id] || {})[r] || 0))) && g.phase === 'main');

  // ---- trading, the official way
  console.log('\nTrading');
  hand(room, t1.id, { wood: 2, brick: 1 }); hand(room, o1[0].id, { ore: 2, sheep: 1 }); hand(room, o1[1].id, { ore: 1, wheat: 2 });
  await sync(room);
  await o1[0].act({ t: 'offer', give: { ore: 1 }, want: { wheat: 1 } });
  check('official rule: an offer to the table has to come from the player whose turn it is', g.trades.length === 0 && o1[0].errors.some(e => /have to include/.test(e)));
  await t1.act({ t: 'offer', give: { wood: 1 }, want: {} });
  check('no free gifts', g.trades.length === 0);
  await t1.act({ t: 'offer', give: { wood: 1 }, want: { wood: 1 } });
  check('no swapping a resource for itself', g.trades.length === 0);
  await t1.act({ t: 'offer', give: { sheep: 2 }, want: { ore: 1 } });
  check('you can’t offer cards you don’t hold', g.trades.length === 0);
  await t1.act({ t: 'offer', give: { wood: 1 }, want: { ore: 1 } });
  await o1[1].until(s => s.game.trades.length === 1);
  check('a table offer lands on every other phone', o1.every(p => p.g.trades.length === 1 && p.g.trades[0].give.wood === 1) && tv.g.trades.length === 1);
  const tid = g.trades[0].id;
  await o1[0].act({ t: 'answer', id: tid, s: 'yes' });
  check('saying yes doesn’t move any cards yet: the offerer picks', g.players[t1.id].res.wood === 2 && g.trades[0].re[o1[0].id].s === 'yes');
  await o1[1].act({ t: 'answer', id: tid, s: 'counter', give: { ore: 1 }, want: { wood: 2 } });
  check('a counter sits in the same thread, in the offerer’s terms', g.trades[0].re[o1[1].id].s === 'counter' && g.trades[0].re[o1[1].id].give.wood === 2 && g.trades[0].re[o1[1].id].want.ore === 1);
  await t1.until(s => Object.keys(s.game.trades[0].re).length === 2);
  check('the offerer sees every answer as it comes in', t1.g.trades[0].re[o1[0].id].s === 'yes' && t1.g.trades[0].re[o1[1].id].s === 'counter');
  await o1[0].act({ t: 'deal', id: tid, with: o1[1].id });
  check('only the offerer can close the deal', g.trades.length === 1);
  await t1.act({ t: 'declineCounter', id: tid, pid: o1[1].id });
  check('the offerer can turn a counter down', g.trades[0].re[o1[1].id].s === 'declined');
  await t1.act({ t: 'deal', id: tid, with: o1[0].id });
  check('picking a yes swaps the cards and clears the offer', g.players[t1.id].res.wood === 1 && g.players[t1.id].res.ore === 1 && g.players[o1[0].id].res.wood === 1 && g.players[o1[0].id].res.ore === 1 && g.trades.length === 0);
  check('the deal is counted for both players', g.players[t1.id].stats.trades === 1 && g.players[o1[0].id].stats.trades === 1);
  // a question to the table
  await t1.act({ t: 'offer', want: { wheat: 1 }, ask: true });
  const ask = g.trades[0];
  check('“who has wheat?” goes out with nothing offered yet', ask && ask.ask && R.total(ask.give) === 0);
  await o1[1].act({ t: 'answer', id: ask.id, s: 'yes' });
  check('a question can’t be accepted, only answered with a price', !ask.re[o1[1].id]);
  await o1[1].act({ t: 'answer', id: ask.id, s: 'counter', give: { wheat: 1 }, want: { brick: 1 } });
  await t1.act({ t: 'deal', id: ask.id, with: o1[1].id });
  check('taking a counter trades on the counter’s terms', g.players[t1.id].res.wheat === 1 && g.players[t1.id].res.brick === 0 && g.players[o1[1].id].res.brick === 1);
  // an offer to one player
  await o1[0].act({ t: 'offer', to: t1.id, give: { sheep: 1 }, want: { wood: 1 } });
  check('anyone can offer the player whose turn it is a deal, just between the two of them', g.trades.length === 1 && g.trades[0].to === t1.id);
  await o1[1].until(s => true);
  check('a private offer is hidden from the rest of the table', o1[1].g.trades.length === 0 && tv.g.trades[0].hidden && !tv.g.trades[0].give);
  await t1.act({ t: 'answer', id: g.trades[0].id, s: 'yes' });
  check('a yes to a private offer is done on the spot', g.players[t1.id].res.sheep === 1 && g.players[t1.id].res.wood === 0 && g.trades.length === 0);
  // an offer its maker can no longer cover
  hand(room, t1.id, { ore: 4, wheat: 1 }); await sync(room);
  await t1.act({ t: 'offer', give: { wheat: 1 }, want: { brick: 1 } });
  await o1[1].act({ t: 'answer', id: g.trades[0].id, s: 'yes' });
  hand(room, o1[1].id, { wheat: 2 }); await sync(room);
  check('a yes is wiped if its maker loses the cards', g.trades.length === 1 && !g.trades[0].re[o1[1].id]);
  hand(room, t1.id, { ore: 4 }); await sync(room);
  check('an offer is withdrawn if its maker loses the cards', g.trades.length === 0);
  // the bank
  hand(room, o1[0].id, { ore: 4 }); await sync(room);
  await o1[0].act({ t: 'bank', give: 'ore', get: 'wood', n: 1 });
  check('the bank only deals with the player whose turn it is', g.players[o1[0].id].res.ore === 4 && g.players[o1[0].id].res.wood === 0);
  await t1.act({ t: 'bank', give: 'ore', get: 'brick', n: 1 });
  const rate = R.rate(g, t1.id, 'ore');
  check('the bank swaps ' + rate + ' ore for 1 brick', g.players[t1.id].res.ore === 4 - rate && g.players[t1.id].res.brick === 1 && !conserved(room));

  // ---- building
  console.log('\nBuilding');
  hand(room, t1.id, { wood: 1 }); await sync(room);
  const e1 = R.legalRoads(g, t1.id)[0];
  await t1.act({ t: 'build', what: 'road', at: e1 });
  check('you can’t build what you can’t afford', g.r[e1] == null);
  hand(room, t1.id, { wood: 5, brick: 5, sheep: 2, wheat: 4, ore: 4 }); await sync(room);
  await t1.act({ t: 'build', what: 'road', at: e1 });
  check('a road costs a wood and a brick', g.r[e1] === t1.id && g.players[t1.id].res.wood === 4 && g.players[t1.id].res.brick === 4);
  const far = R.geo('classic').edges.findIndex((E, i) => g.r[i] == null && !R.canRoad(g, t1.id, i));
  await t1.act({ t: 'build', what: 'road', at: far });
  check('a road out on its own is refused', g.r[far] == null);
  for (let i = 0; i < 3 && !R.legalSettles(g, t1.id, false).length; i++) await t1.act({ t: 'build', what: 'road', at: R.legalRoads(g, t1.id).find(e => { const E = R.geo('classic').edges[e]; return [E.a, E.b].some(v => !g.b[v] && R.geo('classic').verts[v].n.every(n => !g.b[n])); }) || R.legalRoads(g, t1.id)[0] });
  const spot = R.legalSettles(g, t1.id, false)[0];
  hand(room, t1.id, { wood: 1, brick: 1, sheep: 1, wheat: 3, ore: 3 }); await sync(room);
  if (spot != null) {
    await t1.act({ t: 'build', what: 'settlement', at: spot });
    check('a settlement goes up at the end of your road', g.b[spot] && g.b[spot].p === t1.id && R.points(g, t1.id) === 3);
  } else check('a settlement goes up at the end of your road', false, 'no spot opened up');
  const town = R.legalCities(g, t1.id)[0];
  await t1.act({ t: 'build', what: 'city', at: town });
  check('a city replaces a settlement for two wheat and three ore', g.b[town].c === 1 && g.players[t1.id].res.ore === 0 && R.points(g, t1.id) === 4);
  check('the public score follows the board', t1.g.players[t1.id].pts === 4 && t1.me.score === 4);

  // ---- development cards
  console.log('\nDevelopment cards');
  hand(room, t1.id, { sheep: 3, wheat: 3, ore: 3 });
  g.deck.push('vp', 'mono', 'knight'); await sync(room);
  const deckWas = g.deck.length;
  await t1.act({ t: 'buyDev' });
  check('buying a card costs a sheep, a wheat and an ore', g.players[t1.id].dev.length === 1 && g.players[t1.id].dev[0].k === 'knight' && g.deck.length === deckWas - 1 && g.players[t1.id].res.ore === 2);
  check('only its owner sees what it is', t1.me.dev[0].k === 'knight' && o1[0].g.players[t1.id].devs === 1 && !JSON.stringify(o1[0].state).includes('"k":"knight"') && !JSON.stringify(tv.state).includes('"k":"knight"'));
  await t1.act({ t: 'dev', k: 'knight' });
  check('a card can’t be played the turn it was bought', g.players[t1.id].knights === 0 && t1.errors.some(e => /bought that this turn/.test(e)));
  await t1.act({ t: 'buyDev' }); await t1.act({ t: 'buyDev' });
  check('a Victory Point card counts at once, in secret', score(g, t1.id) === 5 && R.points(g, t1.id) === 4 && t1.me.score === 5 && o1[0].g.players[t1.id].pts === 4);
  await t1.act({ t: 'end' });
  check('ending the turn passes the dice to the next player', g.turn.pid === g.order[(g.order.indexOf(t1.id) + 1) % 3] && g.phase === 'roll');

  // a seven
  console.log('\nSevens and the robber');
  const t2 = P.find(p => p.id === g.turn.pid), o2 = P.filter(p => p !== t2);
  hand(room, t2.id, { wood: 4, brick: 4, sheep: 1 }); hand(room, o2[0].id, { ore: 3, wheat: 4 }); hand(room, o2[1].id, { ore: 8 });
  _t.applyRoll(room, 3, 4); await sync(room);
  check('on a 7, everyone holding more than 7 must discard half (rounded down)', g.phase === 'discard' && g.discard[t2.id] === 4 && g.discard[o2[1].id] === 4 && !g.discard[o2[0].id]);
  await t2.act({ t: 'discard', cards: { wood: 1 } });
  check('the discard has to be the exact number', g.discard[t2.id] === 4);
  await t2.act({ t: 'discard', cards: { wood: 2, brick: 2 } });
  await t2.act({ t: 'robber', hex: 0 });
  check('the robber waits until everyone has discarded', g.phase === 'discard');
  await o2[1].act({ t: 'discard', cards: { ore: 4 } });
  check('then the roller moves the robber', g.phase === 'robber' && R.total(g.players[t2.id].res) === 5 && g.players[o2[1].id].res.ore === 4 && !conserved(room));
  await t2.act({ t: 'robber', hex: g.board.robber });
  check('the robber has to move somewhere new', g.phase === 'robber');
  const geo = R.geo('classic');
  const target = R.robberHexes(g, t2.id, false).find(h => R.playersOn(g, h).some(id => id !== t2.id));
  const before = R.total(g.players[t2.id].res);
  await t2.act({ t: 'robber', hex: target });
  if (g.phase === 'steal') await t2.act({ t: 'steal', pid: g.steal.victims[0] });
  check('the robber’s mover steals one card from someone built there', g.board.robber === target && R.total(g.players[t2.id].res) === before + 1 && g.phase === 'main' && !conserved(room));
  check('the thief and the victim are told which card, and nobody else is', t2.state.fx.some(e => e.type === 'stole') && !tv.state.fx.some(e => e.type === 'stole' || e.type === 'robbed'));
  await t2.act({ t: 'end' });

  // knights, on the next player's turns
  const t3 = P.find(p => p.id === g.turn.pid);
  check('the dice go round the table in order', t3.id === g.order[(g.order.indexOf(t2.id) + 1) % 3]);
  await t3.act({ t: 'roll' });
  if (g.phase === 'discard') for (const id of Object.keys(g.discard)) { const h = Object.assign({}, g.players[id].res), cards = R.empty(); let n = g.discard[id]; for (const r of R.RES) while (n > 0 && h[r] > 0) { h[r]--; cards[r]++; n--; } await P.find(p => p.id === id).act({ t: 'discard', cards }); }
  if (g.phase === 'robber') await t3.act({ t: 'robber', hex: R.robberHexes(g, t3.id, false).find(h => !R.playersOn(g, h).length) });
  await t3.act({ t: 'end' });
  // back to the first player, who now holds an old knight
  check('it comes back round to the first player', g.turn.pid === t1.id && g.phase === 'roll');
  g.players[t1.id].dev.push({ k: 'knight', n: 0 }, { k: 'knight', n: 0 }, { k: 'plenty', n: 0 }, { k: 'mono', n: 0 }, { k: 'road', n: 0 }); await sync(room);
  check('a card bought on an earlier turn can be played, even before rolling', t1.me.dev.filter(c => c.ok).length >= 5);
  const emptyHex = R.robberHexes(g, t1.id, false).find(h => !R.playersOn(g, h).length);
  await t1.act({ t: 'dev', k: 'knight' });
  check('a Knight sends the robber out', g.phase === 'robber' && g.players[t1.id].knights === 1);
  await t1.act({ t: 'robber', hex: emptyHex });
  check('...and afterwards the turn carries on where it was', g.phase === 'roll' && g.board.robber === emptyHex);
  await t1.act({ t: 'dev', k: 'plenty', a: 'wood', b: 'wood' });
  check('only one development card a turn', t1.errors.some(e => /Only one development card/.test(e)));
  // three knights over three turns
  for (let k = 0; k < 2; k++) {
    g.turn.devPlayed = false;
    await t1.act({ t: 'dev', k: 'knight' });
    await t1.act({ t: 'robber', hex: R.robberHexes(g, t1.id, false).find(h => !R.playersOn(g, h).length) });
  }
  check('three Knights take the Largest Army, worth two points', g.army && g.army.pid === t1.id && R.points(g, t1.id) === 6);
  g.turn.devPlayed = false;
  hand(room, t1.id, {}); hand(room, o1[0].id, { wheat: 3, ore: 1 }); hand(room, o1[1].id, { wheat: 2 });
  await t1.act({ t: 'dev', k: 'plenty', a: 'wood', b: 'brick' });
  check('Year of Plenty takes two cards from the bank', g.players[t1.id].res.wood === 1 && g.players[t1.id].res.brick === 1 && !conserved(room));
  g.turn.devPlayed = false;
  await t1.act({ t: 'dev', k: 'mono', a: 'wheat' });
  check('Monopoly takes every card of one kind from everyone else', g.players[t1.id].res.wheat === 5 && g.players[o1[0].id].res.wheat === 0 && g.players[o1[1].id].res.wheat === 0 && g.players[o1[0].id].res.ore === 1);
  g.turn.devPlayed = false;
  const roadsWas = R.count(g, t1.id).road, woodWas = g.players[t1.id].res.wood;
  await t1.act({ t: 'dev', k: 'road' });
  check('Road Building opens two free roads', g.phase === 'roads' && g.roads.left === 2);
  await t1.act({ t: 'build', what: 'road', at: R.legalRoads(g, t1.id)[0] });
  await t1.act({ t: 'build', what: 'road', at: R.legalRoads(g, t1.id)[0] });
  check('...and they cost nothing', R.count(g, t1.id).road === roadsWas + 2 && g.players[t1.id].res.wood === woodWas && g.phase === 'roll');

  // longest road
  console.log('\nLongest Road, and winning');
  const len0 = g.players[t1.id].roadLen;
  for (let i = 0; i < 6 && !(g.longest && g.longest.pid === t1.id); i++) {
    let best = null, bl = -1;
    for (const e of R.legalRoads(g, t1.id)) { g.r[e] = t1.id; const l = R.roadLength(g, t1.id); delete g.r[e]; if (l > bl) { bl = l; best = e; } }
    g.r[best] = t1.id; _t.updateLongest(room);
  }
  await sync(room);
  check('five roads in a row take the Longest Road, worth two points', g.longest && g.longest.pid === t1.id && g.longest.len >= 5 && R.points(g, t1.id) === 8, 'from ' + len0 + ' to ' + g.players[t1.id].roadLen);
  // someone else matches it: the holder keeps it
  const other = o1[0].id;
  for (let i = 0; i < 12 && R.roadLength(g, other) < g.longest.len; i++) {
    let best = null, bl = -1;
    for (const e of R.legalRoads(g, other)) { g.r[e] = other; const l = R.roadLength(g, other); delete g.r[e]; if (l > bl) { bl = l; best = e; } }
    if (best == null) break;
    g.r[best] = other; _t.updateLongest(room);
    if (R.roadLength(g, other) > g.players[t1.id].roadLen) { delete g.r[best]; _t.updateLongest(room); break; }
  }
  check('a tie leaves the Longest Road where it is', g.longest.pid === t1.id);
  // the win: one more secret point on top of 8 public + 1 secret
  check('nine points is not enough', score(g, t1.id) === 9 && g.phase !== 'gameOver');
  await t1.act({ t: 'roll' });
  if (g.phase === 'discard') for (const id of Object.keys(g.discard)) { const h = Object.assign({}, g.players[id].res), cards = R.empty(); let n = g.discard[id]; for (const r of R.RES) while (n > 0 && h[r] > 0) { h[r]--; cards[r]++; n--; } await P.find(p => p.id === id).act({ t: 'discard', cards }); }
  if (g.phase === 'robber') await t1.act({ t: 'robber', hex: R.robberHexes(g, t1.id, false).find(h => !R.playersOn(g, h).length) });
  hand(room, t1.id, { sheep: 1, wheat: 1, ore: 1 }); g.deck.push('vp'); await sync(room);
  // somebody else reaching the target off-turn does not end the game
  g.players[other].dev.push({ k: 'vp', n: 0 }, { k: 'vp', n: 0 }, { k: 'vp', n: 0 }, { k: 'vp', n: 0 }, { k: 'vp', n: 0 }, { k: 'vp', n: 0 }, { k: 'vp', n: 0 }, { k: 'vp', n: 0 });
  await t1.act({ t: 'bank', give: 'ore', get: 'wood', n: 1 });
  check('you can only win on your own turn', score(g, other) >= 10 && g.phase === 'main');
  g.players[other].dev = [];
  await t1.act({ t: 'buyDev' });
  await A.until(s => s.phase === 'gameOver');
  check('the tenth point ends the game on the spot', g.phase === 'gameOver' && g.winner === t1.id);
  check('the end shows everyone’s secret points and the awards', A.g.players[t1.id].final.pts === 10 && A.g.players[t1.id].final.vp === 2 && Array.isArray(A.g.awards) && tv.g.winner === t1.id);
  await A.act({ t: 'h', a: 'again' });
  check('the captain can deal a new island and play again with the same table', room.game && room.game.phase === 'rolloff' && room.game !== g);
  [tv, A, B, C].forEach(s => s.close());
  void geo;
}

async function openTable() {
  console.log('\nOpen-table trading, the friendly robber and the clock');
  const tv = await tvRoom({ trading: 'open', friendly: true, turn: 60, board: 'balanced' });
  const code = tv.state.code, room = rooms.get(code);
  const A = await phone(code, 'Anna'), B = await phone(code, 'Bo'), C = await phone(code, 'Cy');
  const P = [A, B, C];
  tv.send({ t: 'h', a: 'start' }); await A.until(s => s.phase === 'rolloff');
  tv.send({ t: 'h', a: 'skipIntro' }); await A.until(s => s.phase === 'setup');
  await settle(room, P);
  const g = room.game;
  await A.until(s => s.phase === 'roll');
  const t1 = P.find(p => p.id === g.turn.pid), o = P.filter(p => p !== t1);
  hand(room, o[0].id, { wood: 1 }); hand(room, o[1].id, { ore: 1 }); await sync(room);
  await o[0].act({ t: 'offer', to: o[1].id, give: { wood: 1 }, want: { ore: 1 } });
  await o[1].act({ t: 'answer', id: g.trades[0] ? g.trades[0].id : 0, s: 'yes' });
  check('with open trading, two players can deal on someone else’s turn', g.players[o[0].id].res.ore === 1 && g.players[o[1].id].res.wood === 1);
  check('the friendly robber leaves players on two points alone', R.robberHexes(g, t1.id, true).every(h => R.playersOn(g, h).every(id => id === t1.id)));
  check('a turn clock is running', g.clock && g.clock.what === 'turn' && t1.g.clock.left > 0);
  const turnWas = g.turnCount;
  await A.until(() => g.turnCount > turnWas, 4000);
  check('when the clock runs out the game rolls, tidies up and moves on', g.turnCount > turnWas && g.log.some(l => /out of time/.test(l.text)));
  [tv, A, B, C].forEach(s => s.close());
}

async function survival() {
  console.log('\nSurviving a restart, saving, leaving');
  // A room started from a phone, with no TV at all.
  const A = new Screen('Anna'); await A.ready;
  A.send({ t: 'host', name: 'Anna', settings: { board: 'starter' } });
  await A.until((s, l) => s && l.joined);
  const code = A.state.code, room = rooms.get(code);
  check('a phone can start a room with no TV, and its owner is the captain', A.last.joined.hosted && A.me.isCaptain && !A.state.tv);
  const B = await phone(code, 'Bo');
  await A.act({ t: 'h', a: 'addBot' });
  check('the captain’s phone adds a bot', A.state.players.length === 3 && A.state.players[2].bot);
  await A.act({ t: 'h', a: 'start' });
  await A.until(s => s.phase === 'rolloff'); await A.act({ t: 'h', a: 'skipIntro' });
  const P = [A, B];
  for (let guard = 0; guard < 400 && room.game.phase === 'setup'; guard++) {
    const su = room.game.setup, p = P.find(x => x.id === su.seq[su.i]);
    if (!p) { await wait(10); continue; }
    await p.until(s => s.phase === 'setup' && s.game.setup.pid === p.id && s.game.setup.step === su.step);
    if (su.step === 'settle') await p.act({ t: 'place', v: R.legalSettles(p.g, p.id, true)[0] }); else await p.act({ t: 'place', e: R.legalRoads(p.g, p.id, p.g.setup.v)[0] });
  }
  check('a bot places its own opening pieces', room.game.phase !== 'setup' && R.count(room.game, A.state.players[2].id).settlement === 2);
  await A.until((s, l) => l.backup && l.backup.code === code);
  await B.until((s, l) => l.backup);
  check('every phone holds a sealed copy of the room', typeof A.last.backup.blob === 'string' && typeof B.last.backup.blob === 'string' && !A.last.backup.blob.includes('res'));
  // the server forgets the room; a phone hands it back
  const g0 = room.game, snap = JSON.stringify({ b: g0.b, r: g0.r, res: g0.order.map(id => g0.players[id].res), turn: g0.turn.pid });
  await wait(450);
  const blob = B.last.backup.blob, tokenA = A.last.joined.token, tokenB = B.last.joined.token;
  clearTimeout(room.timer); clearTimeout(room.botTimer); clearTimeout(room.backupTimer);
  rooms.delete(code);
  for (const p of room.players.values()) if (p.ws) { p.ws.room = null; }
  const B2 = new Screen('Bo'); await B2.ready;
  B2.send({ t: 'rejoin', code, token: tokenB });
  await B2.until(() => B2.errors.length > 0);
  check('a phone that finds its room gone is asked to wait', B2.last.error.code === 'noroom' && B2.last.error.wait === true);
  B2.send({ t: 'restore', phone: true, code, token: 'not-a-real-token', blob });
  await B2.until((s, l) => l.restoreDone);
  check('a stranger can’t hand a room back', B2.last.restoreDone.ok === false && !rooms.has(code));
  delete B2.last.restoreDone;
  B2.send({ t: 'restore', phone: true, code, token: tokenB, blob });
  await B2.until((s, l) => l.restoreDone);
  B2.send({ t: 'rejoin', code, token: tokenB });
  await B2.until(s => s && s.game);
  const room2 = rooms.get(code), g1 = room2 && room2.game;
  check('a phone at the table hands the room back, same code', !!room2 && B2.last.restoreDone.ok === true && B2.state.code === code);
  check('the island, the hands and the turn are exactly as they were', g1 && JSON.stringify({ b: g1.b, r: g1.r, res: g1.order.map(id => g1.players[id].res), turn: g1.turn.pid }) === snap);
  const A2 = new Screen('Anna'); await A2.ready;
  A2.send({ t: 'rejoin', code, token: tokenA }); await A2.until(s => s && s.game && s.me);
  check('the other phone walks back in with its old seat', A2.me.name === 'ANNA' && A2.me.isCaptain && R.total(A2.me.res) === R.total(g1.players[A2.id].res));
  A.close(); B.close();

  // a big screen can watch a phone's room with just the code, but can't run it
  const tv = new Screen('tv'); await tv.ready;
  tv.send({ t: 'watch', code }); await tv.until(s => s && s.game);
  tv.send({ t: 'h', a: 'endGame' }); await wait(40);
  check('a big screen can show a phone’s game from its code, hands hidden, hands off', tv.last.watching && !tv.last.watching.admin && room2.game.phase !== 'gameOver' && !('me' in tv.state) && A2.state.tv === true);

  // saving and loading
  await A2.act({ t: 'h', a: 'save' });
  await A2.until((s, l) => l.saved);
  check('the captain saves the game to their phone', typeof A2.last.saved.blob === 'string' && A2.last.saved.info.players.slice().sort().join() === A2.state.players.map(p => p.name).sort().join());
  const L = new Screen('Anna'); await L.ready;
  L.send({ t: 'load', blob: A2.last.saved.blob }); await L.until((s, l) => l.loaded);
  const code3 = L.last.loaded.code, room3 = rooms.get(code3);
  check('a saved game opens as a new room with a new code', code3 !== code && room3 && room3.game && JSON.stringify(room3.game.b) === JSON.stringify(room2.game.b));
  L.send({ t: 'join', code: code3, name: 'Anna' }); await L.until(s => s && s.me && s.game);
  check('joining it with your old name gives you your seat and your cards back', L.me.name === 'ANNA' && JSON.stringify(L.me.res) === JSON.stringify(room2.game.players[A2.id].res));
  const X = new Screen('x'); await X.ready; X.send({ t: 'join', code: code3, name: 'Zed' }); await X.until(() => X.errors.length > 0);
  check('a stranger can’t take a seat in a saved game', /already under way/.test(X.errors[0] || ''));
  X.close(); L.close();

  // leaving and coming back
  const gg = room2.game;
  await B2.act({ t: 'leave' });
  const bid = [...room2.players.values()].find(p => p.name === 'BO').id;
  check('a player who leaves mid-game is replaced by a bot, so the island stays balanced', gg.players[bid].auto === true && A2.g.players[bid].auto === true && B2.last.left);
  const turnWas = gg.turnCount;
  // let the table play on for a bit: Anna just rolls and ends her turns
  for (let i = 0; i < 300 && gg.turnCount < turnWas + 4 && gg.phase !== 'gameOver'; i++) {
    if (gg.phase === 'roll' && gg.turn.pid === A2.id) await A2.act({ t: 'roll' });
    else if (gg.phase === 'discard' && gg.discard[A2.id]) { const h = Object.assign({}, gg.players[A2.id].res), cards = R.empty(); let n = gg.discard[A2.id]; for (const r of R.RES) while (n > 0 && h[r] > 0) { h[r]--; cards[r]++; n--; } await A2.act({ t: 'discard', cards }); }
    else if (gg.phase === 'robber' && gg.turn.pid === A2.id) await A2.act({ t: 'robber', hex: R.robberHexes(gg, A2.id, false)[0] });
    else if (gg.phase === 'steal' && gg.turn.pid === A2.id) await A2.act({ t: 'steal', pid: gg.steal.victims[0] });
    else if (gg.phase === 'main' && gg.turn.pid === A2.id) await A2.act({ t: 'end' });
    else await wait(15);
  }
  check('the bot plays the empty seat’s turns', gg.turnCount >= turnWas + 4, 'turn ' + gg.turnCount + ' from ' + turnWas);
  const B3 = await phone(code, 'Bo');
  check('joining again with the same name takes the seat back', B3.me.playing && gg.players[bid].auto === false && B3.id === bid);
  // a phone that just goes quiet is played for, minimally
  B3.close(); await wait(30);
  const t0 = gg.turnCount;
  for (let i = 0; i < 400 && gg.turnCount < t0 + 3 && gg.phase !== 'gameOver'; i++) {
    if (gg.phase === 'roll' && gg.turn.pid === A2.id) await A2.act({ t: 'roll' });
    else if (gg.phase === 'discard' && gg.discard[A2.id]) { const h = Object.assign({}, gg.players[A2.id].res), cards = R.empty(); let n = gg.discard[A2.id]; for (const r of R.RES) while (n > 0 && h[r] > 0) { h[r]--; cards[r]++; n--; } await A2.act({ t: 'discard', cards }); }
    else if (gg.phase === 'robber' && gg.turn.pid === A2.id) await A2.act({ t: 'robber', hex: R.robberHexes(gg, A2.id, false)[0] });
    else if (gg.phase === 'steal' && gg.turn.pid === A2.id) await A2.act({ t: 'steal', pid: gg.steal.victims[0] });
    else if (gg.phase === 'main' && gg.turn.pid === A2.id) await A2.act({ t: 'end' });
    else await wait(15);
  }
  check('a phone that drops off is rolled for after a while, so the game never sticks', gg.turnCount >= t0 + 3 && gg.log.some(l => /is away/.test(l.text)));
  check('cards are still conserved after all that', !conserved(room2), conserved(room2));
  [A2, B2, tv].forEach(s => s.close());

  // the TV hands back a room it started
  const tv2 = await tvRoom({});
  const c2 = tv2.state.code, r2 = rooms.get(c2), C = await phone(c2, 'Cy'), D = await phone(c2, 'Dee');
  tv2.send({ t: 'h', a: 'start' }); await C.until(s => s.phase === 'rolloff');
  await tv2.until((s, l) => l.backup && l.backup.info.phase === 'rolloff');
  await wait(420);
  const tb = tv2.last.backup.blob, tok = tv2.last.created.token;
  clearTimeout(r2.timer); clearTimeout(r2.botTimer); clearTimeout(r2.backupTimer); rooms.delete(c2);
  const tv3 = new Screen('tv'); await tv3.ready;
  tv3.send({ t: 'restore', code: c2, token: tok, blob: tb }); await tv3.until(s => s && s.game);
  check('the TV that started a room can hand it back too', tv3.last.watching.restored && tv3.last.watching.admin && rooms.get(c2).game.order.length === 2);
  await tv3.until(s => s.phase === 'setup', 3000);
  check('...and its clocks pick up where they left off', rooms.get(c2).game.phase === 'setup');
  [tv2, tv3, C, D].forEach(s => s.close());
}

async function botGames() {
  console.log('\nWhole games played by bots');
  for (const [n, settings, label] of [[4, { target: 10, board: 'balanced' }, 'four bots on the classic island'], [3, { target: 8, trading: 'open', dice: 'balanced', friendly: true }, 'three bots, open trading, balanced dice, friendly robber'], [6, { target: 10, board: 'random' }, 'six bots on the big island with the extra build phase']]) {
    const tv = await tvRoom(settings), code = tv.state.code, room = rooms.get(code);
    for (let i = 0; i < n; i++) tv.send({ t: 'h', a: 'addBot' });
    await tv.until(s => s.players.length === n);
    tv.send({ t: 'h', a: 'start' });
    await tv.until(s => s.phase === 'rolloff'); tv.send({ t: 'h', a: 'skipIntro' });
    let bad = null, special = false, t0 = Date.now(), maxHand = 0;
    while (Date.now() - t0 < 60000) {
      await wait(15);
      const g = room.game;
      if (!g) { bad = 'the game vanished'; break; }
      bad = bad || conserved(room);
      if (g.phase === 'special') special = true;
      for (const id of g.order) { const c = R.count(g, id); if (c.road > 15 || c.settlement > 5 || c.city > 4) bad = 'too many pieces'; maxHand = Math.max(maxHand, R.total(g.players[id].res)); }
      if (g.phase === 'gameOver') break;
    }
    const g = room.game, dev = g.deck.length + g.order.reduce((s, id) => s + g.players[id].dev.length, 0), B = R.BOARDS[g.kind];
    const played = Object.values(B.dev).reduce((a, b) => a + b, 0) - dev;
    check(label + ': a winner in ' + g.turnCount + ' turns', g.phase === 'gameOver' && score(g, g.winner) >= g.target, 'phase ' + g.phase + ', turn ' + g.turnCount);
    check('  cards and pieces stayed honest the whole way', !bad, bad);
    check('  the bots traded with each other and with the bank', g.order.reduce((s, id) => s + g.players[id].stats.trades, 0) > 0 && g.order.reduce((s, id) => s + g.players[id].stats.bank, 0) > 0);
    check('  development cards were bought and played', played >= 0 && g.order.reduce((s, id) => s + g.players[id].stats.devs, 0) > 0);
    if (n === 6) check('  the big island was used, with extra build phases', g.kind === 'large' && special);
    if (settings.dice === 'balanced') check('  balanced dice kept the numbers close to their odds', Math.abs(g.hist[7] / g.turnCount - 1 / 6) < 0.1, g.hist[7] + ' sevens in ' + g.turnCount);
    tv.close();
  }
}

server.listen(PORT, async () => {
  try {
    await rulesOfTheMap();
    await scriptedGame();
    await openTable();
    await survival();
    await botGames();
  } catch (e) { failures++; console.log('  FAIL the test run crashed — ' + (e && e.stack || e)); }
  console.log('\n' + (failures ? failures + ' FAILED, ' : '') + passed + ' passed');
  process.exit(failures ? 1 : 0);
});
