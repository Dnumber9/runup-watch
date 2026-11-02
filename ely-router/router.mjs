// ely-router: one-tap Elysium trading from Telegram.
//
// Runs on your own VPS with a fresh burner wallet. The key is generated on the VPS (setup.sh) and only
// lives in .env there (chmod 600). Paste any Elysium token address into the trade bot to get a card with
// Buy and Sell buttons. Alerts from the watcher carry ⚡ buttons that buy in one tap through this bot.
//
// Routes:
//   1. Every Uniswap v4 pool on Elysium paired with native HYPE, on any pool manager (eleos, BOXA, Kleos,
//      ElysPump, and any new launchpad the moment its first pool appears). The bot keeps its own live index
//      of every pool (Initialize events, re-read every few seconds) and buys through eleos's stateless v4
//      router on whichever pool gives the most tokens. New launches work from their first block.
//   2. KyberSwap's aggregator, for everything else it indexes on Elysium (v3 DEXes, WHYPE pairs).
//
// Safety before every buy:
//   Sell check: the buy is simulated together with an immediate sell of everything it returns (a tiny
//   helper contract placed only inside the simulation, never deployed). If the coin cannot be sold back
//   (honeypot, blocked sells) or the round trip loses more than the tax limit, the bot does not buy and
//   offers a "Buy anyway" button instead.
//   Stale taps: a ⚡ tap on an alert older than a few minutes shows the coin's current card first, and a
//   second tap on the same button within a few seconds is ignored.
//
// While you hold a coin (checked every 2 seconds):
//   Orders: take profit, stop loss and trailing stop per coin, and an optional preset added to every buy.
//   Dev guard: the coin's creator (sender of the transaction that opened its first pool) is watched; when
//   they have sold or moved away a set share of their bag, the bot sells everything.
//   Rug guard: a coin that passed the sell check at entry is re-checked; if sells get blocked or the round
//   trip cost jumps, the bot sells everything.
// Hunting:
//   Snipes: buy a token the moment its pool opens, the next coin a given wallet launches, or the first coins
//   on a pool manager nobody has used before (a new launchpad going live). The pool index tails the chain
//   every 0.4 s while a snipe is armed.
//   Copy trading: mirror the first buy of each coin by wallets you choose (and their sells), with a size
//   per wallet and a daily cap. The wallet list lives only in state.json on the VPS.
//   Limit buys: buy when a coin's market cap falls to (or rises past) a level.
// Speed: the buy goes out before the Telegram message, the sell check doubles as the quote, coins are
//   approved right after a buy so every sell is one transaction, receipts are polled every 0.3 s.
//
// Chat (only from OWNER_ID): /help lists every command.
//
// CLI: node router.mjs --new-wallet   creates a burner key in .env if there is none, prints the address

import fs from 'node:fs';
import { keccak256, concat, pad as vpad, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

// ── config ─────────────────────────────────────────────────────────────────────────────────────────
const ENV = new URL('./.env', import.meta.url);
const readEnv = () => {
  if (!fs.existsSync(ENV)) return;
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
};
readEnv();

if (process.argv[2] === '--new-wallet') {
  if (process.env.PRIVATE_KEY) {
    console.log('A wallet already exists:', privateKeyToAccount(process.env.PRIVATE_KEY).address);
  } else {
    const key = generatePrivateKey();
    fs.appendFileSync(ENV, `${fs.existsSync(ENV) && !fs.readFileSync(ENV, 'utf8').endsWith('\n') ? '\n' : ''}PRIVATE_KEY=${key}\n`);
    fs.chmodSync(ENV, 0o600);
    console.log('New burner wallet:', privateKeyToAccount(key).address);
    console.log('Its key is in .env on this machine only. Fund the address with HYPE on Elysium.');
  }
  process.exit(0);
}

const need = (k) => { if (!process.env[k]) { console.error(`missing ${k} in .env`); process.exit(1); } return process.env[k]; };
const TG = need('TRADE_BOT_TOKEN');
const OWNER = String(need('OWNER_ID'));
const account = privateKeyToAccount(need('PRIVATE_KEY'));
const me = account.address.toLowerCase();

const CHAIN_ID = 99901;
const RPCS = (process.env.ELY_RPCS || 'https://rpc.eleos.fun,https://rpc-live.boxa.club,https://rpc-live.elyspump.com,https://rpc-live.elysp.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const EXPLORER = process.env.EXPLORER || 'https://www.thekleos.xyz/scan/tx/';
const KYBER = 'https://aggregator-api.kyberswap.com/elysium/api/v1';
const KYBER_ID = process.env.KYBER_CLIENT_ID || 'ely-router';

const ROUTER = '0x04c6b3b5f11ff5f7ef3635f23e9697e4be8443ad'; // eleos's v4 swap router: stateless, no owner
const V4 = [
  { name: 'eleos', pm: '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', hook: '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc', fee: 0, ts: 200 },
  { name: 'BOXA', pm: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', hook: '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc', fee: 0, ts: 200 },
  { name: 'Kleos', pm: '0xb308b5df891c300a5f5a5b8fdbc30108ba842490', hook: '0x0c835e6a51717a514144d95c7f0a1c640179e0cc', fee: 0, ts: 200 },
];
// names for pool managers we know; anything else shows as "v4 0x1234…abcd" and still trades
const PM_NAMES = Object.fromEntries([...V4.map((x) => [x.pm, x.name]), ['0x5fb015a49f5b35073f9ce01c2adb287a75f89600', 'ElysPump']]);
const T_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SIM = '0x00000000000000000000000000000000000b0a7a'; // throwaway "from" for quotes (balance via state override)
const MAX256 = (1n << 256n) - 1n;

// ── state (settings, positions, caches) ────────────────────────────────────────────────────────────
const STATE = new URL('./state.json', import.meta.url);
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
state.offset ||= 0;
state.pos ||= {};      // token → { sym, hypeIn, hypeOut, tokIn, tokOut, t }
state.routes ||= {};   // token → route
state.pools ||= {};    // token → every native-HYPE v4 pool it has [{ pm, fee, ts, hook, b, id }]
state.poolsBlock ||= 0; // last block the pool index has read
state.slots ||= {};    // token → allowance mapping base slot (for sell quotes before approving)
state.set ||= {};
state.orders ||= {};   // token → [{ id, k: tp|sl|trail|lbuy, x, drop, pct, base, peak, hype, mc, dir, auto, at, exp }]
state.snipes ||= [];   // [{ id, k: token|dev|new, w, hype, left, b, at, pms, got }]
state.copy ||= {};     // leader wallet → { name, hype, at }
state.copyDone ||= {}; // `${leader}:${token}` → time (each coin copied once per leader)
state.dev ||= {};      // token → { w: creator, peak: tokens }
const cfg = () => ({
  slip: BigInt(state.set.slip ?? process.env.SLIPPAGE_BPS ?? 1500),
  max: Number(state.set.max ?? process.env.MAX_BUY_HYPE ?? 5),
  sizes: (state.set.sizes ?? process.env.BUY_SIZES ?? '0.5,1,2,5').split(',').map((s) => s.trim()).filter(Boolean),
  tax: Number(state.set.tax ?? process.env.MAX_TAX_PCT ?? 25),     // refuse when buying and selling straight back loses more than this %
  check: (state.set.check ?? process.env.SELL_CHECK ?? 'on') !== 'off',
  stale: Number(state.set.stale ?? process.env.STALE_MIN ?? 5),   // ⚡ taps on alerts older than this many minutes show the card first
  report: state.set.report ?? process.env.DAILY_REPORT ?? 'quiet', // nightly report: quiet (only when there is news), on, off
  devsell: Number(state.set.devsell ?? process.env.DEV_SELL_PCT ?? 50), // sell all once the creator has dumped this % of their peak bag (0 = off)
  rug: (state.set.rug ?? process.env.RUG_GUARD ?? 'on') !== 'off',      // sell all when a held coin turns unsellable or its tax jumps
  preapprove: (state.set.preapprove ?? process.env.PRE_APPROVE ?? 'on') !== 'off', // approve right after a buy so sells are one tx
  auto: state.set.auto ?? process.env.AUTO_SELL ?? 'off',               // orders added to every buy, e.g. "tp 2x 50 trail 40"
  copymax: Number(state.set.copymax ?? process.env.COPY_MAX_DAY ?? 10), // copy buys per day, all wallets together
  copysells: (state.set.copysells ?? 'on') !== 'off',                   // mirror the copied wallet's sells
});
const DEFAULT_AUTO = 'tp 2x 50 trail 40';
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFileSync(STATE, JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v))), 300); };

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => lc(h).replace(/^0x/, '');
const hex = (n) => '0x' + BigInt(n).toString(16);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const word = (v) => {
  if (typeof v === 'number') v = BigInt(v);
  if (typeof v === 'bigint') return (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
  return strip(v).padStart(64, '0');
};
const enc = (sel, ...args) => '0x' + sel + args.map(word).join('');
const u256 = (r) => BigInt('0x' + (strip(r).slice(0, 64) || '0'));
const num = (b, d = 18) => Number(b) / 10 ** d;
const toWei = (s, d = 18) => {
  s = String(s).trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0');
};
const fmt = (n) => {
  if (!isFinite(n)) return '?';
  const a = Math.abs(n);
  return a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : a >= 1 ? n.toFixed(3) : a === 0 ? '0' : n.toPrecision(3);
};
const fmtH = (h) => (h >= 100 ? h.toFixed(0) : h >= 1 ? h.toFixed(2) : h.toPrecision(3)) + ' HYPE';
const decStr = (r) => {
  const h = strip(r);
  const utf = (x) => Buffer.from(x, 'hex').toString('utf8').replace(/\0/g, '');
  if (h.length >= 128) { const o = Number(BigInt('0x' + h.slice(0, 64))) * 2, n = Number(BigInt('0x' + h.slice(o, o + 64))); return utf(h.slice(o + 64, o + 64 + n * 2)); }
  return utf(h.slice(0, 64));
};
const txLink = (h) => `<a href="${EXPLORER}${h}">tx</a>`;

// ── RPC: rotate for reads, broadcast to every node for sends ───────────────────────────────────────
const reverted = (e) => e && (e.code === 3 || /revert/i.test(e.message || ''));
const transient = (e) => /abort|timeout|timed? ?out|rate limit|busy|unavailable|fetch failed|ECONN|ENOTFOUND|socket|502|503|504|-32005/i.test(`${e.name} ${e.message} ${e.code}`);
async function call1(url, method, params, ms = 8000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.code = j.error.code; e.data = j.error.data; throw e; }
  return j.result;
}
let rpcIdx = 0;
async function rpc(method, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try { const r = await call1(url, method, params); rpcIdx = (rpcIdx + i) % RPCS.length; return r; }
    catch (e) { if (!transient(e)) throw e; last = e; await sleep(150 * (i + 1)); }
  }
  throw last;
}
async function ethCall(to, data, extra = {}, override) {
  if (!override) return rpc('eth_call', [{ to, data, ...extra }, 'latest']);
  // state overrides are not supported everywhere: walk the nodes until one answers or the call really reverts
  let last;
  for (let i = 0; i < RPCS.length * 2; i++) {
    try { return await call1(RPCS[i % RPCS.length], 'eth_call', [{ to, data, ...extra }, 'latest', override]); }
    catch (e) { if (reverted(e)) throw e; last = e; }
  }
  throw last;
}
async function broadcast(raw) {
  const res = await Promise.allSettled(RPCS.map((u) => call1(u, 'eth_sendRawTransaction', [raw], 12000)));
  if (res.some((r) => r.status === 'fulfilled')) return;
  const why = res.map((r) => r.reason?.message || '').join(' | ');
  if (/already known|known transaction|already imported/i.test(why)) return;
  const e = new Error(why.slice(0, 220));
  e.nonceLow = /nonce too low/i.test(why);
  throw e;
}

// one send at a time, nonces handed out locally so an approve and its sell can go back to back
let nextNonce = null, queue = Promise.resolve(), gpCache = { v: 0n, t: 0 };
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
async function resyncNonce() {
  const [l, p] = await Promise.all([rpc('eth_getTransactionCount', [me, 'latest']), rpc('eth_getTransactionCount', [me, 'pending']).catch(() => '0x0')]);
  nextNonce = Math.max(Number(BigInt(l)), Number(BigInt(p)));
  return nextNonce;
}
async function gasPrice() {
  if (Date.now() - gpCache.t < 30000) return gpCache.v;
  let g = BigInt(await rpc('eth_gasPrice', []).catch(() => '0x5f5e100')) * 2n;
  if (g < 2n * 10n ** 8n) g = 2n * 10n ** 8n;
  gpCache = { v: g, t: Date.now() };
  return g;
}
async function sendRaw(tx) {
  if (nextNonce == null) await resyncNonce();
  const nonce = nextNonce;
  const raw = await account.signTransaction({ chainId: CHAIN_ID, type: 'legacy', nonce, to: tx.to, value: BigInt(tx.value || 0), data: tx.data, gas: BigInt(tx.gas), gasPrice: await gasPrice() });
  try { await broadcast(raw); }
  catch (e) { if (e.nonceLow) await resyncNonce(); throw e; }
  nextNonce = nonce + 1;
  return keccak256(raw);
}
async function receipt(hash, maxMs = 2 * 3600 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const r = await rpc('eth_getTransactionReceipt', [hash], 3); if (r) return r; } catch {}
    const el = Date.now() - t0;
    await sleep(el < 15000 ? 300 : el < 120000 ? 1500 : 15000);
  }
  return null;
}

