// elysium-watch: launch and volume radar for Elysium mainnet (chain 99901, HYPE gas).
//
// Every scan reads every block since the last one, straight from the chain:
//   1. Pool Initialize events on the launchpads' Uniswap v4 PoolManagers (BOXA, elyspump, Kleos):
//      every new coin, which launchpad, who launched it.
//   2. v4 and v3 Swap events, valued in HYPE, rolled up per coin: volume, buy share, unique buyers.
//   3. Tracked wallets (wallets.json): swaps, token transfers, HYPE moves, contract deploys, launches.
// Alerts go to Telegram: launches that get real traction, volume runs, tracked-wallet moves,
// a brand-new launchpad appearing, the official mainnet RPC opening, and a digest every few hours.

import fs from 'node:fs';
import zlib from 'node:zlib';

// ── config ───────────────────────────────────────────────────────────────────
const RPCS = (process.env.ELY_RPCS || 'https://rpc-live.elyspump.com,https://boxa.pro/api/rpc')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OFFICIAL_RPC = 'https://rpc-elysium-mainnet.t.conduit.xyz';
const CHAIN_ID = 99901;
const BOXA = 'https://boxa.pro';      // BOXA's API (token index)
const BOXA_SITE = 'https://boxa.club'; // links in alerts

const LOG_RANGE = 2000;          // the node allows 10,000 blocks per eth_getLogs; stay well under
const FIRST_LOOKBACK = 900;      // first run: about the last hour (14 blocks a minute)
const MAX_BLOCKS = 6000;         // catch up at most ~7 hours in one scan
const WARMUP_RUNS = 3;           // scans that only learn baselines
const COOLDOWN_H = 2;            // hours before the same coin can ping again
const DIGEST_EVERY_H = 4;
const LAUNCH_WINDOW_H = 6;       // a coin counts as "new" for this long

// thresholds
const LAUNCH_MIN_BUYERS = 15;    // unique buyers since launch
const LAUNCH_MIN_USD = 2000;     // HYPE volume since launch
const LAUNCH_MIN_BUY_SHARE = 0.55;
const RUN_MIN_USD_H = 3000;      // volume pace an hour
const RUN_MIN_SWAPS = 15;
const RUN_MIN_BUYERS = 8;
const RUN_MULT = 3;              // times its own baseline pace
const RUN_MIN_BUY_SHARE = 0.55;
const WALLET_MIN_HYPE = 0.5;     // ignore dust HYPE moves for tracked wallets
// group buys: several wallets of one group (wallets.json "group") buying the same coin close together
const GROUP_WINDOW_MIN = 30;
const GROUP_MIN_WALLETS = 2;     // inside a named group (hewd, marv, signal...)
const ANY_MIN_WALLETS = 3;       // across all tracked wallets, any group
// auto-tracking: a tracked wallet funding a fresh wallet
const FUND_MIN_HYPE = 0.2;
const FRESH_MAX_NONCE = 5;       // recipient has sent at most this many txs = fresh wallet
const AUTO_MAX = 300;

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
// v4 PoolManagers by launchpad (each launchpad runs its own; all pools are native HYPE / coin)
const LAUNCHPADS = {
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4': { name: 'BOXA', hook: '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc' },
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600': { name: 'elyspump', hook: '0xe11cafa5901b0aab51eb78251488400f9e4320cc' },
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490': { name: 'Kleos', hook: '0x0c835e6a51717a514144d95c7f0a1c640179e0cc' },
};
const WHYPE = new Set(['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81']);
const INFRA = new Set([ZERO, DEAD, ...WHYPE, ...Object.keys(LAUNCHPADS), '0x000000000022d473030f116ddee9f6b43ac78ba3']);

const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_INIT_V4 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

