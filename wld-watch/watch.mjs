// wld-watch: volume radar for World Chain (chain 480).
//
// Every run reads every block since the last run, straight from the chain:
//   1. Swap events from every Uniswap v2/v3 style pool and the v4 PoolManager,
//      valued on the WLD / USDC / ETH side and rolled up per token.
//   2. WLD / USDC / WETH transfers into contracts that are not pools
//      (bonding curves, launchpads, presales), rolled up per receiving address.
//   3. Fresh ERC-20 mints, traced back to the contract that created them,
//      so a launchpad factory shows up as soon as it ships a few tokens.
// Alerts go to Telegram when a token or a money magnet runs well above its own
// baseline, plus a leaderboard digest every few hours.

import fs from 'node:fs';

// ── config ───────────────────────────────────────────────────────────────────
const RPCS = [
  'https://worldchain-mainnet.g.alchemy.com/public',
  'https://480.rpc.thirdweb.com',
  'https://worldchain.drpc.org',
  'https://worldchain-mainnet.gateway.tenderly.co',
];
const BLOCKSCOUT = 'https://worldchain-mainnet.explorer.alchemy.com/api/v2';
const EXPLORER = 'https://worldchain-mainnet.explorer.alchemy.com';
const GT = 'https://api.geckoterminal.com/api/v2';

const BLOCK_SECONDS = 2;
const LOG_RANGE = 100;          // public RPCs cap eth_getLogs at 100 blocks
const MAX_BLOCKS = 2700;        // at most 90 minutes of history per run
const WARMUP_RUNS = 6;          // runs that only learn baselines (about an hour)
const COOLDOWN_H = 3;           // hours before the same token/address can ping again
const DIGEST_EVERY_H = 6;       // leaderboard digest cadence

// thresholds, per hour
const RUN_MIN_USD = 3000;       // token volume an hour before a run alert
const RUN_MIN_SWAPS = 25;
const RUN_MULT = 3;             // times its own baseline
const RUN_MIN_BUY_SHARE = 0.55; // share of quote volume that was buying
const HUB_MIN_USD = 1500;       // money flowing into a non-pool contract
const HUB_MIN_SENDERS = 15;
const HUB_MULT = 3;
const FACTORY_STEPS = [3, 10, 25, 50, 100, 250, 500];
const WLD_MIN_USD = 60000;      // WLD itself does ~$20K/h on-chain on a normal day
const WLD_MULT = 3;

// stablecoins, wrapped majors and tokenized gold: never "runs", kept out of alerts and digests
const MAJORS = /^(W?ETH|WBTC|CBBTC|BTC|USDC(\.E)?|USDT\d*|USD₮\d*|DAI|USDS|SUSDS|USDE|FRAX|PYUSD|EURC|EURE|EURS|XAUT|OXAUT|PAXG|USOL|UXRP|UBTC|USUI|UDOGE|W(ARS|BRL|MXN|PEN|CLP|COP|EUR|GBP|JPY|CHF|KRW|IDR|NGN|USD)|IDRX|TRYB|BRZ|MXNB|CADC|XSGD|GYEN)$/i;
const isMajor = (m) => MAJORS.test(String(m?.s || '').trim());

const ZERO = '0x0000000000000000000000000000000000000000';
const WLD = '0x2cfc85d8e48f8eab294be644d9e25c3030863003';
const USDC = '0x79a02482a880bce3f13e09da970dc34db4cd24d1';
const WETH = '0x4200000000000000000000000000000000000006';
const POOL_MANAGER = '0xb1860d529182ac3bc1f51fa2abd56662b7d13f33';
const POSITION_MANAGER = '0xc585e0f504613b5fbf874f21af14c65260fb41fa';
// quote assets, highest priority first: the other side of a pair is the "subject"
const QUOTES = {
  [USDC]: { sym: 'USDC', dec: 6, rank: 3 },
  [WETH]: { sym: 'ETH', dec: 18, rank: 2 },
  [ZERO]: { sym: 'ETH', dec: 18, rank: 2 }, // native ETH in v4 pools
  [WLD]: { sym: 'WLD', dec: 18, rank: 1 },
};
const INFRA = new Set([
  WLD, USDC, WETH, ZERO, POOL_MANAGER, POSITION_MANAGER,
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0x03c4f6b55733cdf3caa07c01e5b83ddee3381f60', // UniversalRouter
  '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f', // UniversalRouter
  '0x8b844f885672f333bc0042cb669255f93a4c1e6b', // UniversalRouter
  '0x5d6b0f5335ec95cd2ab7e52f2a0750dd86502435', // UniversalRouter
]);

const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const T_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const ZERO_TOPIC = '0x' + '0'.repeat(64);

const STATE = new URL('./state.json', import.meta.url);
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
function int256(hex) {
  const x = BigInt('0x' + hex);
  return x >= 1n << 255n ? x - (1n << 256n) : x;
}
const words = (data) => (data.slice(2).match(/.{64}/g) || []);
const toNum = (big, dec) => Number(big) / 10 ** dec;

let rpcIdx = 0;
async function rpc(method, params, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

async function getLogs(filter, from, to) {
  const out = [];
  for (let s = from; s <= to; s += LOG_RANGE) {
    const e = Math.min(to, s + LOG_RANGE - 1);
    const logs = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16) }]);
    out.push(...logs);
  }
  return out;
}

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(2500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[telegram]\n' + text + '\n'); return; }
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (r.ok) return;
    if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
    console.error('telegram', r.status, await r.text());
    return;
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s));
}

// ── metadata (cached in state) ───────────────────────────────────────────────
async function tokenMeta(state, a) {
  const c = state.tok[a];
  if (c && now() - c.t < 86400) return c;
  const j = await getJSON(`${BLOCKSCOUT}/tokens/${a}`);
  const m = {
    s: j?.symbol || c?.s || '?',
    n: j?.name || c?.n || '',
    d: Number(j?.decimals ?? c?.d ?? 18),
    h: Number(j?.holders_count ?? j?.holders ?? c?.h ?? 0),
    t: now(),
  };
  state.tok[a] = m;
  return m;
}