// ── tokens, prices ─────────────────────────────────────────────────────────────────────────────────
const meta = {};
async function tokenMeta(t) {
  if (meta[t]) return meta[t];
  const [s, d, sup] = await Promise.all([
    ethCall(t, '0x95d89b41').then(decStr).catch(() => '?'),
    ethCall(t, '0x313ce567').then((r) => Number(u256(r))).catch(() => 18),
    ethCall(t, '0x18160ddd').then(u256).catch(() => 0n),
  ]);
  return (meta[t] = { sym: (s || '?').replace(/[^\w$.+\- ]/g, '').slice(0, 20) || '?', d, sup });
}
const balOf = async (t, w = me) => u256(await ethCall(t, enc('70a08231', w)));
const hypeBal = async () => BigInt(await rpc('eth_getBalance', [me, 'latest']));
let usdPx = { v: null, t: 0 };
async function hypeUsd() {
  if (Date.now() - usdPx.t < 300000) return usdPx.v;
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"allMids"}', signal: AbortSignal.timeout(5000) }).then((x) => x.json());
    usdPx = { v: Number(r.HYPE) || null, t: Date.now() };
  } catch { usdPx.t = Date.now() - 240000; }
  return usdPx.v;
}
const usd = (h, px) => {
  if (!px) return '';
  const v = h * px, a = Math.abs(v);
  return ` ($${a >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : a >= 10 ? v.toFixed(0) : v.toFixed(2)})`;
};

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────
const v4Buy = (r, t, minOut, to, dl) => enc('c727282f', r.pm, ZERO, t, r.fee, r.ts, r.hook, minOut, to, dl);
const v4Sell = (r, t, amt, minOut, to, dl) => enc('a7fee01b', r.pm, ZERO, t, r.fee, r.ts, r.hook, amt, minOut, to, dl);
const deadline = () => Math.floor(Date.now() / 1000) + 600;

async function v4QuoteBuy(r, t, wei) {
  const data = v4Buy(r, t, 0, SIM, 2 ** 31 - 1);
  return u256(await ethCall(ROUTER, data, { from: SIM, value: hex(wei) }, { [SIM]: { balance: hex(wei + 10n ** 21n) } }));
}
// allowance(me, ROUTER) lives at keccak(spender, keccak(owner, base)); find base once so sells can be quoted before approving
async function allowanceSlot(t, spender) {
  const key = t + ':' + spender;
  if (key in state.slots) return state.slots[key];
  const max = '0x' + 'f'.repeat(64);
  for (let base = 0; base <= 12; base++) {
    const slot = keccak256(concat([vpad(spender), keccak256(concat([vpad(me), vpad(toHex(base))]))]));
    try {
      const r = await ethCall(t, enc('dd62ed3e', me, spender), {}, { [t]: { stateDiff: { [slot]: max } } });
      if (u256(r) === MAX256) { state.slots[key] = slot; save(); return slot; }
    } catch {}
  }
  state.slots[key] = null; save();
  return null;
}
async function v4QuoteSell(r, t, amt, slot) {
  const data = v4Sell(r, t, amt, 0, me, 2 ** 31 - 1);
  const ov = slot ? { [t]: { stateDiff: { [slot]: '0x' + 'f'.repeat(64) } } } : undefined;
  return u256(await ethCall(ROUTER, data, { from: me }, ov));
}
async function kyber(path, body) {
  const r = await fetch(KYBER + path, { method: body ? 'POST' : 'GET', headers: { 'x-client-id': KYBER_ID, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) }).then((x) => x.json());
  if (r.code !== 0 || !r.data) throw new Error(r.message === 'route not found' || r.message === 'token not found' ? 'no KyberSwap route' : `KyberSwap: ${r.message}`);
  return r.data;
}
const kyRoute = (tin, tout, amt) => kyber(`/routes?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amt}`);
const kyBuild = (sum, slip) => kyber('/route/build', { routeSummary: sum, sender: me, recipient: me, slippageTolerance: Number(slip), deadline: deadline() });

// ── live pool index: every v4 Initialize on Elysium, from any pool manager ─────────────────────────────
const pmName = (pm) => PM_NAMES[pm] || 'v4 ' + short(pm);
const knownPms = new Set();   // every pool manager that has ever had a pool (a new one = a new launchpad)
const fresh = [];             // pools seen live (after the first full index), for snipes
let live = false;
function addPool(l) {
  if (lc(l.topics[2]) !== '0x' + word(ZERO)) return 0; // buys go in as native HYPE; WHYPE pairs go through KyberSwap
  const t = lc('0x' + l.topics[3].slice(26)), d = strip(l.data), pm = lc(l.address);
  const list = (state.pools[t] ||= []);
  if (list.some((p) => p.id === lc(l.topics[1]))) return 0;
  const p = { pm, fee: Number(BigInt('0x' + d.slice(0, 64))), ts: Number(BigInt.asIntN(24, BigInt('0x' + d.slice(64, 128)))), hook: '0x' + d.slice(152, 192), b: parseInt(l.blockNumber, 16), id: lc(l.topics[1]) };
  list.push(p);
  delete state.routes[t]; // a new pool for a coin: pick the best one again next time
  if (live) fresh.push({ t, ...p, tx: lc(l.transactionHash || ''), newPm: !knownPms.has(pm) });
  knownPms.add(pm);
  return 1;
}
let indexing = null;
function indexPools() {
  indexing ||= (async () => {
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const wins = [];
    // live, the last few blocks are read again: a node a block behind the others can answer a range empty,
    // and pools already seen are skipped
    for (let a = Math.max(1, (state.poolsBlock || 0) + 1 - (live ? 12 : 0)); a <= head; a += 2000) wins.push([a, Math.min(head, a + 1999)]);
    let added = 0;
    // in order, a few at a time, so the index never skips a range that failed to load
    for (let i = 0; i < wins.length; i += 6) {
      const batch = wins.slice(i, i + 6);
      const res = await Promise.all(batch.map(([a, b]) => rpc('eth_getLogs', [{ fromBlock: hex(a), toBlock: hex(b), topics: [T_INIT] }], 4).catch(() => null)));
      const ok = res.findIndex((r) => r === null) === -1 ? res : res.slice(0, res.findIndex((r) => r === null));
      for (const logs of ok) for (const l of logs) added += addPool(l);
      if (ok.length) state.poolsBlock = batch[ok.length - 1][1];
      if (ok.length < batch.length) break;
    }
    if (added) save();
    return added;
  })().finally(() => { indexing = null; });
  return indexing;
}
const poolCount = () => Object.values(state.pools).reduce((n, l) => n + l.length, 0);

async function findRoute(t, fresh = false) {
  if (!fresh && state.routes[t]) return state.routes[t];
  const probe = 10n ** 16n;
  const quote = async (r) => { try { const out = await v4QuoteBuy(r, t, probe); return out > 0n ? { r, out } : null; } catch { return null; } };
  if (!state.pools[t]?.length) await indexPools().catch(() => {}); // a pool from the last few seconds
  let cands = (state.pools[t] || []).slice(-8).map((p) => ({ kind: 'v4', name: pmName(p.pm), pm: p.pm, fee: p.fee, ts: p.ts, hook: p.hook }));
  if (!cands.length) cands = V4.map((x) => ({ kind: 'v4', name: x.name, pm: x.pm, hook: x.hook, fee: x.fee, ts: x.ts }));
  // every pool the coin has, best price wins (a coin can sit on several launchpads)
  const good = (await Promise.all(cands.map(quote))).filter(Boolean).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  let route = good[0]?.r || null;
  if (!route) {
    try { const k = await kyRoute(NATIVE, t, probe); if (BigInt(k.routeSummary.amountOut) > 0n) route = { kind: 'kyber', name: 'KyberSwap' }; } catch {}
  }
  if (!route && !state.poolsBlock) route = await scanV4(t, async (r) => (await quote(r))?.r || null); // index not built yet
  if (route) { state.routes[t] = route; save(); }
  return route;
}
// a pool on a PoolManager we have never seen: find its Initialize event (recent blocks first)
async function scanV4(t, ok) {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  for (let end = head; end > head - 60000; end -= 8000) {
    const jobs = [];
    for (let k = 0; k < 4; k++) {
      const to = end - k * 2000, from = to - 1999;
      jobs.push(rpc('eth_getLogs', [{ fromBlock: hex(Math.max(0, from)), toBlock: hex(to), topics: [T_INIT, null, '0x' + word(ZERO), '0x' + word(t)] }]).catch(() => []));
    }
    for (const l of (await Promise.all(jobs)).flat()) {
      const d = strip(l.data);
      const r = await ok({ kind: 'v4', name: 'v4 ' + short(lc(l.address)), pm: lc(l.address), hook: '0x' + d.slice(152, 192), fee: Number(BigInt('0x' + d.slice(0, 64))), ts: Number(BigInt.asIntN(24, BigInt('0x' + d.slice(64, 128)))) });
      if (r) return r;
    }
  }
  return null;
}
// ── sell check: buy and sell straight back in one simulated call ──────────────────────────────────────
// Helper bytecode (hand-assembled, lives only in the simulation's state override at SIM): calldata is
// router, token, buyLen, sellLen, amountOffset, buyData, sellData. It buys with all its value, reads its
// token balance, approves the router, writes that balance into sellData and sells. Returns (got, back).
// Reverts with 1 if the buy failed, 2 if balanceOf failed, 3 if the sell failed.
const RT_CODE = '0x36156100c3576040358060a060003760006000826000346000355af1156100a2576370a0823160e01b6000523060045260206000602460006020355afa156100ad5760005163095ea7b360e01b60005260003560045280602452600060006044600060006020355af15047606035808460a00161010037826080356101000152600060008261010060006000355af1156100b85750470360205260005260406000f35b600160005260206000fd5b600260005260206000fd5b600360005260206000fd5b00';
async function sellCheck(r, t, wei) {
  if (r.kind !== 'v4') return { ok: null, note: 'sell check skipped (KyberSwap route)' };
  const buyData = v4Buy(r, t, 0, SIM, 2 ** 31 - 1), sellData = v4Sell(r, t, 0, 0, SIM, 2 ** 31 - 1);
  const len = (h) => (h.length - 2) / 2;
  const data = '0x' + word(ROUTER) + word(t) + word(len(buyData)) + word(len(sellData)) + word(196) + strip(buyData) + strip(sellData);
  const big = hex(wei + 10n ** 21n);
  try {
    const res = await ethCall(SIM, data, { from: me, value: hex(wei) }, { [SIM]: { code: RT_CODE, balance: big }, [me]: { balance: big } });
    const got = u256(res), back = BigInt('0x' + (strip(res).slice(64, 128) || '0'));
    const loss = 1 - num(back) / num(wei);
    return { ok: got > 0n && back > 0n && loss * 100 <= cfg().tax, got, back, loss, note: `sell check: round trip ${(loss * 100).toFixed(1)}%` };
  } catch (e) {
    const code = String(e.data || '').slice(-2);
    if (code === '03') return { ok: false, blocked: true, note: 'cannot be sold back (honeypot or sells blocked)' };
    return { ok: null, note: 'sell check unavailable' }; // buy step refused a contract buyer, or the node failed
  }
}
// tokens out for `wei` HYPE, on whatever route the token uses
async function quoteBuy(r, t, wei) {
  if (r.kind === 'v4') return v4QuoteBuy(r, t, wei);
  return BigInt((await kyRoute(NATIVE, t, wei)).routeSummary.amountOut);
}
// HYPE out for selling `amt` tokens now
async function quoteSellOut(r, t, amt) {
  if (r.kind !== 'v4') return BigInt((await kyRoute(t, NATIVE, amt)).routeSummary.amountOut);
  const allowed = u256(await ethCall(t, enc('dd62ed3e', me, ROUTER)));
  return v4QuoteSell(r, t, amt, allowed >= amt ? null : await allowanceSlot(t, ROUTER));
}
const PROBE = 10n ** 16n;
// HYPE per token right now
async function priceOf(t, r) {
  const m = await tokenMeta(t);
  const q = await quoteBuy(r, t, PROBE);
  return q > 0n ? num(PROBE) / num(q, m.d) : null;
}
// the coin's creator: whoever sent the transaction that opened its first native-HYPE pool (launchpad coins are
// created and opened in one transaction). null when unknown.
async function devOf(t) {
  const d = state.dev[t];
  if (d && d.w !== undefined) return d;
  const p = (state.pools[t] || [])[0];
  if (!p) return null;
  const logs = await rpc('eth_getLogs', [{ fromBlock: hex(p.b), toBlock: hex(p.b), address: p.pm, topics: [T_INIT, p.id] }]);
  const tx = logs[0] ? await rpc('eth_getTransactionByHash', [logs[0].transactionHash]) : null;
  state.dev[t] = { w: tx?.from ? lc(tx.from) : null, peak: 0 };
  save();
  return state.dev[t];
}
const txFrom = async (h) => { try { return lc((await rpc('eth_getTransactionByHash', [h]))?.from); } catch { return null; } };

