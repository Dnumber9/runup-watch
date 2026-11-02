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
// Chat (only from OWNER_ID):
//   paste a token or a link containing one   card with live price, market cap, your bag, buttons
//   /buy <token> <HYPE>   /sell <token> <percent>
//   /bal   /pnl   /wallet
//   /set slip <percent>   /set max <HYPE>   /set sizes 0.5,1,2,5
//   /withdraw <address> <HYPE|all>   (asks you to confirm)
//   /nonce   resync the nonce after stuck transactions
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
const cfg = () => ({
  slip: BigInt(state.set.slip ?? process.env.SLIPPAGE_BPS ?? 1500),
  max: Number(state.set.max ?? process.env.MAX_BUY_HYPE ?? 5),
  sizes: (state.set.sizes ?? process.env.BUY_SIZES ?? '0.5,1,2,5').split(',').map((s) => s.trim()).filter(Boolean),
  tax: Number(state.set.tax ?? process.env.MAX_TAX_PCT ?? 25),     // refuse when buying and selling straight back loses more than this %
  check: (state.set.check ?? process.env.SELL_CHECK ?? 'on') !== 'off',
  stale: Number(state.set.stale ?? process.env.STALE_MIN ?? 5),   // ⚡ taps on alerts older than this many minutes show the card first
});
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
    await sleep(Date.now() - t0 < 120000 ? 1500 : 15000);
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
function addPool(l) {
  if (lc(l.topics[2]) !== '0x' + word(ZERO)) return 0; // buys go in as native HYPE; WHYPE pairs go through KyberSwap
  const t = lc('0x' + l.topics[3].slice(26)), d = strip(l.data), pm = lc(l.address);
  const list = (state.pools[t] ||= []);
  if (list.some((p) => p.id === lc(l.topics[1]))) return 0;
  list.push({ pm, fee: Number(BigInt('0x' + d.slice(0, 64))), ts: Number(BigInt.asIntN(24, BigInt('0x' + d.slice(64, 128)))), hook: '0x' + d.slice(152, 192), b: parseInt(l.blockNumber, 16), id: lc(l.topics[1]) });
  delete state.routes[t]; // a new pool for a coin: pick the best one again next time
  return 1;
}
let indexing = null;
function indexPools() {
  indexing ||= (async () => {
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const wins = [];
    for (let a = (state.poolsBlock || 0) + 1; a <= head; a += 2000) wins.push([a, Math.min(head, a + 1999)]);
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
    if (added || wins.length) save();
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
  ];
};

// ── card ───────────────────────────────────────────────────────────────────────────────────────────
async function cardText(t) {
  const [m, r, px] = await Promise.all([tokenMeta(t), findRoute(t), hypeUsd()]);
  if (!r) return { text: `No route for <code>${t}</code>.\nNo native-HYPE v4 pool for it among the ${poolCount()} the bot has indexed, and KyberSwap does not know it.` };
  const probe = 10n ** 16n;
  const [p, one, bal, sc] = await Promise.all([quoteBuy(r, t, probe), quoteBuy(r, t, 10n ** 18n).catch(() => null), balOf(t), sellCheck(r, t, 10n ** 17n)]);
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
    `<code>${t}</code>`;
  return { text, rows: cardButtons(t) };
}
async function showCard(t, m) {
  const c = await cardText(t);
  return m ? edit(m, c.text, c.rows) : say(c.text, c.rows);
}

// ── trades ─────────────────────────────────────────────────────────────────────────────────────────
const P = (t, sym) => (state.pos[t] ||= { sym, hypeIn: 0, hypeOut: 0, tokIn: 0, tokOut: 0, t: Date.now() });

async function buy(t, hypeAmt, replyTo, force = false) {
  const { slip, max } = cfg();
  if (!(hypeAmt > 0)) throw new Error('amount must be above 0');
  if (hypeAmt > max) throw new Error(`max per buy is ${max} HYPE (change with /set max)`);
  const wei = toWei(String(hypeAmt));
  let [m, r, bal] = await Promise.all([tokenMeta(t), findRoute(t), hypeBal()]);
  if (!r) throw new Error('no route for this token');
  if (bal < wei + 2n * 10n ** 15n) throw new Error(`not enough HYPE: wallet has ${fmtH(num(bal))}`);
  // sell check first: refuse coins that cannot be sold back or lose too much on a round trip
  let sc = { note: '' };
  if (cfg().check && !force) {
    sc = await sellCheck(r, t, wei);
    if (sc.ok === false) {
      const why = sc.blocked ? `🚫 <b>${esc(m.sym)}</b> cannot be sold back in a simulation (honeypot or sells blocked).` : `⚠️ Buying <b>${esc(m.sym)}</b> and selling straight back loses <b>${(sc.loss * 100).toFixed(0)}%</b> (limit ${cfg().tax}%, change with /set tax).`;
      return say(`${why}\nNot buying.`, [[{ text: `Buy ${hypeAmt} anyway`, callback_data: `f:${t.slice(2)}:${Math.round(hypeAmt * 10)}` }, { text: '🔎', callback_data: `c:${t.slice(2)}` }]], replyTo);
    }
  }
  const msg = await say(`⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>…${sc.note ? ` (${sc.note})` : ''}`, null, replyTo);
  let tx, expect;
  if (r.kind === 'v4') expect = await v4QuoteBuy(r, t, wei).catch(() => null);
  if (r.kind === 'v4' && expect == null) { r = await findRoute(t, true); if (!r) throw new Error('no route for this token any more'); } // pool changed: pick again
  if (r.kind === 'v4') {
    expect ??= await v4QuoteBuy(r, t, wei);
    tx = { to: ROUTER, value: wei, data: v4Buy(r, t, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: 600000 };
  } else {
    const k = await kyRoute(NATIVE, t, wei);
    const b = await kyBuild(k.routeSummary, slip);
    expect = BigInt(b.amountOut);
    tx = { to: lc(b.routerAddress), value: BigInt(b.transactionValue), data: b.data, gas: Math.max(Math.ceil(Number(b.gas) * 1.6), 600000) };
  }
  const before = await balOf(t);
  const hash = await serial(() => sendRaw(tx));
  await edit(msg, `⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>, expecting ~${fmt(num(expect, m.d))} · ${txLink(hash)}`);
  track(hash, async (rc) => {
    if (rc.status !== '0x1') return edit(msg, `❌ Buy of <b>${esc(m.sym)}</b> reverted (price moved past your ${Number(slip) / 100}% slippage?) · ${txLink(hash)}`);
    const got = (await balOf(t).catch(() => before)) - before;
    const p = P(t, m.sym); p.hypeIn += hypeAmt; p.tokIn += num(got, m.d); save();
    const px = await hypeUsd();
    const mc = m.sup && got > 0n ? (hypeAmt / num(got, m.d)) * num(m.sup, m.d) : null;
    return edit(msg, `✅ Bought <b>${fmt(num(got, m.d))} ${esc(m.sym)}</b> for ${hypeAmt} HYPE${mc ? ` · entry MC ${fmtH(mc)}${usd(mc, px)}` : ''} · ${txLink(hash)}`, cardButtons(t));
  }, () => edit(msg, `⌛ Buy of <b>${esc(m.sym)}</b> not confirmed after 2 h. Elysium may be holding its batch; check ${txLink(hash)} and /nonce if it never lands.`));
}

async function sell(t, pct, replyTo) {
  const { slip } = cfg();
  pct = Math.min(100, Math.max(1, Math.round(pct)));
  const [m, r, bal] = await Promise.all([tokenMeta(t), findRoute(t), balOf(t)]);
  if (!r) throw new Error('no route for this token');
  const amt = (bal * BigInt(pct)) / 100n;
  if (amt === 0n) throw new Error(`you hold no ${m.sym}`);
  const msg = await say(`⏳ Selling ${pct}% of <b>${esc(m.sym)}</b> (${fmt(num(amt, m.d))})…`, null, replyTo);
  let spender, swapTx, expect;
  if (r.kind === 'v4') {
    spender = ROUTER;
    const allowed = u256(await ethCall(t, enc('dd62ed3e', me, spender)));
    const slot = allowed >= amt ? null : await allowanceSlot(t, spender);
    if (allowed < amt && !slot) {
      // unusual token storage: approve first, then quote for real
      const ah = await serial(() => sendRaw({ to: t, data: enc('095ea7b3', spender, amt), gas: 120000 }));
      await edit(msg, `⏳ Approving ${esc(m.sym)} before selling · ${txLink(ah)}`);
      const arc = await receipt(ah);
      if (!arc || arc.status !== '0x1') throw new Error('approval failed or never confirmed');
      expect = await v4QuoteSell(r, t, amt, null);
      swapTx = { to: ROUTER, data: v4Sell(r, t, amt, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: 600000 };
      return finishSell(t, m, pct, msg, [swapTx], expect);
    }
    expect = await v4QuoteSell(r, t, amt, allowed >= amt ? null : slot);
    swapTx = { to: ROUTER, data: v4Sell(r, t, amt, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: 600000 };
    return finishSell(t, m, pct, msg, allowed >= amt ? [swapTx] : [{ to: t, data: enc('095ea7b3', spender, amt), gas: 120000 }, swapTx], expect);
  }
  const k = await kyRoute(t, NATIVE, amt);
  const b = await kyBuild(k.routeSummary, slip);
  spender = lc(b.routerAddress);
  expect = BigInt(b.amountOut);
  swapTx = { to: spender, value: BigInt(b.transactionValue || 0), data: b.data, gas: Math.max(Math.ceil(Number(b.gas) * 1.6), 600000) };
  const allowed = u256(await ethCall(t, enc('dd62ed3e', me, spender)));
  return finishSell(t, m, pct, msg, allowed >= amt ? [swapTx] : [{ to: t, data: enc('095ea7b3', spender, amt), gas: 120000 }, swapTx], expect);
}
// approve (exact amount, if needed) and the sell go out back to back with consecutive nonces
async function finishSell(t, m, pct, msg, txs, expect) {
  const before = await hypeBal();
  const tokBefore = await balOf(t);
  const hashes = await serial(async () => { const out = []; for (const x of txs) out.push(await sendRaw(x)); return out; });
  const hash = hashes[hashes.length - 1];
  await edit(msg, `⏳ Selling ${pct}% of <b>${esc(m.sym)}</b> for ~${fmtH(num(expect))}${hashes.length > 1 ? ' (approve + sell)' : ''} · ${txLink(hash)}`);
  track(hash, async (rc) => {
    if (rc.status !== '0x1') return edit(msg, `❌ Sell of <b>${esc(m.sym)}</b> reverted · ${txLink(hash)}`);
    const got = num((await hypeBal().catch(() => before)) - before);
    const sold = num(tokBefore - (await balOf(t).catch(() => tokBefore)), m.d);
    const p = P(t, m.sym); p.hypeOut += Math.max(got, 0); p.tokOut += sold; save();
    const px = await hypeUsd();
    return edit(msg, `✅ Sold ${pct}% of <b>${esc(m.sym)}</b> for <b>${fmtH(got)}</b>${usd(got, px)} · ${txLink(hash)}`, cardButtons(t));
  }, () => edit(msg, `⌛ Sell of <b>${esc(m.sym)}</b> not confirmed after 2 h · ${txLink(hash)}`));
}
function track(hash, onDone, onTimeout) {
  receipt(hash).then((rc) => (rc ? onDone(rc) : onTimeout())).catch((e) => console.error('track', e.message));
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
  `Paste a token address (or a link with one) for a card with buy and sell buttons.\n` +
  `/buy &lt;token&gt; &lt;HYPE&gt; · /sell &lt;token&gt; &lt;percent&gt;\n` +
  `/bal · /pnl · /wallet\n` +
  `/set slip 15 · /set max 5 · /set sizes 0.5,1,2,5\n` +
  `/set tax 25 (sell check limit) · /set check off · /set stale 5\n` +
  `/withdraw &lt;address&gt; &lt;HYPE|all&gt;\n` +
  `/nonce if a transaction is stuck`;

// ── update handling ────────────────────────────────────────────────────────────────────────────────
const addrIn = (s) => (String(s).match(/0x[0-9a-fA-F]{40}/) || [])[0]?.toLowerCase();
const pending = {}; // withdraw confirmations: id → {to, amt}
const taps = {};    // recent ⚡ taps, to drop accidental double taps

async function onMessage(msg) {
  const text = (msg.text || '').trim();
  const [cmd0, ...args] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@\S+$/, '');
  if (cmd === '/start' || cmd === '/help') {
    const b = await hypeBal().catch(() => null);
    return say(HELP + `\n\nWallet <code>${account.address}</code>${b != null ? ` · ${fmtH(num(b))}` : ''}\nPools indexed: ${poolCount()} (up to block ${state.poolsBlock})`);
  }
  if (cmd === '/wallet') return say(`<code>${account.address}</code>\nFund it with HYPE on Elysium. The key only lives on your VPS.`);
  if (cmd === '/bal') return say(await balances());
  if (cmd === '/pnl') return say(await pnl());
  if (cmd === '/nonce') { const n = await resyncNonce(); return say(`Nonce resynced: next is ${n}.`); }
  if (cmd === '/set') {
    const [k, v] = args;
    if (k === 'slip' && Number(v) > 0 && Number(v) <= 50) state.set.slip = Math.round(Number(v) * 100);
    else if (k === 'max' && Number(v) > 0) state.set.max = Number(v);
    else if (k === 'sizes' && /^[\d.,]+$/.test(v || '')) state.set.sizes = v;
    else if (k === 'tax' && Number(v) > 0 && Number(v) <= 100) state.set.tax = Number(v);
    else if (k === 'check' && /^(on|off)$/.test(v || '')) state.set.check = v;
    else if (k === 'stale' && Number(v) >= 0) state.set.stale = Number(v);
    else return say('Usage: /set slip 15 · /set max 5 · /set sizes 0.5,1,2,5 · /set tax 25 · /set check on|off · /set stale 5 (minutes, 0 = off)');
    save();
    const c = cfg();
    return say(`Saved. Slippage ${Number(c.slip) / 100}% · max ${c.max} HYPE · sizes ${c.sizes.join(', ')} · sell check ${c.check ? `on (limit ${c.tax}%)` : 'OFF'} · stale taps ${c.stale ? `after ${c.stale} min` : 'off'}`);
  }
  if (cmd === '/buy') {
    const t = addrIn(args[0]); const a = Number(args[1]);
    if (!t || !(a > 0)) return say('Usage: /buy 0xTOKEN 1.5');
    return buy(t, a, msg.message_id);
  }
  if (cmd === '/sell') {
    const t = addrIn(args[0]); const p = Number(String(args[1] || '100').replace('%', ''));
    if (!t || !(p > 0)) return say('Usage: /sell 0xTOKEN 50');
    return sell(t, p, msg.message_id);
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
    return buy(t, h, reply, kind === 'f');
  }
  if (kind === 's' && t) { await ack(`Selling ${b}%…`); return sell(t, Number(b), reply); }
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
    { command: 'buy', description: '/buy <token> <HYPE>' }, { command: 'sell', description: '/sell <token> <percent>' },
    { command: 'set', description: 'slip / max / sizes' }, { command: 'withdraw', description: '/withdraw <address> <HYPE|all>' },
    { command: 'wallet', description: 'Bot wallet address' }, { command: 'nonce', description: 'Resync after a stuck tx' },
  ] });
  // taps and messages sent while the bot was down are dropped, so an old ⚡ tap never buys hours later
  const backlog = await tg('getUpdates', { offset: -1, timeout: 0 });
  if (backlog?.length) state.offset = backlog[backlog.length - 1].update_id + 1;
  const b = await hypeBal().catch(() => null);
  // pool index: first run reads the whole chain (a minute or two), then every few seconds keeps it live
  const first = !state.poolsBlock;
  if (first) console.log('indexing every v4 pool on Elysium…');
  await indexPools().catch((e) => console.error('index', e.message));
  (async () => { for (;;) { await sleep(4000); await indexPools().catch(() => {}); } })();
  await say(`🟢 ely-router online · <code>${account.address}</code>${b != null ? ` · ${fmtH(num(b))}` : ''}\nPools indexed: ${poolCount()} across ${new Set(Object.values(state.pools).flat().map((p) => p.pm)).size} pool managers, kept live.${backlog?.length ? '\nTaps sent while it was offline were skipped.' : ''}`);
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