// v2/v3 pools: token0()/token1(). Anything that fails is remembered as "not a pool".
async function resolvePools(state, addrs) {
  const todo = addrs.filter((a) => state.pool[a] === undefined).slice(0, 300);
  for (let i = 0; i < todo.length; i += 25) {
    const chunk = todo.slice(i, i + 25);
    await Promise.all(chunk.map(async (a) => {
      try {
        const [t0, t1] = await Promise.all([
          rpc('eth_call', [{ to: a, data: '0x0dfe1681' }, 'latest'], 3),
          rpc('eth_call', [{ to: a, data: '0xd21220a7' }, 'latest'], 3),
        ]);
        state.pool[a] = t0 && t0.length >= 66 && t1 && t1.length >= 66 ? [topicAddr(t0), topicAddr(t1)] : 0;
      } catch {
        state.pool[a] = 0;
      }
    }));
  }
}

// v4 pools are ids inside the PoolManager. The v4 PositionManager keeps the full
// PoolKey for every pool it has minted liquidity into: poolKeys(bytes25(id)).
async function resolveV4(state, ids) {
  const todo = ids.filter((id) => state.v4[id] === undefined).slice(0, 60);
  let gtCalls = 0;
  for (const id of todo) {
    let pair = 0;
    try {
      const r = await rpc('eth_call', [{ to: POSITION_MANAGER, data: '0x86b6be7d' + id.slice(2, 52).padEnd(64, '0') }, 'latest'], 3);
      const w = words(r || '0x');
      const c0 = w[0] ? '0x' + w[0].slice(24) : ZERO;
      const c1 = w[1] ? '0x' + w[1].slice(24) : ZERO;
      if (c1 !== ZERO) pair = [c0, c1];
    } catch {}
    if (!pair && gtCalls < 8) {
      // pool created outside the PositionManager: ask GeckoTerminal
      gtCalls++;
      const j = await getJSON(`${GT}/networks/world-chain/pools/${id}`);
      const ids2 = [j?.data?.relationships?.base_token?.data?.id, j?.data?.relationships?.quote_token?.data?.id];
      if (ids2[0] && ids2[1]) {
        pair = ids2.map((x) => lc(x.split('_').pop())).map((x) => (x === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? ZERO : x)).sort();
      }
      await sleep(2200); // GT free tier: 30 calls a minute
    }
    state.v4[id] = pair; // 0 = unknown, counted as an unindexed pool
  }
}

async function prices(state) {
  const j = await getJSON(`${GT}/simple/networks/world-chain/token_price/${WLD},${WETH}`);
  const p = j?.data?.attributes?.token_prices || {};
  const wld = Number(p[WLD]) || state.px?.[WLD] || 0;
  const eth = Number(p[WETH]) || state.px?.[WETH] || 0;
  state.px = { [WLD]: wld, [WETH]: eth, [ZERO]: eth, [USDC]: 1 };
  return state.px;
}

// ── analysis ─────────────────────────────────────────────────────────────────
function pairSide(t0, t1) {
  const q0 = QUOTES[t0], q1 = QUOTES[t1];
  if (!q0 && !q1) return null;               // token/token pool: no USD side
  if (q0 && q1) {
    if (q0.rank === q1.rank) return null;    // ETH/WETH style
    return q0.rank > q1.rank ? { subj: t1, quote: t0, qi: 0 } : { subj: t0, quote: t1, qi: 1 };
  }
  return q0 ? { subj: t1, quote: t0, qi: 0 } : { subj: t0, quote: t1, qi: 1 };
}

function addSwap(agg, subj, pool, quote, poolGotQuote, px) {
  const q = QUOTES[quote];
  const amt = Math.abs(poolGotQuote) / 10 ** q.dec * (px[quote] || 0);
  if (!(amt > 0) || amt > 5e7) return;       // ignore dust and decoding garbage
  const a = (agg[subj] ||= { vol: 0, buy: 0, sell: 0, swaps: 0, pools: new Set() });
  a.vol += amt; a.swaps++; a.pools.add(pool);
  if (poolGotQuote > 0) a.buy += amt; else a.sell += amt;
}

function ema(prev, x) {
  return prev == null ? x : prev * 0.85 + x * 0.15;
}