// ── Telegram ───────────────────────────────────────────────────────────────────────────────────────
async function tg(method, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000) });
      const j = await r.json();
      if (j.ok) return j.result;
      if (j.error_code === 429) { await sleep(1000 * (j.parameters?.retry_after || 2)); continue; }
      if (/message is not modified/.test(j.description || '')) return null;
      console.error('telegram', method, j.description);
      return null;
    } catch (e) { if (i === 2) console.error('telegram', method, e.message); await sleep(800); }
  }
  return null;
}
const kb = (rows) => (rows ? { reply_markup: { inline_keyboard: rows } } : {});
const say = (text, rows, reply) => tg('sendMessage', { chat_id: OWNER, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply ? { reply_to_message_id: reply, allow_sending_without_reply: true } : {}), ...kb(rows) });
const edit = (m, text, rows) => (m ? tg('editMessageText', { chat_id: OWNER, message_id: m.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kb(rows) }) : say(text, rows));

const cardButtons = (t) => {
  const h = t.slice(2);
  return [
    cfg().sizes.map((s) => ({ text: `⚡ ${s}`, callback_data: `b:${h}:${Math.round(Number(s) * 10)}` })),
    [25, 50, 100].map((p) => ({ text: `Sell ${p}%`, callback_data: `s:${h}:${p}` })).concat([{ text: '🔄', callback_data: `r:${h}` }]),
    [{ text: '💰 Initials', callback_data: `i:${h}` }, { text: '🤖 Auto-sell', callback_data: `a:${h}` }, { text: '📋 Orders', callback_data: `l:${h}` }],
  ];
};

// ── card ───────────────────────────────────────────────────────────────────────────────────────────
async function cardText(t) {
  const [m, r, px] = await Promise.all([tokenMeta(t), findRoute(t), hypeUsd()]);
  if (!r) return { text: `No route for <code>${t}</code>.\nNo native-HYPE v4 pool for it among the ${poolCount()} the bot has indexed, and KyberSwap does not know it.` };
  const probe = 10n ** 16n;
  const devInfo = devOf(t).then(async (d) => (d?.w ? { w: d.w, bal: await balOf(t, d.w) } : null)).catch(() => null);
  const [p, one, bal, sc, dv] = await Promise.all([quoteBuy(r, t, probe), quoteBuy(r, t, 10n ** 18n).catch(() => null), balOf(t), sellCheck(r, t, 10n ** 17n), devInfo]);
  const spot = num(probe) / num(p, m.d);               // HYPE per token
  const mc = m.sup ? spot * num(m.sup, m.d) : null;
  const impact = one ? 1 - num(one, m.d) * spot : null;
  const pos = state.pos[t];
  const bagH = num(bal, m.d) * spot;
  let pnl = '';
  if (pos && pos.hypeIn > 0) {
    const pl = (bagH + pos.hypeOut - pos.hypeIn) / pos.hypeIn * 100;
    pnl = ` · PnL <b>${pl >= 0 ? '+' : ''}${pl.toFixed(0)}%</b>`;
  }
  const text =
    `<b>${esc(m.sym)}</b> · ${r.kind === 'v4' ? `${esc(r.name)} v4` : 'via KyberSwap'}\n` +
    `Price ${spot.toPrecision(3)} HYPE${mc ? ` · MC <b>${fmtH(mc)}</b>${usd(mc, px)}` : ''}\n` +
    (one ? `1 HYPE → ${fmt(num(one, m.d))} ${esc(m.sym)}${impact != null ? ` (impact ${(impact * 100).toFixed(1)}%)` : ''}\n` : '') +
    (bal > 0n ? `You hold ${fmt(num(bal, m.d))} ≈ ${fmtH(bagH)}${usd(bagH, px)}${pnl}\n` : '') +
    (sc.blocked ? `🚫 <b>Cannot be sold back</b> in a simulation: likely a honeypot\n` : sc.ok === false ? `⚠️ Buy and sell back loses <b>${(sc.loss * 100).toFixed(0)}%</b> (tax or fees)\n` : sc.loss != null ? `✓ Sell check: buy and sell back loses ${(sc.loss * 100).toFixed(1)}%\n` : '') +
    (dv ? `Dev ${short(dv.w)} holds ${m.sup ? ((num(dv.bal, m.d) / num(m.sup, m.d)) * 100).toFixed(1) + '%' : fmt(num(dv.bal, m.d))}${state.dev[t]?.peak > 0 && num(dv.bal, m.d) < state.dev[t].peak * 0.99 ? ` (sold ${pct(1 - num(dv.bal, m.d) / state.dev[t].peak).replace('+', '')} since you bought)` : ''}\n` : '') +
    ((state.orders[t] || []).length ? `🤖 ${state.orders[t].map(orderText).join(' · ')}\n` : '') +
    `<code>${t}</code>`;
  return { text, rows: cardButtons(t) };
}
async function showCard(t, m) {
  const c = await cardText(t);
  return m ? edit(m, c.text, c.rows) : say(c.text, c.rows);
}

// ── trades ─────────────────────────────────────────────────────────────────────────────────────────
const P = (t, sym) => (state.pos[t] ||= { sym, hypeIn: 0, hypeOut: 0, tokIn: 0, tokOut: 0, t: Date.now() });
const isOpen = (p) => !!p && p.hypeIn > 0 && (p.open ?? (p.now ?? 1) > 0.0005);

