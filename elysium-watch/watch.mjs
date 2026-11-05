// elysium-watch: launch and volume radar for Elysium mainnet (chain 99901, HYPE gas).
//
// Every scan reads every block since the last one, straight from the chain:
//   1. Pool Initialize events on the launchpads' Uniswap v4 PoolManagers (BOXA, elyspump, Kleos):
//      every new coin, which launchpad, who launched it.
//   2. v4 and v3 Swap events, valued in HYPE, rolled up per coin: volume, buy share, unique buyers.
//   3. Tracked wallets (wallets.json): swaps, token transfers, HYPE moves, contract deploys, launches.
// Alerts go to Telegram: launches that get real traction, volume runs, tracked-wallet moves,
// a brand-new launchpad appearing, the official mainnet RPC opening, and a digest every few hours.
// gate.mjs runs on the same blocks every tick to catch Ascend and Signal the moment they go live.
// `node watch.mjs --fast` is the fast lane beside it: tracked-wallet buys, sells and group buys within seconds
// (see fastMain below). The scan here then skips the trades that lane already sent.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { gate, gateDigest, gatePms } from './gate.mjs';
import { zeroWatch } from './zero.mjs';

// ── config ───────────────────────────────────────────────────────────────────
const RPCS = (process.env.ELY_RPCS || 'https://rpc.eleos.fun,https://rpc-live.boxa.club,https://rpc-live.elysp.com,https://rpc-live.elyspump.com,https://boxa.club/api/rpc')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OFFICIAL_RPC = 'https://rpc-elysium-mainnet.t.conduit.xyz';
const CHAIN_ID = 99901;
const BOXA = 'https://boxa.club';     // BOXA's API (token index); boxa.pro is on MetaMask's phishing list
const ELYXA = 'https://elyxa.trade'; // links in alerts (indexes every launchpad's trades and wallet PnL)

const LOG_RANGE = 500;           // the chain got busy: small log windows, split further if a node times out
// Elysium now makes about 6.5 blocks a second (it was 14 a minute at launch), so these are sized in blocks for that pace
const FIRST_LOOKBACK = 3000;     // first run: about the last 8 minutes
const MAX_BLOCKS = 24000;        // catch up at most about an hour in one go
const SCAN_MAX = 1200;           // blocks handled per tick (about 3 min of chain); the next tick continues
const SKIP_LAG = 7800;           // further behind than this (about 20 min): jump to near the head, alerts are only useful live
const BLOCK_FETCH = 10;          // blocks read in parallel each tick (one at a time could not keep up with the chain)
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
// wallet pings carry buys, sells, launches and HYPE moves from this size (small sends are how bundles get funded); plain token transfers are skipped
const WALLET_MIN_HYPE = Number(process.env.WALLET_MIN_HYPE || 0.2);
const DUST_USD = Number(process.env.DUST_USD || 5); // token moves worth less than this (reflections, airdrops, tax payouts) are not pinged
// group buys: several wallets of one group (wallets.json "group") buying the same coin close together
const GROUP_WINDOW_MIN = 30;
const GROUP_MIN_WALLETS = 2;     // inside a named group (hewd, marv, signal...)
const ANY_MIN_WALLETS = 3;       // across all tracked wallets, any group
// exit watch: groups that are a team or a cluster you hold against. Their moves come as one 🚨 alert per group with
// what the whole group still holds, and a coin they send to a fresh wallet is followed (the hop before a sell)
const EXIT_GROUPS = new Set(String(process.env.EXIT_GROUPS || 'eosteam,eosholder,standsteam').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// auto-tracking: a tracked wallet funding a fresh wallet
const FUND_MIN_HYPE = 0.2;
const FRESH_MAX_NONCE = 5;       // recipient has sent at most this many txs = fresh wallet
const BRIDGE_MIN_HYPE = Number(process.env.BRIDGE_MIN_HYPE || 25); // fresh wallet bridging in at least this much from HyperEVM: ping + track
const AUTO_MAX = 300;

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
// Elysium is an Arbitrum chain on HyperEVM: a bridge tx shows its HyperEVM sender here as sender + 0x1111…1111
const unalias = (a) => '0x' + ((BigInt(a) - 0x1111000000000000000000000000000000001111n + (1n << 160n)) % (1n << 160n)).toString(16).padStart(40, '0');
// v4 PoolManagers by launchpad (each launchpad runs its own; all pools are native HYPE / coin)
const LAUNCHPADS = {
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4': { name: 'BOXA', hook: '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc' },
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600': { name: 'elyspump', hook: '0xe11cafa5901b0aab51eb78251488400f9e4320cc' },
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490': { name: 'Kleos', hook: '0x0c835e6a51717a514144d95c7f0a1c640179e0cc' },
  '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da': { name: 'eleos', hook: '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc' }, // eleos.fun (partner-gated site)
};
const BOXA_PM = '0x06c63714fbf1f5753017123e2fcfdede4540b2c4';
const LP_NAMES = Object.values(LAUNCHPADS).map((x) => x.name).join(', ');
const WHYPE = new Set([
  '0x0269031ace34a7821e9d9980d087c35ce7c19eef', // Kleos v3
  '0xba876237b0f021a6c6d852d6c26e107997cc5e81', // Uniswap, BOXA v2, StockiumSwap
  '0x5ab377328592c03b5e7adb09254adb043f91fa11', // ElysPump v4 wrapped HYPE (1:1)
  '0x9f041fad8323d7c5bf8f928aade05b610df34b64', // bonding curve 0xfee8
]);
const isHype = (a) => a === ZERO || WHYPE.has(a);
// v4 pool → { t: coin, q: quote token, inv: 1 when the quote is currency1 }. Native HYPE and WHYPE pools are
// HYPE-quoted. A pool between two tokens (Kleos coins paired with BLOB) is quoted in the side that already has a
// HYPE price, so its trades are valued through that token instead of being read as HYPE.
function poolEntry(state, pm, c0, c1, b) {
  let q = c0, t = c1;
  if (isHype(c0)) { q = c0; t = c1; }
  else if (isHype(c1)) { q = c1; t = c0; }
  else if (!state.tok[c0]?.price && state.tok[c1]?.price) { q = c1; t = c0; }
  return { t, q, inv: q === c1 ? 1 : 0, lp: pm, b };
}
// trading-bot fee wallets (they take 1% of buys made through Multicall3): never followed as anyone's alt
const FEE_WALLETS = ['0x4e496d24aa8fe7e026163c481df726e9dc70b433', '0x058bc86a8262670f97e3dbcb3da789f452b2bf91'];
const INFRA = new Set([ZERO, DEAD, ...WHYPE, ...Object.keys(LAUNCHPADS), '0x000000000022d473030f116ddee9f6b43ac78ba3', ...FEE_WALLETS]);

const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_INIT_V4 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const T_SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const T_WITHDRAW = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'; // WHYPE unwrapped to HYPE

const STATE = new URL('./state.json', import.meta.url);
const WALLETS = new URL('./wallets.json', import.meta.url);
const MUTED = new URL('./muted.json', import.meta.url); // wallets silenced for good (bundlers); their auto-found alts go quiet with them
const MUTED_COINS = new URL('./muted_coins.json', import.meta.url); // coins never alerted: contract addresses, or symbols (every coin with that ticker)
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
const assetLink = (t, label = 'chart') => `<a href="${ELYXA}/#/terminal/${t}">${label}</a>`;
// wallets open on Elyxa's portfolio page; tx links go to Kinetiq's explorer (partner-only until public launch)
const EXPLORER = 'https://elysium.kinetiq.xyz/explorer';
const walletLink = (a, label) => `<a href="${ELYXA}/#/portfolio?w=${a}">${label || short(a)}</a>`;
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

async function getLogs(filter, from, to, span = LOG_RANGE) {
  const out = [];
  for (let s = from; s <= to; s += span) {
    const e = Math.min(to, s + span - 1);
    try {
      out.push(...await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16) }], 2));
    } catch (err) {
      // a node that times out on a busy range usually answers half of it: split down to ~25 blocks before giving up
      if (e - s < 25) throw err;
      const mid = Math.floor((s + e) / 2);
      out.push(...await getLogs(filter, s, mid, mid - s + 1), ...await getLogs(filter, mid + 1, e, e - mid));
    }
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

// buy buttons on an alert. With the VPS trade bot (TRADE_BOT_TOKEN) alerts come from that bot and a ⚡ tap
// buys right away from its burner wallet (callback b:<token>:<tenths of HYPE>, c:<token> opens its card).
// Without it, or if that bot cannot reach you, they open the quick-buy page prefilled (you sign in Rabby).
const BUY_SIZES = (process.env.BUY_SIZES || '1,2,3,5').split(',').map((s) => s.trim()).filter(Boolean);
const BUY_PAGE = process.env.BUY_PAGE || 'https://dnumber9.github.io/runup-watch/buy/';
const TRADE_TOKEN = process.env.TRADE_BOT_TOKEN;
const buyButtons = (chain, addr) => {
  if (chain !== 'e') return [{ text: 'Open on Stockium', url: `https://stockium.fun/token/${addr}` }];
  if (TRADE_TOKEN) return [...BUY_SIZES.map((h) => ({ text: `⚡ ${h}`, callback_data: `b:${addr.slice(2)}:${Math.round(Number(h) * 10)}` })), { text: '⚡ X', callback_data: `k:${addr.slice(2)}` }, { text: '🔎', callback_data: `c:${addr.slice(2)}` }];
  return BUY_SIZES.map((h) => ({ text: `⚡ Buy ${h} HYPE`, url: `${BUY_PAGE}?t=${addr}&a=${h}` }));
};
// the same buttons as links, for routes other than the trade bot (its callbacks only work there)
const asLinks = (buttons) => buttons.map((b) => {
  const m = String(b.callback_data || '').match(/^([bck]):([0-9a-f]{40})(?::(\d+))?$/);
  if (!m) return b;
  return { text: b.text, url: `${BUY_PAGE}?t=0x${m[2]}${m[3] ? `&a=${Number(m[3]) / 10}` : ''}` };
});
// Elyxa's terminal charts coins from every launchpad; quick buy stays as the one-tap route
const coinLink = (state, t) => `${assetLink(t, 'open on Elyxa')} · <a href="${BUY_PAGE}?t=${t}">quick buy</a>`;