function due(state, key, rate) {
  const last = state.alerted[key];
  if (!last) return true;
  if (now() - last.t > COOLDOWN_H * 3600) return true;
  return rate >= last.r * 2; // it doubled since the last ping: worth another
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let state = loadState();
  const firstRun = !state;
  state ||= { v: 1, block: 0, runs: 0, started: now(), tok: {}, pool: {}, v4: {}, base: {}, hub: {}, seenTok: {}, fac: {}, alerted: {}, digestAt: 0, px: {} };

  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  let from = state.block ? state.block + 1 : head - 1800; // first run: last hour
  let skipped = 0;
  if (head - from + 1 > MAX_BLOCKS) { skipped = head - MAX_BLOCKS + 1 - from; from = head - MAX_BLOCKS + 1; }
  if (from > head) { console.log('no new blocks'); return; }
  const blocks = head - from + 1;
  const hours = (blocks * BLOCK_SECONDS) / 3600;
  const px = await prices(state);
  console.log(`blocks ${from}..${head} (${blocks}, ${(hours * 60).toFixed(0)} min${skipped ? `, skipped ${skipped}` : ''}) WLD $${px[WLD]} ETH $${px[WETH]}`);

  // 1) swaps across v2, v3 and v4
  const swapLogs = await getLogs({ topics: [[T_SWAP_V2, T_SWAP_V3]] }, from, head);
  const v4Logs = await getLogs({ address: POOL_MANAGER, topics: [T_SWAP_V4] }, from, head);
  await resolvePools(state, [...new Set(swapLogs.map((l) => lc(l.address)))]);
  const v4Ids = {};
  for (const l of v4Logs) v4Ids[l.topics[1]] = (v4Ids[l.topics[1]] || 0) + 1;
  await resolveV4(state, Object.entries(v4Ids).sort((a, b) => b[1] - a[1]).map(([id]) => id));

  const agg = {};
  let unindexed = {};
  for (const l of swapLogs) {
    const pool = lc(l.address);
    const pr = state.pool[pool];
    if (!pr) continue;
    const side = pairSide(pr[0], pr[1]);
    if (!side) continue;
    const w = words(l.data);
    let got; // what the pool received of the quote asset (positive = someone bought subj)
    if (l.topics[0] === T_SWAP_V3) {
      got = int256(w[side.qi]);
    } else {
      const ins = [BigInt('0x' + w[0]), BigInt('0x' + w[1])];
      const outs = [BigInt('0x' + w[2]), BigInt('0x' + w[3])];
      got = ins[side.qi] - outs[side.qi];
    }
    addSwap(agg, side.subj, pool, side.quote, Number(got), px);
  }
  for (const l of v4Logs) {
    const id = l.topics[1];
    const pr = state.v4[id];
    if (!pr) { unindexed[id] = (unindexed[id] || 0) + 1; continue; }
    const side = pairSide(pr[0], pr[1]);
    if (!side) continue;
    const w = words(l.data);
    // v4 reports the swapper's delta: negative means the swapper paid that currency in
    const got = -int256(w[side.qi]);
    addSwap(agg, side.subj, 'v4:' + id.slice(0, 10), side.quote, Number(got), px);
  }

  // 2) quote money flowing into non-pool contracts (curves, launchpads, presales)
  const qLogs = await getLogs({ address: [WLD, USDC, WETH], topics: [T_TRANSFER] }, from, head);
  const hubs = {};
  for (const l of qLogs) {
    if (l.topics.length !== 3) continue;
    const token = lc(l.address);
    const fromA = topicAddr(l.topics[1]);
    const to = topicAddr(l.topics[2]);
    if (INFRA.has(to) || state.pool[to]) continue;
    const q = QUOTES[token];
    const amt = Number(BigInt(l.data.length > 2 ? l.data.slice(0, 66) : '0x0')) / 10 ** q.dec * (px[token] || 0);
    if (!(amt > 0)) continue;
    const h = (hubs[to] ||= { usd: 0, n: 0, from: new Set() });
    h.usd += amt; h.n++; h.from.add(fromA);
  }
  const hubCands = Object.entries(hubs)
    .filter(([, h]) => h.from.size >= HUB_MIN_SENDERS && h.usd / hours >= HUB_MIN_USD)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, 40);
  // make sure none of them is a pool we have not met yet (a pool with no swaps this window)
  await resolvePools(state, hubCands.map(([a]) => a));

  // 3) brand-new tokens, grouped by the contract that created them
  const mintLogs = await getLogs({ topics: [T_TRANSFER, ZERO_TOPIC] }, from, head);
  const minted = [...new Set(mintLogs.filter((l) => l.topics.length === 3).map((l) => lc(l.address)))]
    .filter((a) => !state.seenTok[a.slice(2, 8) + a.slice(-10)] && !QUOTES[a]);
  const newLaunches = [];
  for (const a of minted.slice(0, 25)) {
    state.seenTok[a.slice(2, 8) + a.slice(-10)] = 1;
    const info = await getJSON(`${BLOCKSCOUT}/addresses/${a}`);
    if (!info?.creation_transaction_hash) continue;
    const tx = await getJSON(`${BLOCKSCOUT}/transactions/${info.creation_transaction_hash}`);
    const ts = tx?.timestamp ? Date.parse(tx.timestamp) / 1000 : 0;
    if (!ts || now() - ts > 48 * 3600) continue; // an old token minting again: ignore
    const factory = lc(tx.to?.hash || info.creator_address_hash || '');
    const meta = await tokenMeta(state, a);
    newLaunches.push({ a, factory, deployer: lc(tx.from?.hash), ts, meta, fname: tx.to?.name || '' });
  }

  // ── decide what to send ────────────────────────────────────────────────────
  const learning = firstRun || state.runs < WARMUP_RUNS;
  const msgs = [];

  // token runs
  const tokRows = [];
  for (const [t, a] of Object.entries(agg)) {
    const rate = a.vol / hours;
    const key = 't:' + t;
    const prev = state.base[key];
    tokRows.push({ t, a, rate, prev: prev?.e });
    state.base[key] = { e: ema(prev?.e, rate), s: now() };
    if (learning) continue;
    if (t === WLD) {
      // WLD itself: only a real surge, measured against its own on-chain baseline
      const buyShare = a.vol ? a.buy / a.vol : 0;
      if (prev?.e != null && rate >= WLD_MIN_USD && rate >= WLD_MULT * prev.e && due(state, key, rate)) {
        state.alerted[key] = { t: now(), r: rate };
        msgs.push(
          `🌐 <b>WLD on-chain volume surge</b>\n` +
          `${usd(rate)}/h on World Chain DEXes · ${(rate / prev.e).toFixed(1)}× baseline (${usd(prev.e)}/h)\n` +
          `${Math.round(buyShare * 100)}% buys · ${Math.round(a.swaps / hours)} swaps/h · WLD $${px[WLD].toFixed(3)}`
        );
      }
      continue;
    }
    const buyShare = a.vol ? a.buy / a.vol : 0;
    const hot = rate >= RUN_MIN_USD && a.swaps / hours >= RUN_MIN_SWAPS && buyShare >= RUN_MIN_BUY_SHARE
      && (prev?.e == null || rate >= RUN_MULT * Math.max(prev.e, 300));
    if (hot && due(state, key, rate)) {
      const m = await tokenMeta(state, t);
      if (isMajor(m)) continue;
      state.alerted[key] = { t: now(), r: rate };
      msgs.push(
        `🔥 <b>${esc(m.s)}</b> volume run on World Chain\n` +
        `${usd(rate)}/h · ${Math.round(buyShare * 100)}% buys · ${Math.round(a.swaps / hours)} swaps/h · ${a.pools.size} pool${a.pools.size > 1 ? 's' : ''}\n` +
        `baseline ${prev?.e == null ? 'new' : usd(prev.e) + '/h'} · ${m.h.toLocaleString('en-US')} holders\n` +
        `<code>${t}</code>\n` +
        `<a href="https://www.geckoterminal.com/world-chain/tokens/${t}">chart</a> · <a href="https://dexscreener.com/worldchain/${t}">dexscreener</a> · <a href="${EXPLORER}/token/${t}">explorer</a>`
      );
    }
  }

  // unindexed v4 pools getting real traffic (GT does not know them yet)
  for (const [id, n] of Object.entries(unindexed)) {
    const rate = n / hours;
    const key = 'u:' + id;
    const prev = state.base[key];
    state.base[key] = { e: ema(prev?.e, rate), s: now() };
    if (!learning && rate >= 60 && (prev?.e == null || rate >= RUN_MULT * prev.e) && due(state, key, rate)) {
      state.alerted[key] = { t: now(), r: rate };
      msgs.push(`👀 Unindexed v4 pool trading on World Chain\n${Math.round(rate)} swaps/h, not on GeckoTerminal yet\npool id <code>${id}</code>`);
    }
    if (state.v4[id] === 0 && rate >= 30) delete state.v4[id]; // ask GT again next run
  }

  // money magnets: non-pool contracts pulling WLD/USDC/ETH from many wallets
  for (const [addr, h] of hubCands) {
    if (state.pool[addr]) continue;
    const rate = h.usd / hours;
    const key = 'h:' + addr;
    const prev = state.hub[addr];
    state.hub[addr] = { e: ema(prev?.e, rate), s: now() };
    if (learning) continue;
    if (prev?.e != null && rate < HUB_MULT * Math.max(prev.e, 200)) continue;
    if (!due(state, key, rate)) continue;
    const info = await getJSON(`${BLOCKSCOUT}/addresses/${addr}`);
    const name = info?.name || info?.implementations?.[0]?.name || (info?.is_contract ? 'unverified contract' : 'wallet (EOA)');
    state.alerted[key] = { t: now(), r: rate };
    msgs.push(
      `💰 Money flowing into <b>${esc(name)}</b>\n` +
      `${usd(rate)}/h from ${h.from.size} wallets (${h.n} transfers) · baseline ${prev?.e == null ? 'new' : usd(prev.e) + '/h'}\n` +
      `<code>${addr}</code>${info?.creator_address_hash ? `\ncreator <code>${lc(info.creator_address_hash)}</code>` : ''}\n` +
      `<a href="${EXPLORER}/address/${addr}">explorer</a>`
    );
  }

  // launchpad / factory detector
  for (const l of newLaunches) {
    if (!l.factory) continue;
    const f = (state.fac[l.factory] ||= { n: 0, step: 0, name: l.fname, last: [] });
    f.n++; f.name ||= l.fname;
    f.last = [`${l.meta.s}|${l.a}`, ...f.last].slice(0, 5);
    f.s = now();
    const next = FACTORY_STEPS.find((x) => x > (f.step || 0));
    if (!learning && next && f.n >= next) {
      f.step = next;
      const recent = f.last.map((x) => { const [s, a] = x.split('|'); return `• ${esc(s)} <code>${a}</code>`; }).join('\n');
      msgs.push(
        `🚀 <b>${f.n} new tokens</b> from one creator contract on World Chain\n` +
        `${esc(f.name || 'unnamed contract')} <code>${l.factory}</code>\n${recent}\n` +
        `<a href="${EXPLORER}/address/${l.factory}">explorer</a>`
      );
    }
  }

  // digest
  if (!firstRun && now() - state.digestAt >= DIGEST_EVERY_H * 3600 && tokRows.length) {
    state.digestAt = now();
    const ranked = tokRows.filter((r) => r.t !== WLD).sort((a, b) => b.rate - a.rate);
    const lines = [];
    for (const r of ranked) {
      if (lines.length >= 10) break;
      const m = await tokenMeta(state, r.t);
      if (isMajor(m)) continue;
      const bs = r.a.vol ? Math.round((r.a.buy / r.a.vol) * 100) : 0;
      const vs = r.prev ? ` (${(r.rate / Math.max(r.prev, 1)).toFixed(1)}× base)` : '';
      lines.push(`${esc(m.s)} · ${usd(r.rate)}/h · ${bs}% buys${vs}`);
    }
    const wld = tokRows.find((r) => r.t === WLD);
    msgs.push(
      `📊 <b>World Chain volume, last ${Math.round(hours * 60)} min</b>\n` +
      (wld ? `WLD itself: ${usd(wld.rate)}/h · $${px[WLD].toFixed(3)}\n` : '') +
      lines.map((x, i) => `${i + 1}. ${x}`).join('\n')
    );
  }

  // ── housekeeping ───────────────────────────────────────────────────────────
  const cutoff = now() - 4 * 86400;
  for (const k of Object.keys(state.base)) if (state.base[k].s < cutoff) delete state.base[k];
  for (const k of Object.keys(state.hub)) if (state.hub[k].s < cutoff) delete state.hub[k];
  for (const k of Object.keys(state.alerted)) if (state.alerted[k].t < cutoff) delete state.alerted[k];
  for (const k of Object.keys(state.fac)) if ((state.fac[k].s || 0) < now() - 14 * 86400) delete state.fac[k];
  const seen = Object.keys(state.seenTok);
  if (seen.length > 20000) for (const k of seen.slice(0, seen.length - 20000)) delete state.seenTok[k];
  const pools = Object.keys(state.pool);
  if (pools.length > 30000) for (const k of pools.slice(0, pools.length - 30000)) delete state.pool[k];

  state.block = head;
  state.runs++;

  if (firstRun) {
    const ranked = tokRows.filter((r) => r.t !== WLD).sort((a, b) => b.rate - a.rate);
    const lines = [];
    for (const r of ranked) {
      if (lines.length >= 8) break;
      const m = await tokenMeta(state, r.t);
      if (!isMajor(m)) lines.push(`${esc(m.s)} · ${usd(r.rate)}/h`);
    }
    msgs.push(
      `👀 <b>wld-watch armed</b>\nWatching every swap on World Chain (Uniswap v2/v3/v4 and forks), money flowing into non-pool contracts, and new-token factories. Baselines learn for about an hour, then alerts start.\n\n` +
      `Busiest tokens right now:\n${lines.map((x, i) => `${i + 1}. ${x}`).join('\n') || '(quiet)'}`
    );
  }

  saveState(state);
  for (const m of msgs) await tg(m);
  console.log(`swaps ${swapLogs.length} v4 ${v4Logs.length} quoteTransfers ${qLogs.length} mints ${mintLogs.length} tokens ${tokRows.length} hubs ${hubCands.length} newTokens ${newLaunches.length} alerts ${msgs.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
// wld-watch: volume radar for World Chain (chain 480).
//
// Every run reads every block since the last run, straight from the chain:
//   1. Swap events from every Uniswap v2/v3 style pool and the v4 PoolManager,
//      valued on the WLD / USDC / ETH side and rolled up per token.
//   2. WLD / USDC / WETH transfers into contracts that are not pools
//      (bonding curves, launchpads, presales), rolled up per receiving address.
//   3. Fresh ERC-20 mints, traced back to the contract that created them,
//      so a launchpad factory shows up as soon as it ships a few tokens.
// Alerts go to Telegram when a token or a money magnet runs well above its own
// baseline, plus a leaderboard digest every few hours.

import fs from 'node:fs';

// ── config ───────────────────────────────────────────────────────────────────
const RPCS = [
  'https://worldchain-mainnet.g.alchemy.com/public',
  'https://480.rpc.thirdweb.com',
  'https://worldchain.drpc.org',
  'https://worldchain-mainnet.gateway.tenderly.co',
];
const BLOCKSCOUT = 'https://worldchain-mainnet.explorer.alchemy.com/api/v2';
const EXPLORER = 'https://worldchain-mainnet.explorer.alchemy.com';
const GT = 'https://api.geckoterminal.com/api/v2';

const BLOCK_SECONDS = 2;
const LOG_RANGE = 100;          // public RPCs cap eth_getLogs at 100 blocks
const MAX_BLOCKS = 2700;        // at most 90 minutes of history per run
const WARMUP_RUNS = 6;          // runs that only learn baselines (about an hour)
const COOLDOWN_H = 3;           // hours before the same token/address can ping again
const DIGEST_EVERY_H = 6;       // leaderboard digest cadence

// thresholds, per hour
const RUN_MIN_USD = 3000;       // token volume an hour before a run alert
const RUN_MIN_SWAPS = 25;
const RUN_MULT = 3;             // times its own baseline
const RUN_MIN_BUY_SHARE = 0.55; // share of quote volume that was buying
const HUB_MIN_USD = 1500;       // money flowing into a non-pool contract
const HUB_MIN_SENDERS = 15;
const HUB_MULT = 3;
const FACTORY_STEPS = [3, 10, 25, 50, 100, 250, 500];
const WLD_MIN_USD = 60000;      // WLD itself does ~$20K/h on-chain on a normal day
const WLD_MULT = 3;

const ZERO = '0x0000000000000000000000000000000000000000';
const WLD = '0x2cfc85d8e48f8eab294be644d9e25c3030863003';
const USDC = '0x79a02482a880bce3f13e09da970dc34db4cd24d1';
const WETH = '0x4200000000000000000000000000000000000006';
const POOL_MANAGER = '0xb1860d529182ac3bc1f51fa2abd56662b7d13f33';
const POSITION_MANAGER = '0xc585e0f504613b5fbf874f21af14c65260fb41fa';
// quote assets, highest priority first: the other side of a pair is the "subject"
const QUOTES = {
  [USDC]: { sym: 'USDC', dec: 6, rank: 3 },
  [WETH]: { sym: 'ETH', dec: 18, rank: 2 },
  [ZERO]: { sym: 'ETH', dec: 18, rank: 2 }, // native ETH in v4 pools
  [WLD]: { sym: 'WLD', dec: 18, rank: 1 },
};
const INFRA = new Set([
  WLD, USDC, WETH, ZERO, POOL_MANAGER, POSITION_MANAGER,
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0x03c4f6b55733cdf3caa07c01e5b83ddee3381f60', // UniversalRouter
  '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f', // UniversalRouter
  '0x8b844f885672f333bc0042cb669255f93a4c1e6b', // UniversalRouter
  '0x5d6b0f5335ec95cd2ab7e52f2a0750dd86502435', // UniversalRouter
]);

const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const T_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const ZERO_TOPIC = '0x' + '0'.repeat(64);

const STATE = new URL('./state.json', import.meta.url);
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
function int256(hex) {
  const x = BigInt('0x' + hex);
  return x >= 1n << 255n ? x - (1n << 256n) : x;
}
const words = (data) => (data.slice(2).match(/.{64}/g) || []);
const toNum = (big, dec) => Number(big) / 10 ** dec;

let rpcIdx = 0;
async function rpc(method, params, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

async function getLogs(filter, from, to) {
  const out = [];
  for (let s = from; s <= to; s += LOG_RANGE) {
    const e = Math.min(to, s + LOG_RANGE - 1);
    const logs = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16) }]);
    out.push(...logs);
  }
  return out;
}

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(2500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[telegram]\n' + text + '\n'); return; }
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (r.ok) return;
    if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
    console.error('telegram', r.status, await r.text());
    return;
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s));
}

// ── metadata (cached in state) ───────────────────────────────────────────────
async function tokenMeta(state, a) {
  const c = state.tok[a];
  if (c && now() - c.t < 86400) return c;
  const j = await getJSON(`${BLOCKSCOUT}/tokens/${a}`);
  const m = {
    s: j?.symbol || c?.s || '?',
    n: j?.name || c?.n || '',
    d: Number(j?.decimals ?? c?.d ?? 18),
    h: Number(j?.holders_count ?? j?.holders ?? c?.h ?? 0),
    t: now(),
  };
  state.tok[a] = m;
  return m;
}

// v2/v3 pools: token0()/token1(). Anything that fails is remembered as "not a pool".
async function resolvePools(state, addrs) {
  const todo = addrs.filter((a) => state.pool[a] === undefined).slice(0, 300);
  for (let i = 0; i < todo.length; i += 25) {
    const chunk = todo.slice(i, i + 25);
    await Promise.all(chunk.map(async (a) => {
      try {
        const [t0, t1] = await Promise.all([
          rpc('eth_call', [{ to: a, data: '0x0dfe1681' }, 'latest'], 3),
          rpc('eth_call', [{ to: a, data: '0xd21220a7' }, 'latest'], 3),
        ]);
        state.pool[a] = t0 && t0.length >= 66 && t1 && t1.length >= 66 ? [topicAddr(t0), topicAddr(t1)] : 0;
      } catch {
        state.pool[a] = 0;
      }
    }));
  }
}

// v4 pools are ids inside the PoolManager. The v4 PositionManager keeps the full
// PoolKey for every pool it has minted liquidity into: poolKeys(bytes25(id)).
async function resolveV4(state, ids) {
  const todo = ids.filter((id) => state.v4[id] === undefined).slice(0, 60);
  let gtCalls = 0;
  for (const id of todo) {
    let pair = 0;
    try {
      const r = await rpc('eth_call', [{ to: POSITION_MANAGER, data: '0x86b6be7d' + id.slice(2, 52).padEnd(64, '0') }, 'latest'], 3);
      const w = words(r || '0x');
      const c0 = w[0] ? '0x' + w[0].slice(24) : ZERO;
      const c1 = w[1] ? '0x' + w[1].slice(24) : ZERO;
      if (c1 !== ZERO) pair = [c0, c1];
    } catch {}
    if (!pair && gtCalls < 8) {
      // pool created outside the PositionManager: ask GeckoTerminal
      gtCalls++;
      const j = await getJSON(`${GT}/networks/world-chain/pools/${id}`);
      const ids2 = [j?.data?.relationships?.base_token?.data?.id, j?.data?.relationships?.quote_token?.data?.id];
      if (ids2[0] && ids2[1]) {
        pair = ids2.map((x) => lc(x.split('_').pop())).map((x) => (x === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? ZERO : x)).sort();
      }
      await sleep(2200); // GT free tier: 30 calls a minute
    }
    state.v4[id] = pair; // 0 = unknown, counted as an unindexed pool
  }
}

async function prices(state) {
  const j = await getJSON(`${GT}/simple/networks/world-chain/token_price/${WLD},${WETH}`);
  const p = j?.data?.attributes?.token_prices || {};
  const wld = Number(p[WLD]) || state.px?.[WLD] || 0;
  const eth = Number(p[WETH]) || state.px?.[WETH] || 0;
  state.px = { [WLD]: wld, [WETH]: eth, [ZERO]: eth, [USDC]: 1 };
  return state.px;
}

// ── analysis ─────────────────────────────────────────────────────────────────
function pairSide(t0, t1) {
  const q0 = QUOTES[t0], q1 = QUOTES[t1];
  if (!q0 && !q1) return null;               // token/token pool: no USD side
  if (q0 && q1) {
    if (q0.rank === q1.rank) return null;    // ETH/WETH style
    return q0.rank > q1.rank ? { subj: t1, quote: t0, qi: 0 } : { subj: t0, quote: t1, qi: 1 };
  }
  return q0 ? { subj: t1, quote: t0, qi: 0 } : { subj: t0, quote: t1, qi: 1 };
}

function addSwap(agg, subj, pool, quote, poolGotQuote, px) {
  const q = QUOTES[quote];
  const amt = Math.abs(poolGotQuote) / 10 ** q.dec * (px[quote] || 0);
  if (!(amt > 0) || amt > 5e7) return;       // ignore dust and decoding garbage
  const a = (agg[subj] ||= { vol: 0, buy: 0, sell: 0, swaps: 0, pools: new Set() });
  a.vol += amt; a.swaps++; a.pools.add(pool);
  if (poolGotQuote > 0) a.buy += amt; else a.sell += amt;
}

function ema(prev, x) {
  return prev == null ? x : prev * 0.85 + x * 0.15;
}

function due(state, key, rate) {
  const last = state.alerted[key];
  if (!last) return true;
  if (now() - last.t > COOLDOWN_H * 3600) return true;
  return rate >= last.r * 2; // it doubled since the last ping: worth another
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let state = loadState();
  const firstRun = !state;
  state ||= { v: 1, block: 0, runs: 0, started: now(), tok: {}, pool: {}, v4: {}, base: {}, hub: {}, seenTok: {}, fac: {}, alerted: {}, digestAt: 0, px: {} };

  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  let from = state.block ? state.block + 1 : head - 1800; // first run: last hour
  let skipped = 0;
  if (head - from + 1 > MAX_BLOCKS) { skipped = head - MAX_BLOCKS + 1 - from; from = head - MAX_BLOCKS + 1; }
  if (from > head) { console.log('no new blocks'); return; }
  const blocks = head - from + 1;
  const hours = (blocks * BLOCK_SECONDS) / 3600;
  const px = await prices(state);
  console.log(`blocks ${from}..${head} (${blocks}, ${(hours * 60).toFixed(0)} min${skipped ? `, skipped ${skipped}` : ''}) WLD $${px[WLD]} ETH $${px[WETH]}`);

  // 1) swaps across v2, v3 and v4
  const swapLogs = await getLogs({ topics: [[T_SWAP_V2, T_SWAP_V3]] }, from, head);
  const v4Logs = await getLogs({ address: POOL_MANAGER, topics: [T_SWAP_V4] }, from, head);
  await resolvePools(state, [...new Set(swapLogs.map((l) => lc(l.address)))]);
  const v4Ids = {};
  for (const l of v4Logs) v4Ids[l.topics[1]] = (v4Ids[l.topics[1]] || 0) + 1;
  await resolveV4(state, Object.entries(v4Ids).sort((a, b) => b[1] - a[1]).map(([id]) => id));

  const agg = {};
  let unindexed = {};
  for (const l of swapLogs) {
    const pool = lc(l.address);
    const pr = state.pool[pool];
    if (!pr) continue;
    const side = pairSide(pr[0], pr[1]);
    if (!side) continue;
    const w = words(l.data);
    let got; // what the pool received of the quote asset (positive = someone bought subj)
    if (l.topics[0] === T_SWAP_V3) {
      got = int256(w[side.qi]);
    } else {
      const ins = [BigInt('0x' + w[0]), BigInt('0x' + w[1])];
      const outs = [BigInt('0x' + w[2]), BigInt('0x' + w[3])];
      got = ins[side.qi] - outs[side.qi];
    }
    addSwap(agg, side.subj, pool, side.quote, Number(got), px);
  }
  for (const l of v4Logs) {
    const id = l.topics[1];
    const pr = state.v4[id];
    if (!pr) { unindexed[id] = (unindexed[id] || 0) + 1; continue; }
    const side = pairSide(pr[0], pr[1]);
    if (!side) continue;
    const w = words(l.data);
    // v4 reports the swapper's delta: negative means the swapper paid that currency in
    const got = -int256(w[side.qi]);
    addSwap(agg, side.subj, 'v4:' + id.slice(0, 10), side.quote, Number(got), px);
  }

  // 2) quote money flowing into non-pool contracts (curves, launchpads, presales)
  const qLogs = await getLogs({ address: [WLD, USDC, WETH], topics: [T_TRANSFER] }, from, head);
  const hubs = {};
  for (const l of qLogs) {
    if (l.topics.length !== 3) continue;
    const token = lc(l.address);
    const fromA = topicAddr(l.topics[1]);
    const to = topicAddr(l.topics[2]);
    if (INFRA.has(to) || state.pool[to]) continue;
    const q = QUOTES[token];
    const amt = Number(BigInt(l.data.length > 2 ? l.data.slice(0, 66) : '0x0')) / 10 ** q.dec * (px[token] || 0);
    if (!(amt > 0)) continue;
    const h = (hubs[to] ||= { usd: 0, n: 0, from: new Set() });
    h.usd += amt; h.n++; h.from.add(fromA);
  }
  const hubCands = Object.entries(hubs)
    .filter(([, h]) => h.from.size >= HUB_MIN_SENDERS && h.usd / hours >= HUB_MIN_USD)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, 40);
  // make sure none of them is a pool we have not met yet (a pool with no swaps this window)
  await resolvePools(state, hubCands.map(([a]) => a));

  // 3) brand-new tokens, grouped by the contract that created them
  const mintLogs = await getLogs({ topics: [T_TRANSFER, ZERO_TOPIC] }, from, head);
  const minted = [...new Set(mintLogs.filter((l) => l.topics.length === 3).map((l) => lc(l.address)))]
    .filter((a) => !state.seenTok[a.slice(2, 8) + a.slice(-10)] && !QUOTES[a]);
  const newLaunches = [];
  for (const a of minted.slice(0, 25)) {
    state.seenTok[a.slice(2, 8) + a.slice(-10)] = 1;
    const info = await getJSON(`${BLOCKSCOUT}/addresses/${a}`);
    if (!info?.creation_transaction_hash) continue;
    const tx = await getJSON(`${BLOCKSCOUT}/transactions/${info.creation_transaction_hash}`);
    const ts = tx?.timestamp ? Date.parse(tx.timestamp) / 1000 : 0;
    if (!ts || now() - ts > 48 * 3600) continue; // an old token minting again: ignore
    const factory = lc(tx.to?.hash || info.creator_address_hash || '');
    const meta = await tokenMeta(state, a);
    newLaunches.push({ a, factory, deployer: lc(tx.from?.hash), ts, meta, fname: tx.to?.name || '' });
  }

  // ── decide what to send ────────────────────────────────────────────────────
  const learning = firstRun || state.runs < WARMUP_RUNS;
  const msgs = [];

  // token runs
  const tokRows = [];
  for (const [t, a] of Object.entries(agg)) {
    const rate = a.vol / hours;
    const key = 't:' + t;
    const prev = state.base[key];
    tokRows.push({ t, a, rate, prev: prev?.e });
    state.base[key] = { e: ema(prev?.e, rate), s: now() };
    if (learning) continue;
    if (t === WLD) {
      // WLD itself: only a real surge, measured against its own on-chain baseline
      const buyShare = a.vol ? a.buy / a.vol : 0;
      if (prev?.e != null && rate >= WLD_MIN_USD && rate >= WLD_MULT * prev.e && due(state, key, rate)) {
        state.alerted[key] = { t: now(), r: rate };
        msgs.push(
          `🌐 <b>WLD on-chain volume surge</b>\n` +
          `${usd(rate)}/h on World Chain DEXes · ${(rate / prev.e).toFixed(1)}× baseline (${usd(prev.e)}/h)\n` +
          `${Math.round(buyShare * 100)}% buys · ${Math.round(a.swaps / hours)} swaps/h · WLD $${px[WLD].toFixed(3)}`
        );
      }
      continue;
    }
    const buyShare = a.vol ? a.buy / a.vol : 0;
    const hot = rate >= RUN_MIN_USD && a.swaps / hours >= RUN_MIN_SWAPS && buyShare >= RUN_MIN_BUY_SHARE
      && (prev?.e == null || rate >= RUN_MULT * Math.max(prev.e, 300));
    if (hot && due(state, key, rate)) {
      const m = await tokenMeta(state, t);
      state.alerted[key] = { t: now(), r: rate };
      msgs.push(
        `🔥 <b>${esc(m.s)}</b> volume run on World Chain\n` +
        `${usd(rate)}/h · ${Math.round(buyShare * 100)}% buys · ${Math.round(a.swaps / hours)} swaps/h · ${a.pools.size} pool${a.pools.size > 1 ? 's' : ''}\n` +
        `baseline ${prev?.e == null ? 'new' : usd(prev.e) + '/h'} · ${m.h.toLocaleString('en-US')} holders\n` +
        `<code>${t}</code>\n` +
        `<a href="https://www.geckoterminal.com/world-chain/tokens/${t}">chart</a> · <a href="https://dexscreener.com/worldchain/${t}">dexscreener</a> · <a href="${EXPLORER}/token/${t}">explorer</a>`
      );
    }
  }

  // unindexed v4 pools getting real traffic (GT does not know them yet)
  for (const [id, n] of Object.entries(unindexed)) {
    const rate = n / hours;
    const key = 'u:' + id;
    const prev = state.base[key];
    state.base[key] = { e: ema(prev?.e, rate), s: now() };
    if (!learning && rate >= 60 && (prev?.e == null || rate >= RUN_MULT * prev.e) && due(state, key, rate)) {
      state.alerted[key] = { t: now(), r: rate };
      msgs.push(`👀 Unindexed v4 pool trading on World Chain\n${Math.round(rate)} swaps/h, not on GeckoTerminal yet\npool id <code>${id}</code>`);
    }
    if (state.v4[id] === 0 && rate >= 30) delete state.v4[id]; // ask GT again next run
  }

  // money magnets: non-pool contracts pulling WLD/USDC/ETH from many wallets
  for (const [addr, h] of hubCands) {
    if (state.pool[addr]) continue;
    const rate = h.usd / hours;
    const key = 'h:' + addr;
    const prev = state.hub[addr];
    state.hub[addr] = { e: ema(prev?.e, rate), s: now() };
    if (learning) continue;
    if (prev?.e != null && rate < HUB_MULT * Math.max(prev.e, 200)) continue;
    if (!due(state, key, rate)) continue;
    const info = await getJSON(`${BLOCKSCOUT}/addresses/${addr}`);
    const name = info?.name || info?.implementations?.[0]?.name || (info?.is_contract ? 'unverified contract' : 'wallet (EOA)');
    state.alerted[key] = { t: now(), r: rate };
    msgs.push(
      `💰 Money flowing into <b>${esc(name)}</b>\n` +
      `${usd(rate)}/h from ${h.from.size} wallets (${h.n} transfers) · baseline ${prev?.e == null ? 'new' : usd(prev.e) + '/h'}\n` +
      `<code>${addr}</code>${info?.creator_address_hash ? `\ncreator <code>${lc(info.creator_address_hash)}</code>` : ''}\n` +
      `<a href="${EXPLORER}/address/${addr}">explorer</a>`
    );
  }

  // launchpad / factory detector
  for (const l of newLaunches) {
    if (!l.factory) continue;
    const f = (state.fac[l.factory] ||= { n: 0, step: 0, name: l.fname, last: [] });
    f.n++; f.name ||= l.fname;
    f.last = [`${l.meta.s}|${l.a}`, ...f.last].slice(0, 5);
    f.s = now();
    const next = FACTORY_STEPS.find((x) => x > (f.step || 0));
    if (!learning && next && f.n >= next) {
      f.step = next;
      const recent = f.last.map((x) => { const [s, a] = x.split('|'); return `• ${esc(s)} <code>${a}</code>`; }).join('\n');
      msgs.push(
        `🚀 <b>${f.n} new tokens</b> from one creator contract on World Chain\n` +
        `${esc(f.name || 'unnamed contract')} <code>${l.factory}</code>\n${recent}\n` +
        `<a href="${EXPLORER}/address/${l.factory}">explorer</a>`
      );
    }
  }

  // digest
  if (!firstRun && now() - state.digestAt >= DIGEST_EVERY_H * 3600 && tokRows.length) {
    state.digestAt = now();
    const top = tokRows.filter((r) => r.t !== WLD).sort((a, b) => b.rate - a.rate).slice(0, 10);
    const lines = [];
    for (const r of top) {
      const m = await tokenMeta(state, r.t);
      const bs = r.a.vol ? Math.round((r.a.buy / r.a.vol) * 100) : 0;
      const vs = r.prev ? ` (${(r.rate / Math.max(r.prev, 1)).toFixed(1)}× base)` : '';
      lines.push(`${esc(m.s)} · ${usd(r.rate)}/h · ${bs}% buys${vs}`);
    }
    const wld = tokRows.find((r) => r.t === WLD);
    msgs.push(
      `📊 <b>World Chain volume, last ${Math.round(hours * 60)} min</b>\n` +
      (wld ? `WLD itself: ${usd(wld.rate)}/h · $${px[WLD].toFixed(3)}\n` : '') +
      lines.map((x, i) => `${i + 1}. ${x}`).join('\n')
    );
  }

  // ── housekeeping ───────────────────────────────────────────────────────────
  const cutoff = now() - 4 * 86400;
  for (const k of Object.keys(state.base)) if (state.base[k].s < cutoff) delete state.base[k];
  for (const k of Object.keys(state.hub)) if (state.hub[k].s < cutoff) delete state.hub[k];
  for (const k of Object.keys(state.alerted)) if (state.alerted[k].t < cutoff) delete state.alerted[k];
  for (const k of Object.keys(state.fac)) if ((state.fac[k].s || 0) < now() - 14 * 86400) delete state.fac[k];
  const seen = Object.keys(state.seenTok);
  if (seen.length > 20000) for (const k of seen.slice(0, seen.length - 20000)) delete state.seenTok[k];
  const pools = Object.keys(state.pool);
  if (pools.length > 30000) for (const k of pools.slice(0, pools.length - 30000)) delete state.pool[k];

  state.block = head;
  state.runs++;

  if (firstRun) {
    const top = tokRows.filter((r) => r.t !== WLD).sort((a, b) => b.rate - a.rate).slice(0, 8);
    const lines = [];
    for (const r of top) lines.push(`${esc((await tokenMeta(state, r.t)).s)} · ${usd(r.rate)}/h`);
    msgs.push(
      `👀 <b>wld-watch armed</b>\nWatching every swap on World Chain (Uniswap v2/v3/v4 and forks), money flowing into non-pool contracts, and new-token factories. Baselines learn for about an hour, then alerts start.\n\n` +
      `Busiest tokens right now:\n${lines.map((x, i) => `${i + 1}. ${x}`).join('\n') || '(quiet)'}`
    );
  }

  saveState(state);
  for (const m of msgs) await tg(m);
  console.log(`swaps ${swapLogs.length} v4 ${v4Logs.length} quoteTransfers ${qLogs.length} mints ${mintLogs.length} tokens ${tokRows.length} hubs ${hubCands.length} newTokens ${newLaunches.length} alerts ${msgs.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