// Resolves once the transaction has a receipt: { ok: true, got } or { ok: false, ... }.
// opts.route: a pool already known (snipes skip the route search) · opts.label: first line of the message
// (snipe, copy, limit) · opts.copy: the wallet being copied
async function buy(t, hypeAmt, replyTo, force = false, src = 'command', opts = {}) {
  const { slip, max } = cfg();
  if (!(hypeAmt > 0)) throw new Error('amount must be above 0');
  if (hypeAmt > max) throw new Error(`max per buy is ${max} HYPE (change with /set max)`);
  const wei = toWei(String(hypeAmt));
  let [m, r, bal, before] = await Promise.all([tokenMeta(t), opts.route || findRoute(t), hypeBal(), balOf(t).catch(() => 0n)]);
  if (!r) throw new Error('no route for this token');
  if (bal < wei + 2n * 10n ** 15n) throw new Error(`not enough HYPE: wallet has ${fmtH(num(bal))}`);
  const head = opts.label ? `${opts.label}\n` : '';
  // sell check: the buy simulated together with an immediate sell. It refuses coins that cannot be sold back
  // or lose too much on the round trip, and its buy leg is the quote for this exact size (one call, not two).
  let sc = { note: '' }, expect = null;
  if (r.kind === 'v4') {
    sc = await sellCheck(r, t, wei);
    if (cfg().check && !force && sc.ok === false) {
      J({ side: 'refused', coin: t, sym: m.sym, hype: hypeAmt, src, sc: sc.loss ?? null, reason: sc.blocked ? 'cannot sell' : 'round trip too costly' });
      const why = sc.blocked ? `🚫 <b>${esc(m.sym)}</b> cannot be sold back in a simulation (honeypot or sells blocked).` : `⚠️ Buying <b>${esc(m.sym)}</b> and selling straight back loses <b>${(sc.loss * 100).toFixed(0)}%</b> (limit ${cfg().tax}%, change with /set tax).`;
      await say(`${head}${why}\nNot buying.`, [[{ text: `Buy ${hypeAmt} anyway`, callback_data: `f:${t.slice(2)}:${Math.round(hypeAmt * 10)}` }, { text: '🔎', callback_data: `c:${t.slice(2)}` }]], replyTo);
      return { ok: false, refused: true };
    }
    if (sc.got > 0n) expect = sc.got;
    else {
      expect = await v4QuoteBuy(r, t, wei).catch(() => null);
      if (expect == null) {
        if (opts.route) throw new Error('no route for this token yet'); // a snipe retries
        r = await findRoute(t, true); // the pool changed: pick again
        if (!r) throw new Error('no route for this token any more');
        if (r.kind === 'v4') expect = await v4QuoteBuy(r, t, wei);
      }
    }
  }
  let tx;
  if (r.kind === 'v4') tx = { to: ROUTER, value: wei, data: v4Buy(r, t, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: 600000 };
  else {
    const k = await kyRoute(NATIVE, t, wei);
    const b = await kyBuild(k.routeSummary, slip);
    expect = BigInt(b.amountOut);
    tx = { to: lc(b.routerAddress), value: BigInt(b.transactionValue), data: b.data, gas: Math.max(Math.ceil(Number(b.gas) * 1.6), 600000) };
  }
  // the transaction goes out first; the Telegram message follows instead of delaying it
  const msgP = say(`${head}⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>…${sc.note ? ` (${sc.note})` : ''}`, null, replyTo);
  let hash;
  try { hash = await serial(() => sendRaw(tx)); }
  catch (e) { await edit(await msgP, `${head}❌ Buy of <b>${esc(m.sym)}</b> not sent: ${esc(e.message).slice(0, 200)}`); return { ok: false, error: e.message }; }
  const rcP = receipt(hash);
  const msg = await msgP;
  await edit(msg, `${head}⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>, expecting ~${fmt(num(expect, m.d))} · ${txLink(hash)}`);
  const rc = await rcP;
  if (!rc) { await edit(msg, `${head}⌛ Buy of <b>${esc(m.sym)}</b> not confirmed after 2 h. Elysium may be holding its batch; check ${txLink(hash)} and /nonce if it never lands.`); return { ok: false }; }
  if (rc.status !== '0x1') {
    J({ side: 'revert', coin: t, sym: m.sym, hype: hypeAmt, src, slip: Number(slip), route: r.name, hash });
    await edit(msg, `${head}❌ Buy of <b>${esc(m.sym)}</b> reverted (price moved past your ${Number(slip) / 100}% slippage?) · ${txLink(hash)}`);
    return { ok: false, reverted: true };
  }
  const got = (await balOf(t).catch(() => before)) - before;
  const px = await hypeUsd();
  const mc = m.sup && got > 0n ? (hypeAmt / num(got, m.d)) * num(m.sup, m.d) : null;
  const p = P(t, m.sym); p.hypeIn += hypeAmt; p.tokIn += num(got, m.d);
  p.first ||= Date.now(); p.src ||= src; if (p.mc0Usd == null && mc && px) p.mc0Usd = mc * px;
  p.open = true; p.devFired = false;
  if (sc.ok != null) { p.scOk = sc.ok; p.sc0 = sc.loss ?? null; }
  if (opts.copy) p.copy ||= opts.copy;
  J({ side: 'buy', coin: t, sym: m.sym, hype: hypeAmt, tok: num(got, m.d), mcUsd: mc && px ? mc * px : null, src, slip: Number(slip), sc: sc.loss ?? null, route: r.name, hash });
  // after the buy: approve so every sell is a single transaction, note the creator's bag for the dev guard,
  // and add the auto-sell preset
  if (cfg().preapprove && r.kind === 'v4') preApprove(t).catch((e) => console.error('preapprove', e.message));
  if (cfg().devsell > 0) devOf(t).then(async (d) => { if (d?.w) { d.peak = num(await balOf(t, d.w), m.d); save(); } }).catch(() => {});
  let autoLine = '';
  try {
    const specs = parseSpec(cfg().auto);
    if (specs.length) autoLine = `\n🤖 ${(await setOrders(t, specs, true)).map(orderText).join(' · ')}`;
  } catch (e) { autoLine = `\n⚠️ Auto-sell not set: ${esc(e.message)}`; }
  save();
  await edit(msg, `${head}✅ Bought <b>${fmt(num(got, m.d))} ${esc(m.sym)}</b> for ${hypeAmt} HYPE${mc ? ` · entry MC ${fmtH(mc)}${usd(mc, px)}` : ''} · ${txLink(hash)}${autoLine}`, cardButtons(t));
  return { ok: true, got };
}

// approve the router for good right after a buy (the wallet is a burner), so a sell, including an automatic
// one, is one transaction instead of approve + sell
async function preApprove(t) {
  const a = u256(await ethCall(t, enc('dd62ed3e', me, ROUTER)));
  if (a >= MAX256 >> 1n) return;
  await serial(() => sendRaw({ to: t, data: enc('095ea7b3', ROUTER, MAX256), gas: 120000 }));
}

// Resolves to true or false once the transaction has a receipt.
// opts.amt: exact token amount (initials) · opts.why: first line, when an order or guard triggered it
async function sell(t, pct, replyTo, opts = {}) {
  const { slip } = cfg();
  const [m, r, bal, hBefore] = await Promise.all([tokenMeta(t), findRoute(t), balOf(t), hypeBal()]);
  if (!r) throw new Error('no route for this token');
  let amt;
  if (opts.amt != null) { amt = opts.amt > bal ? bal : opts.amt; pct = bal > 0n ? Number((amt * 1000n) / bal) / 10 : 0; }
  else { pct = Math.min(100, Math.max(1, Math.round(pct))); amt = (bal * BigInt(pct)) / 100n; }
  if (amt === 0n) throw new Error(`you hold no ${m.sym}`);
  const head = opts.why ? `${opts.icon || '🤖'} ${opts.why}\n` : '';
  const msgP = say(`${head}⏳ Selling ${pct}% of <b>${esc(m.sym)}</b> (${fmt(num(amt, m.d))})…`, null, replyTo);
  const approveTx = (spender) => ({ to: t, data: enc('095ea7b3', spender, cfg().preapprove && spender === ROUTER ? MAX256 : amt), gas: 120000 });
  let txs, expect;
  try {
    if (r.kind === 'v4') {
      const allowed = u256(await ethCall(t, enc('dd62ed3e', me, ROUTER)));
      const slot = allowed >= amt ? null : await allowanceSlot(t, ROUTER);
      if (allowed < amt && !slot) {
        // unusual token storage: approve first, then quote for real
        const ah = await serial(() => sendRaw(approveTx(ROUTER)));
        await edit(await msgP, `${head}⏳ Approving ${esc(m.sym)} before selling · ${txLink(ah)}`);
        const arc = await receipt(ah);
        if (!arc || arc.status !== '0x1') throw new Error('approval failed or never confirmed');
        expect = await v4QuoteSell(r, t, amt, null);
        txs = [{ to: ROUTER, data: v4Sell(r, t, amt, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: 600000 }];
      } else {
        expect = await v4QuoteSell(r, t, amt, slot);
        const sw = { to: ROUTER, data: v4Sell(r, t, amt, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: 600000 };
        txs = allowed >= amt ? [sw] : [approveTx(ROUTER), sw];
      }
    } else {
      const k = await kyRoute(t, NATIVE, amt);
      const b = await kyBuild(k.routeSummary, slip);
      const spender = lc(b.routerAddress);
      expect = BigInt(b.amountOut);
      const sw = { to: spender, value: BigInt(b.transactionValue || 0), data: b.data, gas: Math.max(Math.ceil(Number(b.gas) * 1.6), 600000) };
      const allowed = u256(await ethCall(t, enc('dd62ed3e', me, spender)));
      txs = allowed >= amt ? [sw] : [approveTx(spender), sw];
    }
  } catch (e) {
    await edit(await msgP, `${head}❌ Sell of <b>${esc(m.sym)}</b> failed: ${esc(e.message).slice(0, 200)}`);
    return false;
  }
  return finishSell(t, m, pct, msgP, txs, expect, head, hBefore, bal, opts);
}
// approve (if needed) and the sell go out back to back with consecutive nonces
async function finishSell(t, m, pct, msgP, txs, expect, head, before, tokBefore, opts) {
  let hashes;
  try { hashes = await serial(async () => { const out = []; for (const x of txs) out.push(await sendRaw(x)); return out; }); }
  catch (e) { await edit(await msgP, `${head}❌ Sell of <b>${esc(m.sym)}</b> not sent: ${esc(e.message).slice(0, 200)}`); return false; }
  const hash = hashes[hashes.length - 1];
  const rcP = receipt(hash);
  const msg = await msgP;
  await edit(msg, `${head}⏳ Selling ${pct}% of <b>${esc(m.sym)}</b> for ~${fmtH(num(expect))}${hashes.length > 1 ? ' (approve + sell)' : ''} · ${txLink(hash)}`);
  const rc = await rcP;
  if (!rc) { await edit(msg, `${head}⌛ Sell of <b>${esc(m.sym)}</b> not confirmed after 2 h · ${txLink(hash)}`); return false; }
  if (rc.status !== '0x1') { J({ side: 'sell-revert', coin: t, sym: m.sym, pct, hash, why: opts.kind }); await edit(msg, `${head}❌ Sell of <b>${esc(m.sym)}</b> reverted · ${txLink(hash)}`); return false; }
  const [hNow, left] = await Promise.all([hypeBal().catch(() => before), balOf(t).catch(() => tokBefore)]);
  const got = num(hNow - before);
  const sold = num(tokBefore - left, m.d);
  const p = P(t, m.sym); p.hypeOut += Math.max(got, 0); p.tokOut += sold; p.lastSell = Date.now();
  if (left === 0n) { p.open = false; dropSellOrders(t); }
  J({ side: 'sell', coin: t, sym: m.sym, hype: Math.max(got, 0), tok: sold, pct, hash, why: opts.kind });
  const px = await hypeUsd();
  await edit(msg, `${head}✅ Sold ${pct}% of <b>${esc(m.sym)}</b> for <b>${fmtH(got)}</b>${usd(got, px)} · ${txLink(hash)}`, cardButtons(t));
  return true;
}
function track(hash, onDone, onTimeout) {
  receipt(hash).then((rc) => (rc ? onDone(rc) : onTimeout())).catch((e) => console.error('track', e.message));
}

// sell just enough to take back what went in (HYPE in minus HYPE already out); the rest rides free
async function initials(t, replyTo) {
  const p = state.pos[t];
  if (!p || !(p.hypeIn > 0)) throw new Error('no buy through this bot recorded for this coin');
  const need = p.hypeIn - (p.hypeOut || 0);
  if (need <= 0.0001) return say(`Initials are already out on <b>${esc(p.sym)}</b>: in ${fmtH(p.hypeIn)}, out ${fmtH(p.hypeOut)}. The rest is free.`, null, replyTo);
  const [m, r, bal] = await Promise.all([tokenMeta(t), findRoute(t), balOf(t)]);
  if (!r) throw new Error('no route for this token');
  if (bal === 0n) throw new Error(`you hold no ${m.sym}`);
  const needW = toWei(need.toFixed(18));
  let full = await quoteSellOut(r, t, bal).catch(() => null);
  if (full == null) {
    const pr = await priceOf(t, r);
    if (!pr) throw new Error('cannot price this coin right now');
    full = toWei((num(bal, m.d) * pr).toFixed(18));
  }
  if (full <= needW) return say(`Your whole <b>${esc(m.sym)}</b> bag would fetch about ${fmtH(num(full))}, less than the ${fmtH(need)} still in. Taking initials would mean selling everything (Sell 100%).`, null, replyTo);
  let amt = (bal * needW) / full;
  const o1 = await quoteSellOut(r, t, amt).catch(() => 0n);
  if (o1 > 0n) amt = (amt * needW) / o1;
  amt = (amt * 1010n) / 1000n; // 1% headroom for slippage and gas
  return sell(t, null, replyTo, { amt: amt > bal ? bal : amt, why: `Initials: taking back ${fmtH(need)}`, icon: '💰', kind: 'initials' });
}

// ── automation: orders, dev and rug guards, snipes, copy trading ───────────────────────────────────────
const oid = () => Math.random().toString(36).slice(2, 8);
const orderText = (o) =>
  o.k === 'tp' ? `TP ${+o.x.toFixed(2)}× sell ${o.pct}%` :
  o.k === 'sl' ? `SL −${Math.round(o.drop * 100)}% sell ${o.pct}%` :
  o.k === 'trail' ? `trail ${Math.round(o.drop * 100)}% sell ${o.pct}%` :
  `buy ${o.hype} HYPE at MC ${o.dir === 'above' ? '≥' : '≤'} $${fmt(o.mc)}`;
// "tp 2x 50 tp 5x 100 sl 40 trail 35" → [{ k, x | drop, pct }]
// tp: multiple of the entry price (2x, or +100%), sells 50% by default
// sl: drop from the entry price in %, trail: drop from the highest price since the order was set; both sell 100% by default
function parseSpec(s) {
  const w = lc(s).replace(/[,;·]/g, ' ').split(/\s+/).filter((x) => x && x !== 'off' && x !== 'on');
  const n = (v) => { const m = String(v ?? '').match(/^[-−+]?(\d*\.?\d+)(x|%)?$/); return m ? { v: Number(m[1]), u: m[2] || '' } : null; };
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const k = w[i];
    if (!['tp', 'sl', 'trail'].includes(k)) throw new Error(`"${w[i]}" not understood. Use tp 2x 50, sl 40, trail 35`);
    const a = n(w[i + 1]);
    if (!a) throw new Error(`${k} needs a number, like ${k === 'tp' ? 'tp 2x 50' : k + ' 40'}`);
    i++;
    let sp = k === 'tp' ? 50 : 100;
    const b = n(w[i + 1]);
    if (b && b.u !== 'x') { sp = b.v; i++; }
    if (!(sp > 0 && sp <= 100)) throw new Error('the sell share is 1 to 100 (%)');
    if (k === 'tp') {
      const x = a.u === '%' ? 1 + a.v / 100 : a.v;
      if (!(x > 1 && x <= 1000)) throw new Error('take profit is a multiple of entry above 1, like 2x');
      out.push({ k, x, pct: Math.round(sp) });
    } else {
      if (!(a.v > 0 && a.v < 100)) throw new Error(`${k} is a drop in %, like ${k} 40`);
      out.push({ k, drop: a.v / 100, pct: Math.round(sp) });
    }
  }
  return out;
}
// add orders to a coin, priced from the average entry (or from now, for coins bought elsewhere);
// preset orders replace the coin's previous preset orders
async function setOrders(t, specs, auto = false) {
  const r = await findRoute(t);
  const now = r ? await priceOf(t, r).catch(() => null) : null;
  const p = state.pos[t];
  const entry = p?.tokIn > 0 && p.hypeIn > 0 ? p.hypeIn / p.tokIn : null;
  const base = entry || now;
  if (!base) throw new Error('cannot price this coin yet');
  const keep = (state.orders[t] || []).filter((o) => !(auto && o.auto));
  state.orders[t] = keep.concat(specs.map((s) => ({ id: oid(), ...s, base, peak: now || base, auto, at: Date.now() })));
  save();
  return state.orders[t];
}
const removeOrder = (id) => { for (const t of Object.keys(state.orders)) { state.orders[t] = state.orders[t].filter((o) => o.id !== id); if (!state.orders[t].length) delete state.orders[t]; } save(); };
const dropSellOrders = (t) => { const k = (state.orders[t] || []).filter((o) => o.k === 'lbuy'); if (k.length) state.orders[t] = k; else delete state.orders[t]; save(); };
const parseUsd = (s) => { const m = String(s || '').match(/^\$?(\d*\.?\d+)([kmb]?)$/i); return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[lc(m[2])] || 1) : null; };

const busy = new Set();      // coins with an automatic trade in flight
const lastRun = {};
const every = (key, ms) => { if (Date.now() - (lastRun[key] || 0) < ms) return false; lastRun[key] = Date.now(); return true; };
// an automatic sell; order ones are retried on the next ticks, up to 3 times
function fireSell(t, share, why, o, icon) {
  if (busy.has(t)) return;
  busy.add(t);
  (async () => {
    let ok = false;
    try { ok = await sell(t, share, null, { why, icon, kind: o ? o.k : icon ? 'copy' : 'guard' }); }
    catch (e) { await say(`${icon || '🤖'} ${why}\n⚠️ Sell failed: ${esc(e.message).slice(0, 200)}`); }
    if (o) {
      if (ok) removeOrder(o.id);
      else if ((o.fails = (o.fails || 0) + 1) >= 3) { removeOrder(o.id); await say(`🤖 Gave up on ${orderText(o)} for <b>${esc(state.pos[t]?.sym || short(t))}</b> after 3 failed sells. Sell by hand.`); }
    }
    save();
  })().catch((e) => console.error('fireSell', e.message)).finally(() => busy.delete(t));
}
// every 2 s: each coin with orders, and each coin you hold while a guard is on
async function guardTick() {
  const c = cfg();
  const coins = new Set(Object.keys(state.orders).filter((t) => state.orders[t]?.length));
  if (c.devsell > 0 || c.rug) for (const [t, p] of Object.entries(state.pos)) if (isOpen(p)) coins.add(t);
  const list = [...coins].filter((t) => !busy.has(t));
  for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map((t) => guardCoin(t).catch((e) => console.error('guard', short(t), e.message))));
}
async function guardCoin(t) {
  const c = cfg();
  if (!state.orders[t]?.length && !every(t + ':g', 6000)) return; // guards only: every 6 s; coins with orders every 2 s
  const r = await findRoute(t);
  if (!r) return;
  if (r.kind !== 'v4' && !every(t + ':ky', 15000)) return; // KyberSwap's API: every 15 s is plenty
  const m = await tokenMeta(t);
  const px = await priceOf(t, r);
  if (!px) return;
  const os = state.orders[t] || [];
  for (const o of os.filter((x) => x.k === 'lbuy')) {
    if (o.exp && Date.now() > o.exp) { removeOrder(o.id); say(`⌛ Limit buy on <b>${esc(m.sym)}</b> expired (${orderText(o)}).`); continue; }
    const u = await hypeUsd();
    if (!u || !m.sup) continue;
    const mc = px * num(m.sup, m.d) * u;
    if (o.dir === 'above' ? mc >= o.mc : mc <= o.mc) {
      removeOrder(o.id);
      busy.add(t);
      buy(t, o.hype, null, false, 'limit', { label: `🎯 Limit buy: <b>${esc(m.sym)}</b> MC $${fmt(mc)}` })
        .catch((e) => say(`🎯 Limit buy on <b>${esc(m.sym)}</b> failed: ${esc(e.message).slice(0, 200)}`)).finally(() => busy.delete(t));
      return;
    }
  }
  const sells = os.filter((x) => x.k !== 'lbuy');
  const p = state.pos[t];
  if (!sells.length && !isOpen(p)) return;
  const bal = await balOf(t);
  if (bal === 0n) { if (p) p.open = false; if (sells.length) dropSellOrders(t); save(); return; }
  // take profit, stop loss, trailing stop: the biggest sell that triggers goes first
  let fire = null;
  for (const o of sells) {
    if (o.k === 'trail' && px > (o.peak || 0)) { o.peak = px; save(); }
    const why =
      o.k === 'tp' && px >= o.base * o.x ? `Take profit: <b>${esc(m.sym)}</b> is ${(px / o.base).toFixed(2)}× entry` :
      o.k === 'sl' && px <= o.base * (1 - o.drop) ? `Stop loss: <b>${esc(m.sym)}</b> is down ${Math.round((1 - px / o.base) * 100)}% from entry` :
      o.k === 'trail' && px <= o.peak * (1 - o.drop) ? `Trailing stop: <b>${esc(m.sym)}</b> fell ${Math.round((1 - px / o.peak) * 100)}% from its high (${(o.peak / o.base).toFixed(2)}× entry)` : null;
    if (why && (!fire || o.pct > fire.o.pct)) fire = { o, why };
  }
  if (fire) return fireSell(t, fire.o.pct, fire.why, fire.o);
  if (!p) return;
  // dev guard: the creator has sold or moved away a set share of the bag they held when you bought
  if (c.devsell > 0 && !p.devFired && every(t + ':dev', 4000)) {
    const d = await devOf(t).catch(() => null);
    if (d?.w && d.w !== me) {
      const db = num(await balOf(t, d.w), m.d), sup = num(m.sup, m.d);
      if (db > (d.peak || 0)) { d.peak = db; save(); }
      if (sup > 0 && d.peak >= 0.005 * sup && db <= d.peak * (1 - c.devsell / 100)) {
        p.devFired = true; save();
        return fireSell(t, 100, `Dev guard: the creator ${short(d.w)} has sold or moved ${Math.round((1 - db / d.peak) * 100)}% of their <b>${esc(m.sym)}</b>`);
      }
    }
  }
  // rug guard: only coins that passed the sell check at entry, so a failure now is a real change
  if (c.rug && p.scOk && r.kind === 'v4' && every(t + ':rug', 20000)) {
    const sc = await sellCheck(r, t, 5n * 10n ** 16n);
    const jump = sc.loss != null && sc.loss * 100 > Math.max(c.tax, (p.sc0 || 0) * 100 + 15);
    if (sc.blocked || jump) {
      p.scOk = false; save();
      return fireSell(t, 100, sc.blocked ? `Rug guard: <b>${esc(m.sym)}</b> can no longer be sold in a simulation` : `Rug guard: selling <b>${esc(m.sym)}</b> back now loses ${Math.round(sc.loss * 100)}% (was ${Math.round((p.sc0 || 0) * 100)}% when you bought)`);
    }
  }
}