// alerts go through the trade bot when it is set up, else the command bot (both set in main); the old bot is the fallback
let ALERT = null, TRADE = null;
async function tg(msg) {
  const text = typeof msg === 'string' ? msg : msg.text;
  const buttons0 = typeof msg === 'string' ? null : msg.buttons;
  const routes = [TRADE, ALERT, TG_TOKEN && TG_CHAT ? { token: TG_TOKEN, chat: TG_CHAT } : null].filter(Boolean);
  if (!routes.length) { console.log('[telegram]\n' + text + (buttons0 ? '\n[' + buttons0.map((b) => b.text).join('] [') + ']' : '') + '\n'); return; }
  for (const { token, chat, trade } of routes) {
    const buttons = buttons0 && !trade ? asLinks(buttons0) : buttons0;
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}) }),
      });
      if (r.ok) return;
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      console.error('telegram', r.status, await r.text());
      break; // try the next route
    }
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
// /api/index/tokens covers BOXA v4 launches; BOXA v2 (v3 pool) launches only answer on /api/tokens
async function boxaToken(t) {
  const a = lc(t);
  const j = await getJSON(`${BOXA}/api/index/tokens/${a}`);
  if (j?.token) return j.token;
  const k = await getJSON(`${BOXA}/api/tokens/${a}`);
  if (!k?.token) return null;
  const m = k.token.metadata || {};
  const hs = (k.holders || []).filter((h) => !h.excluded);
  const share = (h) => Number(h.sharePct) || 0;
  const cr = hs.find((h) => lc(h.address) === lc(k.token.creator));
  return {
    ...k.token,
    description: m.description, website: m.website, twitter: m.twitter, telegram: m.telegram,
    top10Pct: hs.length ? hs.slice(0, 10).reduce((s, h) => s + share(h), 0) : null,
    creatorPct: hs.length ? (cr ? share(cr) : 0) : null,
  };
}