const STATE = new URL('./state.json', import.meta.url);
const WALLETS = new URL('./wallets.json', import.meta.url);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const lc = (a) => String(a || '').toLowerCase();
const topicAddr = (t) => '0x' + t.slice(26);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const usd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const hype = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n >= 10 ? n.toFixed(0) : n.toFixed(2)) + ' HYPE';
const ago = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 86400)} days`);
const words = (data) => (data.slice(2).match(/.{64}/g) || []);
function int256(hex) {
  const x = BigInt('0x' + hex);
  return x >= 1n << 255n ? x - (1n << 256n) : x;
}
const assetLink = (t, label = 'BOXA') => `<a href="${BOXA_SITE}/asset?address=${t}">${label}</a>`;
// wallets open on BOXA's portfolio page; tx links go to Kinetiq's explorer (partner-only until public launch)
const EXPLORER = 'https://elysium.kinetiq.xyz/explorer';
const walletLink = (a, label) => `<a href="${BOXA_SITE}/portfolio?address=${a}">${label || short(a)}</a>`;
const txLink = (h) => (h ? ` · <a href="${EXPLORER}/transaction/${h}">tx</a>` : '');

let rpcIdx = 0;
async function rpc(method, params, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      rpcIdx = (rpcIdx + i) % RPCS.length;
      return j.result;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw new Error(`${method} failed on every RPC: ${lastErr?.message}`);
}

// keep only RPCs that answer with Elysium mainnet's chain id
async function pickRpcs() {
  const ok = [];
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (parseInt(j.result, 16) === CHAIN_ID) ok.push(url);
      else console.log('skipping RPC (wrong chain)', url, j.result);
    } catch (e) { console.log('skipping RPC (down)', url, e.message); }
  }
  if (!ok.length) throw new Error('no Elysium mainnet RPC reachable');
  RPCS.splice(0, RPCS.length, ...ok);
}

async function getLogs(filter, from, to) {
  const out = [];
  for (let s = from; s <= to; s += LOG_RANGE) {
    const e = Math.min(to, s + LOG_RANGE - 1);
    out.push(...await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16) }]));
  }
  return out;
}

async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 elysium-watch' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

// buy buttons on an alert; the router on your VPS answers them (b:<h|e>:<address>:<HYPE>)
const BUY_SIZES = (process.env.BUY_SIZES || '1,3,5').split(',').map((s) => s.trim()).filter(Boolean);
const buyButtons = (chain, addr) => BUY_SIZES.map((h) => ({ text: `Buy ${h} HYPE`, callback_data: `b:${chain}:${addr.slice(2)}:${h}` }));

async function tg(msg) {
  const text = typeof msg === 'string' ? msg : msg.text;
  const buttons = typeof msg === 'string' ? null : msg.buttons;
  if (!TG_TOKEN || !TG_CHAT) { console.log('[telegram]\n' + text + (buttons ? '\n[' + buttons.map((b) => b.text).join('] [') + ']' : '') + '\n'); return; }
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}) }),
    });
    if (r.ok) return;
    if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
    console.error('telegram', r.status, await r.text());
    return;
  }
}

function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  const w = words(hex);
  try {
    if (w.length >= 2 && BigInt('0x' + w[0]) === 32n) {
      const len = Number(BigInt('0x' + w[1]));
      return Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
    }
    return Buffer.from(hex.slice(2, 66), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}

async function tokenMeta(state, t) {
  if (state.meta[t]?.v === 2) return state.meta[t];
  const call = (data) => rpc('eth_call', [{ to: t, data }, 'latest']).catch(() => '0x');
  const [n, s, d, ts] = await Promise.all([call('0x06fdde03'), call('0x95d89b41'), call('0x313ce567'), call('0x18160ddd')]);
  const dec = d && d !== '0x' ? Number(BigInt(d)) : 18;
  const m = {
    v: 2,
    n: decodeString(n).slice(0, 40) || 'unknown',
    s: decodeString(s).slice(0, 16) || '???',
    d: dec,
    supply: ts && ts !== '0x' ? Number(BigInt(ts)) / 10 ** dec : 0,
  };
  // tokens bridged from HyperEVM (gateway tokens) only carry part of their supply here: use the HyperEVM total for market cap
  const l1 = await call('0xc2eeeebd');
  if (l1 && l1.length >= 66 && !/^0x0*$/.test(l1)) {
    const l1a = '0x' + l1.slice(26);
    const s1 = await hrpc('eth_call', [{ to: l1a, data: '0x18160ddd' }, 'latest']).catch(() => null);
    if (s1 && s1 !== '0x') { m.l1 = l1a; m.supply = Number(BigInt(s1)) / 10 ** dec; }
  }
  state.meta[t] = m;
  return m;
}

// HyperEVM (Stockium curves live there); public RPCs allow 1,000 blocks per log query and rate-limit, so rotate
const HYPER_RPCS = (process.env.HYPER_RPCS || 'https://rpc.hyperliquid.xyz/evm,https://rpc.hypurrscan.io,https://hyperliquid-json-rpc.stakely.io')
  .split(',').map((s) => s.trim()).filter(Boolean);
let hIdx = 0;
async function hrpc(method, params) {
  let last;
  for (let i = 0; i < HYPER_RPCS.length * 2; i++) {
    const url = HYPER_RPCS[(hIdx + i) % HYPER_RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      hIdx = (hIdx + i) % HYPER_RPCS.length;
      return j.result;
    } catch (e) { last = e; await sleep(300); }
  }
  throw new Error(`hyperevm ${method}: ${last?.message}`);
}

// socials from BOXA's indexer (description + metadata JSON); best effort, never blocks an alert
async function socials(t) {
  const j = await getJSON(`${BOXA}/api/index/tokens/${t}`);
  const tok = j?.token;
  const found = { x: null, tg: null, web: null };
  const take = (u) => {
    if (!u || typeof u !== 'string') return;
    const s = u.trim();
    if (/x\.com\/|twitter\.com\//i.test(s)) found.x ||= s;
    else if (/t\.me\//i.test(s)) found.tg ||= s;
    else if (/^https?:\/\//i.test(s) && !/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(s) && !/b-cdn|ipfs|boxa\.pro/i.test(s)) found.web ||= s;
  };
  if (tok) {
    for (const u of String(tok.description || '').match(/https?:\/\/\S+|(?:x|twitter)\.com\/\S+|t\.me\/\S+/gi) || []) take(u.startsWith('http') ? u : 'https://' + u);
    for (const k of ['twitter', 'x', 'telegram', 'website', 'site']) take(tok[k]);
    if (tok.metadataUri) {
      const m = await getJSON(tok.metadataUri.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/'));
      if (m) { take(m.twitter || m.x); take(m.telegram); take(m.website || m.external_url); }
    }
  }
  const parts = [];
  if (found.x) parts.push(`<a href="${esc(found.x)}">X @${esc(found.x.split('/').filter(Boolean).pop())}</a>`);
  if (found.tg) parts.push(`<a href="${esc(found.tg)}">Telegram</a>`);
  if (found.web) parts.push(`<a href="${esc(found.web)}">${esc(found.web.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`);
  return {
    line: parts.length ? `Socials: ${parts.join(' · ')}` : 'Socials: none found',
    holders: tok?.holders ?? null,
    top10: tok?.top10Pct ?? null,
    creatorPct: tok?.creatorPct ?? null,
  };
}

async function hypeUsd(state) {
  if (state.px && now() - state.px.t < 900) return state.px.v;
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd');
  const v = Number(j?.hyperliquid?.usd);
  if (v > 0) state.px = { v, t: now() };
  return state.px?.v || null;
}

const ema = (prev, x, a = 0.25) => (prev == null ? x : prev + a * (x - prev));
function due(state, key, h = COOLDOWN_H) {
  const a = state.alerted[key];
  return !a || now() - a.t > h * 3600;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  await pickRpcs();
  let state = null;
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const firstRun = !state;
  state ||= { v: 1, block: 0, runs: 0, started: now(), pools: {}, v3: {}, tok: {}, meta: {}, alerted: {}, unknownPm: {}, digestAt: now(), official: false, px: null };
  let wallets = [];
  try { wallets = JSON.parse(fs.readFileSync(WALLETS, 'utf8')); } catch {}
  const okW = wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address));
  const W = new Map(okW.map((w) => [lc(w.address), w.label || short(w.address)]));
  const G = new Map(okW.filter((w) => w.group).map((w) => [lc(w.address), String(w.group)]));
  // wallets the watcher found on its own (fresh wallets funded by tracked ones) live in state
  state.auto ||= {};
  state.gbuys ||= {};
  for (const [a, x] of Object.entries(state.auto)) {
    if (!W.has(a)) W.set(a, x.label);
    if (x.group && !G.has(a)) G.set(a, x.group);
  }

  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  // pool id → coin map: on first run read every pool ever created on the known launchpads
  if (!Object.keys(state.pools).length) {
    for (const pm of Object.keys(LAUNCHPADS)) {
      const logs = await getLogs({ address: pm, topics: [T_INIT_V4] }, 0, head);
      for (const l of logs) {
        const c0 = lc(topicAddr(l.topics[2]));
        const c1 = lc(topicAddr(l.topics[3]));
        state.pools[lc(l.topics[1])] = { t: c0 === ZERO ? c1 : c0, lp: pm, b: parseInt(l.blockNumber, 16) };
      }
    }
    console.log('pools indexed', Object.keys(state.pools).length);
  }

  const from = firstRun ? Math.max(1, head - FIRST_LOOKBACK) : Math.max(state.block + 1, head - MAX_BLOCKS);
  if (from > head) { console.log('no new blocks'); return; }
  const [bFrom, bTo] = await Promise.all([
    rpc('eth_getBlockByNumber', ['0x' + from.toString(16), false]),
    rpc('eth_getBlockByNumber', ['0x' + head.toString(16), false]),
  ]);
  const tFrom = parseInt(bFrom.timestamp, 16);
  const tTo = parseInt(bTo.timestamp, 16);
  const hours = Math.max((tTo - tFrom) / 3600, 1 / 60);
  console.log(`blocks ${from}..${head} (${head - from + 1}), ${(hours * 60).toFixed(1)} min, rpc ${RPCS[0]}`);

  const logs = await getLogs({}, from, head);
  const px = await hypeUsd(state);
  const toUsd = (h) => (px ? h * px : null);
  const msgs = [];

  // 1. new pools: launches on known launchpads, and unknown PoolManagers
  const launchTxs = [];
  for (const l of logs) {
    if (l.topics[0] !== T_INIT_V4) continue;
    const pm = lc(l.address);
    const c0 = lc(topicAddr(l.topics[2]));
    const c1 = lc(topicAddr(l.topics[3]));
    const coin = c0 === ZERO || WHYPE.has(c0) ? c1 : c0;
    if (!LAUNCHPADS[pm]) {
      const u = (state.unknownPm[pm] ||= { n: 0, first: now(), alerted: 0 });
      u.n++;
      state.pools[lc(l.topics[1])] = { t: coin, lp: pm, b: parseInt(l.blockNumber, 16) };
      continue;
    }
    state.pools[lc(l.topics[1])] = { t: coin, lp: pm, b: parseInt(l.blockNumber, 16) };
    if (!state.tok[coin]) {
      const b = parseInt(l.blockNumber, 16);
      const born = Math.round(tFrom + ((b - from) / Math.max(head - from, 1)) * (tTo - tFrom));
      state.tok[coin] = { lp: pm, born, vol: 0, buyVol: 0, swaps: 0, buyers: [], creator: null };
      launchTxs.push({ coin, tx: l.transactionHash });
    }
  }
  // who launched each new coin (one tx lookup per launch; ~10 an hour across the chain)
  for (const { coin, tx } of launchTxs.slice(0, 40)) {
    try { state.tok[coin].creator = lc((await rpc('eth_getTransactionByHash', [tx]))?.from); } catch {}
  }
  for (const [pm, u] of Object.entries(state.unknownPm)) {
    if (!u.alerted && u.n >= 3 && !firstRun) {
      u.alerted = now();
      msgs.push(
        `🆕 <b>New launchpad pool contract on Elysium</b>\n` +
        `${u.n} new pools from a Uniswap v4 PoolManager that is not BOXA, elyspump or Kleos.\n` +
        `<code>${pm}</code>`
      );
    }
  }

  // 2. swaps, rolled up per coin
  const roll = {};
  const R = (t) => (roll[t] ||= { vol: 0, buyVol: 0, swaps: 0, buys: 0, buyers: new Set(), sellers: new Set(), price: null, lp: null });
  const poolOut = new Set([...Object.keys(LAUNCHPADS)]); // token leaves a PoolManager/pool → a buyer receives it
  const v3Pools = {};
  const txBuy = {}; // tx hash → HYPE paid into pools in that tx (buys routed through routers/multicall too)
  for (const l of logs) {
    if (l.topics[0] === T_SWAP_V4) {
      const p = state.pools[lc(l.topics[1])];
      if (!p) continue;
      const w = words(l.data);
      const a0 = Number(int256(w[0])) / 1e18; // HYPE delta for the swapper: negative = paid HYPE = buy
      const sqrt = BigInt('0x' + w[2]);
      const r = R(p.t);
      r.lp = p.lp;
      const h = Math.abs(a0);
      r.vol += h; r.swaps++;
      if (a0 < 0) { r.buyVol += h; r.buys++; txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + h; }
      if (sqrt > 0n) {
        const ratio = Number((sqrt * sqrt * 10n ** 18n) >> 192n) / 1e18; // coin per HYPE
        if (ratio > 0) r.price = 1 / ratio;                                // HYPE per coin
      }
    } else if (l.topics[0] === T_SWAP_V3) {
      const pool = lc(l.address);
      if (!(pool in state.v3)) {
        try {
          const [t0, t1] = await Promise.all([
            rpc('eth_call', [{ to: pool, data: '0x0dfe1681' }, 'latest']),
            rpc('eth_call', [{ to: pool, data: '0xd21220a7' }, 'latest']),
          ]);
          state.v3[pool] = { t0: lc(topicAddr(t0)), t1: lc(topicAddr(t1)) };
        } catch { state.v3[pool] = null; }
      }
      const pi = state.v3[pool];
      if (!pi || (!WHYPE.has(pi.t0) && !WHYPE.has(pi.t1))) continue;
      v3Pools[pool] = 1;
      const w = words(l.data);
      const a0 = Number(int256(w[0])) / 1e18;
      const a1 = Number(int256(w[1])) / 1e18;
      const hypeIsT0 = WHYPE.has(pi.t0);
      const coin = hypeIsT0 ? pi.t1 : pi.t0;
      const h = hypeIsT0 ? a0 : a1; // pool delta: positive = pool received HYPE = buy
      const r = R(coin);
      r.lp ||= 'uniswap';
      r.vol += Math.abs(h); r.swaps++;
      if (h > 0) { r.buyVol += h; r.buys++; txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + h; }
      const sqrt = BigInt('0x' + w[2]);
      if (sqrt > 0n) {
        const p01 = Number((sqrt * sqrt * 10n ** 18n) >> 192n) / 1e18; // token1 per token0
        if (p01 > 0) r.price = hypeIsT0 ? 1 / p01 : p01;
      }
    }
  }
  for (const p of Object.keys(v3Pools)) poolOut.add(p);

  // buyers/sellers from token transfers out of / into pools
  for (const l of logs) {
    if (l.topics[0] !== T_TRANSFER || l.topics.length !== 3) continue;
    const t = lc(l.address);
    if (!roll[t]) continue;
    const f = lc(topicAddr(l.topics[1]));
    const to = lc(topicAddr(l.topics[2]));
    if (poolOut.has(f) && !INFRA.has(to)) roll[t].buyers.add(to);
    if (poolOut.has(to) && !INFRA.has(f)) roll[t].sellers.add(f);
  }

  // 3. per-coin alerts
  for (const [t, r] of Object.entries(roll)) {
    if (WHYPE.has(t)) continue;
    const rec = state.tok[t] || (state.tok[t] = { lp: r.lp, born: null, vol: 0, buyVol: 0, swaps: 0, buyers: [], creator: null });
    rec.vol += r.vol; rec.buyVol += r.buyVol; rec.swaps += r.swaps;
    if (r.price) rec.price = r.price;
    const age = rec.born ? now() - rec.born : null;
    if (age != null && age < LAUNCH_WINDOW_H * 3600) {
      const set = new Set(rec.buyers);
      for (const b of r.buyers) set.add(b);
      rec.buyers = [...set].slice(0, 400);
    }
    const prev = rec.e; // baseline pace, HYPE an hour
    const pace = r.vol / hours;
    rec.e = ema(prev, pace);

    const meta = await tokenMeta(state, t);
    const mcH = rec.price && meta.supply ? rec.price * meta.supply : null;
    const mcLine = mcH ? `MC ${px ? usd(mcH * px) : hype(mcH)}` : 'MC n/a';
    const lpName = LAUNCHPADS[rec.lp]?.name || (rec.lp === 'uniswap' ? 'Uniswap' : 'unknown launchpad');

    // launch with traction: first hours only, once per coin
    if (age != null && age < LAUNCH_WINDOW_H * 3600 && !rec.launchAlert && !firstRun) {
      const volUsd = toUsd(rec.vol) ?? 0;
      const share = rec.vol ? rec.buyVol / rec.vol : 0;
      if (rec.buyers.length >= LAUNCH_MIN_BUYERS && volUsd >= LAUNCH_MIN_USD && share >= LAUNCH_MIN_BUY_SHARE) {
        rec.launchAlert = now();
        state.alerted['c:' + t] = { t: now() };
        const so = await socials(t);
        const creator = rec.creator ? `\nLaunched by ${walletLink(rec.creator)}${W.has(rec.creator) ? ` (👛 ${esc(W.get(rec.creator))})` : ''}` : '';
        msgs.push(
          `🚀 <b>${esc(meta.s)}</b> (${esc(meta.n)}) is taking off on ${lpName}\n` +
          `${ago(age)} old · ${rec.buyers.length} buyers · ${usd(volUsd)} volume · ${Math.round(share * 100)}% buys\n` +
          `${mcLine}${so.holders != null ? ` · ${so.holders} holders` : ''}${so.top10 != null ? ` · top 10 hold ${so.top10.toFixed(0)}%` : ''}\n` +
          `${so.line}${creator}\n` +
          `<code>${t}</code>\n${assetLink(t, 'open on BOXA')}`
        );
        msgs[msgs.length - 1] = { text: msgs[msgs.length - 1], buttons: buyButtons('e', t) };
        continue;
      }
    }

    // volume run against the coin's own baseline
    if (state.runs < WARMUP_RUNS || firstRun) continue;
    const paceUsd = toUsd(pace);
    if (paceUsd == null || paceUsd < RUN_MIN_USD_H || r.swaps < RUN_MIN_SWAPS || r.buyers.size < RUN_MIN_BUYERS) continue;
    const share = r.vol ? r.buyVol / r.vol : 0;
    if (share < RUN_MIN_BUY_SHARE) continue;
    if (prev != null && pace < RUN_MULT * Math.max(prev, 1)) continue;
    if (!due(state, 'c:' + t)) continue;
    state.alerted['c:' + t] = { t: now() };
    const so = await socials(t);
    msgs.push(
      `🔥 <b>${esc(meta.s)}</b> (${esc(meta.n)}) volume run on ${lpName}\n` +
      `${usd(paceUsd)}/h pace · ${r.swaps} swaps · ${r.buyers.size} buyers · ${Math.round(share * 100)}% buys (last ${Math.round(hours * 60)} min)\n` +
      `${prev == null ? 'No baseline yet.' : `${(pace / Math.max(prev, 1e-9)).toFixed(1)}× its usual pace.`}\n` +
      `${mcLine}${so.holders != null ? ` · ${so.holders} holders` : ''}${age != null ? ` · ${ago(age)} old` : ''}\n` +
      `${so.line}\n<code>${t}</code>\n${assetLink(t, 'open on BOXA')}`
    );
    msgs[msgs.length - 1] = { text: msgs[msgs.length - 1], buttons: buyButtons('e', t) };
  }

  // 3b. every new block with its transactions, read once (tracked-wallet moves and Cielo arrivals both use them)
  const blocks = [];
  for (let b = Math.max(from, head - 900); b <= head; b++) {
    try { const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]); if (blk) blocks.push(blk); } catch {}
  }

  // 3c. wallets from the Cielo list showing up on Elysium for the first time: one ping, then full tracking
  const S = loadCielo();
  state.arrived ||= {};
  if (S.size) {
    const seen = new Map();
    const note = (a, txt) => { if (a && S.has(a) && !W.has(a) && !state.arrived[a] && !seen.has(a)) seen.set(a, txt); };
    for (const blk of blocks) {
      for (const tx of blk.transactions || []) {
        const f = lc(tx.from), to = lc(tx.to);
        const val = Number(BigInt(tx.value || '0x0')) / 1e18;
        const bridged = ['0x64', '0x65', '0x68', '0x69'].includes(String(tx.type).toLowerCase());
        if (bridged) note(to, `🌉 bridged in ${hype(val)}${px ? ` (${usd(val * px)})` : ''} from HyperEVM${txLink(tx.hash)}`);
        else if (val > 0) note(to, `received ${hype(val)}${px ? ` (${usd(val * px)})` : ''} from ${walletLink(f)}${txLink(tx.hash)}`);
        note(f, `made its first move here${txLink(tx.hash)}`);
      }
    }
    for (const l of logs) {
      if (l.topics[0] !== T_TRANSFER || l.topics.length !== 3) continue;
      note(lc(topicAddr(l.topics[2])), `received a token${txLink(l.transactionHash)}`);
      note(lc(topicAddr(l.topics[1])), `moved a token${txLink(l.transactionHash)}`);
    }
    for (const [a, txt] of seen) {
      const label = `${S.get(a)} (cielo)`;
      state.arrived[a] = now();
      state.auto[a] = { label, group: 'cielo', from: 'cielo', t: now() };
      W.set(a, label);
      G.set(a, 'cielo');
      msgs.push(`🛬 <b>${esc(S.get(a))}</b> from your Cielo list is on Elysium\n${walletLink(a)} ${txt}\nNow tracking it.`);
    }
  }

  // 4. tracked wallets
  if (W.size) {
    const moves = {};
    const M = (w) => (moves[w] ||= []);
    // token transfers in/out (swaps show up here as tokens arriving from / leaving a pool)
    for (const l of logs) {
      if (l.topics[0] !== T_TRANSFER || l.topics.length !== 3) continue;
      const f = lc(topicAddr(l.topics[1]));
      const to = lc(topicAddr(l.topics[2]));
      if (!W.has(f) && !W.has(to)) continue;
      const t = lc(l.address);
      if (WHYPE.has(t)) continue;
      const meta = await tokenMeta(state, t);
      const amt = Number(BigInt(l.data)) / 10 ** meta.d;
      const price = state.tok[t]?.price;
      const val = price ? amt * price : null;
      const valTxt = val != null ? ` (~${px ? usd(val * px) : hype(val)})` : '';
      if (W.has(to)) {
        const kind = poolOut.has(f) || txBuy[l.transactionHash] ? 'bought' : f === ZERO ? 'minted' : 'received';
        M(to).push(`${kind} ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${valTxt}${kind === 'received' ? ` from ${walletLink(f)}` : ''} · ${assetLink(t, 'chart')}${txLink(l.transactionHash)}`);
        if (kind === 'bought') {
          const paid = txBuy[l.transactionHash] || val || 0;
          for (const g of [G.get(to), '*'].filter(Boolean)) {
            const k = g + '|' + t;
            (state.gbuys[k] ||= []).push({ w: to, t: now(), h: paid });
          }
        }
      }
      if (W.has(f)) {
        const kind = poolOut.has(to) ? 'sold' : to === ZERO || to === DEAD ? 'burned' : 'sent';
        M(f).push(`${kind} ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${valTxt}${kind === 'sent' ? ` to ${walletLink(to)}` : ''} · ${assetLink(t, 'chart')}${txLink(l.transactionHash)}`);
      }
    }
    // native HYPE moves, deploys and launches: read every block with its transactions
    const funded = []; // tracked wallet → untracked recipient, checked for freshness below
    for (const blk of blocks) {
      for (const tx of blk.transactions || []) {
        const f = lc(tx.from);
        const to = lc(tx.to);
        const val = Number(BigInt(tx.value || '0x0')) / 1e18;
        if (W.has(f) && !tx.to) M(f).push(`deployed a contract${txLink(tx.hash)}`);
        if (W.has(f) && val >= WALLET_MIN_HYPE && to) M(f).push(`sent ${hype(val)}${px ? ` (${usd(val * px)})` : ''} to ${walletLink(to)}${W.has(to) ? ` (${esc(W.get(to))})` : ''}${txLink(tx.hash)}`);
        if (W.has(f) && to && !W.has(to) && !INFRA.has(to) && val >= FUND_MIN_HYPE && (tx.input || '0x') === '0x') funded.push({ f, to, val, hash: tx.hash });
        // Arbitrum-style deposit types (0x64 deposit, 0x65 unsigned, 0x68 retry, 0x69 retryable) = HYPE bridged in from HyperEVM
        const bridged = ['0x64', '0x65', '0x68', '0x69'].includes(String(tx.type).toLowerCase());
        if (W.has(to) && (val >= WALLET_MIN_HYPE || (bridged && val > 0))) M(to).push(bridged ? `🌉 <b>bridged in ${hype(val)}</b>${px ? ` (${usd(val * px)})` : ''} from HyperEVM${txLink(tx.hash)}` : `received ${hype(val)}${px ? ` (${usd(val * px)})` : ''} from ${walletLink(f)}${txLink(tx.hash)}`);
      }
    }
    // fresh wallets funded by tracked ones: start tracking them (same group as the funder)
    for (const x of funded.slice(0, 20)) {
      if (W.has(x.to) || Object.keys(state.auto).length >= AUTO_MAX) continue;
      try {
        const [code, nonce] = await Promise.all([rpc('eth_getCode', [x.to, 'latest']), rpc('eth_getTransactionCount', [x.to, 'latest'])]);
        if (code && code !== '0x') continue;
        const n = parseInt(nonce, 16);
        if (n > FRESH_MAX_NONCE) continue;
        const group = G.get(x.f) || null;
        const label = `${group || W.get(x.f).replace(/\s*\(.*\)$/, '')} child ${x.to.slice(2, 6)} (auto)`;
        state.auto[x.to] = { label, group, from: x.f, t: now(), hype: x.val };
        W.set(x.to, label);
        if (group) G.set(x.to, group);
        msgs.push(
          `🧬 <b>${esc(W.get(x.f))}</b> funded a fresh wallet\n` +
          `${walletLink(x.to)} got ${hype(x.val)}${px ? ` (${usd(x.val * px)})` : ''} · it has sent ${n} txs so far${txLink(x.hash)}\n` +
          `Now tracking it as <b>${esc(label)}</b>.`
        );
      } catch {}
    }
    for (const { coin, tx: lt } of launchTxs) {
      const c = state.tok[coin]?.creator;
      if (c && W.has(c)) {
        const meta = await tokenMeta(state, coin);
        M(c).push(`launched <b>${esc(meta.s)}</b> (${esc(meta.n)}) on ${LAUNCHPADS[state.tok[coin].lp]?.name || '?'} · <code>${coin}</code> · ${assetLink(coin, 'chart')}${txLink(lt)}`);
      }
    }
    for (const [w, list] of Object.entries(moves)) {
      if (!list.length) continue;
      msgs.push(`👛 <b>${esc(W.get(w))}</b> · ${walletLink(w)}\n` + list.slice(0, 12).map((x) => '• ' + x).join('\n') + (list.length > 12 ? `\n…and ${list.length - 12} more` : ''));
    }
  }

  // 4c. Stockium curves on HyperEVM: tracked wallets trading them, tracked devs launching, early traction
  try { await stockium(state, W, G, msgs, px); } catch (e) { console.log('stockium scan failed:', e.message); }

  // 4b. group buys: 2+ wallets of one group (or 3+ tracked wallets of any group) into the same coin within the window
  for (const [k, list] of Object.entries(state.gbuys)) {
    const recent = list.filter((x) => now() - x.t <= GROUP_WINDOW_MIN * 60);
    if (!recent.length) { delete state.gbuys[k]; continue; }
    state.gbuys[k] = recent.slice(-50);
    const [g, t] = k.split('|');
    const byW = {};
    for (const x of recent) byW[x.w] = (byW[x.w] || 0) + x.h;
    const n = Object.keys(byW).length;
    if (n < (g === '*' ? ANY_MIN_WALLETS : GROUP_MIN_WALLETS)) continue;
    const key = 'g:' + k;
    const prevN = state.alerted[key]?.n || 0;
    if (!due(state, key) && n <= prevN) continue; // re-ping inside the cooldown only when more wallets pile in
    if (g === '*' && Object.keys(byW).every((w) => G.get(w) && G.get(w) === G.get(Object.keys(byW)[0]))) continue; // same group already pinged
    state.alerted[key] = { t: now(), n };
    const tot = Object.values(byW).reduce((a, b) => a + b, 0);
    const span = Math.max(1, Math.round((Math.max(...recent.map((x) => x.t)) - Math.min(...recent.map((x) => x.t))) / 60));
    const onCurve = t.startsWith('h:');
    const cv = onCurve ? state.hyper?.curves?.[t.slice(2)] : null;
    const meta = onCurve ? { s: cv?.s || '???' } : await tokenMeta(state, t);
    const rec = onCurve ? null : state.tok[t];
    const mcH = onCurve ? cv?.mc : rec?.price && meta.supply ? rec.price * meta.supply : null;
    msgs.push(
      `🎯 <b>${g === '*' ? `${n} tracked wallets` : `${esc(g)} group, ${n} wallets`}</b> bought <b>${esc(meta.s)}</b>${onCurve ? ' on its Stockium curve (HyperEVM)' : ''} within ${span} min\n` +
      `${tot > 0 ? `${hype(tot)}${px ? ` (${usd(tot * px)})` : ''} in` : ''}${mcH ? ` · MC ${px ? usd(mcH * px) : hype(mcH)}` : ''}\n` +
      Object.entries(byW).map(([w, h]) => `• ${walletLink(w, esc(W.get(w) || short(w)))}${h > 0 ? ` ${hype(h)}` : ''}`).join('\n') +
      (onCurve ? `\n<code>${cv?.token || t.slice(2)}</code>\n<a href="https://stockium.fun/token/${t.slice(2)}">open on Stockium</a>` : `\n<code>${t}</code>\n${assetLink(t, 'open on BOXA')}`)
    );
    msgs[msgs.length - 1] = { text: msgs[msgs.length - 1], buttons: buyButtons(t.startsWith('h:') ? 'h' : 'e', t.replace(/^h:/, '')) };
  }

  // 5. the official mainnet RPC opening up (one ping, ever)
  if (!state.official && now() - (state.officialCheckedAt || 0) > 600) {
    state.officialCheckedAt = now();
    try {
      const r = await fetch(OFFICIAL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(10000) });
      const j = r.ok ? await r.json() : null;
      if (j && parseInt(j.result, 16) === CHAIN_ID) {
        state.official = now();
        msgs.push(`📡 <b>The official Elysium mainnet RPC is open</b>\n<code>${OFFICIAL_RPC}</code> now answers for chain ${CHAIN_ID}. Public launch is close.`);
      }
    } catch {}
  }

  // 6. digest
  if (!firstRun && now() - state.digestAt >= DIGEST_EVERY_H * 3600) {
    const since = state.digestAt;
    state.digestAt = now();
    const span = Math.max((now() - since) / 3600, 1);
    const rows = Object.entries(state.tok)
      .filter(([t, r]) => r.dvol > 0 && !WHYPE.has(t))
      .sort((a, b) => b[1].dvol - a[1].dvol)
      .slice(0, 10);
    const lines = [];
    for (const [t, r] of rows) {
      const m = await tokenMeta(state, t);
      const mc = r.price && m.supply ? r.price * m.supply : null;
      lines.push(`${lines.length + 1}. <a href="${BOXA_SITE}/asset?address=${t}">${esc(m.s)}</a> · MC ${mc ? (px ? usd(mc * px) : hype(mc)) : 'n/a'} · ${px ? usd(r.dvol * px) : hype(r.dvol)} vol · ${LAUNCHPADS[r.lp]?.name || 'Uniswap'}`);
    }
    const launches = {};
    for (const r of Object.values(state.tok)) if (r.born && r.born >= since) launches[LAUNCHPADS[r.lp]?.name || 'other'] = (launches[LAUNCHPADS[r.lp]?.name || 'other'] || 0) + 1;
    msgs.push(
      `📊 <b>Elysium, last ${Math.round(span)}h</b>${px ? ` · HYPE $${px.toFixed(2)}` : ''}\n` +
      `New coins: ${Object.entries(launches).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n` +
      (lines.length ? lines.join('\n') : 'No trading recorded.')
    );
    for (const r of Object.values(state.tok)) r.dvol = 0;
  }
  for (const [t, r] of Object.entries(roll)) { const x = state.tok[t]; if (x) x.dvol = (x.dvol || 0) + r.vol; }

  // first run: say it's armed
  if (firstRun) {
    const top = Object.entries(roll).filter(([t]) => !WHYPE.has(t)).sort((a, b) => b[1].vol - a[1].vol).slice(0, 5);
    const lines = [];
    for (const [t, r] of top) { const m = await tokenMeta(state, t); lines.push(`${esc(m.s)} · ${px ? usd(r.vol * px) : hype(r.vol)}`); }
    msgs.push(
      `✅ <b>elysium-watch is live</b> on chain ${CHAIN_ID} (block ${head})\n` +
      `Watching ${Object.keys(state.pools).length} pools across BOXA, elyspump and Kleos, plus Uniswap v3 HYPE pairs.\n` +
      `Tracked wallets: ${W.size}.\n` +
      (lines.length ? `Busiest in the last ${Math.round(hours * 60)} min:\n${lines.join('\n')}` : '')
    );
  }

  // housekeeping: forget dead coins after 3 days, keep state small
  const cutoff = now() - 3 * 86400;
  for (const [t, r] of Object.entries(state.tok)) {
    if ((r.born || 0) < cutoff && !roll[t] && (r.e ?? 0) < 0.05) { delete state.tok[t]; delete state.meta[t]; }
  }
  for (const [k, a] of Object.entries(state.alerted)) if (now() - a.t > 2 * 86400) delete state.alerted[k];

  state.block = head;
  state.runs++;
  fs.writeFileSync(STATE, JSON.stringify(state));
  for (const m of msgs) await tg(m);
  console.log(`done: ${Object.keys(roll).length} coins traded, ${launchTxs.length} launches, ${msgs.length} alerts`);
}

// ── Stockium (launchpad on HyperEVM; graduated tokens move to StockiumSwap on Elysium) ─────────────
const STOCKIUM_LAUNCHPADS = ['0x898f3c534565ef4d41fba4dd054b86f00249ecaa', '0x64fc90c7a07e637af21b1c8fbc41bf508b60efe8', '0x431ef5cb3719de47e567db66594569d208a6cd00', '0xe5212d898ebc950255e4f39e3e5a34cd4826b04a'];
const T_TOKEN_CREATED = '0x1ad1211f7a691e74bd9e10657aedbcf93c3ee2b524e226d7fe04a7ec6f74ed40'; // TokenCreated(token, curve, pairAsset, creator, threshold)
const T_BOUGHT = '0xedba86fd2b22962d534e70ad9b0ff8730de46f636146f2bab6a72cbb1ebbcc53';        // Bought(buyer, hypeIn, tokensOut, fee)
const T_SOLD = '0xe029f26dbcf8c42dd2f352c10214a7fc26773dc62482c6241334a0402ac09a80';          // Sold(seller, tokensIn, hypeOut, fee)
const CURVE_MIN_BUYERS = 8;      // traction: unique buyers seen on a curve
const CURVE_MIN_HYPE = 10;       // and HYPE traded on it
const CURVE_WINDOW_H = 3;        // only for curves younger than this (when we saw the launch)
const STOCKIUM_ALL_LAUNCHES = process.env.STOCKIUM_ALL_LAUNCHES === '1'; // default: launches by tracked wallets only
const hyperLink = (a) => `<a href="https://hyperevmscan.io/address/${a}">${short(a)}</a>`;
const stockiumLink = (curve, label = 'open on Stockium') => `<a href="https://stockium.fun/token/${curve}">${label}</a>`;

async function hLogs(filter, from, to) {
  const out = [];
  for (let s = from; s <= to; s += 1000) {
    out.push(...await hrpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + Math.min(to, s + 999).toString(16) }]));
  }
  return out;
}

async function curveInfo(H, curve) {
  const rec = (H.curves[curve] ||= { buyers: [], vol: 0, buys: 0 });
  if (rec.s) return rec;
  try {
    if (!rec.token) {
      const t = await hrpc('eth_call', [{ to: curve, data: '0xfc0c546a' }, 'latest']); // token()
      if (t && t.length >= 66) rec.token = '0x' + t.slice(26);
    }
    if (rec.token) {
      const [n, s] = await Promise.all([
        hrpc('eth_call', [{ to: rec.token, data: '0x06fdde03' }, 'latest']),
        hrpc('eth_call', [{ to: rec.token, data: '0x95d89b41' }, 'latest']),
      ]);
      rec.n = decodeString(n).slice(0, 40) || 'unknown';
      rec.s = decodeString(s).slice(0, 16) || '???';
    }
  } catch {}
  return rec;
}

async function stockium(state, W, G, msgs, px) {
  const H = (state.hyper ||= { block: 0, curves: {} });
  const head = parseInt(await hrpc('eth_blockNumber', []), 16);
  let from = H.block ? H.block + 1 : head - 300;
  if (head - from > 5000) from = head - 5000;
  if (from > head) return;
  const created = await hLogs({ address: STOCKIUM_LAUNCHPADS, topics: [T_TOKEN_CREATED] }, from, head);
  const trades = await hLogs({ topics: [[T_BOUGHT, T_SOLD]] }, from, head);
  const firstScan = !H.started;
  H.started ||= now();
  H.block = head;
  const usdOrHype = (h) => (px ? usd(h * px) : hype(h));

  for (const l of created) {
    const token = lc(topicAddr(l.topics[1]));
    const curve = lc(topicAddr(l.topics[2]));
    const creator = lc('0x' + l.data.slice(26, 66));
    const rec = (H.curves[curve] ||= { buyers: [], vol: 0, buys: 0 });
    Object.assign(rec, { token, creator, born: now(), valid: true });
    await curveInfo(H, curve);
    if (firstScan || !(STOCKIUM_ALL_LAUNCHES || W.has(creator))) continue;
    msgs.push({
      text: `🧪 <b>New Stockium launch: ${esc(rec.s)}</b> (${esc(rec.n)}) on HyperEVM\n` +
        `Creator ${hyperLink(creator)}${W.has(creator) ? ` · 👛 <b>${esc(W.get(creator))}</b>` : ''}\n<code>${token}</code>\n${stockiumLink(curve)}`,
      buttons: buyButtons('h', curve),
    });
  }

  const touched = new Set();
  const moves = {};
  for (const l of trades) {
    const curve = lc(l.address);
    const who = lc(topicAddr(l.topics[1]));
    const w = words(l.data);
    const buy = l.topics[0] === T_BOUGHT;
    const amt = Number(BigInt('0x' + (buy ? w[0] : w[1]))) / 1e18;
    const rec = (H.curves[curve] ||= { buyers: [], vol: 0, buys: 0 });
    rec.vol += amt;
    touched.add(curve);
    if (buy) { rec.buys++; if (rec.buyers.length < 300 && !rec.buyers.includes(who)) rec.buyers.push(who); }
    if (W.has(who)) {
      const info = await curveInfo(H, curve);
      (moves[who] ||= []).push(`${buy ? 'bought' : 'sold'} <b>${esc(info.s || '???')}</b> for ${hype(amt)}${px ? ` (${usd(amt * px)})` : ''} on its Stockium curve · ${stockiumLink(curve, 'chart')} · <a href="https://hyperevmscan.io/tx/${l.transactionHash}">tx</a>`);
      if (buy) for (const g of [G.get(who), '*'].filter(Boolean)) (state.gbuys[g + '|h:' + curve] ||= []).push({ w: who, t: now(), h: amt });
    }
  }
  // curve state(): spot price (HYPE per token, 1e18) and graduation; 1B supply on every Stockium token
  for (const c of [...touched].slice(0, 15)) {
    const rec = H.curves[c];
    try {
      const st = words(await hrpc('eth_call', [{ to: c, data: '0xc19d93fb' }, 'latest']));
      if (st.length >= 10) {
        rec.valid = true;
        rec.mc = (Number(BigInt('0x' + st[5])) / 1e18) * 1e9;
        rec.graduated = BigInt('0x' + st[6]) === 1n;
      }
    } catch {}
  }
  for (const [w, list] of Object.entries(moves)) {
    msgs.push(`👛 <b>${esc(W.get(w))}</b> · ${hyperLink(w)} (HyperEVM)\n` + list.slice(0, 8).map((x) => '• ' + x).join('\n'));
  }
  for (const c of touched) {
    const rec = H.curves[c];
    if (!rec.valid || rec.tractionAlert || rec.graduated || firstScan) continue;
    if (rec.born && now() - rec.born > CURVE_WINDOW_H * 3600) continue;
    if (rec.buyers.length < CURVE_MIN_BUYERS || rec.vol < CURVE_MIN_HYPE) continue;
    rec.tractionAlert = now();
    await curveInfo(H, c);
    const age = rec.born ? ` · ${ago(now() - rec.born)} old` : '';
    msgs.push({
      text: `🚀 <b>${esc(rec.s || '???')}</b> (${esc(rec.n || '')}) is moving on its Stockium curve (HyperEVM)\n` +
        `${rec.buyers.length} buyers · ${usdOrHype(rec.vol)} traded${age}${rec.mc ? ` · MC ${usdOrHype(rec.mc)}` : ''}\n` +
        `${rec.creator ? `Creator ${hyperLink(rec.creator)}${W.has(rec.creator) ? ` · 👛 <b>${esc(W.get(rec.creator))}</b>` : ''}\n` : ''}` +
        `<code>${rec.token || c}</code>\n${stockiumLink(c)}`,
      buttons: buyButtons('h', c),
    });
  }
  // keep state small: forget quiet curves after 3 days
  for (const [c, rec] of Object.entries(H.curves)) if ((rec.born || H.started) < now() - 3 * 86400 && !touched.has(c)) delete H.curves[c];
}

// Cielo list from the CIELO_WALLETS secret: base64(gzip([count u16][20-byte addresses][labels joined by \n]))
function loadCielo() {
  const m = new Map();
  const b64 = process.env.CIELO_WALLETS;
  if (!b64) return m;
  try {
    const buf = zlib.gunzipSync(Buffer.from(b64, 'base64'));
    const n = buf.readUInt16BE(0);
    const labels = buf.subarray(2 + n * 20).toString('utf8').split('\n');
    for (let i = 0; i < n; i++) m.set('0x' + buf.subarray(2 + i * 20, 22 + i * 20).toString('hex'), labels[i] || 'cielo wallet');
  } catch (e) { console.log('cielo list unreadable:', e.message); }
  return m;
}

function fmtAmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