// snipes fire on pools the index sees live
async function handleFresh() {
  if (!fresh.length) return;
  const list = fresh.splice(0);
  if (!state.snipes.length) return;
  for (const f of list) {
    for (const s of [...state.snipes]) {
      if (f.b <= s.b || (s.got || []).includes(f.t)) continue;
      let hit = false;
      if (s.k === 'token') hit = f.t === s.w;
      else if (s.k === 'new') { hit = f.newPm || (s.pms || []).includes(f.pm); if (hit && f.newPm) (s.pms ||= []).push(f.pm); }
      else if (s.k === 'dev') hit = (f.from ??= await txFrom(f.tx)) === s.w;
      if (!hit) continue;
      (s.got ||= []).push(f.t);
      if (--s.left <= 0) state.snipes = state.snipes.filter((x) => x.id !== s.id);
      save();
      snipeBuy(f, s).catch((e) => console.error('snipe', e.message));
    }
  }
}
async function snipeBuy(f, s) {
  const route = { kind: 'v4', name: pmName(f.pm), pm: f.pm, fee: f.fee, ts: f.ts, hook: f.hook };
  const label = `🎯 Snipe: ${s.k === 'token' ? 'pool opened' : s.k === 'dev' ? `${short(s.w)} launched a coin` : `first coins on new pool manager ${short(f.pm)}`}`;
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    try { return await buy(f.t, s.hype, null, false, 'snipe', { route, label }); }
    catch (e) {
      // a pool can open before its liquidity lands: keep trying for a minute
      if (/no route/.test(e.message) && Date.now() - t0 < 60000) { await sleep(i < 10 ? 300 : 1000); continue; }
      return say(`${label}\n⚠️ <code>${f.t}</code>: ${esc(e.message).slice(0, 200)}`);
    }
  }
}
function snipeText(s) {
  return s.k === 'token' ? `${s.hype} HYPE of <code>${short(s.w)}</code> when its pool opens` :
    s.k === 'dev' ? `${s.hype} HYPE of the next ${s.left > 1 ? s.left + ' coins' : 'coin'} ${short(s.w)} launches` :
    `${s.hype} HYPE of the first ${s.left > 1 ? s.left + ' coins' : 'coin'} on any new pool manager`;
}

// copy trading: Transfer logs to and from the copied wallets, every second
const NOCOPY = new Set(['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81', '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65']); // WHYPE, USDC
let copyBlock = 0;
const copySeen = new Set(); // sell logs already mirrored
async function copyTick() {
  const leaders = Object.keys(state.copy);
  if (!leaders.length) { copyBlock = 0; return; }
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  if (!copyBlock || head - copyBlock > 4000) copyBlock = head; // first run or a long outage: from now on, never old trades
  if (head <= copyBlock) return;
  const from = copyBlock + 1 - 12, to = Math.min(head, copyBlock + 2000); // a few blocks again, for nodes a block behind
  const pad = leaders.map((w) => '0x' + word(w));
  const [ins, outs] = await Promise.all([
    rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics: [T_TRANSFER, null, pad] }], 3),
    rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics: [T_TRANSFER, pad] }], 3),
  ]);
  copyBlock = to;
  const paid = new Set(outs.map((l) => lc(l.transactionHash)));
  const seen = new Set();
  if (copySeen.size > 5000) copySeen.clear();
  for (const l of ins) {
    const tok = lc(l.address), w = lc('0x' + l.topics[2].slice(26)), key = `${w}:${tok}`;
    if (NOCOPY.has(tok) || state.copyDone[key] || seen.has(key) || !state.copy[w]) continue;
    seen.add(key);
    const tx = await rpc('eth_getTransactionByHash', [l.transactionHash]).catch(() => null);
    if (!tx || lc(tx.from) !== w) continue;                                  // sent to them by someone else
    if (!(BigInt(tx.value || 0) > 0n) && !paid.has(lc(l.transactionHash))) continue; // nothing paid: a claim or airdrop
    state.copyDone[key] = Date.now();
    copyBuy(w, tok).catch((e) => console.error('copy', e.message));
  }
  if (cfg().copysells) {
    for (const l of outs) {
      const tok = lc(l.address), w = lc('0x' + l.topics[1].slice(26)), p = state.pos[tok];
      const lk = `${lc(l.transactionHash)}:${l.logIndex ?? tok}`;
      if (NOCOPY.has(tok) || !p || p.copy !== w || !isOpen(p) || busy.has(tok) || copySeen.has(lk)) continue;
      copySeen.add(lk);
      const tx = await rpc('eth_getTransactionByHash', [l.transactionHash]).catch(() => null);
      if (!tx || lc(tx.from) !== w) continue;
      const amt = BigInt(l.data), left = await balOf(tok, w).catch(() => null);
      if (left == null) continue;
      const share = Number((amt * 1000n) / (amt + left || 1n)) / 10;
      fireSell(tok, share >= 90 ? 100 : Math.max(1, Math.round(share)), `Copy: <b>${esc(state.copy[w]?.name || short(w))}</b> sold ${Math.round(share)}% of their <b>${esc(p.sym)}</b>`, null, '👥');
    }
  }
  if (Object.keys(state.copyDone).length > 5000) for (const [k, v] of Object.entries(state.copyDone)) if (Date.now() - v > 30 * 864e5) delete state.copyDone[k];
  save();
}
async function copyBuy(w, tok) {
  const c = state.copy[w];
  if (!c || isOpen(state.pos[tok])) return; // already holding it
  const day = new Date().toISOString().slice(0, 10);
  if (state.copyDay?.d !== day) state.copyDay = { d: day, n: 0, capped: false };
  if (state.copyDay.n >= cfg().copymax) {
    if (!state.copyDay.capped) { state.copyDay.capped = true; save(); await say(`👥 Daily copy cap reached (${cfg().copymax} buys). Skipping copies until tomorrow; /set copymax to change.`); }
    return;
  }
  state.copyDay.n++; save();
  const label = `👥 Copy: <b>${esc(c.name)}</b> bought`;
  let res = null;
  try { res = await buy(tok, Math.min(c.hype, cfg().max), null, false, `copy ${c.name}`, { label, copy: w }); }
  catch (e) { if (!/no route/.test(e.message)) await say(`${label} <code>${tok}</code>\n⚠️ ${esc(e.message).slice(0, 200)}`); }
  if (!res?.ok) { state.copyDay.n--; save(); }
}