async function socials(t) {
  const tok = await boxaToken(t);
  const found = { x: null, tg: null, web: null };
  const take = (u) => {
    if (!u || typeof u !== 'string') return;
    let s = u.trim();
    if (s && !/^https?:\/\//i.test(s) && /^(www\.)?(x\.com|twitter\.com|t\.me)\//i.test(s)) s = 'https://' + s; // BOXA stores some as bare t.me/…
    if (/x\.com\/|twitter\.com\//i.test(s)) found.x ||= s;
    else if (/t\.me\//i.test(s)) found.tg ||= s;
    else if (/^https?:\/\//i.test(s) && !/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(s) && !/b-cdn|ipfs|boxa\.(pro|club)/i.test(s)) found.web ||= s;
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
  // pool managers the gate identified as Ascend or Signal join the launchpad list
  for (const [pm, x] of Object.entries(gatePms(state))) if (!LAUNCHPADS[pm]) { LAUNCHPADS[pm] = { name: x.name, hook: x.hook }; INFRA.add(pm); }
  let wallets = [];
  try { wallets = JSON.parse(fs.readFileSync(WALLETS, 'utf8')); } catch {}
  const okW = wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address));
  const W = new Map(okW.map((w) => [lc(w.address), w.label || short(w.address)]));
  const G = new Map(okW.filter((w) => w.group).map((w) => [lc(w.address), String(w.group)]));
  // dev wallets watched for launches only (wallets.json "watch": "launch", "coins": the runners they made): a new coin,
  // a contract deploy, a bundle split, HYPE bridged in or 25+ HYPE moved, and sells of their own coins. Their routine
  // trading stays quiet; their group still counts toward group buys.
  const DEVW = new Map(okW.filter((w) => w.watch === 'launch').map((w) => [lc(w.address), new Set((w.coins || []).map(lc))]));
  // wallets the watcher found on its own (fresh wallets funded by tracked ones) live in state
  state.auto ||= {};
  state.gbuys ||= {};
  for (const a of FEE_WALLETS) delete state.auto[a]; // followed by mistake as an alt before the bot-fee pattern was known
  for (const [a, x] of Object.entries(state.auto)) {
    if (!W.has(a)) W.set(a, x.label);
    if (x.group && !G.has(a)) G.set(a, x.group);
  }
  // wallets added or removed from Telegram (/add, /remove) through the command bot
  state.manual ||= {};
  state.muted ||= {};
  try {
    for (const x of JSON.parse(fs.readFileSync(MUTED, 'utf8'))) {
      const a = lc(x?.address || x);
      if (/^0x[0-9a-f]{40}$/.test(a) && !state.manual[a]) state.muted[a] ||= now();
    }
  } catch {}
  try { await commands(state, W); } catch (e) { console.log('commands failed:', e.message); }
  const alertChat = state.cmdChat || (/^\d+$/.test(String(TG_CHAT || '')) ? TG_CHAT : null);
  if (CMD_TOKEN && alertChat) ALERT = { token: CMD_TOKEN, chat: alertChat };
  if (TRADE_TOKEN && alertChat) TRADE = { token: TRADE_TOKEN, chat: alertChat, trade: true };
  for (const [a, x] of Object.entries(state.manual)) {
    W.set(a, x.label);
    if (x.group) G.set(a, x.group); else G.delete(a);
  }
  // a muted wallet takes the alts it funded with it (alt of alt too), unless one was added back with /add or is named
  // in wallets.json (a muted bridge service funds plenty of wallets that are tracked for their own reasons)
  const listed = new Set(okW.map((w) => lc(w.address)));
  for (let more = true; more;) {
    more = false;
    for (const [a, x] of Object.entries(state.auto)) if (!state.muted[a] && !state.manual[a] && !listed.has(a) && state.muted[x.from]) { state.muted[a] = now(); more = true; }
  }
  for (const a of Object.keys(state.muted)) { W.delete(a); G.delete(a); }

  let head = parseInt(await rpc('eth_blockNumber', []), 16);
  // pool id → coin map: on first run read every pool ever created on the known launchpads.
  // v2 of the map also records each pool's quote side, so it is rebuilt once from the start.
  if (state.poolsV !== 2 || !Object.keys(state.pools).length) {
    const pools = {};
    for (const pm of Object.keys(LAUNCHPADS)) {
      const logs = await getLogs({ address: pm, topics: [T_INIT_V4] }, 0, head);
      for (const l of logs) {
        pools[lc(l.topics[1])] = poolEntry(state, pm, lc(topicAddr(l.topics[2])), lc(topicAddr(l.topics[3])), parseInt(l.blockNumber, 16));
      }
    }
    // pools from unknown PoolManagers seen live are kept (they are re-read from their own Initialize events)
    for (const [id, p] of Object.entries(state.pools)) if (!pools[id] && !LAUNCHPADS[p.lp]) pools[id] = p;
    state.pools = pools; state.poolsV = 2; // only once the whole index is in (a failed tick retries)
    console.log('pools indexed', Object.keys(state.pools).length);
  }

  let from = firstRun ? Math.max(1, head - FIRST_LOOKBACK) : Math.max(state.block + 1, head - MAX_BLOCKS);
  if (from > head) { console.log('no new blocks'); return; }
  // stay live: skip a stale backlog, and handle at most SCAN_MAX blocks per tick (state.block moves to the window end)
  const chainHead = head;
  if (chainHead - from > SKIP_LAG) { console.log(`behind by ${chainHead - from} blocks, skipping to the head`); from = chainHead - SCAN_MAX + 1; }
  head = Math.min(chainHead, from + SCAN_MAX - 1);
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
  let msgs = [];
  // alert tally for the log: counts by kind and by where the wallet came from (no addresses or names, the log is public)
  const repoSet = new Set(okW.map((w) => lc(w.address)));
  const srcOf = (w) => (state.manual[w] ? 'manual' : repoSet.has(w) ? 'repo' : !state.auto[w] ? 'other' : state.auto[w].from === 'bridge' ? 'bridger' : state.auto[w].from === 'cielo' ? 'cielo' : 'alt');
  const tally = {};
  const bump = (k, n = 1) => { tally[k] = (tally[k] || 0) + n; };

  // 1. new pools: launches on known launchpads, and unknown PoolManagers
  const launchTxs = [];
  for (const l of logs) {
    if (l.topics[0] !== T_INIT_V4) continue;
    const pm = lc(l.address);
    const entry = poolEntry(state, pm, lc(topicAddr(l.topics[2])), lc(topicAddr(l.topics[3])), parseInt(l.blockNumber, 16));
    const coin = entry.t;
    state.pools[lc(l.topics[1])] = entry;
    if (!LAUNCHPADS[pm]) {
      const u = (state.unknownPm[pm] ||= { n: 0, first: now(), alerted: 0 });
      u.n++;
      continue;
    }
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
    if (!u.alerted && u.n >= 3 && !firstRun && !gatePms(state)[pm]) {
      u.alerted = now();
      msgs.push(
        `🆕 <b>New launchpad pool contract on Elysium</b>\n` +
        `${u.n} new pools from a Uniswap v4 PoolManager that is not ${LP_NAMES}.\n` +
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
      const qd = Number(int256(p.inv ? w[1] : w[0])) / 1e18; // quote delta for the swapper: negative = paid = buy
      // a pool quoted in another token (a Kleos coin paired with BLOB) is valued through that token's HYPE price;
      // only HYPE-quoted swaps count as HYPE paid in the tx (a HYPE → BLOB → coin route then counts its HYPE once)
      const hypeQ = isHype(p.q ?? ZERO);
      const qPx = hypeQ ? 1 : state.tok[p.q]?.price || 0;
      const sqrt = BigInt('0x' + w[2]);
      const r = R(p.t);
      r.lp = p.lp;
      const h = Math.abs(qd) * qPx;
      r.vol += h; r.swaps++;
      if (qd < 0) { r.buyVol += h; r.buys++; if (hypeQ) txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + h; }
      if (sqrt > 0n && qPx > 0) {
        const ratio = Number((sqrt * sqrt * 10n ** 18n) >> 192n) / 1e18; // currency1 per currency0
        if (ratio > 0) r.price = (p.inv ? ratio : 1 / ratio) * qPx;        // HYPE per coin
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
          `<code>${t}</code>\n${coinLink(state, t)}`
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
      `${so.line}\n<code>${t}</code>\n${coinLink(state, t)}`
    );
    msgs[msgs.length - 1] = { text: msgs[msgs.length - 1], buttons: buyButtons('e', t) };
  }

  // 3b. every new block with its transactions, read once (tracked-wallet moves and Cielo arrivals both use them)
  // read in parallel and kept in block order
  const want = [];
  for (let b = Math.max(from, head - SCAN_MAX + 1); b <= head; b++) want.push(b);
  const got = new Array(want.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(BLOCK_FETCH, want.length) }, async () => {
    while (next < want.length) {
      const k = next++;
      try { got[k] = await rpc('eth_getBlockByNumber', ['0x' + want[k].toString(16), true]); } catch {}
    }
  }));
  const blocks = got.filter(Boolean);
  if (blocks.length < want.length) console.log(`blocks read ${blocks.length}/${want.length}`);

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
      bump('new/cielo');
      msgs.push(`🛬 <b>${esc(S.get(a))}</b> from your Cielo list is on Elysium\n${walletLink(a)} ${txt}\nNow tracking it.`);
    }
  }

  // 3d. a fresh wallet bridging in a lot of HYPE from HyperEVM: usually a launch or a snipe is coming.
  // One ping per wallet, then it is tracked like the others (its launch or buys show up in section 4).
  state.bridged ||= {};
  for (const [a, t] of Object.entries(state.bridged)) if (now() - t > 14 * 86400) delete state.bridged[a];
  const bigIns = [];
  for (const blk of blocks) {
    for (const tx of blk.transactions || []) {
      if (String(tx.type).toLowerCase() !== '0x64') continue; // Arbitrum deposit tx = HYPE arriving over the bridge
      const to = lc(tx.to);
      const val = Number(BigInt(tx.value || '0x0')) / 1e18;
      if (to && val >= BRIDGE_MIN_HYPE && !W.has(to) && !INFRA.has(to) && !state.bridged[to] && !state.muted[to]) bigIns.push({ to, val, hash: tx.hash });
    }
  }
  for (const x of bigIns.slice(0, 8)) {
    if (Object.keys(state.auto).length >= AUTO_MAX) break;
    try {
      const [code, nonce] = await Promise.all([rpc('eth_getCode', [x.to, 'latest']), rpc('eth_getTransactionCount', [x.to, 'latest'])]);
      state.bridged[x.to] = now();
      if (code && code !== '0x') continue;
      const n = parseInt(nonce, 16);
      if (n > FRESH_MAX_NONCE) continue;
      const label = `bridger ${Math.round(x.val)} ${x.to.slice(2, 6)}`;
      state.auto[x.to] = { label, group: null, from: 'bridge', t: now(), hype: x.val };
      W.set(x.to, label);
      bump('new/bridger');
      msgs.push(
        `🌉 <b>Fresh wallet bridged in ${hype(x.val)}</b>${px ? ` (${usd(x.val * px)})` : ''} from HyperEVM\n` +
        `${walletLink(x.to)} · ${n} txs so far${txLink(x.hash)}\n` +
        `Now tracking it as <b>${esc(label)}</b>, so a launch or buy from it pings you.`
      );
    } catch {}
  }

  // 3e. launch-watched devs that have never been on Elysium (the old HyperCore and HyperEVM meme devs): each is
  // checked once, so its first move here leads its alert (🛬). 0 = never here yet, 1 = already active when first checked
  state.devHere ||= {};
  if (state.hyper) for (const k of ['tokens', 'nonces', 'at']) delete state.hyper[k]; // left by the old HyperCore/HyperEVM deploy watch
  for (const a of [...DEVW.keys()].filter((x) => !(x in state.devHere)).slice(0, 8)) {
    try {
      const [n, b] = await Promise.all([rpc('eth_getTransactionCount', [a, 'latest']), rpc('eth_getBalance', [a, 'latest'])]);
      state.devHere[a] = parseInt(n, 16) > 0 || BigInt(b || '0x0') > 0n ? 1 : 0;
    } catch {}
  }

  // trades the fast lane (watch.mjs --fast) already sent: their 👛 lines are skipped here, group buys still count them.
  // Only trusted while that lane is alive (fast.json written in the last 5 minutes).
  let fast = null;
  try { fast = JSON.parse(fs.readFileSync(FAST, 'utf8')); if (now() - (fast.at || 0) > 300) fast = null; } catch {}
  const fastSent = fast?.sent || {};

  // 4. tracked wallets
  if (W.size) {
    const moves = {};
    const M = (w) => (moves[w] ||= []);
    const lastBuy = {}; // wallet → the coin it bought or launched last in this scan (gets the ⚡ buttons)
    // contract calls sent by tracked wallets: HYPE paid into a router (v3/v2 forks, aggregators) with a token arriving
    // in the same tx is a buy, and a token leaving through a router call is a sell; the HYPE payment itself is then
    // not reported again as "sent"
    const paidIn = {}, routerCall = {}, boughtTx = new Set();
    // exit watch tallies: group → coin → amounts sold / moved out, and coins sent to plain wallets (followed below)
    const exitOf = (w) => (EXIT_GROUPS.has(String(G.get(w) || '').toLowerCase()) ? G.get(w) : null);
    const exitAgg = {}, hops = [], exitRows = {};
    // txs with a swap in them (v2, v3, v4 pools, a curve sell, or WHYPE unwrapped): a token leaving there was sold
    const SWAPS = new Set([T_SWAP_V2, T_SWAP_V3, T_SWAP_V4, T_SOLD, T_WITHDRAW]);
    const swapTx = new Set(logs.filter((l) => SWAPS.has(l.topics[0])).map((l) => l.transactionHash));
    // recipient is a contract or a plain wallet (asked once per address per scan)
    const codeCache = {};
    const isContract = async (a) => {
      if (!(a in codeCache)) { try { const c = await rpc('eth_getCode', [a, 'latest']); codeCache[a] = !!c && c !== '0x'; } catch { codeCache[a] = null; } }
      return codeCache[a];
    };
    for (const blk of blocks) for (const tx of blk.transactions || []) {
      if (!tx.to || (tx.input || '0x') === '0x' || !W.has(lc(tx.from))) continue;
      routerCall[tx.hash] = lc(tx.to);
      const v = Number(BigInt(tx.value || '0x0')) / 1e18;
      if (v > 0) paidIn[tx.hash] = v;
    }
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
      const paidH = txBuy[l.transactionHash] || paidIn[l.transactionHash] || null;
      const shown = val ?? (W.has(to) ? paidH : null);
      const valTxt = shown != null ? ` (~${px ? usd(shown * px) : hype(shown)})` : '';
      // dust filter: skip moves known to be worth under DUST_USD (unpriced moves still show)
      const usdOf = (h) => (h == null ? null : px ? h * px : h * 50);
      const dustIn = (usdOf(paidH || val) ?? Infinity) < DUST_USD;
      const dustOut = (usdOf(val) ?? Infinity) < DUST_USD;
      if (W.has(to) && !dustIn) {
        const kind = poolOut.has(f) || txBuy[l.transactionHash] || (paidIn[l.transactionHash] && f !== ZERO) ? 'bought' : f === ZERO ? 'minted' : 'received';
        if (kind === 'bought') boughtTx.add(l.transactionHash);
        const sentFast = kind === 'bought' && !!fastSent[`${l.transactionHash}|${to}|${t}`];
        // plain token transfers (received, minted) are not pinged, only buys
        if (kind === 'bought' && !sentFast) M(to).push(`bought ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${valTxt} · ${assetLink(t, 'chart')}${txLink(l.transactionHash)}${HOLD(to, t)}`);
        if (kind === 'bought') {
          if (!sentFast) lastBuy[to] = t;
          const paid = paidH || val || 0;
          for (const g of [G.get(to), '*'].filter(Boolean)) {
            const k = g + '|' + t;
            (state.gbuys[k] ||= []).push({ w: to, t: now(), h: paid });
          }
        }
      }
      if (W.has(f) && !dustOut) {
        // sold: into a pool, or through a router call in a tx that has a swap. Otherwise, by where it went:
        // into a contract (LP, locker, bridge, vault) or to a plain wallet (often a dev moving supply to an alt)
        const viaRouter = routerCall[l.transactionHash] && routerCall[l.transactionHash] !== t && swapTx.has(l.transactionHash) && !W.has(to) && to !== ZERO && to !== DEAD;
        const kind = poolOut.has(to) || viaRouter ? 'sold' : to === ZERO || to === DEAD ? 'burned' : 'sent';
        const where = W.has(to) ? `${walletLink(to)} (${esc(W.get(to))})` : walletLink(to);
        if (kind === 'sold' && !fastSent[`${l.transactionHash}|${f}|${t}`]) M(f).push(`sold ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${valTxt} · ${assetLink(t, 'chart')}${txLink(l.transactionHash)}${HOLD(f, t)}`);
        else if (kind === 'sent') {
          const c = await isContract(to);
          if (c) M(f).push(`moved ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${valTxt} into a contract ${where} (no swap: LP, lock, bridge or vault) · ${assetLink(t, 'chart')}${txLink(l.transactionHash)}${HOLD(f, t)}`);
          else M(f).push(`sent ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${valTxt} to wallet ${where} · ${assetLink(t, 'chart')}${txLink(l.transactionHash)}${HOLD(f, t)}`);
          if (c === false && exitOf(f) && !W.has(to)) hops.push({ f, to, t, hash: l.transactionHash });
        }
        const eg = exitOf(f);
        if (eg && kind !== 'burned' && !(W.has(to) && exitOf(to) === eg)) {
          const a = ((exitAgg[eg] ||= {})[t] ||= { sold: 0, soldV: 0, moved: 0, ws: new Set() });
          if (kind === 'sold') { a.sold += amt; a.soldV += val || 0; } else a.moved += amt;
          a.ws.add(f);
        }
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
        // HYPE split through a batch contract (Multicall3 aggregate3Value, Disperse disperseEther): one line for the split, then follow each recipient
        const batch = W.has(f) && val > 0 && (tx.input || '0x') !== '0x' ? batchSends(tx.input) : [];
        if (batch.calls) batch.length = 0; // a swap with a bot's fee beside it: a buy, shown from its token logs
        if (W.has(f) && batch.length >= 2) M(f).push(`<b>split ${hype(val)} across ${batch.length} wallets in one tx</b> (bundle funding pattern)${txLink(tx.hash)}`);
        else if (W.has(f) && val >= WALLET_MIN_HYPE && to && !boughtTx.has(tx.hash)) M(f).push(`sent ${hype(val)}${px ? ` (${usd(val * px)})` : ''} to ${walletLink(to)}${W.has(to) ? ` (${esc(W.get(to))})` : ''}${txLink(tx.hash)}`);
        if (W.has(f) && to && !W.has(to) && !INFRA.has(to) && val >= FUND_MIN_HYPE && (tx.input || '0x') === '0x') funded.push({ f, to, val, hash: tx.hash });
        for (const x of batch) {
          if (x.val >= FUND_MIN_HYPE && !W.has(x.to) && !INFRA.has(x.to)) funded.push({ f, to: x.to, val: x.val, hash: tx.hash, via: 'batch' });
        }
        // Arbitrum-style deposit types (0x64 deposit, 0x65 unsigned, 0x68 retry, 0x69 retryable) = HYPE bridged in from HyperEVM
        const bridged = ['0x64', '0x65', '0x68', '0x69'].includes(String(tx.type).toLowerCase());
        // a tracked wallet bridging from HyperEVM to a different wallet (a retryable ticket): the sender shows aliased,
        // so the recipient is followed like any fresh wallet it funds (a dev setting up a launch wallet)
        if (bridged && to && val > 0 && ['0x64', '0x68'].includes(String(tx.type).toLowerCase())) {
          const src = unalias(f);
          if (src !== to && W.has(src) && !W.has(to) && !INFRA.has(to)) {
            M(src).push(`🌉 <b>bridged ${hype(val)}</b>${px ? ` (${usd(val * px)})` : ''} from HyperEVM to another wallet ${walletLink(to)}${txLink(tx.hash)}`);
            funded.push({ f: src, to, val, hash: tx.hash, via: 'bridge' });
          }
        }
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
        const label = `${W.get(x.f).replace(/\s*\(.*\)$/, '')} alt ${x.to.slice(2, 6)}`;
        state.auto[x.to] = { label, group, from: x.f, t: now(), hype: x.val };
        W.set(x.to, label);
        if (group) G.set(x.to, group);
        bump('new/alt');
        msgs.push(
          `🧬 <b>${esc(W.get(x.f))}</b> funded a fresh wallet\n` +
          `${walletLink(x.to)} got ${hype(x.val)}${px ? ` (${usd(x.val * px)})` : ''}${x.via === 'batch' ? ' (split in one batch tx)' : x.via === 'bridge' ? ' over the bridge from HyperEVM' : ''} · it has sent ${n} txs so far${txLink(x.hash)}\n` +
          `Now tracking it as <b>${esc(label)}</b>.`
        );
      } catch {}
    }
    // exit watch: a coin sent from a watched group to a fresh plain wallet is the usual hop before a sell, so follow that wallet
    for (const x of hops.slice(0, 20)) {
      if (W.has(x.to) || Object.keys(state.auto).length >= AUTO_MAX) continue;
      try {
        const n = parseInt(await rpc('eth_getTransactionCount', [x.to, 'latest']), 16);
        if (n > FRESH_MAX_NONCE) continue;
        const group = G.get(x.f);
        const label = `${W.get(x.f).replace(/\s*\(.*\)$/, '')} hop ${x.to.slice(2, 6)}`;
        state.auto[x.to] = { label, group, from: x.f, t: now(), coin: x.t };
        W.set(x.to, label);
        G.set(x.to, group);
        bump('new/hop');
        M(x.f).push(`↳ now following ${walletLink(x.to)} as <b>${esc(label)}</b> (fresh wallet, ${n} txs, its next move is the tell)`);
      } catch {}
    }
    for (const { coin, tx: lt } of launchTxs) {
      const c = state.tok[coin]?.creator;
      if (c && W.has(c)) {
        lastBuy[c] = coin;
        const meta = await tokenMeta(state, coin);
        M(c).push(`launched <b>${esc(meta.s)}</b> (${esc(meta.n)}) on ${LAUNCHPADS[state.tok[coin].lp]?.name || '?'} · <code>${coin}</code> · ${assetLink(coin, 'chart')} · <a href="${BUY_PAGE}?t=${coin}">⚡ buy</a>${txLink(lt)}`);
      }
    }
    // what each wallet still holds of the coins it moved (last placeholder per wallet+coin gets the line)
    const held = {};
    for (const k of [...new Set(Object.values(moves).flat().join('').match(/\u0000H:[^\u0000]+\u0000/g) || [])].slice(0, 40)) {
      const [, w, t] = k.slice(1, -1).split(':');
      try {
        const meta = await tokenMeta(state, t);
        const bal = Number(BigInt(await rpc('eth_call', [{ to: t, data: '0x70a08231' + w.slice(2).padStart(64, '0') }, 'latest']))) / 10 ** meta.d;
        const price = state.tok[t]?.price;
        held[k] = holdLine(bal, meta, price ? bal * price : null, px);
      } catch { held[k] = ''; }
    }
    // a dev landing on Elysium for the first time: the alert opens with it and keeps every line (even small receives)
    const landed = new Set();
    for (const w of DEVW.keys()) {
      if (!moves[w]?.length || state.devHere[w] !== 0) continue;
      state.devHere[w] = 1;
      landed.add(w);
      moves[w].unshift('🛬 <b>first move on Elysium</b> (never active here before)');
    }
    for (const [w, own] of DEVW) {
      if (!moves[w] || landed.has(w)) continue;
      moves[w] = moves[w].filter((x) => {
        if (/^(launched|deployed a contract|<b>split|🌉)/.test(x)) return true;
        const big = /^(?:sent|received) ([\d.]+)(K?) HYPE/.exec(x);
        if (big) return Number(big[1]) * (big[2] ? 1000 : 1) >= 25;
        const t = /^sold .*?#\/terminal\/(0x[0-9a-fA-F]{40})/.exec(x)?.[1];
        return !!t && (own.has(lc(t)) || lc(state.tok[lc(t)]?.creator || state.tok[t]?.creator || '') === w);
      });
    }
    for (const [w, list] of Object.entries(moves)) {
      if (!list.length) continue;
      const seen = new Set();
      for (let i = list.length - 1; i >= 0; i--) {
        list[i] = list[i].replace(/\u0000H:[^\u0000]+\u0000/g, (k) => (seen.has(k) ? '' : (seen.add(k), held[k] || '')));
      }
      const src = srcOf(w);
      bump('wallet/' + src);
      const trades = list.filter((x) => /^(bought|sold|launched)/.test(x)).length;
      bump('trade/' + src, trades);
      bump('xfer/' + src, list.length - trades);
      // exit-watch groups go out together below, one alert per group
      const eg = exitOf(w);
      if (eg) { (exitRows[eg] ||= []).push({ w, list }); continue; }
      const text = `👛 <b>${esc(W.get(w))}</b> · ${walletLink(w)}\n` + list.slice(0, 12).map((x) => '• ' + x).join('\n') + (list.length > 12 ? `\n…and ${list.length - 12} more` : '');
      // ⚡ buttons for the coin it just bought or launched (one tap through the trade bot when it is set up)
      msgs.push(lastBuy[w] ? { text, buttons: buyButtons('e', lastBuy[w]) } : text);
    }
    // exit watch: one alert per group, headed by what it sold or moved out and what the whole group still holds
    for (const [g, items] of Object.entries(exitRows)) {
      const members = [...G].filter(([, x]) => x === g).map(([a]) => a);
      const head = [];
      for (const [t, a] of Object.entries(exitAgg[g] || {})) {
        const meta = await tokenMeta(state, t);
        let left = null;
        try {
          const bals = await Promise.all(members.map((m) => rpc('eth_call', [{ to: t, data: '0x70a08231' + m.slice(2).padStart(64, '0') }, 'latest']).catch(() => null)));
          left = bals.reduce((s, b) => s + (b && b !== '0x' ? Number(BigInt(b)) / 10 ** meta.d : 0), 0);
        } catch {}
        const pct = (x) => (meta.supply ? ` (${(x / meta.supply * 100).toFixed(2)}% of supply)` : '');
        const price = state.tok[t]?.price;
        const v = (h) => (h ? ` ~${px ? usd(h * px) : hype(h)}` : '');
        const did = [
          a.sold ? `sold ${fmtAmt(a.sold)}${pct(a.sold)}${v(a.soldV)}` : '',
          a.moved ? `moved ${fmtAmt(a.moved)}${pct(a.moved)} out to other wallets or contracts` : '',
        ].filter(Boolean).join(', ');
        head.push(`<b>${esc(meta.s)}</b> · ${a.ws.size} wallet${a.ws.size > 1 ? 's' : ''} ${did}` +
          (left != null ? `\n${esc(g)} still holds <b>${fmtAmt(left)}${pct(left)}</b>${v(price ? left * price : 0)}` : '') + ` · ${assetLink(t, 'chart')}`);
      }
      const selling = Object.values(exitAgg[g] || {}).some((a) => a.sold > 0);
      const icon = selling ? '🚨' : '👀';
      let cur = `${icon} <b>${esc(g)} ${selling ? 'selling' : 'moving'}</b> · ${items.length} of ${members.length} wallets` + (head.length ? '\n' + head.join('\n') : '');
      for (const { w, list } of items) {
        const block = `\n\n👛 <b>${esc(W.get(w))}</b> · ${walletLink(w)}\n` + list.slice(0, 6).map((x) => '• ' + x).join('\n') + (list.length > 6 ? `\n…and ${list.length - 6} more` : '');
        if (cur.length + block.length > 3800) { msgs.push(cur); cur = `${icon} <b>${esc(g)}</b> (continued)`; }
        cur += block;
      }
      msgs.push(cur);
      bump('exit/' + g);
    }
  }

  // 4c. Stockium curves on HyperEVM: tracked wallets trading them, tracked devs launching, early traction
  try { await stockium(state, W, G, msgs, px); } catch (e) { console.log('stockium scan failed:', e.message); }

  // 4b. group buys: 2+ wallets of one group (or 3+ tracked wallets of any group) into the same coin within the window.
  // One owner, one count: a wallet and the alts it funded are one buyer, so a bundler's 15 alts are 1, not 15.
  const rootOf = (w) => {
    let r = w;
    for (let i = 0; i < 8; i++) { const f = state.auto[r]?.from; if (!/^0x[0-9a-f]{40}$/.test(f || '') || f === r) break; r = f; }
    return r;
  };
  for (const [k, list] of Object.entries(state.gbuys)) {
    const recent = list.filter((x) => now() - x.t <= GROUP_WINDOW_MIN * 60 && !state.muted[x.w]);
    if (!recent.length) { delete state.gbuys[k]; continue; }
    state.gbuys[k] = recent.slice(-50);
    const [g, t] = k.split('|');
    const byW = {};
    for (const x of recent) byW[x.w] = (byW[x.w] || 0) + x.h;
    const fam = {};
    for (const [w, h] of Object.entries(byW)) { const r = rootOf(w); (fam[r] ||= { ws: [], h: 0 }); fam[r].ws.push(w); fam[r].h += h; }
    const n = Object.keys(fam).length;      // distinct owners
    const nW = Object.keys(byW).length;     // wallets
    if (n < (g === '*' ? ANY_MIN_WALLETS : GROUP_MIN_WALLETS)) continue;
    const key = 'g:' + k;
    const prevN = state.alerted[key]?.n || 0;
    if (!due(state, key) && n <= prevN) continue; // re-ping inside the cooldown only when more wallets pile in
    if (g === '*' && Object.keys(byW).every((w) => G.get(w) && G.get(w) === G.get(Object.keys(byW)[0]))) continue; // same group already pinged
    const fa = fast?.alerted?.[key]; // the fast lane already sent this group buy
    if (fa && now() - fa.t <= COOLDOWN_H * 3600 && n <= (fa.n || 0)) { state.alerted[key] = { t: fa.t, n: fa.n }; continue; }
    state.alerted[key] = { t: now(), n };
    const tot = Object.values(byW).reduce((a, b) => a + b, 0);
    const span = Math.max(1, Math.round((Math.max(...recent.map((x) => x.t)) - Math.min(...recent.map((x) => x.t))) / 60));
    const onCurve = t.startsWith('h:');
    const cv = onCurve ? state.hyper?.curves?.[t.slice(2)] : null;
    const meta = onCurve ? { s: cv?.s || '???' } : await tokenMeta(state, t);
    const rec = onCurve ? null : state.tok[t];
    const mcH = onCurve ? cv?.mc : rec?.price && meta.supply ? rec.price * meta.supply : null;
    msgs.push(
      `🎯 <b>${g === '*' ? `${n} tracked ${nW > n ? `buyers (${nW} wallets)` : 'wallets'}` : `${esc(g)} group, ${n} ${nW > n ? `buyers (${nW} wallets)` : 'wallets'}`}</b> bought <b>${esc(meta.s)}</b>${onCurve ? ' on its Stockium curve (HyperEVM)' : ''} within ${span} min\n` +
      `${tot > 0 ? `${hype(tot)}${px ? ` (${usd(tot * px)})` : ''} in` : ''}${mcH ? ` · MC ${px ? usd(mcH * px) : hype(mcH)}` : ''}\n` +
      Object.entries(fam).map(([r, f]) => {
        const name = esc(W.get(r) || state.auto[r]?.label || short(r));
        const amt = f.h > 0 ? ` ${hype(f.h)}` : '';
        if (f.ws.length === 1) return `• ${walletLink(f.ws[0], esc(W.get(f.ws[0]) || short(f.ws[0])))}${amt}`;
        const alts = f.ws.filter((w) => w !== r).length;
        return f.ws.includes(r) ? `• ${walletLink(r, name)} + ${alts} of its alts${amt}` : `• ${alts} alts of ${walletLink(r, name)}${amt}`;
      }).join('\n') +
      (onCurve ? `\n<code>${cv?.token || t.slice(2)}</code>\n<a href="https://stockium.fun/token/${t.slice(2)}">open on Stockium</a>` : `\n<code>${t}</code>\n${coinLink(state, t)}`)
    );
    msgs[msgs.length - 1] = { text: msgs[msgs.length - 1], buttons: buyButtons(t.startsWith('h:') ? 'h' : 'e', t.replace(/^h:/, '')) };
  }

  // 4d. Ascend and Signal going live: new contracts fingerprinted, team wallets, their pools, off-chain tells (gate.mjs)
  try {
    await gate({ state, logs, blocks, from, head, rpc, getLogs, hrpc, msgs, known: new Set(Object.keys(LAUNCHPADS)), buttons: (t) => buyButtons('e', t) });
  } catch (e) { console.log('gate failed:', e.message); }

  // 4e. LayerZero's Zero being wired ahead of its Nov 30 launch (zero.mjs keeps its own timers)
  try { await zeroWatch({ state, msgs }); } catch (e) { console.log('zero watch failed:', e.message); }

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
      lines.push(`${lines.length + 1}. ${assetLink(t, esc(m.s))} · MC ${mc ? (px ? usd(mc * px) : hype(mc)) : 'n/a'} · ${px ? usd(r.dvol * px) : hype(r.dvol)} vol · ${LAUNCHPADS[r.lp]?.name || 'Uniswap'}`);
    }
    const launches = {};
    for (const r of Object.values(state.tok)) if (r.born && r.born >= since) launches[LAUNCHPADS[r.lp]?.name || 'other'] = (launches[LAUNCHPADS[r.lp]?.name || 'other'] || 0) + 1;
    msgs.push(
      `📊 <b>Elysium, last ${Math.round(span)}h</b>${px ? ` · HYPE $${px.toFixed(2)}` : ''}\n` +
      `New coins: ${Object.entries(launches).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n` +
      (lines.length ? lines.join('\n') : 'No trading recorded.') +
      (state.gate ? `\n${gateDigest(state)}` : '')
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
      `Watching ${Object.keys(state.pools).length} pools across ${LP_NAMES}, plus Uniswap v3 HYPE pairs.\n` +
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
  writeAtomic(STATE, JSON.stringify(state)); // the fast lane reads this file while this scan runs
  const cm = coinMutes(state);
  const before = msgs.length;
  msgs = dropMutedCoins(msgs, cm);
  if (before > msgs.length) bump('muted coin', before - msgs.length);
  for (const m of msgs) await tg(m);
  const tallied = Object.entries(tally).filter(([k]) => /^(wallet|new)\//.test(k)).reduce((s, [, v]) => s + v, 0);
  if (msgs.length > tallied) bump('other', msgs.length - tallied);
  const autoBy = {};
  for (const x of Object.values(state.auto)) { const k = x.from === 'bridge' || x.from === 'cielo' ? x.from : 'alt'; autoBy[k] = (autoBy[k] || 0) + 1; }
  const kinds = Object.entries(tally).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  const heads = {};
  for (const m of msgs) { const h = [...String(typeof m === 'string' ? m : m.text || '').trim()][0] || '?'; heads[h] = (heads[h] || 0) + 1; }
  console.log(`done: ${Object.keys(roll).length} coins traded, ${launchTxs.length} launches, ${msgs.length} alerts · gate ${Object.keys(state.gate?.refs || {}).length} refs, ${state.gate?.q?.length || 0} queued · kinds ${kinds || 'none'} · auto ${Object.entries(autoBy).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} · manual ${Object.keys(state.manual).length} · by icon ${Object.entries(heads).map(([k, v]) => `${k}${v}`).join(' ') || 'none'}`);
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
      (moves[who] ||= []).push(`${buy ? 'bought' : 'sold'} <b>${esc(info.s || '???')}</b> for ${hype(amt)}${px ? ` (${usd(amt * px)})` : ''} on its Stockium curve · ${stockiumLink(curve, 'chart')} · <a href="https://hyperevmscan.io/tx/${l.transactionHash}">tx</a>${HOLD(who, curve)}`);
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
  // remaining balance on the curve token (1B supply; curve spot price for value)
  const held = {};
  for (const k of [...new Set(Object.values(moves).flat().join('').match(/\u0000H:[^\u0000]+\u0000/g) || [])].slice(0, 15)) {
    const [, w, c] = k.slice(1, -1).split(':');
    const rec = H.curves[c];
    try {
      if (!rec?.token) throw 0;
      const bal = Number(BigInt(await hrpc('eth_call', [{ to: rec.token, data: '0x70a08231' + w.slice(2).padStart(64, '0') }, 'latest']))) / 1e18;
      held[k] = holdLine(bal, { supply: 1e9 }, rec.mc ? bal / 1e9 * rec.mc : null, px);
    } catch { held[k] = ''; }
  }
  for (const [w, list] of Object.entries(moves)) {
    const seen = new Set();
    for (let i = list.length - 1; i >= 0; i--) list[i] = list[i].replace(/\u0000H:[^\u0000]+\u0000/g, (k) => (seen.has(k) ? '' : (seen.add(k), held[k] || '')));
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

// ── muted coins: never alerted, from muted_coins.json (repo) and /mutecoin (Telegram) ──────────────
// A key is a contract address (that coin only) or a symbol (every coin with that ticker, e.g. all the BLOBs).
// /unmutecoin also overrides a key listed in the repo file.
function coinMutes(state) {
  state.mutedCoins ||= {};
  state.unmutedCoins ||= {};
  let repo = [];
  try { repo = JSON.parse(fs.readFileSync(MUTED_COINS, 'utf8')); } catch {}
  const keys = new Set([...repo.map((x) => coinKey(x?.coin || x)), ...Object.keys(state.mutedCoins)].filter(Boolean));
  for (const k of Object.keys(state.unmutedCoins)) keys.delete(k);
  const addrs = new Set(), syms = new Set();
  for (const k of keys) (/^0x[0-9a-f]{40}$/.test(k) ? addrs : syms).add(k);
  return { addrs, syms, repo: new Set(repo.map((x) => coinKey(x?.coin || x)).filter(Boolean)) };
}
// address → lowercase; symbol → upper case without a leading $
function coinKey(x) {
  const s = String(x || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  const sym = s.replace(/^\$/, '').toUpperCase();
  return sym && sym.length <= 20 && !/\s/.test(sym) ? sym : null;
}
// Drops alerts about muted coins. A wallet alert (👛) loses only the lines about the muted coin and goes out if
// anything else is left; every other alert is about one coin, so it goes entirely.
function dropMutedCoins(msgs, cm) {
  if (!cm.addrs.size && !cm.syms.size) return msgs;
  const symTags = [...cm.syms].map((s) => `<b>${esc(s).toLowerCase()}</b>`);
  const hit = (s) => {
    const l = String(s || '').toLowerCase();
    for (const a of cm.addrs) if (l.includes(a) || l.includes(a.slice(2))) return true;
    return symTags.some((t) => l.includes(t));
  };
  const out = [];
  for (const m of msgs) {
    const text = typeof m === 'string' ? m : m.text || '';
    const btnHit = typeof m === 'object' && m.buttons ? hit(JSON.stringify(m.buttons)) : false;
    if (text.startsWith('👛')) {
      const [head, ...lines] = text.split('\n');
      // a line's continuation (its "↳ holds" line) goes with it, so a muted coin's buy never leaves its holds behind
      const groups = [];
      for (const x of lines) { if (groups.length && !/^(• |…and \d+ more$)/.test(x)) groups[groups.length - 1].push(x); else groups.push([x]); }
      const keep = groups.filter((g) => !g.some(hit)).flat();
      if (!keep.length || keep.every((x) => /^…and \d+ more$/.test(x))) continue;
      const t2 = [head, ...keep].join('\n');
      out.push(typeof m === 'string' ? t2 : btnHit ? t2 : { ...m, text: t2 });
      continue;
    }
    if (hit(text) || btnHit) continue;
    out.push(m);
  }
  return out;
}

// ── Telegram commands on the separate command bot (WATCH_BOT_TOKEN), checked once per scan ─────────
// /add <address> [label] [group]   /remove <address>   /list   /export   /help
// Only your own chat is obeyed (TELEGRAM_CHAT_ID). If that id is a group, the first person to message
// the command bot becomes its owner.
const CMD_TOKEN = process.env.WATCH_BOT_TOKEN;
async function cmdApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${CMD_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return r.json();
}
async function commands(state, W) {
  if (!CMD_TOKEN) return;
  const up = await cmdApi('getUpdates', { offset: state.cmdOffset || 0, timeout: 0, allowed_updates: ['message'] });
  if (!up.ok) { console.log('command bot:', up.description); return; }
  for (const u of up.result || []) {
    state.cmdOffset = u.update_id + 1;
    const m = u.message;
    if (!m?.text) continue;
    const from = String(m.from?.id), chat = String(m.chat.id);
    if (!state.cmdOwner && String(TG_CHAT || '').startsWith('-') && m.chat.type === 'private') state.cmdOwner = from;
    if (from !== String(TG_CHAT) && chat !== String(TG_CHAT) && from !== state.cmdOwner) continue;
    state.cmdChat = m.chat.id; // alerts follow you to the command bot
    const reply = async (text) => {
      for (let i = 0; i < text.length; i += 3900) {
        await cmdApi('sendMessage', { chat_id: m.chat.id, text: text.slice(i, i + 3900), parse_mode: 'HTML', disable_web_page_preview: true });
      }
    };
    try { await reply(runCommand(state, W, m.text.trim())); } catch (e) { console.log('command reply failed:', e.message); }
  }
}
function runCommand(state, W, text) {
  const [cmd0, ...rest] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@\S+$/, '');
  const groups = new Set([
    'hewd', 'marv', 'signal', 'dev', 'smart', 'cielo',
    ...Object.values(state.manual).map((x) => x.group).filter(Boolean),
    ...Object.values(state.auto).map((x) => x.group).filter(Boolean),
  ]);
  if (cmd === '/add') {
    const a = lc(rest.shift() || '');
    if (!/^0x[0-9a-f]{40}$/.test(a)) return 'Usage: /add 0x… label group\nGroup is optional: hewd, marv, smart, dev, signal, or #anynewname';
    let group = null;
    const last = rest[rest.length - 1];
    if (last?.startsWith('#')) group = rest.pop().slice(1).toLowerCase();
    else if (rest.length > 1 && groups.has(last.toLowerCase())) group = rest.pop().toLowerCase();
    const label = rest.join(' ').slice(0, 60) || short(a);
    const was = W.has(a) && !state.manual[a];
    state.manual[a] = { label, group, t: now() };
    delete state.muted[a];
    W.set(a, label);
    return `✅ Tracking <b>${esc(label)}</b>${group ? ` in <b>${esc(group)}</b>` : ''}\n<code>${a}</code>${was ? '\n(it was already tracked, label and group updated)' : ''}`;
  }
  if (cmd === '/remove' || cmd === '/rm') {
    // one or many addresses: /remove 0xa 0xb 0xc (spaces or new lines)
    const list = [...new Set(rest.map(lc).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
    if (!list.length) return 'Usage: /remove 0x… (several addresses in one message is fine)';
    const gone = [], missing = [];
    for (const a of list) {
      const label = state.manual[a]?.label || W.get(a);
      if (!label) { missing.push(a); continue; }
      delete state.manual[a];
      state.muted[a] = now(); // also silences wallets from wallets.json or auto-tracking
      W.delete(a);
      gone.push(`${esc(label)} <code>${short(a)}</code>`);
    }
    return (gone.length ? `🗑 Stopped tracking ${gone.length}:\n${gone.slice(0, 60).join('\n')}${gone.length > 60 ? `\n…and ${gone.length - 60} more` : ''}` : '') +
      (missing.length ? `${gone.length ? '\n\n' : ''}Not tracked: ${missing.length}` : '');
  }
  if (cmd === '/mutecoin' || cmd === '/unmutecoin') {
    // one or many: /mutecoin BLOB 0xabc… $FOO
    const keys = [...new Set(rest.map(coinKey).filter(Boolean))];
    if (!keys.length) return `Usage: ${cmd} 0x… or SYMBOL (several in one message is fine)\nA symbol mutes every coin with that ticker; an address mutes that coin only.`;
    state.mutedCoins ||= {};
    state.unmutedCoins ||= {};
    const name = (k) => (/^0x/.test(k) ? `${state.meta?.[k]?.s ? `<b>${esc(state.meta[k].s)}</b> ` : ''}<code>${k}</code>` : `<b>${esc(k)}</b> (every coin with this ticker)`);
    if (cmd === '/mutecoin') {
      for (const k of keys) { state.mutedCoins[k] = now(); delete state.unmutedCoins[k]; }
      return `🔇 No more alerts for:\n${keys.map(name).join('\n')}\n\nUndo with /unmutecoin. /mutedcoins lists them.`;
    }
    const repo = coinMutes(state).repo;
    for (const k of keys) { delete state.mutedCoins[k]; if (repo.has(k)) state.unmutedCoins[k] = now(); }
    return `🔔 Alerts back on for:\n${keys.map(name).join('\n')}`;
  }
  if (cmd === '/mutedcoins') {
    const cm = coinMutes(state);
    const all = [...cm.syms].map((k) => `• <b>${esc(k)}</b> (ticker)${cm.repo.has(k) ? ' · repo list' : ''}`)
      .concat([...cm.addrs].map((k) => `• ${state.meta?.[k]?.s ? `<b>${esc(state.meta[k].s)}</b> ` : ''}<code>${k}</code>${cm.repo.has(k) ? ' · repo list' : ''}`));
    return all.length ? `🔇 Muted coins (${all.length})\n${all.join('\n')}\n\n/unmutecoin to bring one back.` : 'No muted coins. /mutecoin SYMBOL or /mutecoin 0x… to add one.';
  }
  if (cmd === '/list') {
    const by = {};
    for (const [a, x] of Object.entries(state.manual)) (by[x.group || 'no group'] ||= []).push(`• ${esc(x.label)} <code>${a}</code>`);
    const body = Object.entries(by).map(([g, l]) => `<b>${esc(g)}</b> (${l.length})\n${l.join('\n')}`).join('\n\n');
    const muted = Object.keys(state.muted).length;
    return `${body || 'Nothing added from Telegram yet.'}\n\nTracking ${W.size} wallets in total (repo list, auto-found and added here)${muted ? `, ${muted} removed` : ''}.`;
  }
  if (cmd === '/export') {
    const rows = Object.entries(state.manual).map(([a, x]) => JSON.stringify({ address: a, label: x.label, ...(x.group ? { group: x.group } : {}) }));
    return rows.length ? `<code>${esc(rows.join(',\n'))}</code>` : 'Nothing added from Telegram yet.';
  }
  return 'Commands\n/add 0x… label group  (group optional; #name makes a new one)\n/remove 0x…\n/list\n/export  (backup in wallets.json format)\n/mutecoin SYMBOL or 0x…  (no more alerts for that coin)\n/unmutecoin SYMBOL or 0x…\n/mutedcoins';
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

// decode native-HYPE batch sends: Multicall3 aggregate3Value((address,bool,uint256,bytes)[]) and disperseEther(address[],uint256[]).
// An entry with calldata is a contract call, not a send: trading bots buy through Multicall3 as [1% fee to their fee
// wallet, the rest into a swap router], which is a buy with a fee, not a wallet split. out.calls counts those entries.
function batchSends(input) {
  const out = [];
  out.calls = 0;
  try {
    const sel = input.slice(0, 10).toLowerCase();
    const d = input.slice(10);
    const w = (i) => d.slice(i * 64, i * 64 + 64);
    const num = (i) => Number(BigInt('0x' + w(i)));
    if (sel === '0x174dea71') {
      const base = num(0) / 32;
      const n = num(base);
      for (let k = 0; k < Math.min(n, 50); k++) {
        const at = base + 1 + num(base + 1 + k) / 32;
        const v = Number(BigInt('0x' + w(at + 2))) / 1e18;
        if (num(at + num(at + 3) / 32) > 0) { out.calls++; continue; } // calldata: a call into a contract
        if (v > 0) out.push({ to: '0x' + w(at).slice(24), val: v });
      }
    } else if (sel === '0xe63d38ed') {
      const a = num(0) / 32, b = num(1) / 32, n = num(a);
      for (let k = 0; k < Math.min(n, 50); k++) {
        const v = Number(BigInt('0x' + w(b + 1 + k))) / 1e18;
        if (v > 0) out.push({ to: '0x' + w(a + 1 + k).slice(24), val: v });
      }
    }
  } catch {}
  return out;
}

// placeholder in a move line, filled with the wallet's remaining balance of that coin once per scan
const HOLD = (w, t) => `\u0000H:${w}:${t}\u0000`;
function holdLine(bal, meta, valHype, px) {
  if (!(bal > 0) || (meta.supply && bal / meta.supply < 1e-7)) return '\n   ↳ holds none now';
  const pct = meta.supply ? bal / meta.supply * 100 : null;
  const val = valHype != null ? ` ≈ ${px ? usd(valHype * px) : hype(valHype)}` : '';
  return `\n   ↳ holds ${fmtAmt(bal)}${val}${pct != null ? ` · <b>${pct >= 0.01 ? pct.toFixed(2) : pct.toPrecision(1)}% of supply</b>` : ''}`;
}

function fmtAmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2);
}

// write through a temp file and rename, so the other lane never reads a half-written file
function writeAtomic(url, text) {
  const tmp = new URL(url.href + '.tmp');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, url);
}

// ── fast lane (node watch.mjs --fast): tracked-wallet buys and sells within seconds ─────────────────────────
// One long-running process polls every FAST_POLL_MS with a single log query per poll (token transfers, swaps and
// new pools across the new blocks), keeps the transfers that touch a tracked wallet, and sends the same 👛 trade
// lines and 🎯 group buys the main scan would. Everything else (HYPE sends, splits, bridging, launches, new alts,
// exit-group alerts, Stockium) stays with the main scan. The main scan skips the trades this lane already sent,
// listed in fast.json. This lane only reads state.json (wallets, pools, prices) and only writes fast.json.
const FAST = new URL('./fast.json', import.meta.url);
const FAST_POLL_MS = Number(process.env.FAST_POLL_MS || 2000);
const FAST_RANGE = 1000;          // blocks per log query (the busiest public RPC allows 2,000)
const FAST_REJOIN = 300;          // further behind than this on start (about 45 s): rejoin at the head, the main scan has those blocks
const FAST_MINUTES = Number(process.env.FAST_MINUTES || 335);
const FAST_REFRESH_S = 30;        // re-read the wallet list and the main scan's state this often

// the tracked wallet set exactly as main() builds it (repo list, auto-found, /add, minus muted and their alts)
function trackedView(st) {
  let wallets = [];
  try { wallets = JSON.parse(fs.readFileSync(WALLETS, 'utf8')); } catch {}
  const okW = wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address));
  const W = new Map(okW.map((w) => [lc(w.address), w.label || short(w.address)]));
  const G = new Map(okW.filter((w) => w.group).map((w) => [lc(w.address), String(w.group)]));
  const DEVW = new Map(okW.filter((w) => w.watch === 'launch').map((w) => [lc(w.address), new Set((w.coins || []).map(lc))]));
  const auto = { ...(st.auto || {}) };
  for (const a of FEE_WALLETS) delete auto[a];
  for (const [a, x] of Object.entries(auto)) {
    if (!W.has(a)) W.set(a, x.label);
    if (x.group && !G.has(a)) G.set(a, x.group);
  }
  const manual = st.manual || {};
  const muted = { ...(st.muted || {}) };
  try {
    for (const x of JSON.parse(fs.readFileSync(MUTED, 'utf8'))) {
      const a = lc(x?.address || x);
      if (/^0x[0-9a-f]{40}$/.test(a) && !manual[a]) muted[a] ||= 1;
    }
  } catch {}
  for (const [a, x] of Object.entries(manual)) {
    W.set(a, x.label);
    if (x.group) G.set(a, x.group); else G.delete(a);
  }
  const listed = new Set(okW.map((w) => lc(w.address)));
  for (let more = true; more;) {
    more = false;
    for (const [a, x] of Object.entries(auto)) if (!muted[a] && !manual[a] && !listed.has(a) && muted[x.from]) { muted[a] = 1; more = true; }
  }
  for (const a of Object.keys(muted)) { W.delete(a); G.delete(a); }
  return { W, G, DEVW, auto, muted };
}

async function fastMain() {
  await pickRpcs();
  const stopAt = Date.now() + FAST_MINUTES * 60000;
  let fst = {};
  try { fst = JSON.parse(fs.readFileSync(FAST, 'utf8')); } catch {}
  fst = { block: 0, sent: {}, gbuys: {}, alerted: {}, meta: {}, price: {}, pools: {}, v3: {}, px: null, ...fst };
  let st = {}, view = null, refreshedAt = 0;
  const refresh = () => {
    try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {} // a failed read keeps the last good copy
    st.tok ||= {}; st.pools ||= {}; st.v3 ||= {}; st.meta ||= {};
    view = trackedView(st);
    for (const [t, m] of Object.entries(st.meta)) if (!fst.meta[t]) fst.meta[t] = m;
    const alertChat = st.cmdChat || (/^\d+$/.test(String(TG_CHAT || '')) ? TG_CHAT : null);
    if (CMD_TOKEN && alertChat) ALERT = { token: CMD_TOKEN, chat: alertChat };
    if (TRADE_TOKEN && alertChat) TRADE = { token: TRADE_TOKEN, chat: alertChat, trade: true };
    refreshedAt = now();
  };
  refresh();
  // tokenMeta and hypeUsd read and fill these
  const metaBox = { meta: fst.meta };
  const pxBox = { get px() { return fst.px; }, set px(v) { fst.px = v; } };
  const priceOf = (t) => fst.price[t]?.p || st.tok[t]?.price || null;
  // pools: the main scan's index plus pools this lane saw created (the main scan can be minutes behind on new coins)
  const poolOf = (id) => fst.pools[id] || st.pools[id] || null;
  const head0 = parseInt(await rpc('eth_blockNumber', []), 16);
  if (!fst.block || head0 - fst.block > FAST_REJOIN) fst.block = head0 - 20;
  try {
    const seedFrom = Math.max(1, Math.min(st.block || head0, fst.block) - 50, head0 - 8000);
    for (const l of await getLogs({ topics: [T_INIT_V4] }, seedFrom, head0, FAST_RANGE)) {
      const id = lc(l.topics[1]);
      if (!st.pools[id]) fst.pools[id] = poolEntry({ tok: st.tok }, lc(l.address), lc(topicAddr(l.topics[2])), lc(topicAddr(l.topics[3])), parseInt(l.blockNumber, 16));
    }
  } catch (e) { console.log('fast: pool seed failed:', e.message); }

  const stats = { polls: 0, blocks: 0, alerts: 0, trades: 0, errs: 0, lags: [], at: Date.now() };
  const blockTime = {};
  const rootOf = (w) => {
    let r = w;
    for (let i = 0; i < 8; i++) { const f = view.auto[r]?.from; if (!/^0x[0-9a-f]{40}$/.test(f || '') || f === r) break; r = f; }
    return r;
  };
  console.log(`fast: started at block ${fst.block + 1}, polling every ${FAST_POLL_MS} ms`);

  while (Date.now() < stopAt) {
    const t0 = Date.now();
    rpcIdx = 0; // back to the first (fastest) RPC every poll, after a hiccup moved us to a slower one
    try {
      if (now() - refreshedAt >= FAST_REFRESH_S) refresh();
      const head = parseInt(await rpc('eth_blockNumber', [], 3), 16);
      if (head > fst.block) {
        const from = fst.block + 1, to = Math.min(head, from + FAST_RANGE - 1);
        const logs = await getLogs({ topics: [[T_TRANSFER, T_SWAP_V4, T_SWAP_V3, T_SWAP_V2, T_INIT_V4]] }, from, to, FAST_RANGE);
        await fastTick({ logs, fst, st, view, poolOf, priceOf, metaBox, pxBox, rootOf, stats, blockTime });
        stats.blocks += to - from + 1;
        fst.block = to;
        fst.at = now();
        writeAtomic(FAST, JSON.stringify(fst));
      }
      stats.polls++;
    } catch (e) { stats.errs++; if (stats.errs <= 5 || stats.errs % 50 === 0) console.log('fast: poll failed:', e.message); }
    // a summary every 5 min: counts and timings only (the Actions log is public)
    if (Date.now() - stats.at >= 300000) {
      const l = stats.lags.sort((a, b) => a - b);
      const med = l.length ? l[Math.floor(l.length / 2)] : null;
      console.log(`fast: ${stats.polls} polls, ${stats.blocks} blocks, ${stats.trades} trades seen, ${stats.alerts} alerts` +
        (med != null ? `, chain-to-Telegram ${med}s median, ${l[l.length - 1]}s max` : '') + `, ${stats.errs} errors`);
      Object.assign(stats, { polls: 0, blocks: 0, alerts: 0, trades: 0, errs: 0, lags: [], at: Date.now() });
    }
    await sleep(Math.max(200, FAST_POLL_MS - (Date.now() - t0)));
  }
  console.log('fast: time is up, exiting');
}

// one batch of new logs: trades by tracked wallets → 👛 lines, and 🎯 group buys
async function fastTick({ logs, fst, st, view, poolOf, priceOf, metaBox, pxBox, rootOf, stats, blockTime }) {
  const { W, G, DEVW } = view;
  // new pools first, so a coin launched in this batch can be priced and its swaps read
  for (const l of logs) {
    if (l.topics[0] !== T_INIT_V4) continue;
    const id = lc(l.topics[1]);
    if (!poolOf(id)) fst.pools[id] = poolEntry({ tok: st.tok }, lc(l.address), lc(topicAddr(l.topics[2])), lc(topicAddr(l.topics[3])), parseInt(l.blockNumber, 16));
  }
  const mine = logs.filter((l) => l.topics[0] === T_TRANSFER && l.topics.length === 3 && (W.has(lc(topicAddr(l.topics[1]))) || W.has(lc(topicAddr(l.topics[2])))) && !WHYPE.has(lc(l.address)));
  if (!mine.length) return;
  const hot = new Set(mine.map((l) => l.transactionHash));
  // swaps in the txs we care about: HYPE paid per tx, which addresses are pools, the coin's latest price
  const txBuy = {}, emitters = {}, swapTx = new Set();
  for (const l of logs) {
    if (l.topics[0] !== T_SWAP_V4 && l.topics[0] !== T_SWAP_V3 && l.topics[0] !== T_SWAP_V2) continue;
    const b = parseInt(l.blockNumber, 16);
    const inHot = hot.has(l.transactionHash);
    if (inHot) { swapTx.add(l.transactionHash); (emitters[l.transactionHash] ||= new Set()).add(lc(l.address)); }
    if (l.topics[0] === T_SWAP_V4) {
      const p = poolOf(lc(l.topics[1]));
      if (!p) continue;
      const w = words(l.data);
      const qd = Number(int256(p.inv ? w[1] : w[0])) / 1e18;
      const hypeQ = isHype(p.q ?? ZERO);
      const qPx = hypeQ ? 1 : priceOf(p.q) || 0;
      if (inHot && qd < 0 && hypeQ) txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + Math.abs(qd);
      const sqrt = BigInt('0x' + w[2]);
      if (sqrt > 0n && qPx > 0) {
        const ratio = Number((sqrt * sqrt * 10n ** 18n) >> 192n) / 1e18;
        if (ratio > 0 && (!fst.price[p.t] || fst.price[p.t].b <= b)) fst.price[p.t] = { p: (p.inv ? ratio : 1 / ratio) * qPx, b, t: now() };
      }
    } else if (l.topics[0] === T_SWAP_V3 && inHot) {
      const pool = lc(l.address);
      let pi = st.v3[pool] ?? fst.v3[pool];
      if (pi === undefined) {
        try {
          const [t0, t1] = await Promise.all([rpc('eth_call', [{ to: pool, data: '0x0dfe1681' }, 'latest']), rpc('eth_call', [{ to: pool, data: '0xd21220a7' }, 'latest'])]);
          pi = fst.v3[pool] = { t0: lc(topicAddr(t0)), t1: lc(topicAddr(t1)) };
        } catch { pi = fst.v3[pool] = null; }
      }
      if (!pi || (!WHYPE.has(pi.t0) && !WHYPE.has(pi.t1))) continue;
      const w = words(l.data);
      const hypeIsT0 = WHYPE.has(pi.t0);
      const coin = hypeIsT0 ? pi.t1 : pi.t0;
      const h = Number(int256(hypeIsT0 ? w[0] : w[1])) / 1e18;
      if (h > 0) txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + h;
      const sqrt = BigInt('0x' + w[2]);
      if (sqrt > 0n) {
        const p01 = Number((sqrt * sqrt * 10n ** 18n) >> 192n) / 1e18;
        if (p01 > 0 && (!fst.price[coin] || fst.price[coin].b <= b)) fst.price[coin] = { p: hypeIsT0 ? 1 / p01 : p01, b, t: now() };
      }
    }
  }
  // the txs themselves: HYPE sent along by a tracked wallet, and which contract it called (routers)
  const txs = {};
  await Promise.all([...hot].slice(0, 60).map(async (h) => { try { txs[h] = await rpc('eth_getTransactionByHash', [h], 3); } catch {} }));
  const paidIn = {}, routerCall = {};
  for (const [h, tx] of Object.entries(txs)) {
    if (!tx?.to || (tx.input || '0x') === '0x' || !W.has(lc(tx.from))) continue;
    routerCall[h] = lc(tx.to);
    const v = Number(BigInt(tx.value || '0x0')) / 1e18;
    if (v > 0) paidIn[h] = v;
  }
  const px = await hypeUsd(pxBox);
  const exitOf = (w) => EXIT_GROUPS.has(String(G.get(w) || '').toLowerCase());
  const moves = {}, lastBuy = {}, touched = new Set(), firstBlock = {};
  const usdOf = (h) => (h == null ? null : px ? h * px : h * 50);
  for (const l of mine) {
    const f = lc(topicAddr(l.topics[1])), to = lc(topicAddr(l.topics[2]));
    const t = lc(l.address);
    const h = l.transactionHash;
    const em = emitters[h] || new Set();
    const meta = await tokenMeta(metaBox, t);
    const amt = Number(BigInt(l.data === '0x' ? '0x0' : l.data)) / 10 ** meta.d;
    const price = priceOf(t);
    const val = price ? amt * price : null;
    const paidH = txBuy[h] || paidIn[h] || null;
    const b = parseInt(l.blockNumber, 16);
    if (W.has(to) && (em.has(f) || txBuy[h] || (paidIn[h] && f !== ZERO))) {
      stats.trades++;
      const shown = val ?? paidH;
      const dust = (usdOf(paidH || val) ?? Infinity) < DUST_USD;
      for (const g of [G.get(to), '*'].filter(Boolean)) (fst.gbuys[g + '|' + t] ||= []).push({ w: to, t: now(), h: paidH || val || 0 });
      touched.add(t);
      if (exitOf(to)) continue; // the main scan sends exit-group moves as one alert per group
      fst.sent[`${h}|${to}|${t}`] = now();
      if (dust || DEVW.has(to)) continue; // launch-watched devs: their buys count toward group buys but are not pinged
      (moves[to] ||= []).push(`bought ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${shown != null ? ` (~${px ? usd(shown * px) : hype(shown)})` : ''} · ${assetLink(t, 'chart')}${txLink(h)}${HOLD(to, t)}`);
      lastBuy[to] = t;
      firstBlock[to] ??= b;
    }
    if (W.has(f)) {
      const viaRouter = routerCall[h] && routerCall[h] !== t && swapTx.has(h) && !W.has(to) && to !== ZERO && to !== DEAD;
      if (!em.has(to) && !viaRouter) continue; // not a sale: sends, LP moves and burns stay with the main scan
      stats.trades++;
      if (exitOf(f)) continue;
      fst.sent[`${h}|${f}|${t}`] = now();
      if ((usdOf(val) ?? Infinity) < DUST_USD) continue;
      if (DEVW.has(f)) {
        const own = DEVW.get(f).has(t) || lc(st.tok[t]?.creator || '') === f;
        if (!own) continue; // launch-watched devs: only sells of their own coins
      }
      (moves[f] ||= []).push(`sold ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${val != null ? ` (~${px ? usd(val * px) : hype(val)})` : ''} · ${assetLink(t, 'chart')}${txLink(h)}${HOLD(f, t)}`);
      firstBlock[f] ??= b;
    }
  }
  let msgs = [];
  // what each wallet still holds of the coin it traded (last line per wallet+coin gets it)
  const held = {};
  for (const k of [...new Set(Object.values(moves).flat().join('').match(/\u0000H:[^\u0000]+\u0000/g) || [])].slice(0, 20)) {
    const [, w, t] = k.slice(1, -1).split(':');
    try {
      const meta = await tokenMeta(metaBox, t);
      const bal = Number(BigInt(await rpc('eth_call', [{ to: t, data: '0x70a08231' + w.slice(2).padStart(64, '0') }, 'latest'], 3))) / 10 ** meta.d;
      const price = priceOf(t);
      held[k] = holdLine(bal, meta, price ? bal * price : null, px);
    } catch { held[k] = ''; }
  }
  const lagFrom = [];
  for (const [w, list] of Object.entries(moves)) {
    const seen = new Set();
    for (let i = list.length - 1; i >= 0; i--) list[i] = list[i].replace(/\u0000H:[^\u0000]+\u0000/g, (k) => (seen.has(k) ? '' : (seen.add(k), held[k] || '')));
    const text = `👛 <b>${esc(W.get(w))}</b> · ${walletLink(w)}\n` + list.slice(0, 12).map((x) => '• ' + x).join('\n') + (list.length > 12 ? `\n…and ${list.length - 12} more` : '');
    msgs.push(lastBuy[w] ? { text, buttons: buyButtons('e', lastBuy[w]) } : text);
    lagFrom.push(firstBlock[w]);
  }
  // group buys, the same rules as the main scan (one owner = one buyer, cooldown, re-ping when more pile in)
  for (const [k, list] of Object.entries(fst.gbuys)) {
    const recent = list.filter((x) => now() - x.t <= GROUP_WINDOW_MIN * 60 && !view.muted[x.w]);
    if (!recent.length) { delete fst.gbuys[k]; continue; }
    fst.gbuys[k] = recent.slice(-50);
    const [g, t] = k.split('|');
    if (!touched.has(t)) continue;
    const byW = {};
    for (const x of recent) byW[x.w] = (byW[x.w] || 0) + x.h;
    const fam = {};
    for (const [w, h] of Object.entries(byW)) { const r = rootOf(w); (fam[r] ||= { ws: [], h: 0 }); fam[r].ws.push(w); fam[r].h += h; }
    const n = Object.keys(fam).length, nW = Object.keys(byW).length;
    if (n < (g === '*' ? ANY_MIN_WALLETS : GROUP_MIN_WALLETS)) continue;
    const key = 'g:' + k;
    const prev = fst.alerted[key] || st.alerted?.[key];
    if (prev && now() - prev.t <= COOLDOWN_H * 3600 && n <= (prev.n || 0)) continue;
    if (g === '*' && Object.keys(byW).every((w) => G.get(w) && G.get(w) === G.get(Object.keys(byW)[0]))) continue;
    fst.alerted[key] = { t: now(), n };
    const tot = Object.values(byW).reduce((a, b) => a + b, 0);
    const span = Math.max(1, Math.round((Math.max(...recent.map((x) => x.t)) - Math.min(...recent.map((x) => x.t))) / 60));
    const meta = await tokenMeta(metaBox, t);
    const price = priceOf(t);
    const mcH = price && meta.supply ? price * meta.supply : null;
    msgs.push({
      text: `🎯 <b>${g === '*' ? `${n} tracked ${nW > n ? `buyers (${nW} wallets)` : 'wallets'}` : `${esc(g)} group, ${n} ${nW > n ? `buyers (${nW} wallets)` : 'wallets'}`}</b> bought <b>${esc(meta.s)}</b> within ${span} min\n` +
        `${tot > 0 ? `${hype(tot)}${px ? ` (${usd(tot * px)})` : ''} in` : ''}${mcH ? ` · MC ${px ? usd(mcH * px) : hype(mcH)}` : ''}\n` +
        Object.entries(fam).map(([r, x]) => {
          const name = esc(W.get(r) || view.auto[r]?.label || short(r));
          const amt = x.h > 0 ? ` ${hype(x.h)}` : '';
          if (x.ws.length === 1) return `• ${walletLink(x.ws[0], esc(W.get(x.ws[0]) || short(x.ws[0])))}${amt}`;
          const alts = x.ws.filter((w) => w !== r).length;
          return x.ws.includes(r) ? `• ${walletLink(r, name)} + ${alts} of its alts${amt}` : `• ${alts} alts of ${walletLink(r, name)}${amt}`;
        }).join('\n') +
        `\n<code>${t}</code>\n${coinLink(st, t)}`,
      buttons: buyButtons('e', t),
    });
    lagFrom.push(null);
  }
  if (!msgs.length) return;
  msgs = dropMutedCoins(msgs, coinMutes({ mutedCoins: { ...(st.mutedCoins || {}) }, unmutedCoins: { ...(st.unmutedCoins || {}) } }));
  for (const m of msgs) { await tg(m); stats.alerts++; }
  // chain-to-Telegram delay for the log: from the block of the first trade in each alert to now
  for (const b of lagFrom.filter((x) => x != null).slice(0, 5)) {
    try {
      blockTime[b] ??= parseInt((await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false], 2)).timestamp, 16);
      stats.lags.push(now() - blockTime[b]);
    } catch {}
  }
  // housekeeping: dedupe keys for 3 hours, caches bounded
  for (const [k, t] of Object.entries(fst.sent)) if (now() - t > 3 * 3600) delete fst.sent[k];
  for (const [k, a] of Object.entries(fst.alerted)) if (now() - a.t > 2 * 86400) delete fst.alerted[k];
  for (const [t, x] of Object.entries(fst.price)) if (now() - x.t > 6 * 3600) delete fst.price[t];
  if (Object.keys(fst.meta).length > 4000) for (const k of Object.keys(fst.meta).slice(0, 2000)) delete fst.meta[k];
  for (const b of Object.keys(blockTime)) if (Object.keys(blockTime).length > 200) delete blockTime[b];
}

if (process.argv.includes('--fast')) fastMain().catch((e) => { console.error('fast:', e.message); process.exit(1); });
else main().catch((e) => { console.error(e); process.exit(1); });