// ── other commands ─────────────────────────────────────────────────────────────────────────────────
async function balances() {
  const [b, px] = await Promise.all([hypeBal(), hypeUsd()]);
  const lines = [`Wallet <code>${account.address}</code>`, `HYPE: <b>${fmtH(num(b))}</b>${usd(num(b), px)}`];
  const held = [];
  for (const t of Object.keys(state.pos).slice(-15)) {
    try { const bal = await balOf(t); if (bal > 0n) held.push([t, bal]); } catch {}
  }
  for (const [t, bal] of held.slice(0, 10)) {
    const m = await tokenMeta(t);
    let v = '';
    try { const r = await findRoute(t); const p = await quoteBuy(r, t, 10n ** 16n); const h = num(bal, m.d) * (0.01 / num(p, m.d)); v = ` ≈ ${fmtH(h)}`; } catch {}
    lines.push(`• ${esc(m.sym)}: ${fmt(num(bal, m.d))}${v} · /c_${t.slice(2, 10)}`);
  }
  lines.push(`Max per buy ${cfg().max} HYPE · slippage ${Number(cfg().slip) / 100}%`);
  return lines.join('\n');
}
async function pnl() {
  const rows = [];
  let tin = 0, tout = 0, tnow = 0;
  for (const [t, p] of Object.entries(state.pos)) {
    if (!p.hypeIn) continue;
    let now = 0;
    try {
      const bal = await balOf(t);
      if (bal > 0n) { const m = await tokenMeta(t); const r = await findRoute(t); const q = await quoteBuy(r, t, 10n ** 16n); now = num(bal, m.d) * (0.01 / num(q, m.d)); }
    } catch {}
    const pl = now + p.hypeOut - p.hypeIn;
    tin += p.hypeIn; tout += p.hypeOut; tnow += now;
    rows.push(`${pl >= 0 ? '🟢' : '🔴'} <b>${esc(p.sym)}</b> in ${fmtH(p.hypeIn)} · out ${fmtH(p.hypeOut)} · holding ${fmtH(now)} · <b>${pl >= 0 ? '+' : ''}${fmtH(pl)}</b>`);
  }
  if (!rows.length) return 'No trades through this bot yet.';
  const total = tnow + tout - tin;
  return rows.slice(-20).join('\n') + `\n\nTotal: in ${fmtH(tin)} · out ${fmtH(tout)} · holding ${fmtH(tnow)} · <b>${total >= 0 ? '+' : ''}${fmtH(total)}</b>`;
}
// ── performance: trade journal, stats, nightly report with tips ───────────────────────────────────
// Every buy, sell, revert and refused buy is journaled with where the tap came from (which alert type),
// entry market cap, slippage and the sell check result. Open bags are valued every 10 minutes (their
// peak is kept, to spot gains given back). /stats and a nightly report turn that into numbers and tips.
state.journal ||= [];
state.equity ||= [];   // daily wallet value snapshots [{ d: 'YYYY-MM-DD', v: HYPE }]
const REPORT_HOUR_UTC = Number(process.env.REPORT_HOUR_UTC ?? 20); // 21:00 in Lagos
const J = (e) => { state.journal.push({ t: Date.now(), ...e }); if (state.journal.length > 3000) state.journal.splice(0, state.journal.length - 3000); save(); };
// which alert a ⚡ tap came from, by the alert's first emoji
const srcOf = (txt = '') => {
  const map = [['🚀', 'launch alert'], ['🔥', 'volume run'], ['🎯', 'group buy'], ['👛', 'wallet move'], ['🧬', 'fresh wallet'], ['🌉', 'bridge'], ['🚨', 'gate'], ['🛬', 'cielo arrival']];
  for (const [e, n] of map) if (txt.startsWith(e)) return n;
  return 'card';
};
async function valuePositions() {
  for (const [t, p] of Object.entries(state.pos)) {
    if (!(p.hypeIn > 0)) continue;
    try {
      const bal = await balOf(t);
      if (bal === 0n) { p.now = 0; p.nowAt = Date.now(); p.open = false; continue; }
      const m = await tokenMeta(t);
      const r = await findRoute(t);
      if (!r) continue;
      const q = await quoteBuy(r, t, 10n ** 16n);
      p.now = num(bal, m.d) * (0.01 / num(q, m.d));
      p.nowAt = Date.now();
      p.peak = Math.max(p.peak || 0, p.now + (p.hypeOut || 0)); // best total value this trade ever showed
    } catch {}
  }
  save();
}
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const mcBucket = (usdMc) => (usdMc == null ? null : usdMc < 5e3 ? 'under $5K' : usdMc < 20e3 ? '$5K to $20K' : usdMc < 100e3 ? '$20K to $100K' : 'over $100K');
function stats(sinceMs = 0) {
  const coins = new Set(state.journal.filter((e) => e.side === 'buy' && e.t >= sinceMs).map((e) => e.coin));
  const rows = [];
  for (const c of coins) {
    const p = state.pos[c];
    if (!p || !(p.hypeIn > 0)) continue;
    const pl = (p.now ?? 0) + (p.hypeOut || 0) - p.hypeIn;
    rows.push({ c, sym: p.sym, inv: p.hypeIn, out: p.hypeOut || 0, now: p.now ?? 0, pl, r: pl / p.hypeIn, src: p.src || 'card', mc0: p.mc0Usd ?? null, peak: p.peak || 0, open: (p.now ?? 0) > 0.0005, first: p.first, lastSell: p.lastSell });
  }
  const j = state.journal.filter((e) => e.t >= sinceMs);
  const s = {
    rows,
    inv: rows.reduce((a, x) => a + x.inv, 0), out: rows.reduce((a, x) => a + x.out, 0), now: rows.reduce((a, x) => a + x.now, 0),
    buys: j.filter((e) => e.side === 'buy').length, sells: j.filter((e) => e.side === 'sell').length,
    reverts: j.filter((e) => e.side === 'revert').length, refused: j.filter((e) => e.side === 'refused').length,
  };
  s.pl = s.now + s.out - s.inv;
  const wins = rows.filter((x) => x.pl > 0), losses = rows.filter((x) => x.pl <= 0);
  s.winRate = rows.length ? wins.length / rows.length : 0;
  s.avgWin = wins.length ? wins.reduce((a, x) => a + x.r, 0) / wins.length : 0;
  s.avgLoss = losses.length ? losses.reduce((a, x) => a + x.r, 0) / losses.length : 0;
  const group = (key) => {
    const g = {};
    for (const x of rows) { const k = key(x); if (!k) continue; (g[k] ||= []).push(x); }
    return Object.entries(g).map(([k, xs]) => ({ k, n: xs.length, avg: xs.reduce((a, x) => a + x.r, 0) / xs.length, pl: xs.reduce((a, x) => a + x.pl, 0), win: xs.filter((x) => x.pl > 0).length / xs.length }));
  };
  s.bySrc = group((x) => x.src).sort((a, b) => b.avg - a.avg);
  s.byMc = group((x) => mcBucket(x.mc0)).sort((a, b) => b.avg - a.avg);
  return s;
}
function tips(s, hypeNow) {
  const out = [];
  const tries = s.buys + s.reverts;
  if (tries >= 5 && s.reverts / tries >= 0.3) out.push([5, `${s.reverts} of ${tries} buys reverted on slippage. Fresh launches move fast: try <code>/set slip 25</code> (now ${Number(cfg().slip) / 100}%).`]);
  if (tries >= 8 && s.reverts === 0 && cfg().slip >= 3000n) out.push([5, `No reverts at ${Number(cfg().slip) / 100}% slippage: <code>/set slip 20</code> would stop you overpaying on fills.`]);
  const src = s.bySrc.filter((x) => x.n >= 3);
  if (src.length >= 2) {
    const b = src[0], w = src[src.length - 1];
    if (b.avg - w.avg > 0.3) out.push([6, `Buys from <b>${esc(b.k)}</b> average ${pct(b.avg)} (${b.n} coins) vs <b>${esc(w.k)}</b> ${pct(w.avg)} (${w.n}). Lean on the first, size down or skip the second.`]);
  }
  const mc = s.byMc.filter((x) => x.n >= 3);
  if (mc.length >= 2 && mc[0].avg - mc[mc.length - 1].avg > 0.3) out.push([7, `Entries at <b>${mc[0].k}</b> market cap average ${pct(mc[0].avg)}; at ${mc[mc.length - 1].k} ${pct(mc[mc.length - 1].avg)}.`]);
  const dead = s.rows.filter((x) => x.open && x.r <= -0.5 && Date.now() - (x.first || 0) > 24 * 3600e3).sort((a, b) => a.r - b.r);
  if (dead.length) out.push([3, `Bags down over 50% for a day or more: ${dead.slice(0, 3).map((x) => `${esc(x.sym)} ${pct(x.r)}`).join(', ')}. Cut them or write them off; they rarely come back.`]);
  const runners = s.rows.filter((x) => x.open && x.out === 0 && x.now >= 2 * x.inv).sort((a, b) => b.now / b.inv - a.now / a.inv);
  if (runners.length) out.push([1, `${runners.slice(0, 2).map((x) => `<b>${esc(x.sym)}</b> is ${(x.now / x.inv).toFixed(1)}×`).join(', ')} with nothing taken. 💰 Initials on its card sells ${Math.round(100 / (runners[0].now / runners[0].inv))}% to get your stake back; the rest rides free.`]);
  const gave = s.rows.filter((x) => !x.open && x.peak >= 2 * x.inv && x.out < 1.3 * x.inv);
  if (gave.length) out.push([4, `You gave back gains on ${gave.slice(0, 2).map((x) => `${esc(x.sym)} (peaked ${(x.peak / x.inv).toFixed(1)}×, closed ${(x.out / x.inv).toFixed(1)}×)`).join(', ')}.${cfg().auto === 'off' ? ` <code>/auto ${DEFAULT_AUTO}</code> takes half at 2× and trails the rest automatically.` : ` Your preset is ${esc(cfg().auto)}; a tighter trail would have kept more.`}`]);
  if (s.rows.length >= 6 && s.winRate < 0.4 && s.avgWin < 2 * Math.abs(s.avgLoss)) out.push([8, `Win rate ${(s.winRate * 100).toFixed(0)}% with wins averaging ${pct(s.avgWin)} and losses ${pct(s.avgLoss)}: that loses money over time. Smaller sizes until one setup proves itself.`]);
  const total = hypeNow + s.rows.reduce((a, x) => a + x.now, 0);
  const big = s.rows.filter((x) => x.now > 0.4 * total && total > 0)[0];
  if (big) out.push([2, `<b>${esc(big.sym)}</b> is ${((big.now / total) * 100).toFixed(0)}% of the wallet. One rug there sinks the week.`]);
  return out.sort((x, y) => x[0] - y[0]).map((x) => x[1]).slice(0, 4);
}
function statsText(s, label, px) {
  if (!s.rows.length && !s.reverts && !s.refused) return `No trades ${label}.`;
  const best = [...s.rows].sort((a, b) => b.r - a.r).slice(0, 3), worst = [...s.rows].sort((a, b) => a.r - b.r).slice(0, 2);
  return `<b>${label}</b>: ${s.rows.length} coins · ${s.buys} buys · ${s.sells} sells${s.reverts ? ` · ${s.reverts} reverted` : ''}${s.refused ? ` · ${s.refused} refused by the sell check` : ''}\n` +
    `In ${fmtH(s.inv)} · out ${fmtH(s.out)} · still holding ${fmtH(s.now)} · <b>${s.pl >= 0 ? '+' : ''}${fmtH(s.pl)}</b>${usd(s.pl, px)}\n` +
    (s.rows.length ? `Win rate ${(s.winRate * 100).toFixed(0)}% · avg win ${pct(s.avgWin)} · avg loss ${pct(s.avgLoss)}\n` : '') +
    (best.length ? `Best: ${best.map((x) => `${esc(x.sym)} ${pct(x.r)}`).join(', ')}\n` : '') +
    (worst.length && worst[0].r < 0 ? `Worst: ${worst.map((x) => `${esc(x.sym)} ${pct(x.r)}`).join(', ')}\n` : '') +
    (s.bySrc.length > 1 ? `By source: ${s.bySrc.map((x) => `${esc(x.k)} ${pct(x.avg)} (${x.n})`).join(' · ')}\n` : '');
}
async function statsCommand(arg) {
  await valuePositions();
  const spans = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6, all: Infinity };
  const k = spans[arg] ? arg : '7d';
  const since = spans[k] === Infinity ? 0 : Date.now() - spans[k];
  const [px, hb] = await Promise.all([hypeUsd(), hypeBal().catch(() => 0n)]);
  const s = stats(since);
  const t = tips(stats(0), num(hb));
  return statsText(s, k === 'all' ? 'All time' : `Last ${k}`, px) + (t.length ? `\n💡 <b>Tips</b>\n${t.map((x) => '• ' + x).join('\n')}` : '\nTips appear once there are a few trades to learn from.') + `\n\n/stats 24h · /stats 7d · /stats 30d · /stats all`;
}
function journalText() {
  const last = state.journal.slice(-15).reverse();
  if (!last.length) return 'Journal is empty.';
  const icon = { buy: '🟢', sell: '🔵', revert: '❌', refused: '🚫', 'sell-revert': '❌' };
  return last.map((e) => `${icon[e.side] || '•'} ${new Date(e.t).toISOString().slice(5, 16).replace('T', ' ')} ${e.side} <b>${esc(e.sym)}</b> ${e.hype != null ? fmtH(e.hype) : ''}${e.mcUsd ? ` · MC $${fmt(e.mcUsd)}` : ''}${e.src ? ` · ${esc(e.src)}` : ''}${e.sc != null ? ` · rt ${(e.sc * 100).toFixed(0)}%` : ''}`).join('\n') + '\n\n/export sends the full journal as a CSV.';
}
async function exportJournal() {
  const cols = ['time', 'side', 'symbol', 'coin', 'hype', 'tokens', 'mc_usd', 'source', 'slippage_pct', 'roundtrip_pct', 'route', 'tx'];
  const lines = [cols.join(',')].concat(state.journal.map((e) => [new Date(e.t).toISOString(), e.side, e.sym, e.coin, e.hype ?? '', e.tok ?? '', e.mcUsd != null ? Math.round(e.mcUsd) : '', e.src ?? '', e.slip != null ? e.slip / 100 : '', e.sc != null ? (e.sc * 100).toFixed(1) : '', e.route ?? '', e.hash ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
  const fd = new FormData();
  fd.append('chat_id', OWNER);
  fd.append('caption', `Trade journal · ${state.journal.length} entries`);
  fd.append('document', new Blob([lines.join('\n')], { type: 'text/csv' }), `ely-router-journal-${new Date().toISOString().slice(0, 10)}.csv`);
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) }).then((x) => x.json()).catch((e) => ({ ok: false, description: e.message }));
  if (!r.ok) return say(`Export failed: ${esc(r.description || '?')}`);
}
// nightly: wallet value vs yesterday, the day's trades, open bags, tips
async function dailyReport(force = true) {
  await valuePositions();
  const [px, hb] = await Promise.all([hypeUsd(), hypeBal().catch(() => 0n)]);
  const hype = num(hb);
  const open = Object.values(state.pos).filter((p) => (p.now ?? 0) > 0.0005).sort((a, b) => b.now - a.now);
  const value = hype + open.reduce((a, p) => a + p.now, 0);
  const today = new Date().toISOString().slice(0, 10);
  const prev = state.equity[state.equity.length - 1];
  state.equity = state.equity.filter((e) => e.d !== today).concat([{ d: today, v: value }]).slice(-120);
  save();
  const s = stats(Date.now() - 864e5);
  let t = tips(stats(0), hype);
  // quiet mode: a tip already shown in the last 3 days is not repeated, and a day with no trades and
  // no new tip sends nothing at all
  state.tipsSeen ||= {};
  const key = (x) => x.replace(/<[^>]+>/g, '').replace(/[\d.,%×+-]+/g, '#').slice(0, 80);
  if (!force) t = t.filter((x) => !(Date.now() - (state.tipsSeen[key(x)] || 0) < 3 * 864e5));
  for (const x of t) state.tipsSeen[key(x)] = Date.now();
  const traded = s.buys + s.sells + s.reverts + s.refused > 0;
  if (!force && cfg().report === 'quiet' && !traded && !t.length) return null;
  const ch = prev && prev.d !== today ? value - prev.v : null;
  const text = `📒 <b>Daily report</b> · wallet ${fmtH(value)}${usd(value, px)}${ch != null ? ` (${ch >= 0 ? '+' : ''}${fmtH(ch)} vs ${prev.d})` : ''}\n` +
    `Free HYPE ${fmtH(hype)} · ${open.length} open bag${open.length === 1 ? '' : 's'}\n\n` +
    statsText(s, 'Last 24h', px) +
    (open.length ? `\n<b>Open bags</b>\n${open.slice(0, 8).map((p) => { const r = ((p.now ?? 0) + (p.hypeOut || 0) - p.hypeIn) / p.hypeIn; return `• ${esc(p.sym)} ${fmtH(p.now)} · ${pct(r)}`; }).join('\n')}\n` : '') +
    (t.length ? `\n💡 <b>Tips</b>\n${t.map((x) => '• ' + x).join('\n')}` : '');
  return say(text);
}

async function withdraw(to, amtStr) {
  const bal = await hypeBal();
  const gasCost = 21000n * (await gasPrice()) * 2n;
  const value = amtStr === 'all' ? bal - gasCost : toWei(amtStr);
  if (!value || value <= 0n || value > bal - gasCost / 2n) throw new Error(`not enough HYPE (wallet has ${fmtH(num(bal))})`);
  const hash = await serial(() => sendRaw({ to, value, data: '0x', gas: 21000 }));
  const msg = await say(`⏳ Sending ${fmtH(num(value))} to <code>${to}</code> · ${txLink(hash)}`);
  track(hash, (rc) => edit(msg, `${rc.status === '0x1' ? '✅ Sent' : '❌ Failed to send'} ${fmtH(num(value))} to <code>${to}</code> · ${txLink(hash)}`), () => edit(msg, `⌛ Withdrawal not confirmed after 2 h · ${txLink(hash)}`));
}

const HELP =
  `<b>ely-router</b>\n` +
  `Paste a token address (or a link with one) for a card with buy, sell, 💰 initials and 🤖 auto-sell buttons.\n` +
  `/buy &lt;token&gt; &lt;HYPE&gt; · /sell &lt;coin&gt; &lt;percent&gt; · /initials &lt;coin&gt;\n` +
  `&lt;coin&gt; = address, the symbol of a coin you hold, or its 8-character code\n\n` +
  `<b>Auto-sell</b>\n` +
  `/tp &lt;coin&gt; 2x 50 · /sl &lt;coin&gt; 40 · /trail &lt;coin&gt; 35 · /orders\n` +
  `/auto ${DEFAULT_AUTO} (added to every buy) · /auto off\n` +
  `/limit &lt;coin&gt; &lt;HYPE&gt; [below|above] &lt;MC $&gt;, e.g. /limit 0x… 1 20k\n\n` +
  `<b>Snipe and copy</b>\n` +
  `/snipe &lt;token&gt; &lt;HYPE&gt; (buys when its pool opens)\n` +
  `/snipe dev &lt;wallet&gt; &lt;HYPE&gt; [count] · /snipe new &lt;HYPE&gt; [count] (new launchpad) · /snipes\n` +
  `/copy &lt;wallet&gt; &lt;HYPE&gt; [name] · /copy off &lt;wallet|name|all&gt; · /copy sells on|off · /copy\n\n` +
  `<b>Guards</b> (on every coin you hold)\n` +
  `/set devsell 50 (sell when the creator dumps half; 0 = off) · /set rug on|off · /set preapprove on|off\n\n` +
  `/bal · /pnl · /wallet · /stats 7d · /journal · /export · /report\n` +
  `/set slip 15 · /set max 5 · /set sizes 0.5,1,2,5 · /set tax 25 · /set check off · /set stale 5\n` +
  `/set report quiet|on|off · /set copymax 10\n` +
  `/withdraw &lt;address&gt; &lt;HYPE|all&gt; · /nonce if a transaction is stuck`;

// ── update handling ────────────────────────────────────────────────────────────────────────────────
const addrIn = (s) => (String(s).match(/0x[0-9a-fA-F]{40}/) || [])[0]?.toLowerCase();
const pending = {}; // withdraw confirmations: id → {to, amt}
const taps = {};    // recent ⚡ taps, to drop accidental double taps
// a coin by address, by the symbol of a coin you have traded (latest first), or by its /c_ code
function coinArg(s) {
  const a = addrIn(s || '');
  if (a) return a;
  const x = lc(s).replace(/^\/c_/, '').replace(/^\$/, '');
  if (!x) return null;
  if (/^[0-9a-f]{8}$/.test(x)) { const t = Object.keys(state.pos).find((k) => k.slice(2, 10) === x); if (t) return t; }
  const hits = Object.entries(state.pos).filter(([, p]) => lc(p.sym) === x).sort((a, b) => (isOpen(b[1]) - isOpen(a[1])) || ((b[1].first || b[1].t || 0) - (a[1].first || a[1].t || 0)));
  return hits[0]?.[0] || null;
}
const symOf = async (t) => state.pos[t]?.sym || (await tokenMeta(t)).sym;
function ordersView(only) {
  const rows = [], kb = [];
  for (const [t, os] of Object.entries(state.orders)) {
    if (!os?.length || (only && t !== only)) continue;
    const sym = esc(state.pos[t]?.sym || meta[t]?.sym || short(t));
    rows.push(`• <b>${sym}</b>: ${os.map((o) => orderText(o) + (o.k === 'trail' && o.base ? ` (high ${(o.peak / o.base).toFixed(2)}×)` : '')).join(' · ')}`);
    if (only) for (const o of os) kb.push([{ text: `✖ ${orderText(o)}`, callback_data: `o:${o.id}` }]);
    else kb.push([{ text: `✖ ${state.pos[t]?.sym || meta[t]?.sym || short(t)}`, callback_data: `z:${t.slice(2)}` }]);
  }
  const c = cfg();
  const foot = `\nPreset on new buys: ${c.auto === 'off' ? 'off (/auto)' : esc(c.auto)}\nGuards: dev ${c.devsell ? c.devsell + '%' : 'off'} · rug ${c.rug ? 'on' : 'off'}`;
  return { text: (rows.length ? `<b>Orders</b>\n${rows.join('\n')}\n` : only ? 'No orders on this coin. 🤖 Auto-sell adds your preset, or /tp /sl /trail.\n' : 'No open orders.\n') + foot, rows: kb.slice(0, 30) };
}
function snipesView() {
  if (!state.snipes.length) return { text: 'No snipes armed. /snipe &lt;token&gt; &lt;HYPE&gt; · /snipe dev &lt;wallet&gt; &lt;HYPE&gt; · /snipe new &lt;HYPE&gt;' };
  return { text: `<b>Snipes</b> (pool index every 0.4 s)\n${state.snipes.map((s) => '• ' + snipeText(s)).join('\n')}`, rows: state.snipes.map((s) => [{ text: `✖ ${s.k} ${s.hype} HYPE`, callback_data: `n:${s.id}` }]) };
}
function copyView() {
  const ws = Object.entries(state.copy);
  const c = cfg();
  if (!ws.length) return { text: 'Not copying anyone. /copy &lt;wallet&gt; &lt;HYPE&gt; [name]' };
  return {
    text: `<b>Copying</b> (first buy of each coin${c.copysells ? ', sells mirrored' : ''}; ${state.copyDay?.n || 0}/${c.copymax} copy buys today)\n` +
      ws.map(([w, x]) => `• <b>${esc(x.name)}</b> <code>${w}</code> · ${x.hype} HYPE`).join('\n'),
    rows: ws.map(([w, x]) => [{ text: `✖ ${x.name}`, callback_data: `y:${w.slice(2)}` }]),
  };
}

async function onMessage(msg) {
  const text = (msg.text || '').trim();
  const [cmd0, ...args] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@\S+$/, '');
  const reply = msg.message_id;
  if (cmd === '/start' || cmd === '/help') {
    const b = await hypeBal().catch(() => null);
    return say(HELP + `\n\nWallet <code>${account.address}</code>${b != null ? ` · ${fmtH(num(b))}` : ''}\nPools indexed: ${poolCount()} (up to block ${state.poolsBlock})`);
  }
  if (cmd === '/wallet') return say(`<code>${account.address}</code>\nFund it with HYPE on Elysium. The key only lives on your VPS.`);
  if (cmd === '/bal') return say(await balances());
  if (cmd === '/pnl') return say(await pnl());
  if (cmd === '/stats') return say(await statsCommand(lc(args[0] || '')));
  if (cmd === '/journal') return say(journalText());
  if (cmd === '/export') return exportJournal();
  if (cmd === '/report') return dailyReport();
  if (cmd === '/nonce') { const n = await resyncNonce(); return say(`Nonce resynced: next is ${n}.`); }
  if (cmd === '/set') {
    const [k, v] = args;
    const lv = lc(v || '');
    if (k === 'slip' && Number(v) > 0 && Number(v) <= 50) state.set.slip = Math.round(Number(v) * 100);
    else if (k === 'max' && Number(v) > 0) state.set.max = Number(v);
    else if (k === 'sizes' && /^[\d.,]+$/.test(v || '')) state.set.sizes = v;
    else if (k === 'tax' && Number(v) > 0 && Number(v) <= 100) state.set.tax = Number(v);
    else if (k === 'check' && /^(on|off)$/.test(lv)) state.set.check = lv;
    else if (k === 'stale' && Number(v) >= 0) state.set.stale = Number(v);
    else if (k === 'report' && /^(on|off|quiet)$/.test(lv)) state.set.report = lv;
    else if (k === 'devsell' && (lv === 'off' || (Number(v) >= 0 && Number(v) <= 100))) state.set.devsell = lv === 'off' ? 0 : Number(v);
    else if (k === 'rug' && /^(on|off)$/.test(lv)) state.set.rug = lv;
    else if (k === 'preapprove' && /^(on|off)$/.test(lv)) state.set.preapprove = lv;
    else if (k === 'copymax' && Number(v) >= 0) state.set.copymax = Number(v);
    else return say('Usage: /set slip 15 · max 5 · sizes 0.5,1,2,5 · tax 25 · check on|off · stale 5 · report quiet|on|off · devsell 50 · rug on|off · preapprove on|off · copymax 10');
    save();
    const c = cfg();
    return say(`Saved. Slippage ${Number(c.slip) / 100}% · max ${c.max} HYPE · sizes ${c.sizes.join(', ')} · sell check ${c.check ? `on (limit ${c.tax}%)` : 'OFF'} · stale taps ${c.stale ? `after ${c.stale} min` : 'off'} · report ${c.report}\n` +
      `Dev guard ${c.devsell ? c.devsell + '%' : 'off'} · rug guard ${c.rug ? 'on' : 'off'} · pre-approve ${c.preapprove ? 'on' : 'off'} · auto-sell ${c.auto === 'off' ? 'off' : esc(c.auto)} · copy cap ${c.copymax}/day`);
  }
  if (cmd === '/buy') {
    const t = addrIn(args[0]); const a = Number(args[1]);
    if (!t || !(a > 0)) return say('Usage: /buy 0xTOKEN 1.5');
    return buy(t, a, reply);
  }
  if (cmd === '/sell') {
    const t = coinArg(args[0]); const p = Number(String(args[1] || '100').replace('%', ''));
    if (!t || !(p > 0)) return say('Usage: /sell &lt;coin&gt; 50');
    return sell(t, p, reply);
  }
  if (cmd === '/initials') {
    const t = coinArg(args[0]);
    if (!t) return say('Usage: /initials &lt;coin&gt;');
    return initials(t, reply);
  }
  if (cmd === '/tp' || cmd === '/sl' || cmd === '/trail') {
    const t = coinArg(args[0]);
    if (!t || args.length < 2) return say(`Usage: ${cmd} &lt;coin&gt; ${cmd === '/tp' ? '2x 50 (sell 50% at 2× entry)' : cmd === '/sl' ? '40 (sell all when 40% under entry)' : '35 (sell all when 35% off the high)'}\nCombine: /tp &lt;coin&gt; 2x 50 tp 5x 100 sl 40`);
    const specs = parseSpec([cmd.slice(1), ...args.slice(1)].join(' '));
    if ((await balOf(t)) === 0n) return say(`You hold no ${esc(await symOf(t))} in the bot wallet; orders only work on coins it holds.`);
    const os = await setOrders(t, specs);
    return say(`🤖 <b>${esc(await symOf(t))}</b>: ${os.map(orderText).join(' · ')}\nChecked every 2 s.`, [[{ text: '✖ Cancel all on this coin', callback_data: `z:${t.slice(2)}` }]]);
  }
  if (cmd === '/orders') { const t = args[0] ? coinArg(args[0]) : null; const v = ordersView(t); return say(v.text, v.rows.length ? v.rows : null); }
  if (cmd === '/auto') {
    const a = lc(args.join(' ').trim());
    if (!a) return say(`Auto-sell preset (added to every buy): <b>${cfg().auto === 'off' ? 'off' : esc(cfg().auto)}</b>\n/auto ${DEFAULT_AUTO} · /auto on · /auto off\ntp = sell part at a multiple of entry · sl = sell when X% under entry · trail = sell when X% off the high since the buy`);
    if (a === 'off') { if (cfg().auto !== 'off') state.set.autoLast = cfg().auto; state.set.auto = 'off'; }
    else if (a === 'on') state.set.auto = state.set.autoLast || DEFAULT_AUTO;
    else { if (!parseSpec(a).length) return say('Nothing to set. Example: /auto tp 2x 50 trail 40'); state.set.auto = a; }
    save();
    return say(`Auto-sell preset: <b>${cfg().auto === 'off' ? 'off' : parseSpec(cfg().auto).map(orderText).join(' · ')}</b>.${cfg().auto === 'off' ? '' : ' Added to every new buy; 🤖 Auto-sell on a card adds it to a coin you already hold.'}`);
  }
  if (cmd === '/limit') {
    const t = coinArg(args[0]); const h = Number(args[1]);
    let dir = 'below', i = 2;
    if (/^(below|above|under|over)$/.test(lc(args[2] || ''))) { dir = /above|over/.test(lc(args[2])) ? 'above' : 'below'; i = 3; }
    const mc = parseUsd(args[i]);
    if (!t || !(h > 0) || !mc) return say('Usage: /limit &lt;coin&gt; &lt;HYPE&gt; [below|above] &lt;market cap $&gt;\ne.g. /limit 0xTOKEN 1 20k buys 1 HYPE when MC falls to $20K');
    if (h > cfg().max) throw new Error(`max per buy is ${cfg().max} HYPE (change with /set max)`);
    const r = await findRoute(t);
    if (!r) throw new Error('no route for this token');
    const [m, pr, u] = await Promise.all([tokenMeta(t), priceOf(t, r), hypeUsd()]);
    const now = pr && m.sup && u ? pr * num(m.sup, m.d) * u : null;
    (state.orders[t] ||= []).push({ id: oid(), k: 'lbuy', hype: h, mc, dir, at: Date.now(), exp: Date.now() + 3 * 864e5 });
    save();
    return say(`🎯 Limit buy: ${h} HYPE of <b>${esc(m.sym)}</b> when MC ${dir === 'above' ? 'rises to' : 'falls to'} $${fmt(mc)}${now ? ` (now $${fmt(now)}${(dir === 'below' ? now <= mc : now >= mc) ? ', already there: it buys on the next check' : ''})` : ''}. Sell check still runs. Expires in 3 days; /orders to cancel.`);
  }
  if (cmd === '/snipe') {
    const sub = lc(args[0] || '');
    const usage = 'Usage:\n/snipe 0xTOKEN 1 · buys when its pool opens\n/snipe dev 0xWALLET 1 [count] · the next coin(s) that wallet launches\n/snipe new 1 [count] · the first coin(s) on a pool manager never used before (a new launchpad)\n/snipe off · cancel all';
    if (sub === 'off') { state.snipes = []; save(); return say('All snipes cancelled.'); }
    let s;
    if (sub === 'dev') { const w = addrIn(args[1]), h = Number(args[2]); if (!w || !(h > 0)) return say(usage); s = { k: 'dev', w, hype: h, left: Math.max(1, Math.min(20, Math.floor(Number(args[3]) || 1))) }; }
    else if (sub === 'new') { const h = Number(args[1]); if (!(h > 0)) return say(usage); s = { k: 'new', hype: h, left: Math.max(1, Math.min(20, Math.floor(Number(args[2]) || 1))) }; }
    else { const t = addrIn(args[0]), h = Number(args[1]); if (!t || !(h > 0)) return say(usage); s = { k: 'token', w: t, hype: h, left: 1 }; }
    if (s.hype > cfg().max) throw new Error(`max per buy is ${cfg().max} HYPE (change with /set max)`);
    s.id = oid(); s.at = Date.now(); s.b = Number(BigInt(await rpc('eth_blockNumber', [])));
    state.snipes.push(s); save();
    const already = s.k === 'token' && state.pools[s.w]?.length ? `\nIt already has ${state.pools[s.w].length} pool${state.pools[s.w].length > 1 ? 's' : ''}: this fires on its next new one (a migration). To buy now, paste it for a card.` : '';
    return say(`🎯 Snipe armed: ${snipeText(s)}. The pool index now checks every 0.4 s; the sell check still runs first.${already}`, [[{ text: '✖ Cancel', callback_data: `n:${s.id}` }]]);
  }
  if (cmd === '/snipes') { const v = snipesView(); return say(v.text, v.rows); }
  if (cmd === '/copy') {
    const sub = lc(args[0] || '');
    if (!sub) { const v = copyView(); return say(v.text, v.rows); }
    if (sub === 'off') {
      const x = lc(args[1] || '');
      if (x === 'all') state.copy = {};
      else {
        const w = addrIn(x) || Object.keys(state.copy).find((k) => lc(state.copy[k].name) === x);
        if (!w || !state.copy[w]) return say('Not copying that wallet. /copy lists who is copied.');
        delete state.copy[w];
      }
      save();
      return say(x === 'all' ? 'Stopped copying everyone.' : 'Stopped copying that wallet.');
    }
    if (sub === 'sells') {
      const v = lc(args[1] || '');
      if (!/^(on|off)$/.test(v)) return say('Usage: /copy sells on|off');
      state.set.copysells = v; save();
      return say(`Copied wallets' sells are ${v === 'on' ? 'mirrored by the same share' : 'ignored; you sell yourself'}.`);
    }
    const w = addrIn(args[0]), h = Number(args[1]);
    if (!w || !(h > 0)) return say('Usage: /copy 0xWALLET 0.5 [name] · /copy off &lt;wallet|name|all&gt; · /copy sells on|off · /copy');
    if (w === me) return say('That is the bot wallet.');
    if (h > cfg().max) throw new Error(`max per buy is ${cfg().max} HYPE (change with /set max)`);
    const name = args.slice(2).join(' ').replace(/[<>&]/g, '').slice(0, 24) || short(w);
    state.copy[w] = { name, hype: h, at: Date.now() }; save();
    return say(`👥 Copying <b>${esc(name)}</b> <code>${w}</code>: ${h} HYPE on the first buy of each coin they make from now on${cfg().copysells ? ', and their sells mirrored by the same share' : ''}. The sell check and your max still apply; at most ${cfg().copymax} copy buys a day. This list stays on your VPS.`, [[{ text: '✖ Stop', callback_data: `y:${w.slice(2)}` }]]);
  }
  if (cmd === '/withdraw') {
    const to = addrIn(args[0]); const a = lc(args[1] || '');
    if (!to || !(a === 'all' || toWei(a))) return say('Usage: /withdraw 0xYOURWALLET 5  (or all)');
    const id = Math.random().toString(36).slice(2, 10);
    pending[id] = { to, a };
    return say(`Send <b>${a === 'all' ? 'all HYPE' : a + ' HYPE'}</b> from the bot wallet to <code>${to}</code>?`, [[{ text: '✅ Send', callback_data: `w:${id}` }, { text: 'Cancel', callback_data: `x:${id}` }]]);
  }
  const short8 = cmd.match(/^\/c_([0-9a-f]{8})$/);
  if (short8) { const t = Object.keys(state.pos).find((x) => x.slice(2, 10) === short8[1]); if (t) return showCard(t); }
  const t = addrIn(text);
  if (t) { const m = await say(`🔎 Loading <code>${short(t)}</code>…`); return showCard(t, m); }
  return say(HELP);
}

async function onCallback(q) {
  const [kind, a, b] = String(q.data || '').split(':');
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: false });
  const t = /^[0-9a-f]{40}$/.test(a || '') ? '0x' + a : null;
  const reply = q.message?.message_id;
  if ((kind === 'b' || kind === 'f') && t) {
    // the same button twice within a few seconds is one buy, not two
    const key = `${reply}:${q.data}`;
    if (Date.now() - (taps[key] || 0) < 5000) return ack('Already buying');
    if (Object.keys(taps).length > 500) for (const k of Object.keys(taps)) delete taps[k];
    taps[key] = Date.now();
    // an old alert: show today's price first instead of buying blind
    const age = Math.floor(Date.now() / 1000) - (q.message?.date || 0);
    if (kind === 'b' && cfg().stale > 0 && age > cfg().stale * 60) {
      await ack(`This is ${age >= 3600 ? (age / 3600).toFixed(1) + ' h' : Math.round(age / 60) + ' min'} old. Showing the current price.`);
      return showCard(t);
    }
    const h = Number(b) / 10;
    await ack(`Buying ${h} HYPE…`);
    return buy(t, h, reply, kind === 'f', kind === 'f' ? 'override' : srcOf(q.message?.text || ''));
  }
  if (kind === 's' && t) { await ack(`Selling ${b}%…`); return sell(t, Number(b), reply); }
  if (kind === 'i' && t) {
    const key = `${reply}:${q.data}`;
    if (Date.now() - (taps[key] || 0) < 5000) return ack('Already selling');
    taps[key] = Date.now();
    await ack('Taking initials…'); return initials(t, reply);
  }
  if (kind === 'a' && t) {
    if ((await balOf(t)) === 0n) return ack('You hold none of this coin');
    const spec = cfg().auto !== 'off' ? cfg().auto : state.set.autoLast || DEFAULT_AUTO;
    const os = await setOrders(t, parseSpec(spec), true);
    await ack('Auto-sell set');
    return say(`🤖 <b>${esc(await symOf(t))}</b>: ${os.map(orderText).join(' · ')}\nChecked every 2 s. Change the preset with /auto, or set your own with /tp /sl /trail.`, [[{ text: '✖ Cancel all on this coin', callback_data: `z:${t.slice(2)}` }]], reply);
  }
  if (kind === 'l' && t) { await ack(''); const v = ordersView(t); return say(v.text, v.rows.length ? v.rows : null, reply); }
  if (kind === 'z' && t) { const n = (state.orders[t] || []).length; delete state.orders[t]; save(); await ack(n ? `Cancelled ${n} order${n > 1 ? 's' : ''}` : 'No orders'); return edit(q.message, `Orders on <b>${esc(await symOf(t))}</b> cancelled.`); }
  if (kind === 'o' && a) { removeOrder(a); await ack('Order cancelled'); const v = ordersView(); return edit(q.message, v.text, v.rows.length ? v.rows : null); }
  if (kind === 'n' && a) { state.snipes = state.snipes.filter((s) => s.id !== a); save(); await ack('Snipe cancelled'); const v = snipesView(); return edit(q.message, v.text, v.rows); }
  if (kind === 'y' && t) { delete state.copy[t]; save(); await ack('Stopped copying'); const v = copyView(); return edit(q.message, v.text, v.rows); }
  if (kind === 'r' && t) { await ack('Refreshing…'); delete state.routes[t]; return showCard(t, q.message); }
  if (kind === 'c' && t) { await ack('Loading…'); return showCard(t); }
  if (kind === 'w' && pending[a]) { const p = pending[a]; delete pending[a]; await ack('Sending…'); return withdraw(p.to, p.a); }
  if (kind === 'x') { delete pending[a]; await ack('Cancelled'); return edit(q.message, 'Cancelled.'); }
  return ack('');
}

async function main() {
  console.log(`ely-router · wallet ${account.address} · RPCs ${RPCS.length}`);
  await tg('setMyCommands', { commands: [
    { command: 'bal', description: 'Wallet balance and bags' }, { command: 'pnl', description: 'Profit and loss of bot trades' },
    { command: 'buy', description: '/buy <token> <HYPE>' }, { command: 'sell', description: '/sell <coin> <percent>' },
    { command: 'initials', description: '/initials <coin>: sell just enough to take your HYPE back' },
    { command: 'tp', description: '/tp <coin> 2x 50: take profit' }, { command: 'sl', description: '/sl <coin> 40: stop loss' },
    { command: 'trail', description: '/trail <coin> 35: trailing stop' }, { command: 'orders', description: 'Open orders and guards' },
    { command: 'auto', description: 'Auto-sell preset added to every buy' }, { command: 'limit', description: '/limit <coin> <HYPE> <MC $>' },
    { command: 'snipe', description: '/snipe <token|dev|new> <HYPE>' }, { command: 'snipes', description: 'Armed snipes' },
    { command: 'copy', description: '/copy <wallet> <HYPE> [name]' },
    { command: 'set', description: 'slip, max, sizes, guards' }, { command: 'withdraw', description: '/withdraw <address> <HYPE|all>' },
    { command: 'stats', description: 'Performance and tips: /stats 24h|7d|30d|all' }, { command: 'journal', description: 'Last 15 trades' },
    { command: 'export', description: 'Full trade journal as CSV' }, { command: 'report', description: 'Daily report now' },
    { command: 'wallet', description: 'Bot wallet address' }, { command: 'nonce', description: 'Resync after a stuck tx' },
    { command: 'help', description: 'Every command' },
  ] });
  // taps and messages sent while the bot was down are dropped, so an old ⚡ tap never buys hours later
  const backlog = await tg('getUpdates', { offset: -1, timeout: 0 });
  if (backlog?.length) state.offset = backlog[backlog.length - 1].update_id + 1;
  const b = await hypeBal().catch(() => null);
  // pool index: first run reads the whole chain (a minute or two), then every few seconds keeps it live
  const first = !state.poolsBlock;
  if (first) console.log('indexing every v4 pool on Elysium…');
  await indexPools().catch((e) => console.error('index', e.message));
  for (const l of Object.values(state.pools)) for (const p of l) knownPms.add(p.pm);
  live = true; // from here on, new pools are live events for snipes
  // the index tails the chain every 1.5 s, every 0.4 s while a snipe is armed
  (async () => { for (;;) { await sleep(state.snipes.length ? 400 : 1500); await indexPools().catch(() => {}); await handleFresh().catch((e) => console.error('snipes', e.message)); } })();
  // orders and guards every 2 s; copied wallets every second
  (async () => { for (;;) { await sleep(2000); await guardTick().catch((e) => console.error('guard', e.message)); } })();
  (async () => { for (;;) { await sleep(Object.keys(state.copy).length ? 1000 : 5000); await copyTick().catch((e) => console.error('copy', e.message)); } })();
  // open bags valued every 10 minutes; the daily report goes out once a day at REPORT_HOUR_UTC
  (async () => { for (;;) { await sleep(600000); await valuePositions().catch(() => {}); } })();
  (async () => {
    for (;;) {
      await sleep(60000);
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (cfg().report !== 'off' && d.getUTCHours() === REPORT_HOUR_UTC && state.reportDay !== day) { state.reportDay = day; save(); await dailyReport(cfg().report === 'on').catch((e) => console.error('report', e.message)); }
    }
  })();
  await say(`🟢 ely-router online · <code>${account.address}</code>${b != null ? ` · ${fmtH(num(b))}` : ''}\nPools indexed: ${poolCount()} across ${knownPms.size} pool managers, kept live.\n${(() => { const c = cfg(), n = Object.values(state.orders).reduce((a, l) => a + l.length, 0); return `Orders ${n} · snipes ${state.snipes.length} · copying ${Object.keys(state.copy).length} · auto-sell ${c.auto === 'off' ? 'off' : esc(c.auto)} · dev guard ${c.devsell ? c.devsell + '%' : 'off'} · rug guard ${c.rug ? 'on' : 'off'}`; })()}${backlog?.length ? '\nTaps sent while it was offline were skipped.' : ''}`);
  for (;;) {
    const ups = await tg('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    if (!ups) { await sleep(2000); continue; }
    for (const u of ups) {
      state.offset = u.update_id + 1;
      const from = String(u.message?.from?.id ?? u.callback_query?.from?.id ?? '');
      const chat = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? '');
      if (from !== OWNER || chat !== OWNER) continue; // only you, only in your private chat with the bot
      const job = u.message ? onMessage(u.message) : onCallback(u.callback_query);
      job.catch((e) => { console.error('handler', e.message); say(`⚠️ ${esc(e.message).slice(0, 300)}`); });
    }
    save();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
