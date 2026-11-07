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
//   2. KyberSwap's aggregator, for everything else it indexes on Elysium (v3 DEXes, WHYPE pairs), and whenever it pays
//      clearly more than the best pool (a coin whose liquidity moved, leaving a thin pool behind).
//   3. Bonding-curve launchpads (VEINS and its two copies), before and after a coin graduates to the curve's own pair.
//   4. Coins only their own router may trade (Elysium Machines), through that router.
//   5. Single-coin bonding curves (COREPAD): each coin has a curve contract of its own, found from the coin's mint.
//   6. Coins paired with another token on Uniswap v4 (BOXA, USDC, KNTQ…): in one transaction through that token's
//      HYPE pool on the same manager when it has one, otherwise in two steps (HYPE → the token on its own best route,
//      then the token → the coin through Uniswap's Universal Router; sells the other way round). /set pairbuy off
//      keeps the token instead (a buy then needs it in the wallet). Ascend coins paired with USDC work the same way.
//
// Safety before every buy:
//   Sell check: the buy is simulated together with an immediate sell of everything it returns (a tiny
//   helper contract placed only inside the simulation, never deployed). If the coin cannot be sold back
//   (honeypot, blocked sells) or the round trip loses more than the tax limit, the bot does not buy and
//   offers a "Buy anyway" button instead.
//   Stale taps: a ⚡ tap on an alert older than a few minutes shows the coin's current card first, and a
//   second tap on the same button within a few seconds is ignored.
//
// Speed:
//   Reads a trade waits on (the sell check that doubles as the quote, balances, approval) go to every node at
//   once and the first answer wins; with the coin's route known, a buy needs one round trip before it is sent.
//   The signed transaction goes to every node and the first acceptance counts. The Telegram message is sent
//   alongside, never before. Coins are approved right after a buy, and the bag size is remembered, so a sell is
//   one round trip and one transaction. Receipts are polled every 0.3 s; a transaction no node knows after 20 s
//   counts as dropped and the nonce is resynced so nothing queues behind it.
// Limit orders (checked every 2 s, by market cap in $): buy when MC falls to or rises past a level; sell part
//   or all when MC reaches a level, falls to one, or hits a multiple of your entry. Set with /limit or by
//   replying to a card's 🎯 Limit question.
// Pinned panel: one message pinned at the top of the chat lists every open trade with one-tap sells, edited
//   every minute and after each trade, so alerts never bury it (/pin re-sends it at the bottom).
// Your other wallets (/mine): wallets you trade from elsewhere, watch-only. Their Elysium buys and sells go into the
// journal, /stats and the nightly tips beside the bot's own, with a 📒 note question on each buy and each coin closed.
// Extras, off unless set: take profit, stop loss and trailing stop (/tp /sl /trail), an auto-sell preset on
//   every buy (/auto), dev and rug guards (/set devsell, /set rug), snipes (/snipe) and copy trading (/copy).
// Bag watch, per coin: 👀 on a coin's card (or /bagwatch 0xCOIN) watches its dev and top 10 holders, and a sell or
//   move of a real part of their bag posts here. /set bagwatch on watches every coin you hold (bot and /mine wallets).
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
// sends also go to these relays (never read from): every extra path to the sequencer is a chance to land sooner.
// Montra's own RPC: Montra trades seen on Nov 6 landed about 3 to 4 s after their frontend built them
const SEND_RPCS = [...new Set([...RPCS, ...(process.env.ELY_SEND_RPCS ?? 'https://rpc.montramarkets.xyz,https://rpc.mesa.cx').split(',').map((s) => s.trim()).filter(Boolean)])];
// nodes more than ~10 s behind the best head are benched from reads (checked every 10 s): a lagging node answers
// fastest with stale state, so its quotes are old and it says "no receipt" for a buy that already landed
let LIVE = RPCS;
async function checkHeads() {
  const heads = await Promise.all(RPCS.map((u) => call1(u, 'eth_blockNumber', [], 4000).then((h) => Number(BigInt(h))).catch(() => null)));
  const top = Math.max(...heads.filter((h) => h != null));
  const ok = RPCS.filter((u, i) => heads[i] != null && top - heads[i] <= 60);
  const was = LIVE.join();
  LIVE = ok.length ? ok : RPCS;
  if (LIVE.join() !== was) console.log('rpc heads', RPCS.map((u, i) => `${u.replace('https://', '')} ${heads[i] == null ? 'down' : top - heads[i] + ' behind'}`).join(' · '));
}
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
// ElysPump pools paired with ElysPump's own wrapped HYPE instead of native HYPE (QUOTED and others) go through this
// public router: it takes native HYPE in and pays native HYPE out, wrapping inside the same transaction, so a buy
// or sell there is still one transaction
const WROUTER = '0x822c686fc480ae8204260fbd46c524a4a30cbdf8';
const ELYSPUMP_PM = '0x5fb015a49f5b35073f9ce01c2adb287a75f89600';
const WRAPPED = new Set(['0x5ab377328592c03b5e7adb09254adb043f91fa11']); // the WHYPE that router wraps into
// Uniswap v3 forks paired with WHYPE (BOXA v2 launches, StockiumSwap graduates, Kleos v3 launches): their SwapRouter
// takes native HYPE in and wraps it, and a sell is swap + unwrap in one multicall, so both stay one transaction.
// Each fork names its own WHYPE (the one its router's WETH9() returns).
const V3WHYPE = '0xba876237b0f021a6c6d852d6c26e107997cc5e81';
const V3DEX = [
  { name: 'BOXA v2', factory: '0xd5a7c10820446c58868a204b8979b8cc9cb2a1a3', router: '0x03c820b17f17ea86449f6cf700788c97511566c4', whype: V3WHYPE },
  { name: 'StockiumSwap', factory: '0x4f66184a9ffabb7f7071d590c2c48dedf41676f4', router: '0xf7d8d5f9b9125b3d29c5778df5e54c1bbe77f224', whype: V3WHYPE },
  { name: 'Kleos v3', factory: '0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1', router: '0x03c291d55cc178b8fc3e20607125b8f6e9d12687', whype: '0x0269031ace34a7821e9d9980d087c35ce7c19eef' },
];
const V3FEES = [10000, 3000, 500, 100];
// bonding-curve launchpads that trade coins before they reach a pool: buy(token, amountIn, minOut, deadline) payable,
// sell(token, amountIn, minOut, deadline) paying native HYPE, and two views that quote either side. buy() returns
// nothing, so quotes come from the views.
// Once a coin graduates, the same contract trades it on its own v2 pair against its own wrapped HYPE: ammBuy and
// ammSell (token, amountIn, minOut, deadline), returning nothing. info(token) names the pair (word 2, zero while the
// coin is still on the curve) and fee() is in basis points of the HYPE side (VEINS 125, 0x51d9 100: checked Nov 6
// against the pairs' reserves). These are Obol's curves (deployer 0x48ad71ab6467b0d0d9c5e23caf77452a343cdeeb; Elyxa
// calls the venue Obol and its wrapped HYPE 0x9f041fad "WHYPE (Obol)").
// The fourth (0x4de0, Nov 4, an upgradeable proxy, fee 200) graduates a coin into a Uniswap v4 pool that uses the
// curve as its hook: info word 2 is then the PoolManager, not a v2 pair, so there are no reserves to read. Its own
// qBuy/qSell views quote the graduated pool too (checked on CACHE Nov 7), and ammBuy/ammSell still trade it (v4: true).
const CURVE_ABI = { buy: '1622dbe4', sell: '92cdbac5', qBuy: '0d7a94f6', qSell: 'd98b2f5c', info: '7d0f7a88', ammBuy: '73491ee7', ammSell: 'ddc2953d', fee: 'bf333f2c' };
const CURVES = [
  { name: 'Obol 0xfee8', curve: '0xfee823be55ee12b8c3a76aff0bd69470afaf2348', ...CURVE_ABI }, // VEINS
  { name: 'Obol 0x7d19', curve: '0x7d1904bfb2472a0ef97d886139a4236060e064ab', ...CURVE_ABI },
  { name: 'Obol 0x51d9', curve: '0x51d9243d87ad13d7eca55ab57357b2b5fc8241f2', ...CURVE_ABI },
  { name: 'Obol', curve: '0x4de07902f28d00736e29aa5739dea2d4ce98aacc', ...CURVE_ABI, v4: true }, // CACHE
];
// Coins only their own router can trade: the pool's hook refuses every other caller. Elysium Machines (ERC-404, 4,444
// units): buy(minOut, deadline, proof) payable and sell(amountIn, minOut, deadline, proof), both returning the amount
// out. proof is the whitelist's Merkle proof, empty for everyone else, who pays its 40% sell tax for the first 6 h.
// An ERC-404 buy mints an NFT per whole unit (about 120k gas each, 22.7M for 158 units at its launch), so trades
// there use a gas estimate instead of a fixed limit.
// Single-coin bonding curves (COREPAD, Nov 6): a launch contract gives each coin a curve of its own, minted the whole
// supply at launch. buy(minOut, deadline) payable and sell(amount, minOut, deadline) after an approve; quoteBuy(hypeIn)
// and quoteSell(amount) answer (out, fee); graduated() turns true when the coin leaves for a pool (its route is then
// picked again). The curve is found from the coin's mint: the contract that received the whole supply, carrying
// these functions.
const PC = { buy: 'd6febde8', sell: 'd3c9727c', qBuy: '4beb394c', qSell: 'a64190c4', grad: 'e7c2b772' };
const GATED = {
  '0xf67e8da4251eba24f9679fd3f9e39405bafdc10c': { name: 'Elysium Machines', router: '0xb08fc83f1f00d57d3bd7f2c23cc5acf2f61d51eb', bs: '327d0c86', ss: 'f4dbbf5a' },
};
// Signal's Elysium launchpad (v4 lane 4.2, hook 4.3, deployed Nov 7 by 0x5273…6044): coins paired with WHYPE 0xba87…5e81
// on eleos's pool manager. Its hook trusts only Signal's router during a launch's gate, so every trade goes through it:
// buyNative(key, minOut, to, refundTo, deadline) payable and swap(key, zeroForOne, amountIn, minOut, to, unwrap,
// deadline) after an approve, both returning the amount out (SignalV4RouterV2, verified on Base). A launch can charge a
// falling anti-snipe fee on buys (up to 90%, linear over up to 600 s), cap one wallet's share and the tokens all buys of
// one block may take, each for a while after launch; a buy over a cap or the block's budget reverts.
const SIGNAL = { pm: '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', hook: '0x601bdb66b0285c199b43479030a9132f6dd8aaec', router: '0x0f8b987553a40ba565eee9a7f6df3d1ecd07d964', factory: '0xd31471cb7044edae748d2a7324648e298346ecaa', whype: V3WHYPE };
const PM_NAMES = Object.fromEntries([...V4.map((x) => [x.pm, x.name]), ['0x5fb015a49f5b35073f9ce01c2adb287a75f89600', 'ElysPump'], ['0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', 'Uniswap']]);
// launchpads that sit on someone else's pool manager, named by their hook
const HOOK_NAMES = { '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': 'Flaunch' }; // Flaunch fork on the official Uniswap v4
// pools added by hand: always in the pool index, even when the live index is behind
const PINNED = [
  { t: '0x0f79931689af199e7cf868ed1107bba2c83c68f7', pm: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', fee: 0, ts: 60, hook: '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc', b: 279485, id: '0x7b182abb748bae25e2c73abd8b4cf3157d8d35a47e4b36d1ee5565ade94c3c27' }, // VOLTA
];
const T_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
// Ascend runs a PancakeSwap Infinity fork: a CL pool manager whose Initialize is (id, currency0, currency1) with data
// (hooks, fee, parameters, sqrtPrice, tick), a 6-field PoolKey (currency0, currency1, hooks, poolManager, fee,
// parameters), coins paired with a quote token (Mock USDC on its testnet) or native HYPE, and trades through its
// Universal Router (execute, INFI_SWAP) with ERC20s pulled through Permit2. Its launchpad hook charges an anti-snipe
// fee that steps down each second after launch (testnet: 90%, 72.2, 54.4, 36.6, 18.8, then 1% from +5 s).
const T_INIT_ASCEND = '0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c';
const T_SWAP_ASCEND = '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const ASCEND_QUOTES = new Set(String(process.env.ASCEND_QUOTES || '').toLowerCase().split(',').filter(Boolean)); // quote token(s), when known in advance
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
state.alts ||= {};     // token → every route that answered, best first (a coin with several ways in), re-picked per trade size
state.poolsBlock ||= 0; // last block the pool index has read
for (const { t, ...p } of PINNED) {
  const l = (state.pools[t] ||= []);
  if (!l.some((y) => y.id === p.id)) { l.push(p); delete state.routes?.[t]; }
}
state.slots ||= {};    // token → allowance mapping base slot (for sell quotes before approving)
state.set ||= {};
state.orders ||= {};   // token → [{ id, k: tp|sl|trail|lbuy, x, drop, pct, base, peak, hype, mc, dir, auto, at, exp }]
state.snipes ||= [];   // [{ id, k: token|dev|new, w, hype, left, b, at, pms, got }]
state.copy ||= {};     // leader wallet → { name, hype, at }
state.copyDone ||= {}; // `${leader}:${token}` → time (each coin copied once per leader)
state.dev ||= {};      // token → { w: creator, peak: tokens }
state.asc ||= {};
state.asc.ur ||= {};      // Ascend pool manager → its Universal Router (learned from its swaps, or /ascend router)
state.asc.quotes ||= {};  // Ascend quote token → pools seen with it
state.asc.slot ||= {};    // token (or launchpad hook) → storage slot of SIM's balance in it, for simulations
const cfg = () => ({
  slip: BigInt(state.set.slip ?? process.env.SLIPPAGE_BPS ?? 1500),
  max: Number(state.set.max ?? process.env.MAX_BUY_HYPE ?? 5),
  sizes: (state.set.sizes ?? process.env.BUY_SIZES ?? '1,2,3,5').split(',').map((s) => s.trim()).filter(Boolean),
  tax: Number(state.set.tax ?? process.env.MAX_TAX_PCT ?? 25),     // refuse when buying and selling straight back loses more than this %
  check: (state.set.check ?? process.env.SELL_CHECK ?? 'on') !== 'off',
  stale: Number(state.set.stale ?? process.env.STALE_MIN ?? 5),   // ⚡ taps on alerts older than this many minutes show the card first
  report: state.set.report ?? process.env.DAILY_REPORT ?? 'quiet', // nightly report: quiet (only when there is news), on, off
  devsell: Number(state.set.devsell ?? process.env.DEV_SELL_PCT ?? 0),  // sell all once the creator has dumped this % of their peak bag (0 = off)
  rug: (state.set.rug ?? process.env.RUG_GUARD ?? 'off') !== 'off',     // sell all when a held coin turns unsellable or its tax jumps
  preapprove: (state.set.preapprove ?? process.env.PRE_APPROVE ?? 'on') !== 'off', // approve right after a buy so sells are one tx
  auto: state.set.auto ?? process.env.AUTO_SELL ?? 'off',               // orders added to every buy, e.g. "tp 2x 50 trail 40"
  copymax: Number(state.set.copymax ?? process.env.COPY_MAX_DAY ?? 10), // copy buys per day, all wallets together
  copysells: (state.set.copysells ?? 'on') !== 'off',                   // mirror the copied wallet's sells
  pin: (state.set.pin ?? process.env.PIN_TRADES ?? 'on') !== 'off',      // pinned open-trades panel at the top of the chat
  notes: (state.set.notes ?? process.env.TRADE_NOTES ?? 'on') !== 'off', // 📒 note question on each buy and close in your other wallets
  bagwatch: (state.set.bagwatch ?? process.env.BAG_WATCH ?? 'off') !== 'off', // 👀 every coin you hold (off: only the coins you arm)
  inbox: (state.set.inbox ?? process.env.INBOX ?? 'on') !== 'off',            // also post every trade to Elysium's Inbox on HyperEVM
  pairbuy: (state.set.pairbuy ?? process.env.PAIR_BUY ?? 'on') !== 'off',     // coins paired with a token: buy that token with HYPE first, sell it back after
});
const DEFAULT_AUTO = 'tp 2x 50 trail 40';
let saveTimer = null;
// written to a temp file and renamed, so a crash mid-save never leaves a half-written state.json
const STATE_TMP = new URL('./state.json.tmp', import.meta.url);
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { fs.writeFileSync(STATE_TMP, JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); fs.renameSync(STATE_TMP, STATE); }, 300); };

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
const transient = (e) => /abort|timeout|timed? ?out|rate limit|too many|busy|unavailable|fetch failed|ECONN|ENOTFOUND|socket|bad answer|429|502|503|504|-32005/i.test(`${e.name} ${e.message} ${e.code}`);
async function call1(url, method, params, ms = 8000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  // a node that is rate limiting answers 429 with a text or HTML page, not JSON: that is a busy node, not a bad call
  const body = await r.text();
  let j;
  try { j = JSON.parse(body); } catch { throw new Error(`bad answer HTTP ${r.status}`); }
  if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.code = j.error.code; e.data = j.error.data; throw e; }
  return j.result;
}
let rpcIdx = 0;
async function rpc(method, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    const url = LIVE[(rpcIdx + i) % LIVE.length];
    try { const r = await call1(url, method, params); rpcIdx = (rpcIdx + i) % LIVE.length; return r; }
    catch (e) { if (!transient(e)) throw e; last = e; await sleep(150 * (i + 1)); }
  }
  throw last;
}
// Reads a trade waits on go to every live node at once and the first answer wins (the fastest node, and a slow
// one never holds a trade up). A revert counts once half the nodes agree. Nodes without state override support
// just drop out of the race. With `found`, an empty answer (null: no receipt there yet) does not win: the race
// waits for a node that has it, and gives null only when every node said null.
function race(method, params, ms = 5000, found = false) {
  const nodes = LIVE;
  return new Promise((resolve, reject) => {
    let left = nodes.length, reverts = 0, empty = false;
    for (const u of nodes) call1(u, method, params, ms).then((r) => {
      if (found && r == null) { empty = true; if (!--left) resolve(null); return; }
      resolve(r);
    }, (e) => {
      left--;
      if (reverted(e) && ++reverts >= Math.ceil(nodes.length / 2)) return reject(e);
      if (!left) (empty ? resolve(null) : reject(e));
    });
  });
}
// override calls (quotes, sell checks) always race; plain reads race when `fast`, else rotate
async function ethCall(to, data, extra = {}, override, fast = false) {
  const params = override ? [{ to, data, ...extra }, 'latest', override] : [{ to, data, ...extra }, 'latest'];
  if (override || fast) return race('eth_call', params);
  return rpc('eth_call', params);
}
// sent to every node at once; the first node to accept it is enough, the rest keep going in the background
async function broadcast(raw) {
  try { await Promise.any(SEND_RPCS.map((u) => call1(u, 'eth_sendRawTransaction', [raw], 12000))); }
  catch (agg) {
    const why = (agg.errors || [agg]).map((e) => e?.message || '').join(' | ');
    if (/already known|known transaction|already imported/i.test(why)) return;
    const e = new Error(why.slice(0, 220));
    e.nonceLow = /nonce too low/i.test(why);
    e.nonceHigh = /nonce too high|nonce gap/i.test(why);
    throw e;
  }
}

// one send at a time, nonces handed out locally so an approve and its sell can go back to back
let nextNonce = null, queue = Promise.resolve(), gpCache = { v: 0n, t: 0 };
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
// sent but not landed yet, nonce → time sent. While Elysium is slow to include, the chain's count lags behind what
// was sent, so a resync never goes below a nonce still in flight (that would reuse it and knock out the first trade)
const inflight = new Map();
async function resyncNonce() {
  const [l, p] = await Promise.all([rpc('eth_getTransactionCount', [me, 'latest']), rpc('eth_getTransactionCount', [me, 'pending']).catch(() => '0x0')]);
  const chain = Math.max(Number(BigInt(l)), Number(BigInt(p)));
  for (const [n, at] of inflight) if (n < chain || Date.now() - at > 200000) inflight.delete(n);
  nextNonce = Math.max(chain, ...[...inflight.keys()].map((n) => n + 1));
  return nextNonce;
}
async function fetchGas() {
  let g = BigInt(await rpc('eth_gasPrice', []).catch(() => '0x5f5e100')) * 2n;
  if (g < 2n * 10n ** 8n) g = 2n * 10n ** 8n;
  gpCache = { v: g, t: Date.now() };
  return g;
}
// refreshed in the background every 25 s, so a send never waits on it
async function gasPrice() { return gpCache.v && Date.now() - gpCache.t < 120000 ? gpCache.v : fetchGas(); }
async function sendRaw(tx, opts = {}) {
  if (nextNonce == null) await resyncNonce();
  const nonce = nextNonce;
  const raw = await account.signTransaction({ chainId: CHAIN_ID, type: 'legacy', nonce, to: tx.to, value: BigInt(tx.value || 0), data: tx.data, gas: BigInt(tx.gas), gasPrice: await gasPrice() });
  // the same signed tx also goes to Elysium's Inbox on HyperEVM, at the same moment (see inboxSend)
  const viaInbox = opts.inbox === false ? Promise.resolve(null) : inboxQueue(raw).catch((e) => { console.error(e.message); return null; });
  // "nonce too high" while an earlier trade is still landing (an approve and its swap back to back): the earlier one
  // is not in yet, so the same signed tx is offered again every 2 s for up to 30 s instead of failing the trade
  for (let i = 0; ; i++) {
    try { await broadcast(raw); break; }
    catch (e) {
      if (e.nonceHigh && i < 15 && [...inflight.keys()].some((n) => n < nonce)) { await sleep(2000); continue; }
      // every RPC node refused it for a reason other than its nonce: the Inbox copy alone still lands it
      if (!e.nonceLow && !e.nonceHigh && (await viaInbox)) break;
      if (e.nonceLow || e.nonceHigh) await resyncNonce();
      throw e;
    }
  }
  nextNonce = nonce + 1;
  inflight.set(nonce, Date.now());
  const hash = keccak256(raw);
  signed.set(hash, { raw, nonce });
  if (signed.size > 300) signed.delete(signed.keys().next().value);
  return hash;
}

// ── Inbox route ────────────────────────────────────────────────────────────────────────────────────
// Elysium also takes transactions through its Inbox contract on HyperEVM (sendL2Message, message type 4 = one signed
// Elysium tx) and runs them in the order they were posted. Measured Nov 6 on a sniper wallet posting at 50 gwei,
// they executed 1 to 16 s after the post, while Nadir's RPC buys took 8 to 32 s. Every trade is now sent both
// ways at once. Both carry the same signed tx (same hash, same nonce), so it lands once, by whichever is faster.
// HyperEVM gas for the post (a post uses ~93k gas: about 0.019 HYPE at the default 200 gwei) is paid from this wallet's own address on HyperEVM; with
// too little HYPE there the post is skipped and trades go by RPC only, as before. /set inbox off turns it off.
const ELY_INBOX = '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff';
const HYPER_RPCS = (process.env.HYPER_RPCS || 'https://rpc.hyperliquid.xyz/evm,https://rpc.hypurrscan.io').split(',').map((s) => s.trim()).filter(Boolean);
// HyperEVM gas price for the post. High by default: inside one HyperEVM block, posts are ordered by gas price, so
// this keeps a buy ahead of other posts in the same block (the sniper seen on Nov 6 pays 50). /set gwei 300 changes it.
const inboxGwei = () => Number(state.set.gwei ?? process.env.INBOX_GWEI ?? 200);
const INBOX_GAS = 300000n; // limit; a post uses ~93k (a sniper's, Nov 6)
const inboxWei = () => BigInt(Math.round(inboxGwei() * 1e9));
const inbox = { nonce: null, bal: null, warned: false, posts: 0, last: null };
async function hcall(method, params, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await call1(HYPER_RPCS[i % HYPER_RPCS.length], method, params, 6000); }
    catch (e) { last = e; await sleep(400 * (i + 1)); }
  }
  throw last;
}
async function inboxRefresh() {
  const [b, n] = await Promise.all([hcall('eth_getBalance', [me, 'latest']), hcall('eth_getTransactionCount', [me, 'pending'])]);
  inbox.bal = BigInt(b);
  const cn = Number(BigInt(n));
  if (inbox.nonce == null || cn > inbox.nonce) inbox.nonce = cn;
}
const inboxReady = () => cfg().inbox && inbox.bal != null && inbox.bal >= INBOX_GAS * inboxWei();
async function inboxSend(raw) {
  if (!cfg().inbox) return null;
  if (inbox.bal == null || inbox.nonce == null) await inboxRefresh().catch(() => {});
  if (!inboxReady()) {
    if (!inbox.warned && inbox.bal != null) {
      inbox.warned = true;
      say(`ℹ️ Inbox route is off: the bot wallet has ${fmtH(num(inbox.bal))} on HyperEVM. Send about 0.5 HYPE to <code>${account.address}</code> on <b>HyperEVM</b> (not Elysium) to turn it on; each trade's post costs about ${fmtH(93000 * inboxGwei() / 1e9)} there at ${inboxGwei()} gwei. Trades still go by RPC meanwhile.`).catch(() => {});
    }
    return null;
  }
  const msg = '04' + raw.slice(2);
  const len = msg.length / 2;
  const data = '0xb75436bb' + (32).toString(16).padStart(64, '0') + len.toString(16).padStart(64, '0') + msg.padEnd(Math.ceil(len / 32) * 64, '0');
  const nonce = inbox.nonce;
  inbox.nonce = nonce + 1;
  const htx = await account.signTransaction({ chainId: 999, type: 'legacy', nonce, to: ELY_INBOX, value: 0n, data, gas: INBOX_GAS, gasPrice: inboxWei() });
  try { await Promise.any(HYPER_RPCS.map((u) => call1(u, 'eth_sendRawTransaction', [htx], 8000))); }
  catch (agg) {
    const why = (agg.errors || [agg]).map((e) => e?.message || '').join(' | ');
    if (/already known|known transaction/i.test(why)) return keccak256(htx);
    inbox.nonce = null; // resynced from HyperEVM before the next post
    throw new Error(`inbox post failed: ${why.slice(0, 160)}`);
  }
  inbox.bal -= INBOX_GAS * inboxWei(); // worst case; the refresh every few minutes puts the real balance back
  inbox.posts++; inbox.last = Date.now();
  return keccak256(htx);
}
// posts go out one at a time so their HyperEVM nonces stay in order (an approve's post before its swap's)
let inboxQ = Promise.resolve();
const inboxQueue = (raw) => { const p = inboxQ.then(() => inboxSend(raw)); inboxQ = p.catch(() => {}); return p; };
const signed = new Map(); // hash → the signed tx and its nonce, kept so a lost send can be pushed again
// receipts: for the first 2 minutes every live node is asked at once and the first node that HAS the receipt wins
// (a node that has not seen the block yet no longer answers "nothing" for all of them). Elysium can take tens of
// seconds to include a transaction while its sequencer is not public, so a slow one is waited for, never called
// failed: with no receipt yet the same signed transaction goes to every node and relay again at 4, 10, 20, 40 and
// 80 s (same hash, it cannot land twice). It counts as dropped only when, after 3 minutes, no node knows it AND
// the wallet's nonce is still unused; then the nonce is resynced so later trades do not queue behind it.
// onSlow fires once at 20 s so the chat can say it is still landing.
async function receipt(hash, maxMs = 2 * 3600 * 1000, onSlow) {
  const t0 = Date.now();
  const s = signed.get(hash);
  let pushes = 0, slow = false, checked = 0;
  while (Date.now() - t0 < maxMs) {
    const el = Date.now() - t0;
    try { const r = el < 120000 ? await race('eth_getTransactionReceipt', [hash], 3000, true) : await rpc('eth_getTransactionReceipt', [hash], 3); if (r) { if (s) inflight.delete(s.nonce); return r; } } catch {}
    if (s && pushes < 5 && el > [4000, 10000, 20000, 40000, 80000][pushes]) { pushes++; broadcast(s.raw).catch(() => {}); }
    if (!slow && el > 20000) { slow = true; if (onSlow) await Promise.resolve().then(onSlow).catch(() => {}); } // awaited, so the final edit always comes after it
    if (el > 180000 && checked === 0) {
      checked++;
      const seen = await Promise.all(SEND_RPCS.map((u) => call1(u, 'eth_getTransactionByHash', [hash], 5000).catch(() => undefined)));
      const used = s ? await rpc('eth_getTransactionCount', [me, 'latest']).then((n) => Number(BigInt(n)) > s.nonce).catch(() => true) : true;
      if (!used && !seen.some((x) => x)) {
        for (const n of [...inflight.keys()]) if (n >= s.nonce) inflight.delete(n); // anything sent after it is stuck behind the gap
        await serial(resyncNonce);
        return { status: 'dropped' };
      }
    }
    await sleep(el < 30000 ? 300 : el < 120000 ? 1000 : 15000);
  }
  return null;
}

// ── tokens, prices ─────────────────────────────────────────────────────────────────────────────────
const meta = {};
async function tokenMeta(t) {
  if (meta[t]) return meta[t];
  const [s, d, sup] = await Promise.all([
    ethCall(t, '0x95d89b41', {}, undefined, true).then(decStr).catch(() => '?'),
    ethCall(t, '0x313ce567', {}, undefined, true).then((r) => Number(u256(r))).catch(() => 18),
    ethCall(t, '0x18160ddd', {}, undefined, true).then(u256).catch(() => 0n),
  ]);
  return (meta[t] = { sym: (s || '?').replace(/[^\w$.+\- ]/g, '').slice(0, 20) || '?', d, sup });
}
const balOf = async (t, w = me, fast = false) => u256(await ethCall(t, enc('70a08231', w), {}, undefined, fast));
const hypeBal = async (fast = false) => BigInt(await (fast ? race : rpc)('eth_getBalance', [me, 'latest']));
// as of a given block (a receipt's): a node that does not have that block yet errors and drops out of the race
const balAt = async (block) => BigInt(await race('eth_getBalance', [me, block]));
const tokAt = async (t, block, w = me) => u256(await race('eth_call', [{ to: t, data: enc('70a08231', w) }, block]));
const allowanceOf = async (t, spender = ROUTER) => u256(await ethCall(t, enc('dd62ed3e', me, spender), {}, undefined, true));
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
// wrapped pools: swap(path, amountIn, minOut, recipient, unwrapOut, deadline), path = [(currency0, currency1, fee,
// tickSpacing, hooks, zeroForOne)]; amountIn equals the HYPE sent on a buy, unwrapOut pays native HYPE on a sell
const wSwap = (r, t, buy, amt, minOut, to, dl) => {
  const [c0, c1] = r.qFirst ? [r.q, t] : [t, r.q];
  return enc('0ee97731', 192, amt, minOut, to, buy ? 0 : 1, dl, 1, c0, c1, r.fee, r.ts, r.hook, buy === r.qFirst ? 1 : 0);
};
// ABI encoding of f(bytes[]) for multicall
const encBytesArray = (sel, items) => {
  const parts = items.map(strip);
  let off = parts.length * 32;
  const offs = [], body = [];
  for (const h of parts) {
    const n = h.length / 2, padded = h.padEnd(Math.ceil(n / 32) * 64, '0');
    offs.push(word(off)); body.push(word(n) + padded); off += 32 + padded.length / 2;
  }
  return '0x' + sel + word(32) + word(parts.length) + offs.join('') + body.join('');
};
// v3 SwapRouter: exactInputSingle(tokenIn, tokenOut, fee, recipient, deadline, amountIn, minOut, priceLimit); a sell
// swaps into WHYPE held by the router, then unwrapWETH9(minOut, recipient) pays native HYPE
const wOf = (r) => r.whype || V3WHYPE; // routes saved before forks had their own WHYPE are BOXA v2 / StockiumSwap
const v3Buy = (r, t, wei, minOut, to, dl) => enc('414bf389', wOf(r), t, r.fee, to, dl, wei, minOut, 0);
const v3Sell = (r, t, amt, minOut, to, dl) => encBytesArray('ac9650d8', [enc('414bf389', t, wOf(r), r.fee, r.router, dl, amt, minOut, 0), enc('49404b7c', minOut, to)]);
// Signal: the PoolKey inline (currency0, currency1, fee, tickSpacing, hooks); a sell is the coin into WHYPE, unwrapped
const sigKey = (r, t) => [...(r.qFirst ? [r.q, t] : [t, r.q]), r.fee, r.ts, r.hook];
const sigBuy = (r, t, minOut, to, dl) => enc('31561a35', ...sigKey(r, t), minOut, to, to, dl);
const sigSell = (r, t, amt, minOut, to, dl) => enc('38aad789', ...sigKey(r, t), r.qFirst ? 0 : 1, amt, minOut, to, 1, dl);
// routes paid in a token through a Universal Router (Ascend's, or Uniswap's for a coin paired with a token), and
// Uniswap routes that take and pay native HYPE whatever the pair
const tokRoute = (r) => r?.kind === 'ascend' || (r?.kind === 'uni' && r.mode === 'token');
const uniNative = (r) => r?.kind === 'uni' && r.mode !== 'token';
const isPool = (r) => r?.kind === 'v4' || r?.kind === 'wv4' || r?.kind === 'v3' || r?.kind === 'curve' || r?.kind === 'ascend' || r?.kind === 'uni' || r?.kind === 'gated' || r?.kind === 'pcurve' || r?.kind === 'signal';
const routerOf = (r) => (r?.kind === 'ascend' || r?.kind === 'uni' ? r.ur || ROUTER : r?.kind === 'wv4' ? WROUTER : r?.kind === 'v3' || r?.kind === 'curve' || r?.kind === 'gated' || r?.kind === 'pcurve' || r?.kind === 'signal' ? r.router : ROUTER);
const ROUTERS = new Set([ROUTER, WROUTER, SIGNAL.router, ...V3DEX.map((x) => x.router), ...CURVES.map((x) => x.curve), ...Object.values(GATED).map((x) => x.router)]);
const curveOf = (r) => CURVES.find((x) => x.curve === r.router) || CURVES[0];
// curve trades go to msg.sender, so `to` is unused there (the bot and the sell check helper both call it directly)
const buyData = (r, t, wei, minOut, to, dl) => (r.kind === 'signal' ? sigBuy(r, t, minOut, to, dl) : r.kind === 'uni' ? uniBuyData(r, t, wei, minOut, dl) : r.kind === 'gated' ? enc(r.bs, minOut, dl, 96, 0) : r.kind === 'pcurve' ? enc(PC.buy, minOut, dl) : r.kind === 'curve' ? enc(r.amm ? curveOf(r).ammBuy : curveOf(r).buy, t, wei, minOut, dl) : r.kind === 'wv4' ? wSwap(r, t, true, wei, minOut, to, dl) : r.kind === 'v3' ? v3Buy(r, t, wei, minOut, to, dl) : v4Buy(r, t, minOut, to, dl));
const sellData = (r, t, amt, minOut, to, dl) => (r.kind === 'signal' ? sigSell(r, t, amt, minOut, to, dl) : r.kind === 'uni' ? uniSellData(r, t, amt, minOut, dl) : r.kind === 'gated' ? enc(r.ss, amt, minOut, dl, 128, 0) : r.kind === 'pcurve' ? enc(PC.sell, amt, minOut, dl) : r.kind === 'curve' ? enc(r.amm ? curveOf(r).ammSell : curveOf(r).sell, t, amt, minOut, dl) : r.kind === 'wv4' ? wSwap(r, t, false, amt, minOut, to, dl) : r.kind === 'v3' ? v3Sell(r, t, amt, minOut, to, dl) : v4Sell(r, t, amt, minOut, to, dl));
// a sell quote is the swap alone (a multicall answers with bytes[]); WHYPE out of a v3 swap = HYPE after the unwrap
const sellQuoteData = (r, t, amt) => (r.kind === 'curve' ? enc(curveOf(r).qSell, t, amt) : r.kind === 'v3' ? enc('414bf389', t, wOf(r), r.fee, r.router, 2 ** 31 - 1, amt, 0, 0) : sellData(r, t, amt, 0, me, 2 ** 31 - 1));
// byte offset of the amount inside a sell's calldata, for the sell check helper that writes the bag there
const amtOffset = (r, t) => { const M = 0xabcdef0123456789abcdef0123456789n; return strip(sellData(r, t, M, 0, SIM, 2 ** 31 - 1)).indexOf(word(M)) / 2; };
const routeLabel = (r) => (r.kind === 'uni' ? r.name : r.kind === 'ascend' ? `Ascend ${r.q === ZERO ? 'HYPE' : meta[r.q]?.sym || 'USDC'} pool` : r.kind === 'curve' ? (r.amm ? `${r.name} ${curveOf(r).v4 ? 'v4 pool' : 'pair'} (graduated)` : `${r.name} bonding curve`) : r.kind === 'gated' ? `${r.name} router` : r.kind === 'pcurve' ? `${r.name} (its own bonding curve)` : r.kind === 'v3' ? `${r.name} ${r.fee / 10000}% pool` : `${r.name} v4`);
const sigRoute = (p) => ({ kind: 'signal', name: 'Signal', router: SIGNAL.router, pm: p.pm, fee: p.fee, ts: p.ts, hook: p.hook, q: p.q, qFirst: p.qFirst, b: p.b });
const routeOf = (p) => (p.kind === 'signal' ? sigRoute(p) : p.kind === 'ascend' ? ascRoute(p, ascUr(p.pm)) : p.uni ? uniRoute(p) : p.q
  ? { kind: 'wv4', name: pmName(p.pm) + ' WHYPE', pm: p.pm, fee: p.fee, ts: p.ts, hook: p.hook, q: p.q, qFirst: p.qFirst }
  : { kind: 'v4', name: HOOK_NAMES[p.hook] || pmName(p.pm), pm: p.pm, fee: p.fee, ts: p.ts, hook: p.hook });

async function v4QuoteBuy(r, t, wei) {
  if (uniNative(r)) return (await ascSim(r, t, { qAmt: wei, sell: false })).got;
  if (tokRoute(r)) return ascQuoteBuy(r, t, wei);
  if (r.kind === 'pcurve') return u256(await ethCall(r.router, enc(PC.qBuy, wei), {}, undefined, true));
  if (r.kind === 'curve') return r.amm && !curveOf(r).v4 ? ammQuote(r, t, wei, true) : u256(await ethCall(r.router, enc(curveOf(r).qBuy, t, wei))); // its buy() returns nothing
  const data = buyData(r, t, wei, 0, SIM, 2 ** 31 - 1);
  return u256(await ethCall(routerOf(r), data, { from: SIM, value: hex(wei) }, { [SIM]: { balance: hex(wei + 10n ** 21n) } }));
}
// a graduated curve coin: x·y = k on its pair, the fee taken on the HYPE side (in on a buy, out on a sell)
async function ammQuote(r, t, amt, buy) {
  const [res, t0] = await Promise.all([ethCall(r.pair, '0x0902f1ac', {}, undefined, true), ethCall(r.pair, '0x0dfe1681', {}, undefined, true)]);
  const h = strip(res), a = BigInt('0x' + h.slice(0, 64)), b = BigInt('0x' + h.slice(64, 128));
  const [rT, rW] = lc('0x' + strip(t0).slice(24)) === t ? [a, b] : [b, a];
  const keep = BigInt(10000 - (r.fee ?? 125));
  if (buy) { const x = (amt * keep) / 10000n; return (rT * x) / (rW + x); }
  return ((rW * amt) / (rT + amt)) * keep / 10000n;
}
// gas limit: an estimate with room to spare (heavy transfer logic, an ERC-404 minting an NFT per unit), or a
// generous default when the estimate failed. Only the gas used is charged, so a high limit costs nothing.
const GAS_DEF = { uni: 3000000, gated: 12000000 }; // gated: about 85 ERC-404 units, when no estimate came back
const gasFor = (r, est) => Math.min(31000000, est ? Math.max(Math.ceil(est * 1.5) + 100000, 400000) : GAS_DEF[r.kind] || 2000000);
async function estGas(r, t, wei) {
  try { return Number(BigInt(await race('eth_estimateGas', [{ from: me, to: routerOf(r), value: hex(wei), data: buyData(r, t, wei, 0, me, deadline()) }]))); }
  catch { return null; }
}
// allowance(me, ROUTER) lives at keccak(spender, keccak(owner, base)); find base once so sells can be quoted before approving
async function allowanceSlot(t, spender) {
  const key = t + ':' + spender;
  if (key in state.slots) return state.slots[key];
  const max = '0x' + 'f'.repeat(64);
  // every candidate at once: one round trip instead of up to thirteen
  const slots = Array.from({ length: 13 }, (_, base) => keccak256(concat([vpad(spender), keccak256(concat([vpad(me), vpad(toHex(base))]))])));
  const hits = await Promise.all(slots.map((slot) => ethCall(t, enc('dd62ed3e', me, spender), {}, { [t]: { stateDiff: { [slot]: max } } }).then((r) => u256(r) === MAX256).catch(() => false)));
  state.slots[key] = slots[hits.indexOf(true)] ?? null; save();
  return state.slots[key];
}
async function v4QuoteSell(r, t, amt, slot) {
  if (uniNative(r)) return (await ascSim(r, t, { buy: false, sellAmt: amt })).back;
  if (tokRoute(r)) return ascQuoteSell(r, t, amt);
  if (r.kind === 'pcurve') return u256(await ethCall(r.router, enc(PC.qSell, amt), {}, undefined, true)); // a view
  if (r.kind === 'curve') return r.amm && !curveOf(r).v4 ? ammQuote(r, t, amt, false) : u256(await ethCall(r.router, sellQuoteData(r, t, amt))); // a view: no allowance needed
  const data = sellQuoteData(r, t, amt);
  const ov = slot ? { [t]: { stateDiff: { [slot]: '0x' + 'f'.repeat(64) } } } : undefined;
  return u256(await ethCall(routerOf(r), data, { from: me }, ov, true));
}
async function kyber(path, body, ms = 10000) {
  const r = await fetch(KYBER + path, { method: body ? 'POST' : 'GET', headers: { 'x-client-id': KYBER_ID, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) }).then((x) => x.json());
  if (r.code !== 0 || !r.data) throw new Error(r.message === 'route not found' || r.message === 'token not found' ? 'no KyberSwap route' : `KyberSwap: ${r.message}`);
  return r.data;
}
const kyRoute = (tin, tout, amt, ms) => kyber(`/routes?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amt}`, undefined, ms);
const kyBuild = (sum, slip) => kyber('/route/build', { routeSummary: sum, sender: me, recipient: me, slippageTolerance: Number(slip), deadline: deadline() });

// ── Ascend (PancakeSwap Infinity fork) ───────────────────────────────────────────────────────────────
const ascQuotes = () => new Set([...ASCEND_QUOTES, ...Object.keys(state.asc?.quotes || {}), ...(state.set?.ascquote ? [state.set.ascquote] : [])]);
// seconds after launch before a snipe buys: set by hand, or null (auto: the fee schedule is read by simulation)
const ascDelay = () => { const v = state.set.ascdelay ?? process.env.ASCEND_DELAY; return v == null || v === '' || v === 'auto' ? null : Number(v); };
const ascDelayText = () => (ascDelay() == null ? 'as soon as its anti-snipe fee is gone' : `${ascDelay()} s after launch`);
const ascUr = (pm) => lc(state.asc.ur[pm] || state.set.ascrouter || process.env.ASCEND_ROUTER || '');
// ABI pieces for the Universal Router: execute(bytes commands, bytes[] inputs, uint256 deadline), INFI_SWAP (0x10)
// carrying (bytes actions, bytes[] params); actions CL_SWAP_EXACT_IN_SINGLE 06, SETTLE_ALL 0c, TAKE_ALL 0f
const pad32 = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const abiBytes = (h) => word(h.length / 2) + pad32(h);
const abiBytesArr = (items) => {
  let off = items.length * 32;
  const offs = [], body = [];
  for (const h of items) { const e = abiBytes(h); offs.push(word(off)); body.push(e); off += e.length / 2; }
  return word(items.length) + offs.join('') + body.join('');
};
const infiSwap = (actions, params) => { const A = abiBytes(actions); return word(64) + word(64 + A.length / 2) + A + abiBytesArr(params); };
const urExecute = (commands, inputs, dl) => { const C = abiBytes(commands); return '0x3593564c' + word(96) + word(96 + C.length / 2) + word(dl) + C + abiBytesArr(inputs); };
const ascKey = (r, t) => (r.qFirst ? [r.q, t] : [t, r.q]).concat([r.hook, r.pm, r.fee, r.params]);
const ascSwapParam = (r, t, zfo, amt, minOut) => word(32) + [...ascKey(r, t), zfo ? 1 : 0, amt, minOut, 320].map(word).join('') + word(0);
// buy: the quote in (native HYPE from msg.value, or pulled through Permit2), the coin out to the sender
const ascBuyData = (r, t, qAmt, minOut, dl) => urExecute('10', [infiSwap('060c0f', [ascSwapParam(r, t, r.qFirst, qAmt, minOut), word(r.q) + word(qAmt), word(t) + word(minOut)])], dl);
const ascSellData = (r, t, amt, minOut, dl, settleMax = amt) => urExecute('10', [infiSwap('060c0f', [ascSwapParam(r, t, !r.qFirst, amt, minOut), word(t) + word(settleMax), word(r.q) + word(minOut)])], dl);

// ── Uniswap v4 pools paired with a token instead of native HYPE (kind 'uni') ───────────────────────────
// Launchpads on the official Uniswap v4 (pool manager UNI_PM) pair coins with WHYPE or with a token such as KNTQ.
// They trade through Uniswap's Universal Router, still one transaction with native HYPE in and out:
//   wrap: WHYPE pools. Buy = WRAP_ETH into the router, swap, settle the WHYPE from the router, take the coin.
//         Sell = swap, settle the coin (pulled through Permit2), take WHYPE to the router, UNWRAP_WETH to the wallet.
//   hop:  token pools (KNTQ). Buy = HYPE → token on a native pool of the same manager, then token → coin (the second
//         swap spends the whole credit of the first), settle HYPE, take the coin. Sell is the mirror.
// Its swap struct has one more word than Uniswap's original (read off a live KNTQ buy): poolKey, zeroForOne,
// amountIn, amountOutMinimum, a per-hop price limit (0 = none), hookData.
const UNI_PM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1';
const UNI_UR = lc(process.env.UNI_ROUTER || '0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a');
const UNI_WETH = '0xba876237b0f021a6c6d852d6c26e107997cc5e81'; // the WETH9 inside that router
const KNTQ = '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0';
const HOP_QUOTES = new Set([KNTQ, ...String(process.env.HOP_QUOTES || '').toLowerCase().split(',').filter(Boolean)]);
// native pools for the first leg, used until the index has them (fees in millionths: KNTQ's are 5%, 10%, 20%)
const HOP_LEGS = { [KNTQ]: [{ fee: 50000, ts: 60, hook: ZERO }, { fee: 100000, ts: 60, hook: ZERO }, { fee: 200000, ts: 60, hook: ZERO }] };
const uniSingle = (key, zfo, amt, minOut) => word(32) + [...key, zfo ? 1 : 0, amt, minOut, 0, 320].map(word).join('') + word(0);
const uniKey = (r, t) => [...(r.qFirst ? [r.q, t] : [t, r.q]), r.fee, r.ts, r.hook];
const legKey = (r) => [ZERO, r.q, r.h.fee, r.h.ts, r.h.hook];
// token: a coin paired with a token, swapped straight from that token (pulled through Permit2) and back into it
function uniBuyData(r, t, wei, minOut, dl) {
  if (r.mode === 'token') return urExecute('10', [infiSwap('060c0f', [uniSingle(uniKey(r, t), r.qFirst, wei, minOut), word(r.q) + word(wei), word(t) + word(minOut)])], dl);
  if (r.mode === 'wrap') return urExecute('0b10', [word(2) + word(wei), infiSwap('060b0f', [uniSingle(uniKey(r, t), r.qFirst, wei, minOut), word(r.q) + word(wei) + word(0), word(t) + word(minOut)])], dl);
  return urExecute('10', [infiSwap('06060c0f', [uniSingle(legKey(r), true, wei, 0), uniSingle(uniKey(r, t), r.qFirst, 0, minOut), word(ZERO) + word(wei), word(t) + word(minOut)])], dl);
}
function uniSellData(r, t, amt, minOut, dl, settleMax = amt) {
  if (r.mode === 'token') return urExecute('10', [infiSwap('060c0f', [uniSingle(uniKey(r, t), !r.qFirst, amt, minOut), word(t) + word(settleMax), word(r.q) + word(minOut)])], dl);
  if (r.mode === 'wrap') return urExecute('100c', [infiSwap('060c0e', [uniSingle(uniKey(r, t), !r.qFirst, amt, 0), word(t) + word(settleMax), word(r.q) + word(2) + word(0)]), word(1) + word(minOut)], dl);
  return urExecute('10', [infiSwap('06060c0f', [uniSingle(uniKey(r, t), !r.qFirst, amt, 0), uniSingle(legKey(r), false, 0, minOut), word(t) + word(settleMax), word(ZERO) + word(minOut)])], dl);
}
const urBuyData = (r, t, qAmt, minOut, dl) => (r.kind === 'uni' ? uniBuyData(r, t, qAmt, minOut, dl) : ascBuyData(r, t, qAmt, minOut, dl));
const urSellData = (r, t, amt, minOut, dl, settleMax = amt) => (r.kind === 'uni' ? uniSellData(r, t, amt, minOut, dl, settleMax) : ascSellData(r, t, amt, minOut, dl, settleMax));
const uniLegs = (r) => {
  const seen = new Set(), out = [];
  for (const x of [...(state.pools[r.q] || []).filter((p) => p.pm === r.pm && !p.q && !p.uni && p.kind !== 'ascend'), ...(HOP_LEGS[r.q] || [])]) {
    const k = `${x.fee}:${x.ts}:${x.hook}`;
    if (!seen.has(k)) { seen.add(k); out.push({ fee: x.fee, ts: x.ts, hook: x.hook }); }
  }
  return out.sort((a, b) => a.fee - b.fee); // cheapest first: the default leg when there is no time to quote them all
};
const uniRoute = (p, h) => {
  const qs = p.q === KNTQ ? 'KNTQ' : meta[p.q]?.sym || short(p.q);
  const name = p.uni === 'wrap' ? 'Uniswap WHYPE' : p.uni === 'token' ? `Uniswap ${qs} pair (${qs} bought first)` : `Uniswap via ${qs}`;
  const r = { kind: 'uni', mode: p.uni, name, pm: p.pm, fee: p.fee, ts: p.ts, hook: p.hook, q: p.q, qFirst: p.qFirst, ur: UNI_UR };
  if (p.uni === 'hop') r.h = h || uniLegs(r)[0] || null;
  return r;
};
// every first leg of a hop route, so the best one can be picked by quote
// a pool paired with any token ('pair'): one hop route per HYPE pool that token has on the same manager, and the
// two-step route through the token itself; the best quote wins
const uniExpand = (r) => {
  if (r.kind !== 'uni') return [r];
  if (r.mode === 'hop') return uniLegs(r).map((h) => ({ ...r, h }));
  if (r.mode === 'pair') return [...uniLegs(r).map((h) => uniRoute({ ...r, uni: 'hop' }, h)), uniRoute({ ...r, uni: 'token' })].map((v) => ({ ...v, pair: true }));
  return [r];
};
// Simulation helper (hand-assembled, only ever placed at SIM through a state override). Calldata words: router,
// coin, buyLen, sellLen, amount offset in sellData, quote (0 = native), Permit2, flags (1: approve the quote
// before buying, 2: proceeds are native), then buyData and sellData. It approves through Permit2 itself, buys,
// reads its coin balance, sells that balance back and returns (got, back); reverts with 1 (buy), 2 (balance),
// 3 (sell), 4/5 (approvals). Checked against Ascend's testnet pools: 5 USDC in, 4.9006 USDC back (1% each way).
const ASC_CODE = '0x36156101e55760e0356001161561007f5763095ea7b360e01b60005260c0356004526000196024526000600060446000600060a0355af115610208576387517c4560e01b60005260a035600452600035602452600160a01b60019003604452600160301b600190036064526000600060846000600060c0355af115610213575b60403580156100a45780610100612000376000600082612000346000355af1156101e7575b506370a0823160e01b6000523060045260206000602460006020355afa156101f25760005160603580156101d95763095ea7b360e01b60005260c035600452600019602452600060006044600060006020355af115610208576387517c4560e01b600052602035600452600035602452600160a01b60019003604452600160301b600190036064526000600060846000600060c0355af1156102135780604035610100016130003781608035613000015260e03560021660a0351517610189576370a0823160e01b60005230600452602060006024600060a0355afa5060005161018b565b475b600060008361300060006000355af1156101fd5760e03560021660a03515176101d3576370a0823160e01b60005230600452602060006024600060a0355afa506000516101d5565b475b0390505b60205260005260406000f35b005b600160005260206000fd5b600260005260206000fd5b600360005260206000fd5b600460005260206000fd5b600560005260206000fd';
const ASC_MARK = 0xabcdef0123456789abcdef0123456789n;
// The storage slot of SIM's balance in a token, so a simulation can hand the helper tokens. Tried in order: the
// slot found before for this token or its launchpad (coins of one launchpad share a layout), the usual mapping
// slots (0-12; 51 for bridged OpenZeppelin-upgradeable tokens such as Elysium's USDC; the OpenZeppelin 5 namespace;
// Solady's seed), then slots 13-60.
const OZ5_ERC20 = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const mapSlot = (base) => keccak256(concat([vpad(SIM), vpad(toHex(base))]));
const SLOT_GROUPS = () => [
  [...Array.from({ length: 13 }, (_, i) => mapSlot(i)), mapSlot(51), mapSlot(OZ5_ERC20), keccak256(concat([SIM, '0x000000000000000087a211a2']))],
  Array.from({ length: 24 }, (_, i) => mapSlot(13 + i)),
  Array.from({ length: 24 }, (_, i) => mapSlot(37 + i)),
];
const slotSeen = new Set();
async function simSlot(t, hint) {
  const probe = async (s) => {
    const r = await ethCall(t, enc('70a08231', SIM), {}, { [t]: { stateDiff: { [s]: '0x' + word(123456789n) } } }).catch(() => null);
    return !!r && u256(r) === 123456789n;
  };
  const known = state.asc.slot[t] ?? (hint ? state.asc.slot[hint] : undefined);
  if (known && slotSeen.has(t + known)) return known; // checked once this run: no extra round trip
  let s = known && (await probe(known)) ? known : null;
  for (const g of SLOT_GROUPS()) {
    if (s) break;
    s = g[(await Promise.all(g.map(probe))).indexOf(true)] || null;
  }
  if (!s) return null;
  slotSeen.add(t + s);
  if (state.asc.slot[t] !== s || (hint && state.asc.slot[hint] !== s)) { state.asc.slot[t] = s; if (hint) state.asc.slot[hint] = s; save(); }
  return s;
}
// buy and/or sell through the helper, as of now or as of `time` (a block-time override, for the seconds after launch)
async function ascSim(r, t, { qAmt = 0n, sellAmt = 0n, buy = true, sell = true, time = null } = {}) {
  if (!r.ur) throw new Error('Ascend router not known yet');
  const native = r.q === ZERO || uniNative(r); // uni routes take and pay native HYPE whatever the pair (token mode aside)
  const bd = buy ? strip(urBuyData(r, t, qAmt, 0n, 2 ** 31 - 1)) : '';
  const sd = sell ? strip(urSellData(r, t, ASC_MARK, 0n, 2 ** 31 - 1, MAX256)) : '';
  const off = sell ? sd.indexOf(word(ASC_MARK)) / 2 : 0;
  const flags = (buy && !native ? 1 : 0) | (native ? 2 : 0);
  const data = '0x' + [r.ur, t, bd.length / 2, sd.length / 2, off, native ? ZERO : r.q, PERMIT2, flags].map(word).join('') + bd + sd;
  const ov = { [SIM]: { code: ASC_CODE, balance: hex((buy && native ? qAmt : 0n) + 10n ** 22n) } };
  if (buy && !native) {
    const s = await simSlot(r.q);
    if (!s) throw new Error('cannot simulate: unknown balance layout of the quote token');
    ov[r.q] = { stateDiff: { [s]: '0x' + word(qAmt) } };
  }
  if (!buy) {
    const s = await simSlot(t, r.hook);
    if (!s) throw new Error('cannot simulate: unknown balance layout of the coin');
    ov[t] = { stateDiff: { [s]: '0x' + word(sellAmt) } };
  }
  const params = [{ from: SIM, to: SIM, data, value: hex(buy && native ? qAmt : 0n), gas: hex(30000000) }, 'latest', ov];
  let res;
  if (time) {
    try { res = await race('eth_call', [...params, { time: hex(time) }]); }
    catch (e) { if (reverted(e)) throw e; res = await race('eth_call', params); } // no node takes a block time: as of now
  } else res = await race('eth_call', params);
  return { got: u256(res), back: BigInt('0x' + (strip(res).slice(64, 128) || '0')) };
}
// quote units per HYPE (1e18 for native HYPE): dollar quotes at the HYPE price, others at KyberSwap's price
const ascRates = {};
async function ascRate(q) {
  if (q === ZERO) return 10n ** 18n;
  const c = ascRates[q];
  if (c && Date.now() - c.t < 60000) return c.v;
  const m = await tokenMeta(q);
  let v = null;
  if (/usd/i.test(m.sym)) { const px = await hypeUsd(); if (px) v = (BigInt(Math.round(px * 1e6)) * 10n ** BigInt(m.d)) / 10n ** 6n; }
  // what the token's own best route pays for 0.1 HYPE (the pools the bot trades it on), else KyberSwap's price
  if (!v) { try { const qr = state.routes[q] || (await findRoute(q)); if (qr && !tokRoute(qr)) { const o = await quoteBuy(qr, q, 10n ** 17n); if (o > 0n) v = o * 10n; } } catch {} }
  if (!v) { try { v = BigInt((await kyRoute(NATIVE, q, 10n ** 18n)).routeSummary.amountOut); } catch {} }
  if (!v) throw new Error(`no HYPE price for ${m.sym}`);
  ascRates[q] = { v, t: Date.now() };
  return v;
}
const qOfWei = async (q, wei) => (wei * (await ascRate(q))) / 10n ** 18n;
const weiOfQ = async (q, amt) => (amt * 10n ** 18n) / (await ascRate(q));
// Ascend's testnet Universal Router: mainnet may reuse the address (same deployer and nonce). Its code holds
// execute() and, as immutables, its pool manager and the canonical Permit2 (checked on testnet).
const ASC_UR_GUESS = ['0x90332b0ecbb2c9517f405627b0dd5d5265246563'];
// the Universal Router of an Ascend pool manager: set by hand, the contract with execute() that its swaps come
// from, or the testnet address when the code there names this pool manager (before anyone trades through it)
async function ascRouterFor(pm) {
  const known = ascUr(pm);
  if (known) return known;
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  const logs = (await Promise.all([0, 1, 2].map((k) => rpc('eth_getLogs', [{ address: pm, topics: [T_SWAP_ASCEND], fromBlock: hex(Math.max(0, head - 2000 * (k + 1) + 1)), toBlock: hex(Math.max(0, head - 2000 * k)) }]).catch(() => [])))).flat();
  const n = {};
  for (const l of logs) { const a = lc('0x' + l.topics[2].slice(26)); n[a] = (n[a] || 0) + 1; }
  const cands = Object.keys(n).sort((x, y) => n[y] - n[x]).slice(0, 6).map((a) => [a, false]).concat(ASC_UR_GUESS.map((a) => [a, true]));
  for (const [a, guess] of cands) {
    const code = lc(await rpc('eth_getCode', [a, 'latest']).catch(() => '0x'));
    if (code.includes('3593564c') && (!guess || code.includes(pm.slice(2)))) { state.asc.ur[pm] = a; save(); return a; }
  }
  return null;
}
const ascRoute = (p, ur) => ({ kind: 'ascend', name: 'Ascend', pm: p.pm, hook: p.hook, fee: p.fee, params: p.params, q: p.q, qFirst: p.qFirst, ur: ur || null, b: p.b });
async function ascRouteOf(p) { const ur = await ascRouterFor(p.pm); return ur ? ascRoute(p, ur) : null; }
async function ascQuoteBuy(r, t, wei) { return (await ascSim(r, t, { qAmt: await qOfWei(r.q, wei), sell: false })).got; }
async function ascQuoteSell(r, t, amt) { return weiOfQ(r.q, (await ascSim(r, t, { buy: false, sellAmt: amt })).back); }
async function ascSellCheck(r, t, wei, time) {
  try {
    const uni = uniNative(r); // native in and out: no quote-token conversion
    const qAmt = uni ? wei : await qOfWei(r.q, wei);
    const { got, back } = await ascSim(r, t, { qAmt, time });
    const loss = 1 - num(back) / num(qAmt);
    return { ok: got > 0n && back > 0n && loss * 100 <= cfg().tax, got, back: uni ? back : await weiOfQ(r.q, back), loss, note: `sell check: round trip ${(loss * 100).toFixed(1)}%` };
  } catch (e) {
    const code = String(e.data || '').slice(-2);
    if (code === '03') return { ok: false, blocked: true, note: 'cannot be sold back (honeypot or sells blocked)' };
    return { ok: null, note: `sell check unavailable${/router not known/.test(e.message) ? ' (Ascend router not known yet)' : ''}` };
  }
}
// Permit2 route: the token approves Permit2, Permit2 lets the router pull it; both for good (burner wallet)
async function ascApprovals(token, ur, amt) {
  const [a, p] = await Promise.all([
    ethCall(token, enc('dd62ed3e', me, PERMIT2), {}, undefined, true).then(u256).catch(() => 0n),
    ethCall(PERMIT2, enc('927da105', me, token, ur), {}, undefined, true).then(strip).catch(() => ''),
  ]);
  const p2 = p ? BigInt('0x' + (p.slice(0, 64) || '0')) : 0n, exp = p ? Number(BigInt('0x' + (p.slice(64, 128) || '0'))) : 0;
  const txs = [];
  if (a < amt) txs.push({ to: token, data: enc('095ea7b3', PERMIT2, MAX256), gas: 120000 });
  if (p2 < amt || exp < Date.now() / 1000 + 600) txs.push({ to: PERMIT2, data: enc('87517c45', token, ur, (1n << 160n) - 1n, (1n << 48n) - 1n), gas: 120000 });
  return txs;
}
async function ascPreApprove(t, r) {
  if (approving.has(t)) return;
  const txs = await ascApprovals(t, r.ur, 1n << 128n);
  if (!txs.length) return;
  approving.add(t);
  try { await serial(async () => { for (const x of txs) await sendRaw(x); }); }
  catch (e) { approving.delete(t); throw e; }
}
// a new Ascend pool whose coin side is not obvious: the coin is the side that had no code before the launch block
const ascResolving = new Set();
async function resolveAscend(l, p) {
  if (ascResolving.has(p.id)) return;
  ascResolving.add(p.id);
  try {
    const before = hex(Math.max(0, p.b - 1));
    const [k0, k1] = await Promise.all([p.c0, p.c1].map((c) => rpc('eth_getCode', [c, before]).catch(() => null)));
    let q = null;
    if (k0 === '0x' && k1 && k1 !== '0x') q = p.c1;
    else if (k1 === '0x' && k0 && k0 !== '0x') q = p.c0;
    else {
      const [m0, m1] = await Promise.all([tokenMeta(p.c0), tokenMeta(p.c1)]);
      const qq = (m) => /usd|hype/i.test(m.sym);
      q = qq(m0) && !qq(m1) ? p.c0 : qq(m1) && !qq(m0) ? p.c1 : null;
    }
    if (!q) return;
    const t = q === p.c0 ? p.c1 : p.c0;
    const pp = { ...p, q, qFirst: q === p.c0 };
    const list = (state.pools[t] ||= []);
    if (list.some((y) => y.id === pp.id)) return;
    list.push(pp);
    delete state.routes[t];
    state.asc.quotes[q] = (state.asc.quotes[q] || 0) + 1;
    if (live) fresh.push({ t, ...pp, tx: lc(l.transactionHash || ''), newPm: !knownPms.has(pp.pm) });
    knownPms.add(pp.pm);
    save();
  } finally { ascResolving.delete(p.id); }
}
// a Uniswap pool pairing two tokens: the coin is the side that had no code before the launch block, the other side
// is the token it trades against. Both older than the pool: not a launch, left out.
async function resolvePair(l, p) {
  if (ascResolving.has(p.id)) return;
  ascResolving.add(p.id);
  try {
    const before = hex(Math.max(0, p.b - 1));
    const [k0, k1] = await Promise.all([p.c0, p.c1].map((c) => rpc('eth_getCode', [c, before]).catch(() => null)));
    const q = k0 === '0x' && k1 && k1 !== '0x' ? p.c1 : k1 === '0x' && k0 && k0 !== '0x' ? p.c0 : null;
    if (q) addPairPool(q === p.c0 ? p.c1 : p.c0, q, p, l);
  } finally { ascResolving.delete(p.id); }
}
function addPairPool(t, q, p, l) {
  const { c0, c1, pair, ...rest } = p;
  const pp = { ...rest, q, qFirst: q === c0, uni: 'pair' };
  const list = (state.pools[t] ||= []);
  const had = list.find((y) => y.id === pp.id);
  if (had) return had;
  list.push(pp);
  delete state.routes[t];
  tokenMeta(q).catch(() => {}); // its symbol, for the route's name
  if (live && l) fresh.push({ t, ...pp, tx: lc(l.transactionHash || ''), newPm: !knownPms.has(pp.pm) });
  knownPms.add(pp.pm);
  save();
  return pp;
}
// buy plan for an Ascend coin: amount in the quote, sell check (as of `time` for a snipe), approvals, the swap
async function ascPlanBuy(t, hypeAmt, wei, replyTo, force, src, opts, r, m, hBal) {
  const { slip } = cfg();
  if (r.kind === 'ascend') r.ur ||= await ascRouterFor(r.pm);
  if (!r.ur) throw new Error('Ascend router not known yet: set it with /ascend router 0x…');
  const native = r.q === ZERO;
  let [qAmt, qm, qBal] = await Promise.all([qOfWei(r.q, wei), native ? null : tokenMeta(r.q), native ? null : balOf(r.q, me, true)]);
  // not enough of the token the coin is paired with: buy it with HYPE first (step 1 of 2), unless /set pairbuy off
  const topUp = !native && qBal < qAmt && cfg().pairbuy && !opts.convert;
  if (native || topUp ? hBal < wei + 3n * 10n ** 15n : qBal < qAmt) {
    throw new Error(native || topUp ? `not enough HYPE: wallet has ${fmtH(num(hBal))}` : `not enough ${qm.sym}: wallet has ${fmt(num(qBal, qm.d))}, this buy needs ${fmt(num(qAmt, qm.d))}. ${m.sym} is paired with ${qm.sym}: send some to ${me}, or /set pairbuy on to buy it with HYPE first`);
  }
  if (!native && hBal < 2n * 10n ** 15n) throw new Error('need a little HYPE in the wallet for gas');
  const head = opts.label ? `${opts.label}\n` : '';
  // a snipe timed for the second the fee drops also prices the second before, for its minimum (below)
  const [sc, prev] = await Promise.all([ascSellCheck(r, t, wei, opts.ascTime),
    opts.sendAt && opts.ascTime ? ascSim(r, t, { qAmt, sell: false, time: opts.ascTime - 1 }).then((x) => x.got).catch(() => null) : null]);
  if (cfg().check && !force && sc.ok === false) {
    J({ side: 'refused', coin: t, sym: m.sym, hype: hypeAmt, src, sc: sc.loss ?? null, reason: sc.blocked ? 'cannot sell' : 'round trip too costly' });
    const why = sc.blocked ? `🚫 <b>${esc(m.sym)}</b> cannot be sold back in a simulation (honeypot or sells blocked).`
      : `⚠️ Buying <b>${esc(m.sym)}</b> and selling straight back loses <b>${(sc.loss * 100).toFixed(0)}%</b> (limit ${cfg().tax}%, change with /set tax).${sc.loss > 0.15 ? ' Ascend charges a falling anti-snipe fee for the first seconds after launch.' : ''}`;
    await say(`${head}${why}\nNot buying.`, [[{ text: `Buy ${hypeAmt} anyway`, callback_data: `f:${t.slice(2)}:${Math.round(hypeAmt * 10)}` }, { text: '🔎', callback_data: `c:${t.slice(2)}` }]], replyTo);
    return { refused: true };
  }
  // the sell check ran first, so a coin that cannot be sold back costs nothing; now the token itself
  if (topUp) {
    const res = await buy(r.q, hypeAmt, replyTo, force, src, { convert: true, label: `${head}1/2 · ${esc(m.sym)} trades against ${esc(qm.sym)}: buying ${esc(qm.sym)} first` });
    if (!res.ok) { if (res.refused) return { refused: true }; throw new Error(`could not buy ${qm.sym} first${res.error ? ': ' + res.error : ''}`); }
    qBal = await balOf(r.q, me, true).catch(() => res.got);
    qAmt = res.got > 0n && res.got < qBal ? res.got : qBal;
  }
  const expect = sc.got > 0n && !topUp ? sc.got : (await ascSim(r, t, { qAmt, sell: false, time: opts.ascTime })).got;
  let minOut = (expect * (10000n - slip)) / 10000n;
  // landing a second early means a higher fee: the minimum sits halfway between the two outcomes, so that reverts
  if (prev != null && prev > 0n && prev * 100n < expect * 98n && (prev + expect) / 2n > minOut) minOut = (prev + expect) / 2n;
  const txs = native ? [] : await ascApprovals(r.q, r.ur, qAmt);
  txs.push({ to: r.ur, value: native ? qAmt : 0n, data: urBuyData(r, t, qAmt, minOut, deadline()), gas: r.kind === 'uni' ? 1500000 : 900000 });
  if (!native) sc.note = `${topUp ? '2/2 · ' : ''}${fmt(num(qAmt, qm.d))} ${qm.sym}${sc.note ? ', ' + sc.note : ''}`;
  return { txs, expect, sc };
}
// when the anti-snipe fee is gone: the round trip simulated as of each second after launch, against the same trip
// ten minutes later (the pool's normal fee); the first second within half a percent of that. null if unreadable.
async function ascFeeDrop(r, t, t0, qAmt) {
  const loss = (time) => ascSim(r, t, { qAmt, time }).then((x) => 1 - num(x.back) / num(qAmt)).catch(() => null);
  const base = await loss(t0 + 600);
  if (base == null) return null;
  for (const ks of [[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14, 15], [20, 30, 45, 60, 90, 120]]) {
    const ls = await Promise.all(ks.map((k) => loss(t0 + k)));
    const i = ls.findIndex((x) => x != null && x <= base + 0.005);
    if (i >= 0) return { k: ks[i], base, loss: ls[i], first: ls[0] };
  }
  return { k: null, base };
}
// An Ascend coin in its first minutes: when its anti-snipe fee is gone ({ t0, at } while that second is still ahead,
// else null). Measured once per coin by simulating the round trip as of each second after launch, or the delay set
// with /ascend delay.
const ascDrops = {};
async function ascEarly(r, t, wei) {
  if (r.b == null) return null;
  let d = ascDrops[t];
  if (!d) {
    const blk = await rpc('eth_getBlockByNumber', [hex(r.b), false]);
    const t0 = Number(BigInt(blk.timestamp));
    let k = 0;
    if (Date.now() / 1000 - t0 < 300) {
      k = ascDelay();
      if (k == null) k = (await ascFeeDrop(r, t, t0, await qOfWei(r.q, wei)).catch(() => null))?.k ?? 5;
    }
    d = ascDrops[t] = { t0, at: t0 + k };
  }
  return Date.now() / 1000 < d.at ? d : null;
}
// A buy while the fee is still up: planned now, the swap sent the second the fee drops (its minimum is priced as of
// that second, so landing early reverts instead of paying the higher fee), tried again up to 3 times if it lands
// early or the price runs.
const ASC_MARGIN = Number(process.env.ASCEND_MARGIN_MS ?? 200); // ms after the second turns before sending
async function ascWaitBuy(t, hypeAmt, replyTo, force, src, opts, r, d) {
  const sendAt = d.at * 1000 + ASC_MARGIN;
  const label = `${opts.label ? opts.label + '\n' : ''}⏱ Anti-snipe fee still up: buying at +${d.at - d.t0} s after launch, the second it drops`;
  let res;
  for (let i = 0; i < 4; i++) {
    const sa = sendAt + i * 400;
    res = await buy(t, hypeAmt, replyTo, force, src, { ...opts, route: r, label, ascTime: Math.max(d.at, Math.floor(Date.now() / 1000)), sendAt: sa > Date.now() ? sa : 0,
      revertNote: i < 3 ? 'it landed before the fee dropped, or the price ran past your slippage; trying again' : null });
    if (!res?.reverted) return res;
    await sleep(300);
  }
  return res;
}
// /snipe ascend: buys the next launch on its own (the timing is the same as a tap, see ascEarly)
async function ascSnipe(f, s) {
  const label = `🎯 Ascend snipe: new coin <code>${short(f.t)}</code>`;
  try {
    let r = null;
    for (let i = 0; i < 80 && !r; i++) { r = await ascRouteOf(f).catch(() => null); if (!r) await sleep(250); } // its router shows up with the first trades
    if (!r) return say(`${label}\n⚠️ Ascend's router is not known and no trade revealed it within 20 s. Set it with /ascend router 0x…, then buy from the card.`);
    return await buy(f.t, s.hype, null, false, 'snipe', { route: r, label });
  } catch (e) { return say(`${label}\n⚠️ ${esc(e.message).slice(0, 200)}`); }
}
// New Ascend coins are posted the moment the index sees them, with buy buttons, so a launch can be bought early by
// hand. Up to 6 an hour (/ascend alerts off|on|N), then one note and quiet until the hour rolls over.
const ELYXA = 'https://elyxa.trade';
const ascAlerted = [];
let ascMuted = 0;
const ascCap = () => { const v = state.set.ascalerts ?? 6; return v === 'off' ? 0 : Number(v) || 6; };
async function ascAlert(f) {
  const cap = ascCap();
  if (!cap) return;
  const now = Date.now();
  while (ascAlerted.length && now - ascAlerted[0] > 3600000) ascAlerted.shift();
  if (ascAlerted.length >= cap) {
    if (now - ascMuted > 3600000) { ascMuted = now; await say(`🆕 Ascend is busy: ${cap} launches posted in the last hour, the rest stay quiet until it slows (/ascend alerts 20 raises the limit, /ascend alerts off stops them).`); }
    return;
  }
  ascAlerted.push(now);
  const [m, dev, r] = await Promise.all([tokenMeta(f.t), txFrom(f.tx), ascRouteOf(f).catch(() => null)]);
  const [devBal, d] = await Promise.all([dev ? balOf(f.t, dev, true).catch(() => null) : null, r ? ascEarly(r, f.t, 10n ** 18n).catch(() => null) : null]);
  const sup = m.sup ? num(m.sup, m.d) : 0;
  const qn = f.q === ZERO ? 'HYPE' : esc((await tokenMeta(f.q).catch(() => ({ sym: 'USDC' }))).sym);
  const devLine = dev ? `Dev <a href="${ELYXA}/#/portfolio?w=${dev}">${short(dev)}</a>${devBal != null && sup ? ` holds ${((num(devBal, m.d) / sup) * 100).toFixed(1)}%` : ''}\n` : '';
  const when = !r ? `⚠️ Ascend's router is not known yet, so ⚡ cannot buy until the first trades show it (or /ascend router 0x…).\n`
    : d ? `⏱ Anti-snipe fee is up until +${d.at - d.t0} s after launch. A ⚡ tap now waits for it and buys the second it drops.\n` : '';
  const h = f.t.slice(2);
  await say(`🆕 <b>Ascend launch</b> · <b>${esc(m.sym)}</b> · paired with ${qn} · <a href="${ELYXA}/#/terminal/${f.t}">chart</a>\n${devLine}${when}<code>${f.t}</code>`,
    [[...cfg().sizes.map((s) => ({ text: `⚡ ${s}`, callback_data: `b:${h}:${Math.round(Number(s) * 10)}` })), { text: '⚡ X', callback_data: `k:${h}` }, { text: '🔎', callback_data: `c:${h}` }]]);
}
async function ascStatus() {
  const pools = Object.values(state.pools).flat().filter((p) => p.kind === 'ascend');
  const qs = [...ascQuotes()];
  const qLines = await Promise.all(qs.map(async (q) => {
    if (q === ZERO) return 'native HYPE';
    const m = await tokenMeta(q).catch(() => ({ sym: '?', d: 18 }));
    const b = await balOf(q, me, true).catch(() => null);
    return `${esc(m.sym)} <code>${q}</code>${b != null ? ` · wallet ${fmt(num(b, m.d))}` : ''}`;
  }));
  const urs = { ...state.asc.ur };
  const armed = state.snipes.filter((x) => x.k === 'asc').map(snipeText).join(' · ');
  return `<b>Ascend</b>\nRouter: ${state.set.ascrouter ? `<code>${state.set.ascrouter}</code> (set)` : Object.keys(urs).length ? Object.entries(urs).map(([pm, u]) => `<code>${u}</code> (learned for ${short(pm)})`).join(', ') : 'not known yet (learned from the first trades, or /ascend router 0x…)'}\n` +
    `Quote: ${qLines.length ? qLines.join(' · ') : 'not known yet (learned from the first pool, or /ascend quote 0x…)'}\n` +
    `Pools indexed: ${pools.length}\n` +
    `New launches: ${ascCap() ? `posted here with ⚡ buttons, up to ${ascCap()} an hour` : 'not posted (/ascend alerts on)'}\n` +
    `A ⚡ tap while a coin's anti-snipe fee is up waits and buys ${ascDelay() == null ? 'the second it drops' : `${ascDelay()} s after launch`}\n` +
    (armed ? `Snipe armed: ${armed}\n` : '') +
    `\n/ascend router 0x… · /ascend quote 0x… · /ascend alerts off|on|20 · /ascend delay auto|5 · /ascend approve (approve the quote once, so the first buy is one transaction)`;
}

// ── live pool index: every v4 Initialize on Elysium, from any pool manager ─────────────────────────────
const pmName = (pm) => PM_NAMES[pm] || short(pm);
const knownPms = new Set();   // every pool manager that has ever had a pool (a new one = a new launchpad)
const fresh = [];             // pools seen live (after the first full index), for snipes
let live = false;
// a pool we can trade: native HYPE on any pool manager, or ElysPump's WHYPE on ElysPump (through WROUTER).
// Other WHYPE pairs go through KyberSwap.
function parseInit(l) {
  const c0 = lc('0x' + l.topics[2].slice(26)), c1 = lc('0x' + l.topics[3].slice(26)), pm = lc(l.address), d = strip(l.data);
  let t, q = null;
  if (l.topics[0] === T_INIT_ASCEND) {
    // which side is the coin: native HYPE or a known quote is the other side; otherwise it is settled on chain
    // (resolveAscend: the coin is the side that had no code before the launch block)
    const p = { pm, kind: 'ascend', fee: Number(BigInt('0x' + d.slice(64, 128))), params: '0x' + d.slice(128, 192), hook: '0x' + d.slice(24, 64), b: parseInt(l.blockNumber, 16), id: lc(l.topics[1]), c0, c1 };
    const qs = ascQuotes();
    const q = c0 === ZERO || qs.has(c0) ? c0 : qs.has(c1) ? c1 : null;
    if (q) { p.q = q; p.qFirst = q === c0; }
    return { t: q ? (q === c0 ? c1 : c0) : null, p };
  }
  // a Signal launch: its WHYPE pair on eleos's pool manager, traded through Signal's router
  const hk = '0x' + d.slice(152, 192);
  if (pm === SIGNAL.pm && hk === SIGNAL.hook && (c0 === SIGNAL.whype || c1 === SIGNAL.whype)) {
    const sq = SIGNAL.whype;
    return { t: sq === c0 ? c1 : c0, p: { pm, kind: 'signal', fee: Number(BigInt('0x' + d.slice(0, 64))), ts: Number(BigInt.asIntN(24, BigInt('0x' + d.slice(64, 128)))), hook: hk, b: parseInt(l.blockNumber, 16), id: lc(l.topics[1]), q: sq, qFirst: sq === c0 } };
  }
  let uni = null;
  if (c0 === ZERO) t = c1;
  else if (pm === ELYSPUMP_PM && WRAPPED.has(c0)) { t = c1; q = c0; }
  else if (pm === ELYSPUMP_PM && WRAPPED.has(c1)) { t = c0; q = c1; }
  // official Uniswap v4: WHYPE pairs and token pairs (KNTQ…) through Uniswap's Universal Router
  else if (pm === UNI_PM && (c0 === UNI_WETH || c1 === UNI_WETH)) { q = UNI_WETH; t = c0 === q ? c1 : c0; uni = 'wrap'; }
  else if (pm === UNI_PM && (HOP_QUOTES.has(c0) || HOP_QUOTES.has(c1))) { q = HOP_QUOTES.has(c1) ? c1 : c0; t = q === c0 ? c1 : c0; uni = 'hop'; }
  // any other token pair on Uniswap's manager (a coin launched against BOXA, USDC…): which side is the coin is
  // settled on chain (resolvePair)
  else if (pm !== UNI_PM) return null;
  const p = { pm, fee: Number(BigInt('0x' + d.slice(0, 64))), ts: Number(BigInt.asIntN(24, BigInt('0x' + d.slice(64, 128)))), hook: '0x' + d.slice(152, 192), b: parseInt(l.blockNumber, 16), id: lc(l.topics[1]) };
  if (!t) return { t: null, p: { ...p, c0, c1, pair: true } };
  if (q) { p.q = q; p.qFirst = q === c0; }
  if (uni) p.uni = uni;
  return { t, p };
}
function addPool(l) {
  const x = parseInit(l);
  if (!x) return 0;
  if (!x.t) { (x.p.pair ? resolvePair : resolveAscend)(l, x.p).catch((e) => console.error(x.p.pair ? 'pair pool' : 'ascend pool', e.message)); return 0; }
  const { t, p } = x, pm = p.pm;
  const list = (state.pools[t] ||= []);
  if (list.some((y) => y.id === p.id)) return 0;
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
      const res = await Promise.all(batch.map(([a, b]) => rpc('eth_getLogs', [{ fromBlock: hex(a), toBlock: hex(b), topics: [[T_INIT, T_INIT_ASCEND]] }], 4).catch(() => null)));
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

// a coin paired with a token: every way to trade it (through each HYPE pool that token has on the same manager, or
// through the token bought on its own best route), quoted at this exact size (HYPE in for a buy, coins for a sell)
const isPair = (t, r) => r?.kind === 'uni' && (r.pair || (state.pools[t] || []).some((p) => p.uni === 'pair' && p.pm === r.pm && p.hook === r.hook));
async function pairBest(t, r, amt, sell) {
  const pp = (state.pools[t] || []).find((p) => p.uni === 'pair' && p.pm === r.pm && p.hook === r.hook && p.fee === r.fee && p.ts === r.ts);
  if (!pp) return r;
  const vs = uniExpand(routeOf(pp));
  const outs = await Promise.all(vs.map((v) => (sell ? v4QuoteSell(v, t, amt) : v4QuoteBuy(v, t, amt)).catch(() => 0n)));
  let best = null, bo = 0n;
  outs.forEach((o, i) => { if (o > bo) { bo = o; best = vs[i]; } });
  return best || r;
}
// the same route, whatever object it sits in
const routeKey = (r) => [r.kind, r.mode, r.pm, r.fee, r.ts, r.hook, r.router, r.pool, r.q, r.h?.fee, r.h?.ts, r.h?.hook].join(':');
// another way in or out of the coin, when it pays at least 0.5% more than the current one at this exact size
function pickAlt(r, alts, outs) {
  let bi = -1;
  outs.forEach((o, i) => { if (o > 0n && (bi < 0 || o > outs[bi])) bi = i; });
  if (bi < 0) return r;
  const k = routeKey(r), ri = alts.findIndex((a) => routeKey(a) === k), rOut = ri >= 0 ? outs[ri] : 0n;
  return routeKey(alts[bi]) !== k && outs[bi] * 1000n > rOut * 1005n ? alts[bi] : r;
}
async function findRoute(t, fresh = false) {
  const kept = state.routes[t];
  // a KyberSwap route picked although the coin has pools of its own is looked at again after a while: its pools may
  // only have failed to answer (busy nodes)
  // (a route saved before routes were ranked at a real size is picked again when the coin has several ways in)
  const unranked = kept && state.alts[t] === undefined && ((state.pools[t] || []).length > 1 || isPair(t, kept));
  if (!fresh && kept && !(kept.again && Date.now() > kept.again) && !unranked) return kept;
  const probe = 10n ** 16n;
  const kyP = kyRoute(NATIVE, t, probe, 2500).then((k) => k.routeSummary).catch(() => null); // asked alongside the pools
  const quote = async (r) => { try { const out = await v4QuoteBuy(r, t, probe); return out > 0n ? { r, out } : null; } catch { return null; } };
  if (!state.pools[t]?.length) await indexPools().catch(() => {}); // a pool from the last few seconds
  const pools = state.pools[t] || [];
  await Promise.all(pools.filter((p) => p.uni === 'pair').map((p) => tokenMeta(p.q).catch(() => null)));
  let cands = pools.filter((p) => p.kind !== 'ascend').slice(-8).map(routeOf).flatMap(uniExpand);
  for (const p of pools.filter((x) => x.kind === 'ascend').slice(-2)) { const ar = await ascRouteOf(p).catch(() => null); if (ar) cands.push(ar); }
  if (!cands.length) cands = V4.map((x) => ({ kind: 'v4', name: x.name, pm: x.pm, hook: x.hook, fee: x.fee, ts: x.ts }));
  const g = GATED[t];
  if (g) cands.push({ kind: 'gated', name: g.name, router: g.router, bs: g.bs, ss: g.ss });
  cands = cands.concat(await v3Pools(t), await curvePools(t));
  // every pool the coin has, best price wins (a coin can sit on several launchpads)
  const good = (await Promise.all(cands.map(quote))).filter(Boolean).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  // ...ranked again at a real size (the smallest buy size): a near-empty pool looks as good as a deep one at 0.01 HYPE
  // and costs 90%+ at 1 HYPE (BMB, Nov 7: Uniswap's BOXA pool paid 24x less than BOXA's own). A route that cannot
  // take the bigger size (a buy cap) stays below those that can.
  if (good.length > 1) {
    const big = toWei(String(Math.max(0.1, Number(cfg().sizes[0]) || 1)));
    const outs = await Promise.all(good.map((x) => v4QuoteBuy(x.r, t, big).catch(() => 0n)));
    good.forEach((x, i) => { x.big = outs[i] > 0n ? outs[i] : 0n; });
    good.sort((a, b) => (a.big > 0n) !== (b.big > 0n) ? (a.big > 0n ? -1 : 1) : a.big !== b.big ? (b.big > a.big ? 1 : -1) : b.out > a.out ? 1 : b.out < a.out ? -1 : 0);
  }
  state.alts[t] = good.length > 1 ? good.slice(0, 6).map((x) => x.r) : [];
  let route = good[0]?.r || null;
  // KyberSwap reaches pools the index does not trade (other v3 forks, other wrapped-HYPE pairs). It also wins when it
  // pays clearly more than the best pool (measured Nov 6: one coin's only indexed pool paid half of what its v3 pool
  // did); that pool still runs the sell check, so a coin that cannot be sold is caught either way
  const kSum = await kyP, kOut = kSum ? BigInt(kSum.amountOut) : 0n;
  // ...but never when KyberSwap goes through one of the coin's own pools: it reads that pool's state seconds late, so in
  // a fast move it looks cheaper than it is (TESTICLES, Nov 6: a buy routed that way reverted on a 5% slippage)
  const own = new Set([...pools.map((p) => lc(p.id)), ...cands.filter((c) => c.pool).map((c) => lc(c.pool))]);
  const kPools = (kSum?.route || []).flat().map((h) => lc(h.pool));
  if (route && route.kind !== 'gated' && route.kind !== 'ascend' && route.kind !== 'signal' && kOut > (good[0].out * 103n) / 100n && !kPools.some((x) => own.has(x))) route = { kind: 'kyber', name: 'KyberSwap', check: good[0].r };
  if (!route) {
    if (kOut > 0n) route = { kind: 'kyber', name: 'KyberSwap', ...(pools.length ? { again: Date.now() + 600000 } : {}) };
    else try { const k = await kyRoute(NATIVE, t, probe); if (BigInt(k.routeSummary.amountOut) > 0n) route = { kind: 'kyber', name: 'KyberSwap' }; } catch {}
  }
  // the index is not built yet, or is behind: look for the coin's pool on chain directly
  if (!route) route = await coinCurve(t).then((r) => r && quote(r)).then((x) => x?.r || null).catch(() => null);
  if (!route) route = await scanV4(t, async (r) => (await quote(r))?.r || null);
  if (route) { state.routes[t] = route; save(); }
  return route;
}
// WHYPE pools of the v3 forks: every fee tier of every factory, asked at once
async function v3Pools(t) {
  const out = [];
  await Promise.all(V3DEX.flatMap((x) => V3FEES.map(async (fee) => {
    try {
      const pool = '0x' + strip(await ethCall(x.factory, enc('1698ee82', t, x.whype, fee), {}, undefined, true)).slice(24);
      if (pool !== ZERO) out.push({ kind: 'v3', name: x.name, router: x.router, whype: x.whype, fee, pool });
    } catch {}
  })));
  return out;
}
// bonding curves still trading the coin: their buy quote answers above zero
async function curvePools(t) {
  const out = [];
  await Promise.all(CURVES.map(async (x) => {
    try {
      const info = x.info ? strip(await ethCall(x.curve, enc(x.info, t), {}, undefined, true).catch(() => '0x')) : '';
      const pair = info.length >= 192 ? '0x' + info.slice(152, 192) : ZERO;
      if (pair !== ZERO) {
        const fee = Number(u256(await ethCall(x.curve, '0x' + x.fee, {}, undefined, true).catch(() => '0x7d')));
        out.push({ kind: 'curve', name: x.name, router: x.curve, amm: true, pair, fee: fee > 0 && fee < 2000 ? fee : 125 });
      } else if (u256(await ethCall(x.curve, enc(x.qBuy, t, 10n ** 16n))) > 0n) out.push({ kind: 'curve', name: x.name, router: x.curve });
    } catch {}
  }));
  return out;
}
// a coin on a single-coin curve (PC): the block it was created in (binary search on its code), and the contract
// its mint went to
async function coinCurve(t) {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  let lo = 1, hi = head;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const c = await rpc('eth_getCode', [t, hex(mid)]); if (c && c.length > 2) hi = mid; else lo = mid + 1; }
  const logs = await rpc('eth_getLogs', [{ address: t, fromBlock: hex(lo), toBlock: hex(lo), topics: [T_TRANSFER, '0x' + word(ZERO)] }]);
  for (const l of logs || []) {
    const c = lc('0x' + l.topics[2].slice(26));
    const code = lc(await rpc('eth_getCode', [c, 'latest']));
    if (!Object.values(PC).every((sel) => code.includes('63' + sel))) continue;
    if (u256(await ethCall(c, '0x' + PC.grad, {}, undefined, true)) !== 0n) return null; // graduated: its pool takes over
    return { kind: 'pcurve', name: `Curve ${c.slice(0, 6)}`, router: c };
  }
  return null;
}
// a pool on a PoolManager we have never seen: find its Initialize event (recent blocks first)
async function scanV4(t, ok) {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  for (let end = head; end > head - 60000; end -= 8000) {
    const jobs = [];
    for (let k = 0; k < 4; k++) {
      const to = end - k * 2000, from = to - 1999;
      for (const topics of [[T_INIT, null, '0x' + word(ZERO), '0x' + word(t)], [T_INIT, null, null, '0x' + word(t)], [T_INIT, null, '0x' + word(t)]]) {
        jobs.push(rpc('eth_getLogs', [{ fromBlock: hex(Math.max(0, from)), toBlock: hex(to), topics }]).catch(() => []));
      }
    }
    for (const l of (await Promise.all(jobs)).flat()) {
      const x = parseInit(l);
      if (x?.p?.pair && (x.p.c0 === t || x.p.c1 === t)) {
        // a token pair: the coin is the one asked about
        const pp = addPairPool(t, x.p.c0 === t ? x.p.c1 : x.p.c0, x.p, null);
        await tokenMeta(pp.q).catch(() => {});
        const best = await pairBest(t, uniExpand(routeOf(pp))[0], 10n ** 18n, false).catch(() => null);
        if (best && (await ok(best))) return best;
        continue;
      }
      if (!x || x.t !== t) continue;
      const r = await ok(routeOf(x.p));
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
  if (!isPool(r)) return { ok: null, note: 'sell check skipped (KyberSwap route)' };
  if (r.kind === 'ascend' || r.kind === 'uni') return ascSellCheck(r, t, wei); // Permit2 routers: the helper approves through Permit2
  const bd = buyData(r, t, wei, 0, SIM, 2 ** 31 - 1), sd = sellData(r, t, 0, 0, SIM, 2 ** 31 - 1);
  const len = (h) => (h.length - 2) / 2;
  const data = '0x' + word(routerOf(r)) + word(t) + word(len(bd)) + word(len(sd)) + word(amtOffset(r, t)) + strip(bd) + strip(sd);
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
  if (isPool(r)) return v4QuoteBuy(r, t, wei);
  return BigInt((await kyRoute(NATIVE, t, wei)).routeSummary.amountOut);
}
// HYPE out for selling `amt` tokens now
async function quoteSellOut(r, t, amt) {
  if (!isPool(r)) return BigInt((await kyRoute(t, NATIVE, amt)).routeSummary.amountOut);
  if (tokRoute(r)) return ascQuoteSell(r, t, amt);
  if (r.kind === 'uni' || r.kind === 'pcurve') return v4QuoteSell(r, t, amt);
  const allowed = u256(await ethCall(t, enc('dd62ed3e', me, routerOf(r))));
  return v4QuoteSell(r, t, amt, allowed >= amt ? null : await allowanceSlot(t, routerOf(r)));
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
  const logs = await rpc('eth_getLogs', [{ fromBlock: hex(p.b), toBlock: hex(p.b), address: p.pm, topics: [p.kind === 'ascend' ? T_INIT_ASCEND : T_INIT, p.id] }]);
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
      if (/message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i.test(j.description || '')) return { gone: true };
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
    [...cfg().sizes.map((s) => ({ text: `⚡ ${s}`, callback_data: `b:${h}:${Math.round(Number(s) * 10)}` })), { text: '⚡ X', callback_data: `k:${h}` }],
    [25, 50, 100].map((p) => ({ text: `Sell ${p}%`, callback_data: `s:${h}:${p}` })).concat([{ text: '🔄', callback_data: `r:${h}` }]),
    [{ text: '💰 Initials', callback_data: `i:${h}` }, { text: '🎯 Limit', callback_data: `m:${h}` }, { text: '📋 Orders', callback_data: `l:${h}` }, { text: '📤 Send', callback_data: `g:${h}` }],
    watchRow(t),
  ];
};

// the current round of a position: since the last time the bag was empty (a re-buy after a full exit starts a
// new one, so its entry price, initials and PnL are not mixed with the old trade). Older positions fall back to
// their lifetime totals.
const cyc = (p) => (p ? (p.cTok != null ? { in: p.cIn, out: p.cOut, tok: p.cTok } : { in: p.hypeIn, out: p.hypeOut, tok: p.tokIn }) : null);
const entryOf = (p) => { const c = cyc(p); return c && c.tok > 0 && c.in > 0 ? c.in / c.tok : null; }; // HYPE per token
const cacheBal = (t, bal) => { const p = state.pos[t]; if (p) { p.balW = bal.toString(); p.balAt = Date.now(); } };

// ── card ───────────────────────────────────────────────────────────────────────────────────────────
async function cardText(t) {
  const [m, r, px] = await Promise.all([tokenMeta(t), findRoute(t), hypeUsd()]);
  if (!r && (state.pools[t] || []).some((p) => p.kind === 'ascend')) return { text: `<b>${esc(m.sym || short(t))}</b> trades on <b>Ascend</b>, but the bot does not know Ascend's router yet (it learns it from the first trades on Ascend).\nSet it with /ascend router 0x… and paste the coin again.\n<code>${t}</code>` };
  if (!r) {
    // a pasted wallet (no code) is not a coin: point at /withdraw instead of a pool search that cannot succeed
    const code = await rpc('eth_getCode', [t, 'latest']).catch(() => null);
    if (code === '0x') return { text: `<code>${t}</code> is a wallet, not a coin.\nTo send HYPE there: <code>/withdraw ${t} all</code> (or an amount), then tap ✅ Send.\nTo send a coin there: <code>/send 0xCOIN all ${t}</code>` };
    return { text: `No route for <code>${t}</code>.\nNo HYPE, WHYPE or KNTQ pool for it among the ${poolCount()} the bot has indexed (ElysPump, Uniswap and the other v4 pool managers), no WHYPE pool on ${V3DEX.map((x) => x.name).join(' or ')}, not on a known bonding curve, and KyberSwap does not know it. Coins paired with USDC on Uniswap are not routed yet.` };
  }
  const probe = 10n ** 16n;
  const devInfo = devOf(t).then(async (d) => (d?.w ? { w: d.w, bal: await balOf(t, d.w, true) } : null)).catch(() => null);
  // an Ascend coin whose anti-snipe fee is still up: priced as of the second it drops (when a tap would buy)
  const d = r.kind === 'ascend' ? await ascEarly(r, t, 10n ** 17n).catch(() => null) : null;
  const qb = async (wei) => (d ? (await ascSim(r, t, { qAmt: await qOfWei(r.q, wei), sell: false, time: d.at })).got : quoteBuy(r, t, wei));
  const [p, one, bal, sc, dv] = await Promise.all([qb(probe), qb(10n ** 18n).catch(() => null), balOf(t, me, true), d ? ascSellCheck(r, t, 10n ** 17n, d.at) : sellCheck(r, t, 10n ** 17n), devInfo]);
  cacheBal(t, bal);
  const spot = num(probe) / num(p, m.d);               // HYPE per token
  const sup = m.sup ? num(m.sup, m.d) : 0;
  const mc = sup ? spot * sup : null;
  const impact = one ? 1 - num(one, m.d) * spot : null;
  const pos = state.pos[t], c = cyc(pos), entry = entryOf(pos);
  const bagH = num(bal, m.d) * spot;
  let pnl = '';
  if (bal > 0n && c && c.in > 0) {
    const pl = (bagH + c.out - c.in) / c.in * 100;
    pnl = ` · PnL <b>${pl >= 0 ? '+' : ''}${pl.toFixed(0)}%</b>`;
  }
  const os = state.orders[t] || [];
  const text =
    `<b>${esc(m.sym)}</b> · ${isPool(r) ? esc(routeLabel(r)) : 'via KyberSwap'}\n` +
    (d ? `⏱ Anti-snipe fee is up until +${d.at - d.t0} s after launch (${Math.max(0, d.at - Math.floor(Date.now() / 1000))} s left). Prices below are as of then, and a ⚡ tap waits for it.\n` : '') +
    `Price ${spot.toPrecision(3)} HYPE${mc ? ` · MC <b>${fmtH(mc)}</b>${usd(mc, px)}` : ''}\n` +
    (one ? `1 HYPE → ${fmt(num(one, m.d))} ${esc(m.sym)}${impact != null ? ` (impact ${(impact * 100).toFixed(1)}%)` : ''}\n` : '') +
    (bal > 0n ? `You hold ${fmt(num(bal, m.d))} ≈ ${fmtH(bagH)}${usd(bagH, px)}${pnl}${entry && sup && px ? ` · entry MC $${fmt(entry * sup * px)}` : ''}\n` : '') +
    (sc.blocked ? `🚫 <b>Cannot be sold back</b> in a simulation: likely a honeypot\n` : sc.ok === false ? `⚠️ Buy and sell back loses <b>${(sc.loss * 100).toFixed(0)}%</b> (tax or fees)\n` : sc.loss != null ? `✓ Sell check: buy and sell back loses ${(sc.loss * 100).toFixed(1)}%\n` : '') +
    (dv ? `Dev ${short(dv.w)} holds ${sup ? ((num(dv.bal, m.d) / sup) * 100).toFixed(1) + '%' : fmt(num(dv.bal, m.d))}\n` : '') +
    (os.length ? `🎯 ${os.map(orderText).join(' · ')}\n` : '') +
    `<code>${t}</code>`;
  return { text, rows: cardButtons(t) };
}
async function showCard(t, m, note = '') {
  const c = await cardText(t);
  const text = note ? `${note}\n\n${c.text}` : c.text;
  return m ? edit(m, text, c.rows) : say(text, c.rows);
}

// ── trades ─────────────────────────────────────────────────────────────────────────────────────────
const P = (t, sym) => (state.pos[t] ||= { sym, hypeIn: 0, hypeOut: 0, tokIn: 0, tokOut: 0, t: Date.now() });
const isOpen = (p) => !!p && p.hypeIn > 0 && (p.open ?? (p.now ?? 1) > 0.0005);
const approving = new Set(); // coins whose approval transaction is already on its way
// tokens that arrived in this receipt (no extra balance read after a buy)
const gotFromLogs = (rc, t) => (rc.logs || []).filter((l) => lc(l.address) === t && lc(l.topics?.[0]) === T_TRANSFER && lc(l.topics?.[2]) === '0x' + word(me)).reduce((a, l) => a + BigInt(l.data || '0x0'), 0n);

// Resolves once the transaction has a receipt: { ok: true, got } or { ok: false, ... }.
// opts.route: a pool already known (snipes) · opts.label: first line of the message · opts.copy: copied wallet
//
// Speed: with the coin's route known (it is once its card was shown or an alert named it), everything the buy
// needs, the sell check that doubles as the quote, the wallet and bag balances, is asked of every node at once
// in one round trip; then the signed transaction goes to every node and the first acceptance counts. The
// Telegram message is sent alongside, never before.
const buyingNow = new Map(); // coin → when a buy of it was sent, until its receipt is in
async function buy(t, hypeAmt, replyTo, force = false, src = 'command', opts = {}) {
  const { slip, max } = cfg();
  if (!(hypeAmt > 0)) throw new Error('amount must be above 0');
  if (hypeAmt > max) throw new Error(`max per buy is ${max} HYPE (change with /set max)`);
  // a second tap while a buy of the same coin is still landing is almost always a retry of that buy: it does not buy
  // twice unless asked (limit orders, snipes and copies are not held back)
  const busy = buyingNow.get(t);
  if (busy && !force && !opts.convert && !/^(limit|snipe|copy)/.test(src) && Date.now() - busy < 200000) {
    await say(`⏳ A buy of <b>${esc(meta[t]?.sym || t.slice(0, 10))}</b> sent ${Math.round((Date.now() - busy) / 1000)} s ago is still landing, so this tap did not buy again.`, [[{ text: `Buy ${hypeAmt} more anyway`, callback_data: `f:${t.slice(2)}:${Math.round(hypeAmt * 10)}` }]], replyTo);
    return { ok: false, refused: true };
  }
  const wei = toWei(String(hypeAmt));
  const kept = state.routes[t];
  const known = (opts.route?.mode === 'pair' ? null : opts.route) || (kept?.again && Date.now() > kept.again ? null : kept); // see findRoute
  // a coin with several ways in (several launchpads, thin and deep pools, a token's HYPE pools): each is quoted at this
  // exact size alongside the sell check, and one paying 0.5%+ more takes over (snipes keep the pool they were given)
  const alts = opts.route ? [] : state.alts[t] || [];
  const altP = alts.length > 1 ? Promise.all(alts.map((a) => v4QuoteBuy(a, t, wei).catch(() => 0n))) : null;
  // started right away when the route is known: the sell check (a KyberSwap route runs it on the coin's own pool) and
  // the gas estimate
  const scOn = (x) => (isPool(x) && !tokRoute(x) ? x : x?.kind === 'kyber' && x.check ? x.check : null);
  const scP = scOn(known) ? sellCheck(scOn(known), t, wei) : null;
  const gasP = isPool(known) && !tokRoute(known) ? estGas(known, t, wei) : null;
  let [m, r, bal, before] = await Promise.all([tokenMeta(t), known || findRoute(t), hypeBal(true), balOf(t, me, true).catch(() => 0n)]);
  if (!r) throw new Error('no route for this token');
  // the token a coin is paired with is bought on a route of its own that takes HYPE (never two pairs deep)
  if (opts.convert && tokRoute(r)) throw new Error(`no direct HYPE route for ${m.sym}`);
  if (altP && isPool(r)) { const b = pickAlt(r, alts, await altP); if (b !== r) { r = b; state.routes[t] = r; save(); } }
  // an Ascend coin whose anti-snipe fee is still up: wait for the second it drops instead of paying it
  if (r.kind === 'ascend' && opts.ascTime == null) {
    r.ur ||= await ascRouterFor(r.pm).catch(() => null);
    const d = r.ur ? await ascEarly(r, t, wei).catch(() => null) : null;
    if (d) return ascWaitBuy(t, hypeAmt, replyTo, force, src, opts, r, d);
  }
  if (!tokRoute(r) && bal < wei + 2n * 10n ** 15n + (r.kind === 'gated' ? 10n ** 15n : 0n)) throw new Error(`not enough HYPE: wallet has ${fmtH(num(bal))}`);
  const head = opts.label ? `${opts.label}\n` : '';
  // sell check: the buy simulated together with an immediate sell. It refuses coins that cannot be sold back
  // or lose too much on the round trip, and its buy leg is the quote for this exact size.
  let sc = { note: '' }, expect = null, ascTxs = null, gasEst = null;
  const refuse = async () => {
    J({ side: 'refused', coin: t, sym: m.sym, hype: hypeAmt, src, sc: sc.loss ?? null, reason: sc.blocked ? 'cannot sell' : 'round trip too costly' });
    const why = sc.blocked ? `🚫 <b>${esc(m.sym)}</b> cannot be sold back in a simulation (honeypot or sells blocked).` : `⚠️ Buying <b>${esc(m.sym)}</b> and selling straight back loses <b>${(sc.loss * 100).toFixed(0)}%</b> (limit ${cfg().tax}%, change with /set tax).`;
    await say(`${head}${why}\nNot buying.`, [[{ text: `Buy ${hypeAmt} anyway`, callback_data: `f:${t.slice(2)}:${Math.round(hypeAmt * 10)}` }, { text: '🔎', callback_data: `c:${t.slice(2)}` }]], replyTo);
    return { ok: false, refused: true };
  };
  if (tokRoute(r)) {
    const plan = await ascPlanBuy(t, hypeAmt, wei, replyTo, force, src, opts, r, m, bal);
    if (plan.refused) return { ok: false, refused: true };
    ({ sc, expect } = plan);
    ascTxs = plan.txs;
  } else if (isPool(r)) {
    const same = r === known;
    [sc, gasEst] = await Promise.all([same && scP ? scP : sellCheck(r, t, wei), same && gasP ? gasP : estGas(r, t, wei)]);
    if (cfg().check && !force && sc.ok === false) return refuse();
    if (sc.got > 0n) expect = sc.got;
    else {
      expect = await v4QuoteBuy(r, t, wei).catch(() => null);
      // no answer, or nothing out (a pool drained by its dev, a curve that graduated): look for the coin's pool again
      if (!(expect > 0n)) {
        if (opts.route) throw new Error('no route for this token yet'); // a snipe retries
        r = await findRoute(t, true); // the pool changed: pick again
        if (!r) throw new Error('no route for this token any more: its pool is empty or gone (liquidity pulled?)');
        if (isPool(r)) {
          [expect, gasEst] = await Promise.all([v4QuoteBuy(r, t, wei), estGas(r, t, wei)]);
          if (!(expect > 0n)) throw new Error('its pool has no liquidity left (pulled or empty), so there is nothing to buy into');
        }
      }
    }
  } else if (r.check) {
    // KyberSwap pays more than the coin's own pool, but that pool still shows whether the coin can be sold at all
    // (its round trip there says nothing about KyberSwap's price, so only a blocked sell refuses)
    sc = await (r === known && scP ? scP : sellCheck(r.check, t, wei));
    if (cfg().check && !force && sc.blocked) return refuse();
    sc = { note: 'KyberSwap: better price than the pool', poolGot: sc.got || 0n };
  }
  let tx;
  if (ascTxs) tx = ascTxs[ascTxs.length - 1];
  else if (isPool(r)) tx = { to: routerOf(r), value: wei, data: buyData(r, t, wei, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: gasFor(r, gasEst) };
  else {
    const k = await kyRoute(NATIVE, t, wei);
    const b = await kyBuild(k.routeSummary, slip);
    expect = BigInt(b.amountOut);
    tx = { to: lc(b.routerAddress), value: BigInt(b.transactionValue), data: b.data, gas: Math.max(Math.ceil(Number(b.gas) * 2), 1500000) };
    // the coin's own pool, read fresh for this exact size, still pays about as much: buy there (no aggregator lag)
    if (r.check && sc.poolGot > 0n && expect * 100n < sc.poolGot * 103n) {
      r = r.check; expect = sc.poolGot; sc = { note: 'its own pool pays as much as KyberSwap now' };
      tx = { to: routerOf(r), value: wei, data: buyData(r, t, wei, (expect * (10000n - slip)) / 10000n, me, deadline()), gas: gasFor(r, await estGas(r, t, wei)) };
    }
  }
  // the node wants the whole gas limit covered up front (at 0.4 gwei: 2M gas 0.0008 HYPE, 12M 0.005)
  if (!ascTxs && bal < BigInt(tx.value || 0) + BigInt(tx.gas) * (await gasPrice())) throw new Error(`not enough HYPE for ${hypeAmt} HYPE plus gas: wallet has ${fmtH(num(bal))}`);
  const waitS = opts.sendAt ? (opts.sendAt - Date.now()) / 1000 : 0;
  const msgP = say(`${head}⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>…${sc.note ? ` (${sc.note})` : ''}${waitS > 0.3 ? `\nSending in ${waitS.toFixed(1)} s, when the fee drops.` : ''}`, null, replyTo);
  let hash;
  // a timed snipe: approvals go now, the swap itself at opts.sendAt
  const send = async () => { let h; const list = ascTxs || [tx]; for (const x of list) { if (opts.sendAt && x === list[list.length - 1] && opts.sendAt > Date.now()) await sleep(opts.sendAt - Date.now()); h = await sendRaw(x); } return h; };
  try { hash = await serial(send); }
  catch (e) { await edit(await msgP, `${head}❌ Buy of <b>${esc(m.sym)}</b> not sent: ${esc(e.message).slice(0, 200)}`); return { ok: false, error: e.message }; }
  const sentAt = Date.now();
  buyingNow.set(t, sentAt);
  const rcP = receipt(hash, undefined, async () => edit(await msgP, `${head}⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>, still landing (Elysium is slow to include right now, do not tap again) · ${txLink(hash)}`));
  const msg = await msgP;
  await edit(msg, `${head}⏳ Buying ${hypeAmt} HYPE of <b>${esc(m.sym)}</b>, expecting ~${fmt(num(expect, m.d))} · ${txLink(hash)}`);
  const rc = await rcP;
  if (buyingNow.get(t) === sentAt) buyingNow.delete(t);
  if (!rc) { await edit(msg, `${head}⌛ Buy of <b>${esc(m.sym)}</b> not confirmed after 2 h. Check ${txLink(hash)}; /nonce if it never lands.`); return { ok: false }; }
  if (rc.status === 'dropped') { await edit(msg, `${head}❌ Buy of <b>${esc(m.sym)}</b> never landed: no node has it after 3 min and the wallet nonce is unused, so nothing was spent. Tap again.`, cardButtons(t)); return { ok: false }; }
  if (rc.status !== '0x1') {
    J({ side: 'revert', coin: t, sym: m.sym, hype: hypeAmt, src, slip: Number(slip), route: r.name, hash });
    await edit(msg, `${head}❌ Buy of <b>${esc(m.sym)}</b> reverted (${opts.revertNote || `price moved past your ${Number(slip) / 100}% slippage?`}) · ${txLink(hash)}`, cardButtons(t));
    return { ok: false, reverted: true };
  }
  let got = gotFromLogs(rc, t);
  if (got === 0n) got = (await balOf(t, me, true).catch(() => before)) - before;
  // the token a paired coin trades against (step 1 of 2): no position, no journal, approved for the way back
  if (opts.convert) {
    cacheBal(t, before + got);
    if (cfg().preapprove && uniNative(r)) ascPreApprove(t, r).catch(() => {});
    else if (cfg().preapprove && isPool(r) && !tokRoute(r)) preApprove(t, routerOf(r)).catch(() => {});
    await edit(msg, `${head}✅ Got ${fmt(num(got, m.d))} ${esc(m.sym)} for ${hypeAmt} HYPE · ${txLink(hash)}`);
    return { ok: true, got };
  }
  const px = await hypeUsd();
  const mc = m.sup && got > 0n ? (hypeAmt / num(got, m.d)) * num(m.sup, m.d) : null;
  const p = P(t, m.sym);
  if (before === 0n || !isOpen(p)) { p.cIn = 0; p.cOut = 0; p.cTok = 0; } // a fresh round
  p.hypeIn += hypeAmt; p.tokIn += num(got, m.d);
  p.cIn = (p.cIn ?? 0) + hypeAmt; p.cTok = (p.cTok ?? 0) + num(got, m.d); p.cOut ??= 0;
  p.first ||= Date.now(); p.src ||= src; if (p.mc0Usd == null && mc && px) p.mc0Usd = mc * px;
  p.open = true; p.devFired = false;
  cacheBal(t, before + got);
  if (sc.ok != null) { p.scOk = sc.ok; p.sc0 = sc.loss ?? null; }
  if (opts.copy) p.copy ||= opts.copy;
  J({ side: 'buy', coin: t, sym: m.sym, hype: hypeAmt, tok: num(got, m.d), mcUsd: mc && px ? mc * px : null, src, slip: Number(slip), sc: sc.loss ?? null, route: r.name, hash });
  // after the buy: approve so every sell is one transaction, note the creator's bag for the dev guard (when on),
  // and add the auto-sell preset (when set)
  if (cfg().preapprove && (r.kind === 'ascend' || r.kind === 'uni')) ascPreApprove(t, r).catch((e) => console.error('preapprove', e.message));
  else if (cfg().preapprove && isPool(r)) preApprove(t, routerOf(r)).catch((e) => console.error('preapprove', e.message));
  if (cfg().devsell > 0) devOf(t).then(async (d) => { if (d?.w) { d.peak = num(await balOf(t, d.w), m.d); save(); } }).catch(() => {});
  let autoLine = '';
  try {
    const specs = parseSpec(cfg().auto);
    if (specs.length) autoLine = `\n🤖 ${(await setOrders(t, specs, true)).map(orderText).join(' · ')}`;
  } catch (e) { autoLine = `\n⚠️ Auto-sell not set: ${esc(e.message)}`; }
  save();
  refreshPin();
  await edit(msg, `${head}✅ Bought <b>${fmt(num(got, m.d))} ${esc(m.sym)}</b> for ${hypeAmt} HYPE${mc ? ` · entry MC ${fmtH(mc)}${usd(mc, px)}` : ''} · ${((Date.now() - sentAt) / 1000).toFixed(1)} s · ${txLink(hash)}${autoLine}`, cardButtons(t));
  return { ok: true, got };
}

// approve the router for good right after a buy (the wallet is a burner), so a sell is one transaction
async function preApprove(t, spender = ROUTER) {
  if (approving.has(t)) return;
  if ((await allowanceOf(t, spender)) >= MAX256 >> 1n) return;
  approving.add(t);
  try { await serial(() => sendRaw({ to: t, data: enc('095ea7b3', spender, MAX256), gas: 200000 })); }
  catch (e) { approving.delete(t); throw e; }
}

// Resolves to true or false once the transaction has a receipt.
// opts.amt: exact token amount (initials) · opts.why: first line when an order triggered it
//
// Speed: the bag size is known from the last buy or card, so the sell quote starts at once alongside the
// balance and approval reads (one round trip); if the bag turns out different, it is quoted again. With the
// approval made right after the buy, the sell is a single transaction.
async function sell(t, pct, replyTo, opts = {}) {
  const { slip } = cfg();
  const p0 = state.pos[t], r0 = state.routes[t];
  const cached = p0?.balW ? BigInt(p0.balW) : null;
  const guess = opts.amt == null && cached > 0n ? (cached * BigInt(Math.min(100, Math.max(1, Math.round(pct))))) / 100n : null;
  const qGuess = isPool(r0) && r0.kind !== 'ascend' && r0.kind !== 'uni' && guess ? v4QuoteSell(r0, t, guess, null).catch(() => null) : null; // valid once approved
  let [m, r, bal, hBefore, allowed] = await Promise.all([tokenMeta(t), r0 || findRoute(t), balOf(t, me, true), hypeBal(true), allowanceOf(t, routerOf(r0)).catch(() => 0n)]);
  if (!r) throw new Error('no route for this token');
  let rtr = routerOf(r);
  if (isPool(r) && rtr !== routerOf(r0)) allowed = await allowanceOf(t, rtr).catch(() => 0n);
  cacheBal(t, bal);
  let amt;
  if (opts.amt != null) { amt = opts.amt > bal ? bal : opts.amt; pct = bal > 0n ? Number((amt * 1000n) / bal) / 10 : 0; }
  else { pct = Math.min(100, Math.max(1, Math.round(pct))); amt = (bal * BigInt(pct)) / 100n; }
  if (amt === 0n) throw new Error(`you hold no ${m.sym}`);
  // a coin with several ways out: each quoted for this exact amount, one paying 0.5%+ more takes over
  const alts = state.alts[t] || [];
  if (alts.length > 1 && isPool(r)) {
    const b = pickAlt(r, alts, await Promise.all(alts.map((a) => quoteSellOut(a, t, amt).catch(() => 0n))));
    if (b !== r) { r = b; if (routerOf(r) !== rtr) { rtr = routerOf(r); allowed = await allowanceOf(t, rtr).catch(() => 0n); } }
  }
  const head = opts.why ? `${opts.icon || '🎯'} ${opts.why}\n` : '';
  const msgP = say(`${head}⏳ Selling ${pct}% of <b>${esc(m.sym)}</b> (${fmt(num(amt, m.d))})…`, null, replyTo);
  const approveTx = (spender) => ({ to: t, data: enc('095ea7b3', spender, cfg().preapprove && ROUTERS.has(spender) ? MAX256 : amt), gas: 200000 });
  let txs, expect;
  try {
    if (r.kind === 'ascend' || r.kind === 'uni') {
      const uni = uniNative(r); // pays native HYPE (unwrapped or swapped back inside the router)
      if (r.kind === 'ascend') r.ur ||= await ascRouterFor(r.pm);
      if (!r.ur) throw new Error('Ascend router not known yet: /ascend router 0x…');
      const backQ = (await ascSim(r, t, { buy: false, sellAmt: amt })).back;
      expect = uni ? backQ : await weiOfQ(r.q, backQ);
      const ap = approving.has(t) ? [] : await ascApprovals(t, r.ur, amt);
      txs = [...ap, { to: r.ur, data: urSellData(r, t, amt, (backQ * (10000n - slip)) / 10000n, deadline()), gas: r.kind === 'uni' ? 3000000 : 2000000 }];
      if (!uni && r.q !== ZERO) { const [qm, qb] = await Promise.all([tokenMeta(r.q), balOf(r.q, me, true)]); opts = { ...opts, outQ: { q: r.q, before: qb, qm } }; }
    } else if (isPool(r)) {
      // an ERC-404 sell burns an NFT per whole unit: its gas is estimated once the router may pull the coin, and is
      // otherwise a high limit (only the gas used is charged)
      const sGas = r.kind === 'gated' && allowed >= amt ? await race('eth_estimateGas', [{ from: me, to: rtr, data: sellData(r, t, amt, 0, me, deadline()) }]).then((g) => Number(BigInt(g))).catch(() => null) : null;
      const swap = (out) => ({ to: rtr, data: sellData(r, t, amt, (out * (10000n - slip)) / 10000n, me, deadline()), gas: r.kind === 'gated' ? gasFor(r, sGas) : 2000000 });
      if (allowed >= amt) {
        expect = (r === r0 && amt === guess && (await qGuess)) || (await v4QuoteSell(r, t, amt, null));
        txs = [swap(expect)];
      } else {
        const slot = await allowanceSlot(t, rtr);
        if (!slot) {
          // unusual token storage: approve first, then quote for real
          const ah = await serial(() => sendRaw(approveTx(rtr)));
          await edit(await msgP, `${head}⏳ Approving ${esc(m.sym)} before selling · ${txLink(ah)}`);
          const arc = await receipt(ah);
          if (!arc || arc.status !== '0x1') throw new Error('approval failed or never confirmed');
          expect = await v4QuoteSell(r, t, amt, null);
          txs = [swap(expect)];
        } else {
          expect = await v4QuoteSell(r, t, amt, slot);
          // the approval sent after the buy goes first (lower nonce), so the sell needs no second one
          txs = approving.has(t) ? [swap(expect)] : [approveTx(rtr), swap(expect)];
        }
      }
    } else {
      const k = await kyRoute(t, NATIVE, amt);
      const b = await kyBuild(k.routeSummary, slip);
      const spender = lc(b.routerAddress);
      expect = BigInt(b.amountOut);
      const sw = { to: spender, value: BigInt(b.transactionValue || 0), data: b.data, gas: Math.max(Math.ceil(Number(b.gas) * 2), 1500000) };
      const ka = await allowanceOf(t, spender);
      txs = ka >= amt ? [sw] : [approveTx(spender), sw];
    }
  } catch (e) {
    // the remembered route may be stale (a curve coin graduated to its pair, a pool emptied): pick again, once
    if (r0 && !opts.again) {
      delete state.routes[t]; save();
      await edit(await msgP, `${head}↻ ${esc(m.sym)}'s route changed, finding it again…`).catch(() => {});
      return sell(t, pct, replyTo, { ...opts, again: true });
    }
    await edit(await msgP, `${head}❌ Sell of <b>${esc(m.sym)}</b> failed: ${esc(e.message).slice(0, 200)}`, cardButtons(t));
    return false;
  }
  return finishSell(t, m, pct, msgP, txs, expect, head, hBefore, bal, opts);
}
// approve (if needed) and the sell go out back to back with consecutive nonces
async function finishSell(t, m, pct, msgP, txs, expect, head, before, tokBefore, opts) {
  let hashes;
  try { hashes = await serial(async () => { const out = []; for (const x of txs) out.push(await sendRaw(x)); return out; }); }
  catch (e) { await edit(await msgP, `${head}❌ Sell of <b>${esc(m.sym)}</b> not sent: ${esc(e.message).slice(0, 200)}`, cardButtons(t)); return false; }
  const hash = hashes[hashes.length - 1];
  const sentAt = Date.now();
  const rcP = receipt(hash, undefined, async () => edit(await msgP, `${head}⏳ Selling ${pct}% of <b>${esc(m.sym)}</b>, still landing (Elysium is slow to include right now, do not tap again) · ${txLink(hash)}`));
  const msg = await msgP;
  await edit(msg, `${head}⏳ Selling ${pct}% of <b>${esc(m.sym)}</b> for ~${fmtH(num(expect))}${hashes.length > 1 ? ' (approve + sell)' : ''} · ${txLink(hash)}`);
  const rc = await rcP;
  if (!rc) { await edit(msg, `${head}⌛ Sell of <b>${esc(m.sym)}</b> not confirmed after 2 h · ${txLink(hash)}`); return false; }
  if (rc.status === 'dropped') { await edit(msg, `${head}❌ Sell of <b>${esc(m.sym)}</b> never landed: no node has it after 3 min and the wallet nonce is unused, so nothing was sold. Tap again.`, cardButtons(t)); return false; }
  if (rc.status !== '0x1') { J({ side: 'sell-revert', coin: t, sym: m.sym, pct, hash, why: opts.kind }); await edit(msg, `${head}❌ Sell of <b>${esc(m.sym)}</b> reverted (price moved past your slippage?) · ${txLink(hash)}`, cardButtons(t)); return false; }
  // balances read at the block the sell landed in: a node a block or two behind would still show the bag and the
  // old HYPE, record a 0 HYPE sell and leave the position open
  const at = rc.blockNumber;
  const [hNow, left] = await Promise.all([
    balAt(at).catch(() => hypeBal(true)).catch(() => before),
    tokAt(t, at).catch(() => balOf(t, me, true)).catch(() => tokBefore),
  ]);
  let got = num(hNow - before), qLine = '';
  if (opts.outQ) {
    // an Ascend coin paired with a token (USDC): the proceeds are that token, valued in HYPE
    const qNow = await tokAt(opts.outQ.q, at).catch(() => balOf(opts.outQ.q, me, true)).catch(() => opts.outQ.before);
    const gq = qNow > opts.outQ.before ? qNow - opts.outQ.before : 0n;
    got = num(await weiOfQ(opts.outQ.q, gq).catch(() => 0n));
    qLine = ` (${fmt(num(gq, opts.outQ.qm.d))} ${esc(opts.outQ.qm.sym)})`;
    // a coin paired with a token: that token goes straight back to HYPE (step 2 of 2), unless /set pairbuy off
    if (gq > 0n && cfg().pairbuy && !opts.convert) {
      await edit(msg, `${head}✅ Sold ${pct}% of <b>${esc(m.sym)}</b> for ${fmt(num(gq, opts.outQ.qm.d))} ${esc(opts.outQ.qm.sym)} · ${txLink(hash)}\n↩️ Swapping the ${esc(opts.outQ.qm.sym)} back to HYPE…`).catch(() => {});
      const h = await sell(opts.outQ.q, 100, null, { amt: gq, convert: true, why: `2/2 · ${opts.outQ.qm.sym} from the ${m.sym} sell back to HYPE`, icon: '↩️' }).catch(() => null);
      if (typeof h === 'number') { got = h; qLine = ` (through ${fmt(num(gq, opts.outQ.qm.d))} ${esc(opts.outQ.qm.sym)})`; }
      else qLine = ` (kept as ${fmt(num(gq, opts.outQ.qm.d))} ${esc(opts.outQ.qm.sym)}: swapping it back failed, sell it from its card)`;
    }
  }
  const sold = num(tokBefore - left, m.d);
  // the token from a paired coin's sell, back to HYPE: no position, no journal
  if (opts.convert) {
    cacheBal(t, left);
    await edit(msg, `${head}✅ ${fmt(sold)} ${esc(m.sym)} back to <b>${fmtH(got)}</b> · ${txLink(hash)}`);
    return got;
  }
  const p = P(t, m.sym); p.hypeOut += Math.max(got, 0); p.tokOut += sold; p.lastSell = Date.now();
  p.cOut = (p.cOut ?? 0) + Math.max(got, 0);
  cacheBal(t, left);
  if (left === 0n) { p.open = false; dropSellOrders(t); }
  J({ side: 'sell', coin: t, sym: m.sym, hype: Math.max(got, 0), tok: sold, pct, hash, why: opts.kind });
  refreshPin();
  const px = await hypeUsd();
  await edit(msg, `${head}✅ Sold ${pct}% of <b>${esc(m.sym)}</b> for <b>${fmtH(got)}</b>${qLine || usd(got, px)} · ${((Date.now() - sentAt) / 1000).toFixed(1)} s · ${txLink(hash)}`, cardButtons(t));
  return true;
}
function track(hash, onDone, onTimeout) {
  receipt(hash).then((rc) => (rc ? onDone(rc) : onTimeout())).catch((e) => console.error('track', e.message));
}

// sell just enough to take back what went into this round (HYPE in minus HYPE already out); the rest rides free
async function initials(t, replyTo) {
  const p = state.pos[t], c = cyc(p);
  if (!c || !(c.in > 0)) throw new Error('no buy through this bot recorded for this coin');
  const need = c.in - (c.out || 0);
  if (need <= 0.0001) return say(`Initials are already out on <b>${esc(p.sym)}</b>: in ${fmtH(c.in)}, out ${fmtH(c.out)}. The rest is free.`, null, replyTo);
  const [m, r, bal] = await Promise.all([tokenMeta(t), findRoute(t), balOf(t, me, true)]);
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
  o.k === 'lsell' ? `sell ${o.pct}% at MC ${o.dir === 'below' ? '≤' : '≥'} $${fmt(o.mc)}` :
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
  const entry = entryOf(p);
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
    try { ok = await sell(t, share, null, { why, icon: icon || (o ? '🎯' : '🛡'), kind: o ? o.k : icon ? 'copy' : 'guard' }); }
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
  if (!isPool(r) && !every(t + ':ky', 15000)) return; // KyberSwap's API: every 15 s is plenty
  const m = await tokenMeta(t);
  const px = await priceOf(t, r);
  if (!px) return;
  const os = state.orders[t] || [];
  const u = await hypeUsd();
  const mcUsd = u && m.sup ? px * num(m.sup, m.d) * u : null;
  for (const o of os.filter((x) => x.exp && Date.now() > x.exp)) { removeOrder(o.id); say(`⌛ Limit order on <b>${esc(m.sym)}</b> expired (${orderText(o)}).`); }
  // limit buys: kept until one fills; a revert is retried on the next checks, up to 3 times
  for (const o of os.filter((x) => x.k === 'lbuy' && !(x.exp && Date.now() > x.exp))) {
    if (mcUsd == null || !(o.dir === 'above' ? mcUsd >= o.mc : mcUsd <= o.mc)) continue;
    busy.add(t);
    buy(t, o.hype, null, false, 'limit', { label: `🎯 Limit buy: <b>${esc(m.sym)}</b> MC $${fmt(mcUsd)}` })
      .then((res) => {
        if (res?.ok || res?.refused) return removeOrder(o.id);
        if ((o.fails = (o.fails || 0) + 1) >= 3) { removeOrder(o.id); return say(`🎯 Gave up on ${orderText(o)} for <b>${esc(m.sym)}</b> after 3 failed buys.`); }
        save();
      })
      .catch((e) => { removeOrder(o.id); say(`🎯 Limit buy on <b>${esc(m.sym)}</b> failed: ${esc(e.message).slice(0, 200)}`); })
      .finally(() => busy.delete(t));
    return;
  }
  const sells = os.filter((x) => x.k !== 'lbuy' && !(x.exp && Date.now() > x.exp));
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
      o.k === 'trail' && px <= o.peak * (1 - o.drop) ? `Trailing stop: <b>${esc(m.sym)}</b> fell ${Math.round((1 - px / o.peak) * 100)}% from its high (${(o.peak / o.base).toFixed(2)}× entry)` :
      o.k === 'lsell' && mcUsd != null && (o.dir === 'below' ? mcUsd <= o.mc : mcUsd >= o.mc) ? `Limit sell: <b>${esc(m.sym)}</b> MC $${fmt(mcUsd)} (${o.dir === 'below' ? 'at or under' : 'at or over'} $${fmt(o.mc)})` : null;
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
  if (c.rug && p.scOk && isPool(r) && every(t + ':rug', 20000)) {
    const sc = await sellCheck(r, t, 5n * 10n ** 16n);
    const jump = sc.loss != null && sc.loss * 100 > Math.max(c.tax, (p.sc0 || 0) * 100 + 15);
    if (sc.blocked || jump) {
      p.scOk = false; save();
      return fireSell(t, 100, sc.blocked ? `Rug guard: <b>${esc(m.sym)}</b> can no longer be sold in a simulation` : `Rug guard: selling <b>${esc(m.sym)}</b> back now loses ${Math.round(sc.loss * 100)}% (was ${Math.round((p.sc0 || 0) * 100)}% when you bought)`);
    }
  }
}

// ── bag watch ──────────────────────────────────────────────────────────────────────────────────────
// Coins you arm (👀 on the card, /bagwatch 0xCOIN), or with /set bagwatch on every coin you hold (the bot wallet and
// your /mine wallets): its dev and its 10 biggest holders are watched, and a sell or a move of a real part of their
// bag posts here. A coin armed while you held it is disarmed when the bag closes. Holders come from the coin's Transfer logs since its first
// pool (at most the last two days, ranked by balanceOf), kept live by one log read every 5 s for all bags together.
// A wallet a watched holder moves a big part of its bag to is watched too, as "<holder> alt".
state.bwAlts ||= {};          // coin → { wallet: label } (wallets a watched holder moved its bag to)
state.bwArm ||= {};           // coin → { at, held } armed by hand (held: you held it then, so it ends with the bag)
state.bwMute ||= {};          // coin → time: one of your bags taken out of the watch while every bag is watched
const BW_MAX = 40, BW_TOP = 10;         // coins watched at once (biggest bags first), holders per coin
const BW_SPAN = 1200000;      // blocks read back at most (about two days)
const BW_PRE = 20000;         // blocks before the first pool (coins minted before their pool opened)
const BW_RANK_MS = 600000;    // top holders ranked again every 10 minutes
const BW_DEV = 0.05, BW_HOLDER = 0.2;   // share of their bag a sell needs to post: dev 5%, top holders 20%
const BW_BIG = 0.005;                   // of supply: always posts
const BW_MIN = 0.0005, BW_DEV_MIN = 0.0001; // of supply: never posts under (holders 0.05%, dev 0.01%)
const BW_COOL = 60000;        // after a post, the same wallet's next sells wait a minute and are added up
const T_SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const DEAD = '0x000000000000000000000000000000000000dead';
const bw = {};                // coin → { ready, bal: Map(wallet → tokens), b, top, at, dev, d, sup, sym, failAt, filling }
const bwHold = {};            // `${coin}|${wallet}` → { t, w, label, base, rows: [{ to, amt, tx }], at, last }
const codeOf = new Map();     // address → true for a contract (EIP-7702 delegated wallets count as wallets)
const kindOf = new Map();     // tx → sold (a swap in it) or contract
let bwFilling = 0;
async function isContract(a) {
  if (codeOf.has(a)) return codeOf.get(a);
  const c = lc(await rpc('eth_getCode', [a, 'latest']));
  const v = c !== '0x' && c !== '' && !c.startsWith('0xef0100');
  codeOf.set(a, v);
  return v;
}
const ascUrs = () => Object.values(state.asc.ur || {}).map(lc);
const bwSkip = () => new Set([ZERO, DEAD, me, ...Object.keys(state.mine), ...knownPms, ...ROUTERS, ...ascUrs()]);
const moveOf = (l) => {
  if (!l.topics || l.topics.length < 3 || lc(l.topics[0]) !== T_TRANSFER) return null;
  const d = strip(l.data).slice(0, 64);
  return { from: lc('0x' + l.topics[1].slice(26)), to: lc('0x' + l.topics[2].slice(26)), amt: d ? BigInt('0x' + d) : 0n };
};
const bwAdd = (bal, mv) => { if (!mv.amt) return; bal.set(mv.from, (bal.get(mv.from) || 0n) - mv.amt); bal.set(mv.to, (bal.get(mv.to) || 0n) + mv.amt); };
const big = (a, b) => (b > a ? 1 : b < a ? -1 : 0);
// open bags: the bot wallet's and your other wallets'
function heldMap() {
  const out = new Map();
  const add = (t, who, v) => { const x = out.get(t) || { bot: false, who: [], v: 0 }; if (who) x.who.push(who); else x.bot = true; x.v += v || 0; out.set(t, x); };
  for (const [t, p] of Object.entries(state.pos)) if (isOpen(p)) add(t, null, p.now);
  for (const [w, ps] of Object.entries(state.mpos)) for (const [t, p] of Object.entries(ps)) if (p.held > 0 && p.open !== false && !MINE_SKIP.has(t) && !WHYPES.has(t)) add(t, mineName(w), p.now);
  return out;
}
// the coins watched: armed ones first, then (with /set bagwatch on) every bag, biggest first
function bagCoins() {
  const held = heldMap(), out = new Map();
  for (const [t, a] of Object.entries(state.bwArm)) {
    if (a.held && !held.has(t)) { delete state.bwArm[t]; save(); continue; } // armed while held: ends with the bag
    out.set(t, { ...(held.get(t) || { bot: false, who: [], v: 0 }), armed: true });
  }
  if (cfg().bagwatch) for (const [t, x] of held) if (!state.bwMute[t] && !out.has(t)) out.set(t, x);
  for (const t of Object.keys(state.bwMute)) if (!held.has(t)) delete state.bwMute[t];
  return new Map([...out].sort((a, b) => (b[1].armed ? 1e12 : 0) + b[1].v - (a[1].armed ? 1e12 : 0) - a[1].v).slice(0, BW_MAX));
}
function watchedNow(t) { return !!state.bwArm[t] || (cfg().bagwatch && !state.bwMute[t] && heldMap().has(t)); }
// 👀 / 🔕: arm or disarm one coin; true when it is watched after the tap
function bwToggle(t) {
  const on = watchedNow(t), held = heldMap().has(t);
  if (on) { delete state.bwArm[t]; if (cfg().bagwatch && held) state.bwMute[t] = Date.now(); }
  else { state.bwArm[t] = { at: Date.now(), held }; delete state.bwMute[t]; }
  save();
  return !on;
}
const watchRow = (t) => [{ text: watchedNow(t) ? '🔕 Stop holder watch' : '👀 Watch dev + top holders', callback_data: `h:${t.slice(2)}` }];
// a coin's holders from its Transfer logs, then its top 10 ranked
async function bwFill(t) {
  bwFilling++;
  const x = bw[t];
  try {
    const [m, head] = await Promise.all([tokenMeta(t), rpc('eth_blockNumber', []).then((h) => Number(BigInt(h)))]);
    const pb = (state.pools[t] || []).map((p) => p.b).filter((b) => b > 0);
    const start = Math.max(0, head - BW_SPAN, pb.length ? Math.min(...pb) - BW_PRE : 0);
    const bal = new Map(), wins = [];
    for (let a = start; a <= head; a += 2000) wins.push([a, Math.min(head, a + 1999)]);
    await pmap(wins, 3, async ([a, b]) => {
      const q = [{ address: t, topics: [T_TRANSFER], fromBlock: hex(a), toBlock: hex(b) }];
      let logs;
      try { logs = await rpc('eth_getLogs', q, 5); } catch { logs = await arch('eth_getLogs', q); }
      for (const l of logs) { const mv = moveOf(l); if (mv) bwAdd(bal, mv); }
    });
    const dev = (await devOf(t).catch(() => null))?.w || null;
    Object.assign(x, { bal, b: head, d: m.d, sup: m.sup, sym: m.sym, dev, ready: true });
    await bwRank(t);
  } finally { bwFilling--; }
}
// the 10 biggest wallets (no contracts, pools, routers or your own wallets), by their real balance
async function bwRank(t) {
  const x = bw[t];
  if (!x?.ready || x.ranking) return;
  x.ranking = true; x.at = Date.now();
  try {
    const skip = bwSkip();
    const cands = [...x.bal].filter(([w, v]) => v > 0n && !skip.has(w) && w !== t).sort((a, b) => big(a[1], b[1])).slice(0, 30).map(([w]) => w);
    const rows = await pmap(cands, 6, async (w) => ({ w, c: await isContract(w), b: await balOf(t, w) }));
    for (const r of rows) x.bal.set(r.w, r.b);
    x.top = rows.filter((r) => !r.c && r.b > 0n).sort((a, b) => big(a.b, b.b)).slice(0, BW_TOP).map((r) => r.w);
  } finally { x.ranking = false; }
}
function watchedOf(t) {
  const x = bw[t], W = new Map(), own = new Set([me, ...Object.keys(state.mine)]);
  for (const [w, l] of Object.entries(state.bwAlts[t] || {})) W.set(w, l);
  (x.top || []).forEach((w, i) => W.set(w, `#${i + 1} holder`));
  if (x.dev) { const i = (x.top || []).indexOf(x.dev); W.set(x.dev, i >= 0 ? `Dev (#${i + 1} holder)` : 'Dev'); }
  for (const w of own) W.delete(w);
  return W;
}
// every 5 s: new coins read in the background, then one log read for every coin that is ready
async function bagWatchTick() {
  const bags = bagCoins();
  for (const t of Object.keys(bw)) if (!bags.has(t)) { delete bw[t]; delete state.bwAlts[t]; for (const k of Object.keys(bwHold)) if (bwHold[k].t === t) delete bwHold[k]; }
  for (const t of bags.keys()) {
    if (bwFilling >= 2) break;
    const x = (bw[t] ||= {});
    if (x.ready || x.filling || Date.now() - (x.failAt || 0) < 120000) continue;
    x.filling = true;
    bwFill(t).catch((e) => { console.error('bag watch', short(t), e.message); x.failAt = Date.now(); }).finally(() => { x.filling = false; });
  }
  const ready = [...bags.keys()].filter((t) => bw[t]?.ready);
  for (const t of ready) if (Date.now() - (bw[t].at || 0) > BW_RANK_MS) bwRank(t).catch((e) => console.error('bag rank', short(t), e.message));
  if (ready.length) {
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const from = Math.min(...ready.map((t) => bw[t].b + 1));
    if (from <= head) {
      const to = Math.min(head, from + 9999);
      const logs = await logsRange({ address: ready, topics: [T_TRANSFER] }, from, to, 3);
      const Ws = {};
      for (const l of logs) {
        const t = lc(l.address), x = bw[t];
        if (!x?.ready || parseInt(l.blockNumber, 16) <= x.b) continue;
        const mv = moveOf(l);
        if (!mv?.amt) continue;
        bwAdd(x.bal, mv);
        const label = (Ws[t] ||= watchedOf(t)).get(mv.from);
        if (!label || mv.to === ZERO || mv.to === DEAD) continue;
        const h = (bwHold[t + '|' + mv.from] ||= { t, w: mv.from, rows: [], last: 0 });
        h.label = label;
        if (!h.rows.length) { h.at = Date.now(); h.base = null; }
        h.rows.push({ to: mv.to, amt: mv.amt, tx: lc(l.transactionHash) });
      }
      for (const t of ready) if (bw[t]?.b < to) bw[t].b = to;
    }
  }
  await bwPost(bags);
}
// a wallet's sells and moves, added up until they are big enough to post (and a minute apart per wallet)
async function bwPost(bags) {
  const byCoin = new Map();
  for (const [k, h] of Object.entries(bwHold)) {
    const x = bw[h.t];
    if (!x?.ready || !bags.has(h.t)) { delete bwHold[k]; continue; }
    if (!h.rows.length) continue;
    if (Date.now() - h.at > 30 * 60000) { h.rows = []; continue; } // small sells that never added up
    const tot = h.rows.reduce((a, r) => a + r.amt, 0n);
    if (h.base == null) h.base = (await balOf(h.t, h.w).catch(() => 0n)) + tot; // their bag before these
    if (Date.now() - h.last < BW_COOL) continue;
    const share = h.base > 0n ? Number((tot * 10000n) / h.base) / 10000 : 1;
    const ofSup = x.sup > 0n ? Number((tot * 1000000n) / x.sup) / 1e6 : null;
    const dev = h.label.startsWith('Dev');
    if (ofSup != null && ofSup < (dev ? BW_DEV_MIN : BW_MIN)) continue;
    if (!(share >= (dev ? BW_DEV : BW_HOLDER) || (ofSup != null && ofSup >= BW_BIG))) continue;
    if (!byCoin.has(h.t)) byCoin.set(h.t, []);
    byCoin.get(h.t).push(h);
  }
  for (const [t, hs] of byCoin) await bwSend(t, hs, bags.get(t)).catch((e) => console.error('bag post', short(t), e.message));
}
// where the tokens went: a pool manager, router or curve, or any contract whose transaction swapped = sold;
// a wallet = moved; any other contract = sent to a contract
async function bwKind(r) {
  if (knownPms.has(r.to) || ROUTERS.has(r.to) || ascUrs().includes(r.to)) return 'sold';
  if (!(await isContract(r.to).catch(() => false))) return 'moved';
  if (!kindOf.has(r.tx)) {
    if (kindOf.size > 5000) kindOf.clear();
    const rc = await rpc('eth_getTransactionReceipt', [r.tx]).catch(() => null);
    kindOf.set(r.tx, (rc?.logs || []).some((l) => [T_SWAP_V4, T_SWAP_V3, T_SWAP_V2, T_SWAP_ASCEND].includes(lc(l.topics?.[0]))) ? 'sold' : 'contract');
  }
  return kindOf.get(r.tx);
}
async function bwSend(t, hs, bag) {
  const x = bw[t], m = await tokenMeta(t), u = await hypeUsd();
  const px = await findRoute(t).then((r) => (r ? priceOf(t, r) : null)).catch(() => null);
  const sup = x.sup > 0n ? x.sup : null;
  const pc = (v) => (v >= 0.1 ? (v * 100).toFixed(0) : (v * 100).toFixed(1)) + '%';
  const ofS = (a) => (sup ? `${(Number((a * 1000000n) / sup) / 1e4).toFixed(2)}% of supply` : `${fmt(num(a, m.d))} ${esc(m.sym)}`);
  const lines = [];
  for (const h of hs) {
    const kinds = await Promise.all(h.rows.map(bwKind));
    const share = (a) => pc(h.base > 0n ? Number((a * 10000n) / h.base) / 10000 : 1);
    const sold = h.rows.filter((_, i) => kinds[i] === 'sold').reduce((a, r) => a + r.amt, 0n);
    const moved = new Map(), sent = new Map();
    h.rows.forEach((r, i) => { const mp = kinds[i] === 'moved' ? moved : kinds[i] === 'contract' ? sent : null; if (mp) mp.set(r.to, (mp.get(r.to) || 0n) + r.amt); });
    const parts = [];
    if (sold) { const hy = px ? num(sold, m.d) * px : null; parts.push(`sold ${share(sold)} of their bag (${ofS(sold)}${hy ? ` ≈ ${fmtH(hy)}${usd(hy, u)}` : ''})`); }
    const alts = (state.bwAlts[t] ||= {});
    for (const [to, a] of moved) {
      let tag = '';
      if (!alts[to] && to !== me && !state.mine[to] && Object.keys(alts).length < 20 && (h.base > 0n ? a * 5n >= h.base : true)) {
        alts[to] = `${h.label.replace(/ \(#\d+ holder\)$/, '').replace(/ alt$/, '')} alt`;
        tag = `, watching it as ${esc(alts[to])}`;
      }
      parts.push(`moved ${share(a)} (${ofS(a)}) to <code>${to}</code>${tag}`);
    }
    for (const [to, a] of sent) parts.push(`sent ${share(a)} (${ofS(a)}) to contract <code>${to}</code>`);
    const left = await balOf(t, h.w).catch(() => null);
    lines.push(`${esc(h.label)} <code>${h.w}</code>\n${parts.join(', ')}${left != null ? ` · ${left > 0n ? ofS(left) + ' left' : 'nothing left'}` : ''}`);
    h.rows = []; h.base = null; h.last = Date.now();
  }
  save();
  const where = [bag?.bot ? 'the bot wallet' : null, ...(bag?.who || [])].filter(Boolean).join(', ');
  await say(`👀 <b>Bag watch · ${esc(m.sym)}</b>${where ? ` · you hold it in ${esc(where)}` : ''}\n${lines.join('\n')}\n<code>${t}</code>`, bag?.bot ? cardButtons(t) : [watchRow(t)]);
}
function bagWatchView() {
  const bags = bagCoins(), all = cfg().bagwatch;
  const head = `👀 <b>Bag watch</b> · ${all ? 'every coin you hold, plus coins you arm' : 'coins you arm (/set bagwatch on watches every coin you hold)'}\n` +
    `Arm or stop one: 👀 on its card, or /bagwatch 0xCOIN\nPosts when the dev sells ${BW_DEV * 100}%+ of their bag, a top holder ${BW_HOLDER * 100}%+, or either ${BW_BIG * 100}%+ of supply`;
  if (!bags.size) return `${head}\n\nNothing watched right now.`;
  const rows = [...bags].map(([t, b]) => {
    const x = bw[t], sym = esc(x?.sym || meta[t]?.sym || state.pos[t]?.sym || short(t)), tag = b.armed ? ' (armed)' : '';
    if (!x?.ready) return `• <b>${sym}</b>${tag}: reading its holders…`;
    const tot = (x.top || []).reduce((a, w) => a + (x.bal.get(w) || 0n), 0n), n = Object.keys(state.bwAlts[t] || {}).length;
    const held = x.sup > 0n ? (Number((tot * 10000n) / x.sup) / 100).toFixed(1) + '% of supply' : fmt(num(tot, x.d));
    return `• <b>${sym}</b>${tag}: dev ${x.dev ? `<code>${x.dev}</code>` : 'unknown'} · top ${x.top?.length || 0} hold ${held}${n ? ` · ${n} alt${n > 1 ? 's' : ''}` : ''}`;
  });
  return `${head}\n\n${rows.join('\n')}`;
}

// pools the index sees live: Ascend launches are posted, snipes fire
async function handleFresh() {
  if (!fresh.length) return;
  const list = fresh.splice(0);
  for (const f of list) if (f.kind === 'ascend') ascAlert(f).catch((e) => console.error('ascend alert', e.message));
  if (!state.snipes.length) return;
  for (const f of list) {
    for (const s of [...state.snipes]) {
      if (f.b <= s.b || (s.got || []).includes(f.t)) continue;
      // a Signal snipe holds a slot while it waits on a coin and spends it only when it buys (sigSnipe, sigDone)
      if (s.k === 'sig') {
        if (f.kind !== 'signal' || s.left - (s.wait || []).length <= 0) continue;
        (s.got ||= []).push(f.t);
        save();
        const why = await sigSkip(f).catch(() => null);
        if (why) { say(`🎯 Signal snipe skipped <code>${f.t}</code>: ${why}. The slot stays for the next launch.`).catch(() => {}); continue; }
        (s.wait ||= []).push({ f, at: Date.now() });
        save();
        sigSnipe(f, s).catch((e) => { console.error('signal snipe', e.message); sigDone(s, f.t, false); });
        continue;
      }
      let hit = false;
      if (s.k === 'token') hit = f.t === s.w;
      else if (s.k === 'new') { hit = f.newPm || (s.pms || []).includes(f.pm); if (hit && f.newPm) (s.pms ||= []).push(f.pm); }
      else if (s.k === 'dev') hit = (f.from ??= await txFrom(f.tx)) === s.w;
      else if (s.k === 'asc') hit = f.kind === 'ascend';
      if (!hit) continue;
      (s.got ||= []).push(f.t);
      if (--s.left <= 0) state.snipes = state.snipes.filter((x) => x.id !== s.id);
      save();
      snipeBuy(f, s).catch((e) => console.error('snipe', e.message));
    }
  }
}
async function snipeBuy(f, s) {
  if (f.kind === 'ascend') return ascSnipe(f, s);
  if (f.kind === 'signal') return sigSnipe(f, s);
  // a coin that already trades elsewhere is bought on its best pool, not blindly on the new one (anyone can open a
  // thin, mispriced pool for any token)
  const others = (state.pools[f.t] || []).some((p) => p.id !== f.id);
  const route = others ? undefined : routeOf(f);
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
// /snipe signal: the next Signal launch(es) on Elysium. Every second the round trip (buy, then sell straight back) is
// simulated at the snipe's size and at half and a quarter of it; the buy goes the first second one of them is within
// the snipe's own limit (or /set tax), at the largest size that is. That waits out the anti-snipe fee, and a size over the launch's wallet cap or
// its per-block budget (the simulated buy reverts) drops to one that fits. A buy that still reverts is tried again the
// next second. Gives up after 11 minutes (the longest fee window is 10).
// Signal's own test launches are skipped: its first coins on Robinhood Chain (Oct 26) were CANARY (launched by its
// tester 0x0f87…3e38, 3 holders), then TOS, NMSS and EGGSFUN with 2 holders each. Signal's Elysium deployer funded
// that same tester on Elysium on Nov 7, minutes after deploying the lane.
const SIG_TESTERS = new Set(['0x0f8742f1d379cfdc474138f35ebd22998b6b3e38']);
async function sigSkip(f) {
  const [cr, nm, m] = await Promise.all([
    ethCall(SIGNAL.hook, '0xff94e4f3' + strip(f.id), {}, undefined, true).then((r) => lc('0x' + strip(r).slice(24, 64))).catch(() => null), // creatorOf(id)
    ethCall(f.t, '0x06fdde03', {}, undefined, true).then(decStr).catch(() => ''),
    tokenMeta(f.t),
  ]);
  if (cr && SIG_TESTERS.has(cr)) return `<b>${esc(m.sym)}</b> was launched by Signal's test wallet ${short(cr)}, most likely a test coin`;
  if (/canary|\btest/i.test(`${m.sym} ${nm}`)) return `<b>${esc(m.sym)}</b> (${esc(nm)}) reads like a test coin`;
  return null;
}
let snipeOffAt = 0; // /snipe off also stops a Signal snipe that is waiting out a launch's fee
// a Signal snipe is done with a coin: it leaves the waiting list, and the slot is spent only when it bought
function sigDone(s, t, bought) {
  s.wait = (s.wait || []).filter((w) => w.f.t !== t);
  if (bought) s.left--;
  if (s.left <= 0 && !s.wait.length) state.snipes = state.snipes.filter((x) => x.id !== s.id);
  save();
}
// t0: when the launch was seen (a wait resumed after a restart keeps its first start, so the 11 minutes still hold)
async function sigSnipe(f, s, t0 = Date.now(), resumed = false) {
  const r = sigRoute(f), t = f.t;
  const label = `🎯 Signal snipe: new coin <code>${t}</code>${resumed ? ' (resumed after a restart)' : ''}`;
  const sizes = [s.hype, s.hype / 2, s.hype / 4].map((h) => Math.round(h * 1000) / 1000).filter((h) => h >= 0.05);
  const lim = s.tax ?? cfg().tax; // this snipe's limit (set with /snipe signal … tax%) or /set tax
  const fits = (x) => x.got > 0n && x.back > 0n && x.loss * 100 <= lim; // a coin that cannot be sold back never fits
  const gone = () => snipeOffAt > t0 || !state.snipes.some((x) => x.id === s.id); // /snipe off, or ✖ on this snipe
  let last = null, told = false, tries = 0, bought = false;
  try {
    while (Date.now() - t0 < 11 * 60000) {
      if (gone()) return say(`${label}\nCancelled before it bought.`);
      const scs = await Promise.all(sizes.map((h) => sellCheck(r, t, toWei(String(h))).catch(() => ({ ok: null, note: 'sell check unavailable' }))));
      last = scs[0];
      const i = scs.findIndex(fits);
      if (i >= 0 && !gone()) {
        // checked just now against this snipe's own limit, so buy() does not refuse it again on /set tax
        const res = await buy(t, sizes[i], null, s.tax != null, 'snipe', { route: r, label: label + (i ? `\nBuying ${sizes[i]} HYPE: ${s.hype} is over the launch's wallet cap or block budget right now` : '') })
          .catch((e) => ({ err: e.message }));
        if (res?.ok) { bought = true; return res; }
        if (res?.err && !/revert|budget|cap|gated|too little|no route/i.test(res.err)) return say(`${label}\n⚠️ ${esc(res.err).slice(0, 200)}\nThe slot is kept for the next Signal launch.`);
        if (++tries >= 8) return say(`${label}\n⚠️ Stopped after ${tries} tries: ${esc(res?.err || 'the buy kept reverting').slice(0, 200)}\nThe slot is kept for the next Signal launch.`);
      } else if (!told && Date.now() - t0 > 1500) {
        told = true;
        const l = scs.find((x) => x.loss != null);
        say(`${label}\n⏱ ${l ? `Buying and selling straight back loses ${(l.loss * 100).toFixed(0)}% right now (limit ${lim}%)` : 'The simulated buy is refused right now (a gate, cap or block budget)'}: checking every second and buying the moment it fits. /snipe off cancels.`).catch(() => {});
      }
      await sleep(1000);
    }
    return say(`${label}\n⚠️ Gave up after 11 minutes: ${esc(last?.note || 'the round trip never came within your limit')}.\nThe slot is kept for the next Signal launch.`);
  } finally {
    sigDone(s, t, bought);
  }
}
// Signal launches read straight from its factory: launchCount() asked of every node, and two read-only ones, every
// 0.4 s while a Signal snipe is armed. The highest answer wins, so one node in step is enough to see a launch while the
// others lag (Nov 7: three of four nodes 74 to 85 blocks behind at times). Its pool comes from launches(i) (the pool
// id) and the hook's poolKey(id), read from the node that saw it. The pool index still adds it again from its
// Initialize log later; that is a duplicate and skipped.
const WATCH_RPCS = [...new Set([...RPCS, ...(process.env.ELY_WATCH_RPCS ?? 'https://rpc.montramarkets.xyz,https://rpc.elytag.com').split(',').map((x) => x.trim()).filter(Boolean)])];
let sigCount = null; // Signal launches seen so far; null until the first read after a snipe is armed (or a restart)
let sigBusy = false, sigPending = null;
async function sigWatch() {
  if (!state.snipes.some((x) => x.k === 'sig')) { sigCount = null; return; }
  const ask = (u, ms) => call1(u, 'eth_call', [{ to: SIGNAL.factory, data: '0x27cca59f' }, 'latest'], ms).then((v) => Number(BigInt(v)));
  if (sigCount == null) {
    // the starting point is the highest count any node gives, so launches from before never fire
    const ns = (await Promise.all(WATCH_RPCS.map((u) => ask(u, 3000).catch(() => null)))).filter((v) => v != null);
    if (ns.length) sigCount = Math.max(...ns);
    return;
  }
  // after that, any node that answers higher starts the snipe at once, without waiting on the slow or lagging ones
  await Promise.all(WATCH_RPCS.map((u) => ask(u, 1500).then((n) => sigNew(u, n)).catch(() => {})));
}
async function sigNew(url, n) {
  if (sigCount == null || n <= sigCount) return;
  if (sigBusy) { if (!sigPending || n > sigPending.n) sigPending = { url, n }; return; }
  sigBusy = true;
  try {
    const head = Number(BigInt(await call1(url, 'eth_blockNumber', [], 2500)));
    for (let i = sigCount; i < n; i++) {
      const id = lc('0x' + strip(await call1(url, 'eth_call', [{ to: SIGNAL.factory, data: enc('7b443a76', i) }, 'latest'], 3000)).slice(0, 64));
      const w = strip(await call1(url, 'eth_call', [{ to: SIGNAL.hook, data: '0xca266dfe' + strip(id) }, 'latest'], 3000)).match(/.{64}/g) || [];
      if (w.length < 5) throw new Error('pool key not readable yet'); // read again on the next tick
      const c0 = lc('0x' + w[0].slice(24)), c1 = lc('0x' + w[1].slice(24));
      sigCount = i + 1;
      if (c0 !== SIGNAL.whype && c1 !== SIGNAL.whype) continue; // paired with another asset, not HYPE: not traded here
      const p = { pm: SIGNAL.pm, kind: 'signal', fee: Number(BigInt('0x' + w[2])), ts: Number(BigInt.asIntN(24, BigInt('0x' + w[3]))), hook: lc('0x' + w[4].slice(24)), b: head, id, q: SIGNAL.whype, qFirst: c0 === SIGNAL.whype };
      const t = p.qFirst ? c1 : c0;
      const list = (state.pools[t] ||= []);
      if (!list.some((y) => y.id === id)) { list.push(p); delete state.routes[t]; }
      fresh.push({ t, ...p, tx: '', newPm: false });
      console.log(`signal launch ${i}: ${t} (seen first on ${url.replace('https://', '')})`);
    }
    save();
    await handleFresh();
  } finally {
    sigBusy = false;
    const nx = sigPending;
    sigPending = null;
    if (nx) sigNew(nx.url, nx.n).catch((e) => console.error('signal watch', e.message));
  }
}
function snipeText(s) {
  if (s.k === 'sig') return `${s.hype} HYPE of the next ${s.left > 1 ? s.left + ' Signal launches' : 'Signal launch'} on Elysium, once the round trip loses ${s.tax ?? cfg().tax}% or less${s.wait?.length ? ` (waiting on ${s.wait.length} now)` : ''}`;
  if (s.k === 'asc') return `${s.hype} HYPE of the next ${s.left > 1 ? s.left + ' Ascend launches' : 'Ascend launch'}, ${ascDelayText()}`;
  return s.k === 'token' ? `${s.hype} HYPE of <code>${short(s.w)}</code> when its pool opens` :
    s.k === 'dev' ? `${s.hype} HYPE of the next ${s.left > 1 ? s.left + ' coins' : 'coin'} ${short(s.w)} launches` :
    `${s.hype} HYPE of the first ${s.left > 1 ? s.left + ' coins' : 'coin'} on any new pool manager`;
}

// copy trading: Transfer logs to and from the copied wallets, every second
const NOCOPY = new Set(['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81', '0x5ab377328592c03b5e7adb09254adb043f91fa11', '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65']); // WHYPEs, USDC
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

// ── your other wallets: watch-only, for the journal and the tips ──────────────────────────────────────
// Wallets you trade from yourself (another bot, a site) are added with /mine. The bot never holds their keys and
// never trades from them. Their buys and sells on Elysium are read from the chain into the journal, /stats and the
// nightly tips, beside the bot's own trades. A trade's HYPE side is the wallet's HYPE balance change across that
// block plus gas plus any WHYPE it paid or got, so a trade through any bot, router or site counts the same.
// Adding a wallet first imports its whole Elysium history. Each coin also gets its price history from the pool it
// was traded on, to see how far it ran after the buy (round trips, late exits) and how far it had run before.
state.mine ||= {};     // wallet → { name, at, imported }
state.mpos ||= {};     // wallet → coin → position (cost basis, peak, run-up, pool)
state.mineSeen ||= {}; // `${hash}:${wallet}` → time (each transaction read once per wallet)
state.mineMove ||= {}; // `${hash}:${coin}:${to}` → cost that moved with tokens sent to another of your wallets
const ARCHIVE = process.env.ARCHIVE_RPC || 'https://rpc.eleos.fun'; // archive node: balances at past blocks
const T_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const WHYPES = new Set(['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81', '0x5ab377328592c03b5e7adb09254adb043f91fa11', '0x9f041fad8323d7c5bf8f928aade05b610df34b64']);
const MINE_SKIP = new Set(['0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65']); // USDC: not a coin trade
const DUST = 0.0005;          // HYPE: below this a token move is a transfer, not a trade
const RUNUP_BLOCKS = 12000;   // about half an hour of Elysium blocks: the run-up looked at before each buy
const mineName = (w) => state.mine[w]?.name || short(w);
const noteAsk = {};           // message id of a 📒 trade note question → journal entry ids
const noteSent = {};          // coin → last 📒 buy message (a coin bought in two of your wallets at once asks once)
// "missing trie node": the node that answered keeps no state for that block (the archive host sits behind a load
// balancer with some pruned nodes), so the same call is asked again and lands on another node
const stateGone = (e) => /missing trie node|is not available|header not found|state.{0,40}not found|pruned/i.test(`${e?.message}`);
const STATE_CALLS = new Set(['eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getCode', 'eth_getStorageAt']);
async function arch(method, params) {
  let last;
  for (let i = 0; i < 8; i++) {
    try { return await call1(ARCHIVE, method, params, 12000); } catch (e) { last = e; if (!transient(e) && !stateGone(e)) break; await sleep(500 * (i + 1)); }
  }
  // the live nodes keep recent state only: a balance or nonce at an old block has to come from the archive node,
  // so asking them only turns a busy archive into a wrong "missing trie node"
  if (STATE_CALLS.has(method) && params[params.length - 1] !== 'latest') throw last;
  return rpc(method, params);
}
async function pmap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
// logs over any block range, 2,000 blocks per request, a few at once; a window that keeps failing is asked of the archive node
async function logsRange(filter, from, to, n = 6) {
  const wins = [];
  for (let a = Math.max(0, from); a <= to; a += 2000) wins.push([a, Math.min(to, a + 1999)]);
  const res = await pmap(wins, n, async ([a, b]) => {
    const q = [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }];
    try { return await rpc('eth_getLogs', q, 5); } catch { return arch('eth_getLogs', q); }
  });
  return res.flat();
}
// HYPE per token at a swap, from the pool's sqrt price; flip = HYPE is the pool's first currency
function swapPx(src, data, d) {
  const sp = Number(BigInt('0x' + (strip(data).slice(128, 192) || '0'))) / 2 ** 96;
  if (!(sp > 0)) return null;
  const raw = sp * sp;
  return (src.flip ? 1 / raw : raw) * 10 ** (d - 18);
}

// one wallet's token moves in one block, and its HYPE change across that block
async function readTrades(w, b, txs) {
  const [before, after] = await Promise.all([arch('eth_getBalance', [w, hex(b - 1)]), arch('eth_getBalance', [w, hex(b)])]);
  let hypeLeg = num(BigInt(after) - BigInt(before));
  const toks = {}, swaps = [];
  for (const x of txs) {
    if (x.from === w) hypeLeg += x.gas;
    for (const l of x.logs) {
      const t0 = lc(l.topics?.[0]);
      if (t0 === T_SWAP_V4) swaps.push({ kind: 'v4', pm: lc(l.address), id: lc(l.topics[1]), data: l.data, hash: x.hash });
      else if (t0 === T_SWAP_V3) swaps.push({ kind: 'v3', pool: lc(l.address), data: l.data, hash: x.hash });
      if (t0 !== T_TRANSFER || l.topics.length !== 3) continue;
      const f = lc('0x' + l.topics[1].slice(26)), to = lc('0x' + l.topics[2].slice(26)), a = lc(l.address);
      if (f === to || (f !== w && to !== w)) continue;
      const v = BigInt(l.data || '0x0');
      if (WHYPES.has(a)) { hypeLeg += (to === w ? 1 : -1) * num(v); continue; }
      if (MINE_SKIP.has(a)) continue;
      const k = (toks[a] ||= { amt: 0n, peer: null, hash: x.hash });
      k.amt += to === w ? v : -v;
      k.peer = to === w ? f : to;
      k.hash = x.hash;
    }
  }
  return { hypeLeg, toks, swaps };
}
const mpos = (w, t, sym) => ((state.mpos[w] ||= {})[t] ||= { sym, hypeIn: 0, hypeOut: 0, tokIn: 0, tokOut: 0, cost: 0, held: 0 });
// the pool a fill went through: the swap in the same transaction whose price matches the fill
function pickPool(p, swaps, fillPx, d) {
  let best = null, err = Infinity;
  for (const s of swaps) {
    for (const flip of [false, true]) {
      const src = s.kind === 'v4' ? { kind: 'v4', pm: s.pm, id: s.id, flip } : { kind: 'v3', pool: s.pool, flip };
      const px = swapPx(src, s.data, d);
      if (!px) continue;
      const e = Math.abs(Math.log(px / fillPx));
      if (e < err) { err = e; best = src; }
    }
  }
  if (best && err < 0.7) p.src = best; // within 2× of the fill (fees, slippage, a multi-hop route)
}
// turn one wallet-block into journal entries; moves in from another of your wallets come back in `later`
async function applyTrades(w, b, ms, r, live, later) {
  const coins = Object.entries(r.toks).filter(([, k]) => k.amt !== 0n);
  if (!coins.length) return [];
  const each = r.hypeLeg / coins.length;
  const px = await hypeUsd();
  const done = [];
  for (const [t, k] of coins) {
    const m = await tokenMeta(t);
    const amt = num(k.amt < 0n ? -k.amt : k.amt, m.d);
    if (!(amt > 0)) continue;
    const own = !!state.mine[k.peer];
    if (k.amt > 0n && each < -DUST) {
      const hype = -each, p = mpos(w, t, m.sym);
      p.hypeIn += hype; p.tokIn += amt; p.cost += hype; p.held += amt;
      p.first ||= ms; p.b0 ||= b; p.lastBuy = ms; p.nb = (p.nb || 0) + 1; p.open = true;
      const fill = hype / amt;
      if (!p.src) pickPool(p, r.swaps.filter((s) => s.hash === k.hash), fill, m.d);
      const mc = fill * num(m.sup, m.d);
      if (p.mc0Usd == null && mc && px) p.mc0Usd = mc * px;
      const e = { side: 'buy', coin: t, sym: m.sym, hype, tok: amt, mcUsd: mc && px ? mc * px : null, src: mineName(w), w, hash: k.hash, t: ms, id: oid() };
      J(e); done.push(e);
    } else if (k.amt < 0n && each > DUST) {
      const hype = each, p = mpos(w, t, m.sym);
      const frac = p.held > 0 ? Math.min(1, amt / p.held) : 1;
      p.cost -= p.cost * frac; p.held = Math.max(0, p.held - amt);
      if (p.held / Math.max(p.tokIn, 1e-18) < 0.02) { p.held = 0; p.cost = 0; p.open = false; p.now = 0; } // all out (taxed coins leave crumbs)
      p.hypeOut += hype; p.tokOut += amt; p.lastSell = ms; p.lastSellB = b; p.ns = (p.ns || 0) + 1;
      if (!p.src) pickPool(p, r.swaps.filter((s) => s.hash === k.hash), hype / amt, m.d);
      const e = { side: 'sell', coin: t, sym: m.sym, hype, tok: amt, src: mineName(w), w, hash: k.hash, t: ms, id: oid() };
      J(e); done.push(e);
    } else if (k.amt < 0n) {
      // sent away: the cost leaves with the tokens, so it is neither a win nor a loss here
      const p = state.mpos[w]?.[t];
      if (!p) continue;
      const frac = p.held > 0 ? Math.min(1, amt / p.held) : 1;
      const moved = p.cost * frac;
      p.cost -= moved; p.held = Math.max(0, p.held - amt); p.hypeIn = Math.max(0, p.hypeIn - moved); p.tokIn = Math.max(0, p.tokIn - amt);
      if (own) state.mineMove[`${k.hash}:${t}:${k.peer}`] = moved;
    } else if (own) {
      later.push({ w, t, m, amt, key: `${k.hash}:${t}:${w}`, ms, b });
    }
    // anything else coming in (airdrops, claims) is not a trade
  }
  return done;
}
function applyMoves(later) {
  for (const x of later) {
    const cost = state.mineMove[x.key];
    if (cost == null) continue;
    delete state.mineMove[x.key];
    const p = mpos(x.w, x.t, x.m.sym);
    p.hypeIn += cost; p.tokIn += x.amt; p.cost += cost; p.held += x.amt; p.first ||= x.ms; p.b0 ||= x.b; p.open = true;
  }
}
// read a set of transactions for the given wallets: receipts, then each wallet-block in block order
const seenKey = (h, w) => `${h}:${w.slice(2, 10)}`;
const mineRetry = new Map(); // tx hash → tries, for receipts a node could not give yet
async function mineRead(hashes, wallets, live) {
  const ws = new Set(wallets);
  const todo = [...new Set(hashes)].filter((h) => wallets.some((w) => !state.mineSeen[seenKey(h, w)]));
  const got = await pmap(todo, 6, async (h) => {
    try {
      const [rc, tx] = await Promise.all([rpc('eth_getTransactionReceipt', [h]), rpc('eth_getTransactionByHash', [h])]);
      if (!rc || !tx) throw new Error('not visible yet');
      mineRetry.delete(h);
      if (rc.status !== '0x1') { for (const w of ws) state.mineSeen[seenKey(h, w)] = Date.now(); return null; }
      return { hash: h, b: parseInt(rc.blockNumber, 16), logs: rc.logs || [], from: lc(tx.from), gas: num(BigInt(rc.gasUsed || 0) * BigInt(rc.effectiveGasPrice || tx.gasPrice || 0)) };
    } catch {
      const n = (mineRetry.get(h) || 0) + 1;
      if (live && n < 30) mineRetry.set(h, n); else mineRetry.delete(h); // live: asked again on the next ticks
      return null;
    }
  });
  const groups = {};
  for (const x of got) {
    if (!x) continue;
    for (const w of ws) {
      if (state.mineSeen[seenKey(x.hash, w)]) continue;
      const hit = x.logs.some((l) => lc(l.topics?.[0]) === T_TRANSFER && l.topics.length === 3 && (lc('0x' + l.topics[1].slice(26)) === w || lc('0x' + l.topics[2].slice(26)) === w));
      if (hit) (groups[`${w}:${x.b}`] ||= { w, b: x.b, txs: [] }).txs.push(x);
      state.mineSeen[seenKey(x.hash, w)] = Date.now();
    }
  }
  const order = Object.values(groups).sort((a, b) => a.b - b.b);
  const times = {};
  await pmap([...new Set(order.map((g) => g.b))], 6, async (b) => { try { times[b] = parseInt((await rpc('eth_getBlockByNumber', [hex(b), false])).timestamp, 16) * 1000; } catch { times[b] = Date.now(); } });
  const out = [], later = [];
  for (const g of order) {
    // in block order: a trade read later than the ones after it would mix up the cost of a coin, so a failed read
    // is asked again here before moving on
    let r = null, err = null;
    for (let k = 0; k < 4 && !r; k++) {
      try { r = await readTrades(g.w, g.b, g.txs); } catch (e) { err = e; await sleep(3000 * (k + 1)); }
    }
    if (!r) {
      console.error('mine read', g.w, g.b, err?.message);
      for (const x of g.txs) delete state.mineSeen[seenKey(x.hash, g.w)];
      (state.mineGaps ||= {})[`${g.w}:${g.b}`] = Date.now();
      continue;
    }
    try { out.push(...(await applyTrades(g.w, g.b, times[g.b], r, live, later))); }
    catch (e) { console.error('mine apply', g.w, g.b, e.message); }
  }
  applyMoves(later);
  if (Object.keys(state.mineSeen).length > 20000) { const keep = Object.entries(state.mineSeen).sort((a, b) => b[1] - a[1]).slice(0, 10000); state.mineSeen = Object.fromEntries(keep); }
  save();
  return out;
}

// price history since each buy: how far the coin ran after it (peak) and before it (run-up), and its price now
async function mineHistory(head) {
  const list = [];
  for (const [w, ps] of Object.entries(state.mpos)) for (const [t, p] of Object.entries(ps)) {
    if (!p.src || !p.b0 || p.hdone) continue;
    list.push({ w, t, p });
  }
  if (!list.length) return;
  const v4 = list.filter((x) => x.p.src.kind === 'v4'), v3 = list.filter((x) => x.p.src.kind === 'v3');
  const from = Math.min(...list.map((x) => (x.p.hb ? x.p.hb + 1 : x.p.b0 - RUNUP_BLOCKS)));
  if (from > head) return;
  const logs = [];
  if (v4.length) logs.push(...(await logsRange({ address: [...new Set(v4.map((x) => x.p.src.pm))], topics: [T_SWAP_V4, [...new Set(v4.map((x) => x.p.src.id))]] }, from, head)));
  if (v3.length) logs.push(...(await logsRange({ address: [...new Set(v3.map((x) => x.p.src.pool))], topics: [T_SWAP_V3] }, from, head)));
  const by = {};
  for (const l of logs) (by[l.topics[0] === T_SWAP_V4 ? lc(l.topics[1]) : lc(l.address)] ||= []).push(l);
  for (const { t, p } of list) {
    const m = await tokenMeta(t);
    const ls = (by[p.src.kind === 'v4' ? p.src.id : p.src.pool] || []).sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
    const end = p.held > 0 ? head : p.lastSellB || head;
    for (const l of ls) {
      const b = parseInt(l.blockNumber, 16);
      if (p.hb && b <= p.hb) continue;
      const px = swapPx(p.src, l.data, m.d);
      if (!px) continue;
      if (b < p.b0) { if (b >= p.b0 - RUNUP_BLOCKS) p.preMin = Math.min(p.preMin ?? Infinity, px); continue; }
      if (b <= end) p.pkPx = Math.max(p.pkPx || 0, px);
      p.lastPx = px; p.lastPxAt = Date.now();
    }
    p.hb = head;
    if (!(p.held > 0)) p.hdone = true; // closed: its history is complete up to the last sell
  }
  save();
}
// open bags of your wallets: what is really in the wallet now, at the pool's last price (or a quote)
async function mineValue() {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  await mineHistory(head).catch((e) => console.error('mine history', e.message));
  for (const [w, ps] of Object.entries(state.mpos)) for (const [t, p] of Object.entries(ps)) {
    if (!(p.held > 0) && !(p.now > 0)) continue;
    try {
      const m = await tokenMeta(t);
      const bal = num(await balOf(t, w), m.d);
      if (bal <= 0) { p.now = 0; p.open = false; if (p.held > 0) { p.held = 0; p.cost = 0; } continue; }
      let px = p.lastPx && p.src ? p.lastPx : null;
      if (!px) { const r = await findRoute(t); if (r) px = await priceOf(t, r); }
      if (px) { p.now = bal * px; p.nowAt = Date.now(); }
      p.open = bal / Math.max(p.tokIn, 1e-18) > 0.02;
    } catch {}
  }
  save();
}

// live: Transfer logs to and from your wallets, every few seconds; after a restart it catches up on what it missed
let mineNonceAt = 0;
async function mineTick() {
  const ws = Object.keys(state.mine).filter((w) => state.mine[w].imported);
  if (!ws.length) return;
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  if (!state.mineBlock) state.mineBlock = head;
  if (head <= state.mineBlock) return;
  const from = state.mineBlock + 1 - 12, to = Math.min(head, state.mineBlock + 40000);
  const pad = ws.map((w) => '0x' + word(w));
  const [ins, outs] = await Promise.all([logsRange({ topics: [T_TRANSFER, null, pad] }, from, to), logsRange({ topics: [T_TRANSFER, pad] }, from, to)]);
  state.mineBlock = to;
  const hashes = [...ins, ...outs].map((l) => lc(l.transactionHash)).concat([...mineRetry.keys()]);
  const ev = hashes.length ? await mineRead(hashes, ws, true) : [];
  // the nonce check once a minute catches anything the log tail missed
  if (Date.now() - (mineNonceAt || 0) > 60000) { mineNonceAt = Date.now(); ev.push(...(await mineNonces(head).catch((e) => { console.error('mine nonces', e.message); return []; }))); }
  save();
  if (ev.length && cfg().notes) await mineNotify(ev, head).catch((e) => console.error('mine notify', e.message));
}
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`; };
// a 📒 message for each buy (why?) and each coin closed (what did you learn?); replies are saved on the trade
async function mineNotify(ev, head) {
  const px = await hypeUsd();
  await mineHistory(head).catch(() => {}); // run-ups before the new buys, peaks of the coins just closed
  for (const e of ev.filter((x) => x.side === 'buy')) {
    const last = noteSent[e.coin];
    if (last && Date.now() - last.at < 5 * 60000) { (noteAsk[last.id] ||= []).push(e.id); continue; } // the same coin in another of your wallets
    const p = state.mpos[e.w]?.[e.coin];
    const ran = p?.preMin && p.hypeIn ? (e.hype / e.tok) / p.preMin : null;
    const m = await tg('sendMessage', { chat_id: OWNER, parse_mode: 'HTML', disable_web_page_preview: true, text: `📒 <b>${esc(mineName(e.w))}</b> bought <b>${esc(e.sym)}</b> · ${fmtH(e.hype)}${usd(e.hype, px)}${e.mcUsd ? ` at MC $${fmt(e.mcUsd)}` : ''}${ran && ran >= 1.5 ? ` · it had already run ${ran.toFixed(1)}× in the half hour before` : ''}\nWhy this one? Reply to note it (optional).`, reply_markup: { force_reply: true, input_field_placeholder: 'why I bought' } });
    if (m?.message_id) { noteAsk[m.message_id] = [e.id]; noteSent[e.coin] = { id: m.message_id, at: Date.now() }; }
  }
  const closed = [...new Map(ev.filter((x) => x.side === 'sell').map((x) => [`${x.w}:${x.coin}`, x])).values()].filter((x) => !(state.mpos[x.w]?.[x.coin]?.held > 0));
  for (const e of closed) {
    const p = state.mpos[e.w][e.coin];
    const pl = p.hypeOut - p.hypeIn, r = p.hypeIn > 0 ? pl / p.hypeIn : 0;
    const entry = p.tokIn > 0 ? p.hypeIn / p.tokIn : null, exit = p.tokOut > 0 ? p.hypeOut / p.tokOut : null;
    const pk = p.pkPx && entry ? p.pkPx / entry : null;
    const off = p.pkPx && exit ? 1 - exit / p.pkPx : null;
    const lines = [`📒 <b>${esc(mineName(e.w))}</b> closed <b>${esc(e.sym)}</b>: in ${fmtH(p.hypeIn)} · out ${fmtH(p.hypeOut)} · <b>${pl >= 0 ? '+' : ''}${fmtH(pl)} (${pct(r)})</b>${p.first ? ` · held ${dur((p.lastSell || Date.now()) - p.first)}` : ''}`];
    if (pk && pk >= 1.3) lines.push(`It ran ${pk.toFixed(1)}× after your first buy${off != null && off > 0.15 ? `; you sold ${(off * 100).toFixed(0)}% under the top` : ''}.`);
    else if (pk != null && pk < 1.15) lines.push('It never went 15% above your entry.');
    lines.push('What did you learn? Reply to note it (optional).');
    const m = await tg('sendMessage', { chat_id: OWNER, parse_mode: 'HTML', disable_web_page_preview: true, text: lines.join('\n'), reply_markup: { force_reply: true, input_field_placeholder: 'the lesson' } });
    if (m?.message_id) noteAsk[m.message_id] = [e.id];
  }
  const ks = Object.keys(noteAsk); if (ks.length > 100) for (const k of ks.slice(0, ks.length - 100)) delete noteAsk[k];
}
// every transaction a wallet sent from nonce `after` on, found by nonce (a log query under load can come back empty,
// a nonce count cannot): for each nonce, the first block where the wallet's count passes it
async function sentTxs(w, head, after = 0, low = 0) {
  const n = Number(BigInt(await arch('eth_getTransactionCount', [w, hex(head)])));
  if (n <= after || n - after > 3000) return { n, hashes: [] };
  const k = n - after, lo = new Array(k).fill(low), hi = new Array(k).fill(head);
  for (let round = 0; round < 48; round++) {
    const idx = [];
    for (let i = 0; i < k; i++) if (hi[i] - lo[i] > 1) idx.push(i);
    if (!idx.length) break;
    await pmap(idx, 8, async (i) => {
      const mid = Math.floor((lo[i] + hi[i]) / 2);
      try { const c = Number(BigInt(await arch('eth_getTransactionCount', [w, hex(mid)]))); if (c >= after + i + 1) hi[i] = mid; else lo[i] = mid; } catch {}
    });
  }
  const hashes = [];
  await pmap([...new Set(hi)], 6, async (b) => {
    try { const blk = await arch('eth_getBlockByNumber', [hex(b), true]); for (const t of blk.transactions || []) if (lc(t.from) === w) hashes.push(lc(t.hash)); } catch {}
  });
  return { n, hashes };
}
// once a minute: any nonce the live log tail missed is read by nonce
async function mineNonces(head) {
  const ev = [];
  for (const [w, x] of Object.entries(state.mine)) {
    if (!x.imported || x.nonce == null) continue;
    const latest = Number(BigInt(await rpc('eth_getTransactionCount', [w, 'latest'])));
    if (latest <= x.nonce) continue;
    const { n, hashes } = await sentTxs(w, head, x.nonce, Math.max(0, (x.nonceB || head) - 2000));
    ev.push(...(await mineRead(hashes, [w], true)));
    x.nonce = n; x.nonceB = head;
  }
  save();
  return ev;
}
// first import: every Transfer to or from the wallets over the whole chain plus every transaction they sent, then
// their price histories
const importing = new Set();
const noteKey = (e) => `${e.w}:${e.hash}:${e.side}:${e.coin}`;
// wipe what was read from your wallets and read it all again; trade notes are put back on the same trades
function mineRebuild(quiet = false) {
  const ws = Object.keys(state.mine);
  if (!ws.length) return;
  const keep = state.mineNotesKeep || {};
  for (const e of state.journal) if (e.w && e.note) keep[noteKey(e)] = e.note;
  state.mineNotesKeep = keep;
  for (const w of ws) { delete state.mpos[w]; state.mine[w].imported = 0; }
  state.journal = state.journal.filter((e) => !e.w);
  state.mineSeen = {};
  state.mineMove = {};
  state.mineGaps = {};
  save();
  mineImport(ws, quiet).catch((e) => console.error('mine import', e.message));
}
async function mineImport(wallets, quiet = false) {
  const ws = wallets.filter((w) => !importing.has(w));
  if (!ws.length) return;
  for (const w of ws) importing.add(w);
  try {
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const pad = ws.map((w) => '0x' + word(w));
    const t0 = Date.now();
    // three windows at a time each way: under heavier load a node can answer a log query empty
    const [ins, outs] = await Promise.all([logsRange({ topics: [T_TRANSFER, null, pad] }, 1, head, 3), logsRange({ topics: [T_TRANSFER, pad] }, 1, head, 3)]);
    const sent = [];
    for (const w of ws) { const s = await sentTxs(w, head); sent.push(...s.hashes); if (state.mine[w]) { state.mine[w].nonce = s.n; state.mine[w].nonceB = head; } }
    const ev = await mineRead([...ins, ...outs].map((l) => lc(l.transactionHash)).concat(sent), ws, false);
    // trades made while the import ran: the live tail may already be past them for the wallets added before
    if (state.mineBlock > head) {
      const [i2, o2] = await Promise.all([logsRange({ topics: [T_TRANSFER, null, pad] }, head + 1, state.mineBlock), logsRange({ topics: [T_TRANSFER, pad] }, head + 1, state.mineBlock)]);
      ev.push(...(await mineRead([...i2, ...o2].map((l) => lc(l.transactionHash)), ws, false)));
    }
    state.journal.sort((a, b) => a.t - b.t);
    const keep = state.mineNotesKeep;
    if (keep) { for (const e of state.journal) { const n = e.w && keep[noteKey(e)]; if (n && !e.note) e.note = n; } if (!Object.keys(state.mine).some((w) => !state.mine[w].imported && !ws.includes(w))) delete state.mineNotesKeep; }
    for (const w of ws) if (state.mine[w]) state.mine[w].imported = head;
    if (!state.mineBlock) state.mineBlock = head;
    save();
    await mineValue().catch((e) => console.error('mine value', e.message));
    if (quiet) return;
    const lines = ws.map((w) => {
      const ps = Object.values(state.mpos[w] || {}).filter((p) => p.hypeIn > 0);
      const n = ev.filter((e) => e.w === w);
      const inv = ps.reduce((a, p) => a + p.hypeIn, 0), out = ps.reduce((a, p) => a + p.hypeOut, 0), now = ps.reduce((a, p) => a + (p.now || 0), 0);
      return `• <b>${esc(mineName(w))}</b>: ${n.filter((e) => e.side === 'buy').length} buys, ${n.filter((e) => e.side === 'sell').length} sells on ${ps.length} coins · in ${fmtH(inv)} · out ${fmtH(out)} · holding ${fmtH(now)} · <b>${out + now - inv >= 0 ? '+' : ''}${fmtH(out + now - inv)}</b>`;
    });
    await say(`📒 Imported (${Math.round((Date.now() - t0) / 1000)} s):\n${lines.join('\n')}\n\nThey are in /journal, /stats and the nightly tips from now on. /stats all mine for the full read.`);
  } catch (e) {
    console.error('mine import', e.message);
    if (!quiet) await say(`⚠️ Import stopped: ${esc(e.message).slice(0, 200)}. /mine sync tries again.`);
  } finally { for (const w of ws) importing.delete(w); }
}
function mineView() {
  const ws = Object.entries(state.mine);
  if (!ws.length) return { text: 'No wallets of yours added yet.\n/mine add 0xWALLET [name] · several addresses in one message work too. Watch-only: the bot never trades from them.', rows: null };
  const rows = ws.map(([w, x]) => {
    const ps = Object.values(state.mpos[w] || {}).filter((p) => p.hypeIn > 0);
    const open = ps.filter((p) => p.open && (p.now || 0) > DUST);
    return `• <b>${esc(x.name)}</b> <code>${w}</code>\n   ${x.imported ? `${ps.length} coins · ${open.length} open bags worth ${fmtH(open.reduce((a, p) => a + (p.now || 0), 0))}` : 'importing…'}`;
  });
  return {
    text: `📒 <b>Your wallets</b> (watch-only)\n${rows.join('\n')}${Object.keys(state.mineGaps || {}).length ? `\n\n⚠️ ${Object.keys(state.mineGaps).length} trade block(s) could not be read from the node, so some numbers are short. /mine sync reads everything again.` : ''}\n\nTrade notes ${cfg().notes ? 'on' : 'off'} (/mine notes on|off) · /mine name 0x… main · /mine sync rebuilds from the chain · /stats 7d mine`,
    rows: ws.map(([w, x]) => [{ text: `✖ ${x.name}`, callback_data: `u:${w.slice(2)}` }]),
  };
}
function mineDrop(w) {
  delete state.mine[w]; delete state.mpos[w];
  state.journal = state.journal.filter((e) => e.w !== w);
  save();
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
  const map = [['🚀', 'launch alert'], ['🔥', 'volume run'], ['🎯', 'group buy'], ['👛', 'wallet move'], ['🧬', 'fresh wallet'], ['🌉', 'bridge'], ['🚨', 'gate'], ['🛬', 'cielo arrival'], ['🆕', 'ascend launch']];
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
  if (Object.keys(state.mine).length) await mineValue().catch((e) => console.error('mine value', e.message));
}
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const mcBucket = (usdMc) => (usdMc == null ? null : usdMc < 5e3 ? 'under $5K' : usdMc < 20e3 ? '$5K to $20K' : usdMc < 100e3 ? '$20K to $100K' : 'over $100K');
const sizeBucket = (h) => (h < 1 ? 'under 1 HYPE' : h <= 2.01 ? '1 to 2 HYPE' : h <= 5 ? '2 to 5 HYPE' : 'over 5 HYPE');
const holdBucket = (ms) => (ms == null ? null : ms < 15 * 60000 ? 'under 15 min' : ms < 2 * 3600e3 ? '15 min to 2 h' : 'over 2 h');
// who: 'all' (the bot and your wallets), 'bot', 'mine' (your wallets), or one of your wallets by name
function stats(sinceMs = 0, who = 'all') {
  const wantBot = who === 'all' || who === 'bot';
  const wantW = (w) => who === 'all' || who === 'mine' || lc(state.mine[w]?.name) === who || w === who;
  const rows = [];
  if (wantBot) {
    const coins = new Set(state.journal.filter((e) => e.side === 'buy' && !e.w && e.t >= sinceMs).map((e) => e.coin));
    for (const c of coins) {
      const p = state.pos[c];
      if (!p || !(p.hypeIn > 0)) continue;
      const pl = (p.now ?? 0) + (p.hypeOut || 0) - p.hypeIn;
      rows.push({ c, sym: p.sym, inv: p.hypeIn, out: p.hypeOut || 0, now: p.now ?? 0, pl, r: pl / p.hypeIn, src: p.src || 'card', mc0: p.mc0Usd ?? null, peak: p.peak || 0, open: (p.now ?? 0) > 0.0005, first: p.first, lastSell: p.lastSell });
    }
  }
  // your wallets: one row per wallet and coin, with how far the coin ran after the first buy (pk), how far it had
  // run in the half hour before it (runup) and how far under its top the exit was (off)
  for (const [w, ps] of Object.entries(state.mpos)) {
    if (!state.mine[w] || !wantW(w)) continue;
    for (const [c, p] of Object.entries(ps)) {
      if (!(p.hypeIn > 0) || (p.lastBuy || p.first || 0) < sinceMs) continue;
      const now = p.open ? p.now ?? 0 : 0;
      const pl = now + p.hypeOut - p.hypeIn;
      const entry = p.tokIn > 0 ? p.hypeIn / p.tokIn : null, exit = p.tokOut > 0 ? p.hypeOut / p.tokOut : null;
      const pk = p.pkPx && entry ? Math.max(1, p.pkPx / entry) : null;
      rows.push({
        c, w, mine: true, sym: p.sym, inv: p.hypeIn, out: p.hypeOut, now, pl, r: pl / p.hypeIn, src: mineName(w), mc0: p.mc0Usd ?? null,
        peak: pk ? pk * p.hypeIn : 0, open: !!p.open && now > DUST, first: p.first, lastSell: p.lastSell,
        pk, runup: p.preMin && entry ? entry / p.preMin : null, off: !p.open && exit && p.pkPx ? Math.max(0, 1 - exit / p.pkPx) : null,
        hold: !p.open && p.first && p.lastSell ? p.lastSell - p.first : null,
      });
    }
  }
  const j = state.journal.filter((e) => e.t >= sinceMs && (e.w ? state.mine[e.w] && wantW(e.w) : wantBot));
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
  const group = (key, xs = rows) => {
    const g = {};
    for (const x of xs) { const k = key(x); if (!k) continue; (g[k] ||= []).push(x); }
    return Object.entries(g).map(([k, ys]) => ({ k, n: ys.length, avg: ys.reduce((a, x) => a + x.r, 0) / ys.length, pl: ys.reduce((a, x) => a + x.pl, 0), win: ys.filter((x) => x.pl > 0).length / ys.length }));
  };
  s.bySrc = group((x) => x.src).sort((a, b) => b.avg - a.avg);
  s.byMc = group((x) => mcBucket(x.mc0)).sort((a, b) => b.avg - a.avg);
  s.bySize = group((x) => sizeBucket(x.inv)).sort((a, b) => b.pl - a.pl);
  s.byHold = group((x) => holdBucket(x.hold), rows.filter((x) => x.mine && !x.open)).sort((a, b) => b.pl - a.pl);
  return s;
}
function tips(s, hypeNow) {
  const out = [];
  const bot = s.rows.filter((x) => !x.mine), mine = s.rows.filter((x) => x.mine);
  const list = (xs) => xs.map((x) => `${esc(x.sym)}${Object.keys(state.mine).length > 1 && x.mine ? ` in ${esc(x.src)}` : ''}`);
  const tries = s.buys + s.reverts;
  if (tries >= 5 && s.reverts / tries >= 0.3) out.push([5, `${s.reverts} of ${tries} buys reverted on slippage. Fresh launches move fast: try <code>/set slip 25</code> (now ${Number(cfg().slip) / 100}%).`]);
  if (tries >= 8 && s.reverts === 0 && cfg().slip >= 3000n && bot.length) out.push([5, `No reverts at ${Number(cfg().slip) / 100}% slippage: <code>/set slip 20</code> would stop you overpaying on fills.`]);
  const src = s.bySrc.filter((x) => x.n >= 3);
  if (src.length >= 2) {
    const b = src[0], w = src[src.length - 1];
    if (b.avg - w.avg > 0.3) out.push([7, `Buys from <b>${esc(b.k)}</b> average ${pct(b.avg)} (${b.n} coins) vs <b>${esc(w.k)}</b> ${pct(w.avg)} (${w.n}). Lean on the first, size down or skip the second.`]);
  }
  const mc = s.byMc.filter((x) => x.n >= 3);
  if (mc.length >= 2 && mc[0].avg - mc[mc.length - 1].avg > 0.3) out.push([7, `Entries at <b>${mc[0].k}</b> market cap average ${pct(mc[0].avg)}; at ${mc[mc.length - 1].k} ${pct(mc[mc.length - 1].avg)}.`]);
  const dead = s.rows.filter((x) => x.open && x.r <= -0.5 && Date.now() - (x.first || 0) > 24 * 3600e3).sort((a, b) => a.r - b.r);
  if (dead.length) out.push([3, `Bags down over 50% for a day or more: ${dead.slice(0, 3).map((x) => `${list([x])[0]} ${pct(x.r)}`).join(', ')}. Cut them or write them off; they rarely come back.`]);
  const runners = s.rows.filter((x) => x.open && x.out === 0 && x.now >= 2 * x.inv).sort((a, b) => b.now / b.inv - a.now / a.inv);
  if (runners.length) out.push([1, `${runners.slice(0, 2).map((x) => `<b>${list([x])[0]}</b> is ${(x.now / x.inv).toFixed(1)}×`).join(', ')} with nothing taken. ${runners[0].mine ? `Sell ${Math.round(100 / (runners[0].now / runners[0].inv))}% to get your stake back; the rest rides free.` : `💰 Initials on its card sells ${Math.round(100 / (runners[0].now / runners[0].inv))}% to get your stake back; the rest rides free.`}`]);
  const gave = bot.filter((x) => !x.open && x.peak >= 2 * x.inv && x.out < 1.3 * x.inv);
  if (gave.length) out.push([4, `You gave back gains on ${gave.slice(0, 2).map((x) => `${esc(x.sym)} (peaked ${(x.peak / x.inv).toFixed(1)}×, closed ${(x.out / x.inv).toFixed(1)}×)`).join(', ')}.${cfg().auto === 'off' ? ` <code>/auto ${DEFAULT_AUTO}</code> takes half at 2× and trails the rest automatically.` : ` Your preset is ${esc(cfg().auto)}; a tighter trail would have kept more.`}`]);
  // your wallets: coins that doubled after the buy and came back under 1.2×, closed or still held
  // the honest test of "sell half at 2×": what it keeps on the round trips against what it costs on the runners
  const rt = mine.filter((x) => x.pk >= 2 && (x.out + x.now) / x.inv < 1.2).sort((a, b) => b.pk - a.pk);
  if (rt.length) {
    const kept = rt.reduce((a, x) => a + (x.inv - 0.5 * (x.out + x.now)), 0);
    const run = mine.filter((x) => x.pk >= 2 && x.inv - 0.5 * (x.out + x.now) < 0).sort((a, b) => (a.inv - 0.5 * (a.out + a.now)) - (b.inv - 0.5 * (b.out + b.now)));
    const cost = run.reduce((a, x) => a + (x.inv - 0.5 * (x.out + x.now)), 0);
    out.push([2, `${rt.length} coin${rt.length > 1 ? 's' : ''} went 2× or more after you bought and ${rt.length > 1 ? 'are' : 'is'} back under 1.2× for you: ${rt.slice(0, 4).map((x) => `${list([x])[0]} (ran ${x.pk.toFixed(1)}×, now ${((x.out + x.now) / x.inv).toFixed(2)}×)`).join(', ')}. Half at 2× would have kept +${fmtH(kept)} there${run.length ? ` but cost ${fmtH(-cost)} on your runners (${run.slice(0, 2).map((x) => list([x])[0]).join(', ')})` : ''}: <b>net ${kept + cost >= 0 ? '+' : ''}${fmtH(kept + cost)}</b>. ${kept + cost > 0.2 * kept ? 'Taking something off after a big run pays for you so far.' : 'A fixed multiple does not fix this for you; sell on what the coin shows (dev, insiders or the group that pumped it selling), not on 2×.'}`]);
  }
  const late = mine.filter((x) => x.pl > 0 && x.off != null && x.pk >= 2);
  if (late.length >= 2) {
    const mid = [...late].sort((a, b) => a.off - b.off)[Math.floor(late.length / 2)].off;
    const ex = [...late].sort((a, b) => b.pk - a.pk)[0];
    if (mid >= 0.4) out.push([4, `On winners you sell a median ${(mid * 100).toFixed(0)}% under the top (${esc(ex.sym)} ran ${ex.pk.toFixed(1)}×, you got ${((ex.out + ex.now) / ex.inv).toFixed(1)}×). Scale out on the way up: a slice at 2×, 3× and 5×.`]);
  }
  // bought in two or more of your wallets within 5 minutes: double the size, not double the edge
  const by = {};
  for (const x of mine) (by[x.c] ||= []).push(x);
  const twin = Object.values(by).filter((xs) => new Set(xs.map((x) => x.w)).size > 1 && Math.max(...xs.map((x) => x.first || 0)) - Math.min(...xs.map((x) => x.first || 0)) < 5 * 60000).flat();
  if (twin.length >= 6) {
    const pl = twin.reduce((a, x) => a + x.pl, 0), rest = mine.filter((x) => !twin.includes(x)), plr = rest.reduce((a, x) => a + x.pl, 0);
    if (pl < 0) out.push([5, `${new Set(twin.map((x) => x.c)).size} coins were bought in two of your wallets at once: <b>${pl >= 0 ? '+' : ''}${fmtH(pl)}</b> on them, vs ${plr >= 0 ? '+' : ''}${fmtH(plr)} on everything else. One wallet per trade; double up only on your best setup.`]);
  }
  const sz = s.bySize.filter((x) => x.n >= 4);
  if (sz.length >= 2 && sz[0].pl > 0 && sz[sz.length - 1].pl < 0) out.push([6, `Trades of <b>${sz[0].k}</b> made ${sz[0].pl >= 0 ? '+' : ''}${fmtH(sz[0].pl)} (${sz[0].n}); ${sz.filter((x) => x.pl < 0).map((x) => `${x.k} ${fmtH(x.pl)} (${x.n})`).join(', ')}. Keep to ${sz[0].k} until another size proves itself.`]);
  const hd = s.byHold.filter((x) => x.n >= 4);
  if (hd.length >= 2 && hd[0].pl > 0 && hd[hd.length - 1].pl < 0) out.push([6, `Coins you held <b>${hd[0].k}</b> made ${hd[0].pl >= 0 ? '+' : ''}${fmtH(hd[0].pl)} (${hd[0].n}); ${hd.filter((x) => x.pl < 0).map((x) => `${x.k} ${fmtH(x.pl)} (${x.n}, ${(x.win * 100).toFixed(0)}% wins)`).join(', ')}. The quick flips are where it leaks; give a trade time unless it breaks.`]);
  const flat = mine.filter((x) => x.pk != null && x.pk < 1.15 && (!x.open || Date.now() - (x.first || 0) > 3600e3));
  const measured = mine.filter((x) => x.pk != null);
  if (measured.length >= 8 && flat.length / measured.length >= 0.3) out.push([7, `${flat.length} of ${measured.length} coins never went 15% above your price after you bought (${fmtH(flat.reduce((a, x) => a + x.pl, 0))}): those buys were the top of a move. Wait for the first pullback, or skip it.`]);
  const ch = mine.filter((x) => x.runup >= 3), calm = mine.filter((x) => x.runup != null && x.runup < 1.5);
  if (ch.length >= 4 && calm.length >= 4) {
    const a = ch.reduce((s2, x) => s2 + x.r, 0) / ch.length, b = calm.reduce((s2, x) => s2 + x.r, 0) / calm.length;
    if (b - a > 0.3) out.push([6, `Buys after a coin already ran 3× in the half hour before average ${pct(a)} (${ch.length}); buys before the run ${pct(b)} (${calm.length}). Stop chasing green candles.`]);
  }
  if (s.rows.length >= 6 && s.winRate < 0.4 && s.avgWin < 2 * Math.abs(s.avgLoss)) out.push([8, `Win rate ${(s.winRate * 100).toFixed(0)}% with wins averaging ${pct(s.avgWin)} and losses ${pct(s.avgLoss)}: that loses money over time. Smaller sizes until one setup proves itself.`]);
  const total = hypeNow + bot.reduce((a, x) => a + x.now, 0);
  const big = bot.filter((x) => x.now > 0.4 * total && total > 0)[0];
  if (big) out.push([2, `<b>${esc(big.sym)}</b> is ${((big.now / total) * 100).toFixed(0)}% of the bot wallet. One rug there sinks the week.`]);
  return out.sort((x, y) => x[0] - y[0]).map((x) => x[1]).slice(0, 5);
}
function statsText(s, label, px) {
  if (!s.rows.length && !s.reverts && !s.refused) return `No trades ${label}.`;
  const best = [...s.rows].sort((a, b) => b.r - a.r).slice(0, 3), worst = [...s.rows].sort((a, b) => a.r - b.r).slice(0, 2);
  const nm = (x) => `${esc(x.sym)}${x.mine && Object.keys(state.mine).length > 1 ? ` (${esc(x.src)})` : ''}`;
  return `<b>${label}</b>: ${s.rows.length} coins · ${s.buys} buys · ${s.sells} sells${s.reverts ? ` · ${s.reverts} reverted` : ''}${s.refused ? ` · ${s.refused} refused by the sell check` : ''}\n` +
    `In ${fmtH(s.inv)} · out ${fmtH(s.out)} · still holding ${fmtH(s.now)} · <b>${s.pl >= 0 ? '+' : ''}${fmtH(s.pl)}</b>${usd(s.pl, px)}\n` +
    (s.rows.length ? `Win rate ${(s.winRate * 100).toFixed(0)}% · avg win ${pct(s.avgWin)} · avg loss ${pct(s.avgLoss)}\n` : '') +
    (best.length ? `Best: ${best.map((x) => `${nm(x)} ${pct(x.r)}`).join(', ')}\n` : '') +
    (worst.length && worst[0].r < 0 ? `Worst: ${worst.map((x) => `${nm(x)} ${pct(x.r)}`).join(', ')}\n` : '') +
    (s.bySrc.length > 1 ? `By source: ${s.bySrc.map((x) => `${esc(x.k)} ${x.pl >= 0 ? '+' : ''}${fmtH(x.pl)} (${x.n})`).join(' · ')}\n` : '');
}
async function statsCommand(args) {
  await valuePositions();
  const spans = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6, all: Infinity };
  const words = args.map(lc).filter(Boolean);
  const k = words.find((x) => spans[x]) || '7d';
  const rest = words.filter((x) => !spans[x]).join(' ');
  const who = !rest ? 'all' : rest === 'bot' || rest === 'mine' ? rest : addrIn(rest) || rest;
  if (who !== 'all' && who !== 'bot' && who !== 'mine' && !Object.entries(state.mine).some(([w, x]) => w === who || lc(x.name) === who)) return `No wallet called <code>${esc(rest)}</code>. /mine lists yours.`;
  const since = spans[k] === Infinity ? 0 : Date.now() - spans[k];
  const [px, hb] = await Promise.all([hypeUsd(), hypeBal().catch(() => 0n)]);
  const s = stats(since, who);
  // tips from the same window as the numbers above them: /stats 24h teaches from the last day's coins only
  const t = tips(s, num(hb));
  const whoTxt = who === 'all' ? '' : who === 'bot' ? ' · bot wallet' : who === 'mine' ? ' · your wallets' : ` · ${esc(mineName(Object.keys(state.mine).find((w) => w === who || lc(state.mine[w].name) === who)))}`;
  return statsText(s, (k === 'all' ? 'All time' : `Last ${k}`) + whoTxt, px) + (t.length ? `\n💡 <b>Tips</b> · from these ${k === 'all' ? 'trades' : k}\n${t.map((x) => '• ' + x).join('\n')}` : `\nNot enough trades ${k === 'all' ? 'yet' : `in the last ${k}`} for tips${k === '24h' || k === '7d' ? `: /stats ${k === '24h' ? '7d' : '30d'} looks further back` : ''}.`) +
    `\n\n/stats 24h · 7d · 30d · all${Object.keys(state.mine).length ? ', then bot, mine or a wallet name (/stats 30d mine)' : ''}`;
}
function journalText() {
  const last = state.journal.slice(-15).reverse();
  if (!last.length) return 'Journal is empty.';
  const icon = { buy: '🟢', sell: '🔵', revert: '❌', refused: '🚫', 'sell-revert': '❌' };
  return last.map((e) => `${icon[e.side] || '•'} ${new Date(e.t).toISOString().slice(5, 16).replace('T', ' ')} ${e.side} <b>${esc(e.sym)}</b> ${e.hype != null ? fmtH(e.hype) : ''}${e.mcUsd ? ` · MC $${fmt(e.mcUsd)}` : ''}${e.w ? ` · 👛 ${esc(mineName(e.w))}` : e.src ? ` · ${esc(e.src)}` : ''}${e.sc != null ? ` · rt ${(e.sc * 100).toFixed(0)}%` : ''}${e.note ? `\n    📝 ${esc(e.note)}` : ''}`).join('\n') + '\n\n/export sends the full journal as a CSV.';
}
async function exportJournal() {
  const cols = ['time', 'side', 'symbol', 'coin', 'hype', 'tokens', 'mc_usd', 'source', 'wallet', 'slippage_pct', 'roundtrip_pct', 'route', 'tx', 'note'];
  const lines = [cols.join(',')].concat(state.journal.map((e) => [new Date(e.t).toISOString(), e.side, e.sym, e.coin, e.hype ?? '', e.tok ?? '', e.mcUsd != null ? Math.round(e.mcUsd) : '', e.src ?? '', e.w ?? me, e.slip != null ? e.slip / 100 : '', e.sc != null ? (e.sc * 100).toFixed(1) : '', e.route ?? '', e.hash ?? '', e.note ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
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
  let t = tips(s, hype); // the last 24h's coins, like the numbers it sits under
  // quiet mode: a tip already shown in the last 3 days is not repeated, and a day with no trades and
  // no new tip sends nothing at all
  state.tipsSeen ||= {};
  const key = (x) => x.replace(/<[^>]+>/g, '').replace(/[\d.,%×+-]+/g, '#').slice(0, 80);
  if (!force) t = t.filter((x) => !(Date.now() - (state.tipsSeen[key(x)] || 0) < 3 * 864e5));
  for (const x of t) state.tipsSeen[key(x)] = Date.now();
  const traded = s.buys + s.sells + s.reverts + s.refused > 0;
  if (!force && cfg().report === 'quiet' && !traded && !t.length) return null;
  const ch = prev && prev.d !== today ? value - prev.v : null;
  const mineOpen = Object.entries(state.mpos).filter(([w]) => state.mine[w]).flatMap(([w, ps]) => Object.values(ps).filter((p) => p.open && (p.now ?? 0) > DUST).map((p) => ({ w, p }))).sort((a, b) => b.p.now - a.p.now);
  const text = `📒 <b>Daily report</b> · wallet ${fmtH(value)}${usd(value, px)}${ch != null ? ` (${ch >= 0 ? '+' : ''}${fmtH(ch)} vs ${prev.d})` : ''}\n` +
    `Free HYPE ${fmtH(hype)} · ${open.length} open bag${open.length === 1 ? '' : 's'}\n\n` +
    statsText(s, 'Last 24h', px) +
    (open.length ? `\n<b>Open bags</b>\n${open.slice(0, 8).map((p) => { const r = ((p.now ?? 0) + (p.hypeOut || 0) - p.hypeIn) / p.hypeIn; return `• ${esc(p.sym)} ${fmtH(p.now)} · ${pct(r)}`; }).join('\n')}\n` : '') +
    (mineOpen.length ? `\n<b>Open bags in your wallets</b> · ${fmtH(mineOpen.reduce((a, x) => a + x.p.now, 0))}\n${mineOpen.slice(0, 8).map(({ w, p }) => { const r = ((p.now ?? 0) + (p.hypeOut || 0) - p.hypeIn) / p.hypeIn; return `• ${esc(p.sym)}${Object.keys(state.mine).length > 1 ? ` (${esc(mineName(w))})` : ''} ${fmtH(p.now)} · ${pct(r)}`; }).join('\n')}\n` : '') +
    (t.length ? `\n💡 <b>Tips</b> · from the last 24h\n${t.map((x) => '• ' + x).join('\n')}` : '');
  return say(text);
}

async function withdraw(to, amtStr) {
  const bal = await hypeBal();
  // a plain transfer costs more than 21000 gas on Elysium: as an Arbitrum chain it adds its parent chain's data fee
  // (about 31K in all), and a transfer sent with 21000 is refused outright
  let gas = 80000;
  try { gas = Math.max(30000, Math.ceil(Number(BigInt(await rpc('eth_estimateGas', [{ from: me, to, value: '0x1' }]))) * 1.5)); } catch {}
  const gasCost = BigInt(gas) * (await gasPrice()) * 2n;
  const value = amtStr === 'all' ? bal - gasCost : toWei(amtStr);
  if (!value || value <= 0n || value > bal - gasCost / 2n) throw new Error(`not enough HYPE (wallet has ${fmtH(num(bal))})`);
  const hash = await serial(() => sendRaw({ to, value, data: '0x', gas }));
  const msg = await say(`⏳ Sending ${fmtH(num(value))} to <code>${to}</code> · ${txLink(hash)}`);
  track(hash, (rc) => edit(msg, `${rc.status === '0x1' ? '✅ Sent' : '❌ Failed to send'} ${fmtH(num(value))} to <code>${to}</code> · ${txLink(hash)}`), () => edit(msg, `⌛ Withdrawal not confirmed after 2 h · ${txLink(hash)}`));
}

// ── token transfers: part or all of a bag to another wallet, after a confirmation tap ─────────────────
const sendAsk = {}; // message id of a card's 📤 Send question → token
// how much of the bag: "all", "50%", or a token amount
async function sendAmount(t, a) {
  const [m, bal] = await Promise.all([tokenMeta(t), balOf(t, me, true)]);
  a = lc(String(a || '')).replace(/,/g, '');
  let amt = null;
  if (a === 'all' || a === 'max') amt = bal;
  else if (/^\d*\.?\d+%$/.test(a)) { const pc = Number(a.slice(0, -1)); if (pc > 0 && pc <= 100) amt = (bal * BigInt(Math.round(pc * 100))) / 10000n; }
  else amt = toWei(a, m.d);
  return { m, bal, amt };
}
async function askSend(t, to, a, replyTo) {
  if (!t || !to || !a) return say('Usage: /send &lt;coin&gt; &lt;amount|50%|all&gt; &lt;address&gt;\nOr tap 📤 Send on a coin card.', null, replyTo);
  if (to === me) return say('That is the bot wallet itself.', null, replyTo);
  if (to === t || to === ZERO) return say('That address is the token contract or the zero address; tokens sent there are lost.', null, replyTo);
  const { m, bal, amt } = await sendAmount(t, a);
  if (!amt || amt <= 0n) return say(`Amount not understood. Use a number of ${esc(m.sym)}, a percent like 50%, or all.`, null, replyTo);
  if (bal === 0n) return say(`You hold no ${esc(m.sym)} in the bot wallet.`, null, replyTo);
  if (amt > bal) return say(`You hold ${fmt(num(bal, m.d))} ${esc(m.sym)}, less than that.`, null, replyTo);
  const id = Math.random().toString(36).slice(2, 10);
  pending[id] = { kind: 'tok', t, to, amt: amt.toString() };
  return say(`Send <b>${fmt(num(amt, m.d))} ${esc(m.sym)}</b> (${((num(amt, m.d) / num(bal, m.d)) * 100).toFixed(0)}% of the bag) to <code>${to}</code>?\nA transfer is not a sell: no HYPE comes back.`, [[{ text: '✅ Send', callback_data: `v:${id}` }, { text: 'Cancel', callback_data: `x:${id}` }]], replyTo);
}
async function sendToken(t, to, amt) {
  const [m, bal] = await Promise.all([tokenMeta(t), balOf(t, me, true)]);
  if (amt > bal) throw new Error(`the bot wallet holds only ${fmt(num(bal, m.d))} ${m.sym} now`);
  const hash = await serial(() => sendRaw({ to: t, data: enc('a9059cbb', to, amt), gas: 150000 }));
  const what = `${fmt(num(amt, m.d))} <b>${esc(m.sym)}</b> to <code>${to}</code>`;
  const msg = await say(`⏳ Sending ${what} · ${txLink(hash)}`);
  track(hash, async (rc) => {
    if (rc.status !== '0x1') return edit(msg, `❌ Transfer of ${what} ${rc.status === 'dropped' ? 'was dropped by the network; nothing sent' : 'reverted'} · ${txLink(hash)}`);
    const left = await balOf(t, me, true).catch(() => bal - amt);
    const p = state.pos[t];
    if (p) { p.sent = (p.sent || 0) + num(amt, m.d); if (left === 0n) { p.open = false; dropSellOrders(t); } }
    cacheBal(t, left);
    J({ side: 'send', coin: t, sym: m.sym, tok: num(amt, m.d), to, hash });
    save(); refreshPin();
    return edit(msg, `✅ Sent ${what} · ${fmt(num(left, m.d))} ${esc(m.sym)} left in the bot wallet · ${txLink(hash)}`);
  }, () => edit(msg, `⌛ Transfer of ${what} not confirmed after 2 h · ${txLink(hash)}`));
}

// ── /fire: keep sending one call at a contract until it lands ──────────────────────────────────────
// For launches that open at a set moment (a router that reverts until the owner calls launch()). Elysium takes
// transactions in arrival order, so the first buys in are the ones already on their way when it opens: /fire sends
// the same call again and again (a failure costs only gas, about 0.00001 HYPE) and stops at the first one that goes
// through. One attempt is in flight at a time by default, so it can never fill twice; x2 or x3 sends more at once
// (faster, and up to that many could fill). Attempts skip the Inbox route: its HyperEVM gas would add up over
// hundreds of failures. "/fire copy 0xTX 1" fires the same call someone else is firing (a sniper's failed attempt),
// with their own address in the call swapped for this wallet's.
const fires = new Map();
let fireSeq = 0;
const FIRE_HELP =
  `<b>/fire</b> keeps sending a call to a contract until it goes through, then stops (for launches that open at a set time).\n` +
  `/fire 0xCONTRACT 1.5 0xDATA · send 1.5 HYPE with that call data\n` +
  `/fire copy 0xTXHASH 1.5 · fire the same call as that transaction (a sniper's failed attempt), from this wallet\n` +
  `Options: 2s (every 2 s, default) · 15m (stop after 15 min, default) · x2 or x3 (attempts in flight at once; that many could fill) · gas=30m (gas limit, default 30m: an ERC-404 buy mints an NFT per unit and used 12 to 23m on MACHINE; a copy uses the copied tx's limit)\n` +
  `/fire · status · /fire stop`;
const fireText = (f) => `🔫 <b>Firing</b> ${fmtH(num(f.value))} at <code>${f.to}</code>${f.label ? `\n${esc(f.label)}` : ''}\n${f.sent} sent · ${f.failed} failed (normal until it opens) · every ${f.every} s · ${f.k} in flight · ${(f.gas / 1e6).toFixed(1)}m gas · ${Math.max(0, Math.ceil((f.until - Date.now()) / 60000))} min left · /fire stop`;
async function fireStart(o, replyTo) {
  if (fires.size) throw new Error('a /fire is already running (/fire stop first)');
  const gas = Math.min(Math.max(Number(o.gas) || 30e6, 100000), 32e6);
  const bal = await hypeBal(true), need = o.value + BigInt(gas) * (await gasPrice()) + 5n * 10n ** 15n;
  if (bal < need) throw new Error(`not enough HYPE: the bot wallet has ${fmtH(num(bal))}, a ${fmtH(num(o.value))} attempt at ${(gas / 1e6).toFixed(1)}m gas needs ${fmtH(num(need))}`);
  const f = { id: ++fireSeq, to: o.to, value: o.value, data: o.data, gas, label: o.label || '', every: Math.max(0.5, o.every || 2), until: Date.now() + (o.mins || 15) * 60000, k: Math.min(Math.max(1, o.k || 1), 3), sent: 0, failed: 0, inflight: 0, filled: 0, done: false, t0: Date.now() };
  fires.set(f.id, f);
  f.msg = await say(fireText(f), null, replyTo);
  fireLoop(f).catch((e) => console.error('fire', e.message));
}
async function fireLoop(f) {
  let shown = 0;
  while (!f.done && Date.now() < f.until) {
    if (f.inflight < f.k) {
      f.inflight++;
      try {
        const hash = await serial(() => sendRaw({ to: f.to, value: f.value, data: f.data, gas: f.gas }, { inbox: false }));
        f.sent++;
        receipt(hash, 600000).then((rc) => fireLanded(f, hash, rc)).catch(() => {}).finally(() => { f.inflight--; });
      } catch (e) {
        f.inflight--; f.lastErr = e.message;
        if (/insufficient funds/i.test(e.message)) break;
        await sleep(1000);
      }
    }
    if (Date.now() - shown > 15000) { shown = Date.now(); edit(f.msg, fireText(f)).catch(() => {}); }
    await sleep(f.every * 1000);
  }
  for (let i = 0; i < 180 && f.inflight > 0; i++) await sleep(1000); // the ones still on their way
  fires.delete(f.id);
  if (!f.filled) edit(f.msg, `${fireText(f)}\n${f.stopped ? '⏹ Stopped, nothing filled.' : '⌛ Time is up, nothing filled.'}${f.lastErr ? `\nLast error: ${esc(f.lastErr).slice(0, 160)}` : ''}`).catch(() => {});
}
async function fireLanded(f, hash, rc) {
  if (!rc || rc.status === 'dropped') return;
  if (rc.status !== '0x1') { f.failed++; return; }
  f.done = true;
  f.filled++;
  // what arrived: ERC-20 transfers to this wallet (3 topics; an ERC-404's NFT transfers have 4)
  const lines = [];
  let card = null;
  for (const l of rc.logs || []) {
    if (l.topics?.[0] !== T_TRANSFER || l.topics.length !== 3 || lc('0x' + l.topics[2].slice(26)) !== me) continue;
    const t = lc(l.address), amt = BigInt(l.data || '0x0');
    const m = await tokenMeta(t).catch(() => ({ sym: '?', d: 18 }));
    const h = num(f.value), tok = num(amt, m.d);
    const p = P(t, m.sym);
    p.hypeIn += h; p.tokIn += tok; p.cIn = (p.cIn ?? 0) + h; p.cTok = (p.cTok ?? 0) + tok; p.cOut ??= 0;
    p.first ||= Date.now(); p.src ||= 'fire'; p.open = true;
    J({ side: 'buy', coin: t, sym: m.sym, hype: h, tok, src: 'fire', route: 'fire', hash });
    lines.push(`${fmt(tok)} <b>${esc(m.sym)}</b>`);
    card ||= t;
  }
  save(); refreshPin();
  const text = `✅ <b>Fired ${f.filled > 1 ? `call filled again (#${f.filled})` : 'call landed'}</b> after ${f.sent} attempts, ${((Date.now() - f.t0) / 1000).toFixed(0)} s in: ${lines.length ? `got ${lines.join(', ')}` : 'no token transfer to this wallet seen'} for ${fmtH(num(f.value))} · ${txLink(hash)}`;
  if (f.filled === 1) await edit(f.msg, text, card ? cardButtons(card) : null); else await say(text, card ? cardButtons(card) : null);
}

const HELP =
  `<b>ely-router</b>\n` +
  `Paste a token address (or a link with one) for a card: ⚡ buy (⚡ X asks for any amount), sell 25/50/100%, 💰 initials, 🎯 limit, 📤 send.\n` +
  `/pos · open bags with one-tap sells · /pin · re-pin the open trades panel at the bottom (/set pin off to stop)\n` +
  `/buy &lt;token&gt; &lt;HYPE&gt; · /sell &lt;coin&gt; &lt;percent&gt; · /initials &lt;coin&gt;\n` +
  `&lt;coin&gt; = address, the symbol of a coin you hold, or its 8-character code\n\n` +
  `<b>Limit orders</b> (market cap in $, checked every 2 s)\n` +
  `/limit &lt;coin&gt; 1 20k · buy 1 HYPE when MC falls to $20K (add "above" for breakouts)\n` +
  `/limit sell &lt;coin&gt; 50 100k · /limit sell &lt;coin&gt; 100 below 3k · /limit sell &lt;coin&gt; 50 2x\n` +
  `/orders · see and cancel\n\n` +
  `/bal · /pnl · /stats 7d · /journal · /export · /report · /wallet\n` +
  `/mine add 0xWALLET [name] · your other wallets, watch-only: their trades go into /journal, /stats and the tips (no key, never traded from)\n` +
  `/set slip 15 · /set max 5 · /set sizes 1,2,3,5 · /set tax 25 · /set check off · /set stale 5 · /set report quiet|on|off\n` +
  `/withdraw &lt;address&gt; &lt;HYPE|all&gt; · /send &lt;coin&gt; &lt;amount|50%|all&gt; &lt;address&gt; moves tokens to another wallet · /nonce if a transaction is stuck\n\n` +
  `<b>Extras</b> (off unless you set them): /tp /sl /trail · /auto · /snipe · /copy · /set devsell 50 · /set rug on\n` +
  `<b>Bag watch</b>, per coin: 👀 on its card or /bagwatch 0xCOIN watches its dev and top 10 holders, a post when they sell or move a real part of their bag · /bagwatch lists them · /set bagwatch on watches every coin you hold\n` +
  `<b>Ascend</b>: new launches post here with ⚡ buttons; a tap while the anti-snipe fee is up waits and buys the second it drops · /ascend (status, router, alerts)\n` +
  `<b>Token pairs</b>: a coin paired with BOXA, USDC or any other token is bought with HYPE in two steps (the token first, then the coin) and sold back to HYPE the same way · /set pairbuy off keeps the token instead\n` +
  `<b>/fire</b> keeps sending a buy to a launch contract until it opens and fills (/fire for how)`;

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
  const foot = `\nPreset on new buys: ${c.auto === 'off' ? 'off (/auto)' : esc(c.auto)}\nGuards: dev ${c.devsell ? c.devsell + '%' : 'off'} · rug ${c.rug ? 'on' : 'off'} · bag watch ${c.bagwatch ? 'every bag' : 'armed coins'}`;
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

const LIMIT_HELP = 'Limit orders, triggered by market cap in $ (checked every 2 s):\n' +
  '/limit &lt;coin&gt; &lt;HYPE&gt; 20k · buy when MC falls to $20K\n' +
  '/limit &lt;coin&gt; &lt;HYPE&gt; above 50k · buy on a breakout\n' +
  '/limit sell &lt;coin&gt; 50 100k · sell 50% when MC reaches $100K\n' +
  '/limit sell &lt;coin&gt; 100 below 3k · sell all if MC falls to $3K\n' +
  '/limit sell &lt;coin&gt; 50 2x · sell 50% at 2× your entry\n' +
  'Add 12h or 7d at the end for an expiry (buys default to 3 days, sells to none). Or tap 🎯 Limit on a card and reply.';
const limitAsk = {}; // message id of a card's 🎯 Limit question → token
const buyAsk = {};   // message id of a ⚡ X question (custom amount) → { t, src }
// "1 20k", "1 below 20k", "50 at 100k 12h", "50% 2x" → { side, a, dir, mc | x, exp }
function parseLimit(side, ws) {
  ws = ws.filter(Boolean);
  const a = Number(String(ws[0] || '').replace('%', ''));
  let i = 1, dir = side === 'buy' ? 'below' : 'above';
  if (/^at$/i.test(ws[i] || '')) i++;
  if (/^(below|above|under|over)$/i.test(ws[i] || '')) { dir = /above|over/i.test(ws[i]) ? 'above' : 'below'; i++; }
  if (/^at$/i.test(ws[i] || '')) i++;
  const xm = String(ws[i] || '').match(/^(\d*\.?\d+)x$/i);
  const x = side === 'sell' && xm ? Number(xm[1]) : null;
  const mc = x ? null : parseUsd(ws[i]);
  i++;
  const tm = String(ws[i] || '').match(/^(\d*\.?\d+)(h|d)$/i);
  const exp = tm ? Date.now() + Number(tm[1]) * (lc(tm[2]) === 'd' ? 864e5 : 36e5) : side === 'buy' ? Date.now() + 3 * 864e5 : null;
  if (!(a > 0) || (!mc && !x) || (side === 'sell' && a > 100)) return null;
  return { side, a, dir, mc, x, exp };
}
async function addLimit(t, L, reply) {
  if (L.side === 'buy' && L.a > cfg().max) throw new Error(`max per buy is ${cfg().max} HYPE (change with /set max)`);
  const r = await findRoute(t);
  if (!r) throw new Error('no route for this token');
  const [m, pr, u, bal] = await Promise.all([tokenMeta(t), priceOf(t, r), hypeUsd(), balOf(t, me, true)]);
  const sup = m.sup ? num(m.sup, m.d) : 0;
  if (!pr || !sup || !u) throw new Error('cannot read this coin\'s market cap right now');
  const now = pr * sup * u;
  if (L.side === 'sell' && bal === 0n) return say(`You hold no ${esc(m.sym)} in the bot wallet; a limit sell needs a bag.`, null, reply);
  if (L.x) {
    const e = entryOf(state.pos[t]);
    if (!e) return say(`No entry recorded for ${esc(m.sym)}, so "${L.x}x" has nothing to multiply. Use a market cap instead, e.g. 100k.`, null, reply);
    L.mc = e * sup * u * L.x;
  }
  const o = L.side === 'buy' ? { id: oid(), k: 'lbuy', hype: L.a, mc: L.mc, dir: L.dir, at: Date.now(), exp: L.exp } : { id: oid(), k: 'lsell', pct: Math.round(L.a), mc: L.mc, dir: L.dir, at: Date.now(), exp: L.exp };
  (state.orders[t] ||= []).push(o);
  save();
  const hit = L.dir === 'above' ? now >= L.mc : now <= L.mc;
  const left = o.exp ? Math.round((o.exp - Date.now()) / 36e5) : null;
  return say(`🎯 Limit ${L.side}: ${L.side === 'buy' ? `${L.a} HYPE of` : `${o.pct}% of your`} <b>${esc(m.sym)}</b> when MC ${L.dir === 'above' ? 'reaches' : 'falls to'} $${fmt(L.mc)}${L.x ? ` (${L.x}× entry)` : ''}.\nNow $${fmt(now)}${hit ? ', already there: it fills on the next check' : ` (${pct(L.mc / now - 1)} away)`}. ${left != null ? `Expires in ${left >= 48 ? Math.round(left / 24) + ' days' : left + ' h'}.` : 'No expiry.'}${L.side === 'buy' ? ' The sell check still runs.' : ''}`,
    [[{ text: '✖ Cancel', callback_data: `o:${o.id}` }, { text: '📋 Orders', callback_data: `l:${t.slice(2)}` }]], reply);
}
// open bags with one-tap sells
async function positionsView() {
  const open = Object.entries(state.pos).filter(([, p]) => isOpen(p)).slice(-15);
  const rows = await Promise.all(open.map(async ([t, p]) => {
    try {
      const [m, r, bal] = await Promise.all([tokenMeta(t), findRoute(t), balOf(t, me, true)]);
      cacheBal(t, bal);
      if (bal === 0n) { p.open = false; return null; }
      const pr = r ? await priceOf(t, r).catch(() => null) : null;
      const v = pr ? num(bal, m.d) * pr : null, c = cyc(p);
      return { t, sym: m.sym, v, pl: v != null && c.in > 0 ? (v + c.out - c.in) / c.in : null, n: (state.orders[t] || []).length };
    } catch { return null; }
  }));
  save();
  const list = rows.filter(Boolean).sort((a, b) => (b.v || 0) - (a.v || 0));
  if (!list.length) return { text: 'No open bags.', rows: [], list };
  const px = await hypeUsd();
  return {
    list, px,
    text: `<b>Open bags</b>\n` + list.map((x) => `• <b>${esc(x.sym)}</b> ${x.v != null ? fmtH(x.v) + usd(x.v, px) : '?'}${x.pl != null ? ` · ${pct(x.pl)}` : ''}${x.n ? ` · 🎯 ${x.n}` : ''}`).join('\n'),
    rows: list.map((x) => [{ text: `${x.sym} 50%`, callback_data: `s:${x.t.slice(2)}:50` }, { text: `${x.sym} 100%`, callback_data: `s:${x.t.slice(2)}:100` }, { text: '💰', callback_data: `i:${x.t.slice(2)}` }, { text: '🎯', callback_data: `m:${x.t.slice(2)}` }, { text: '🔎', callback_data: `c:${x.t.slice(2)}` }]),
  };
}

// ── pinned open-trades panel ───────────────────────────────────────────────────────────────────────
// One message pinned at the top of the chat lists every open bag with one-tap sells, so alerts never bury
// what you are in. It is edited in place every minute and right after each trade. A new one is sent (and
// pinned) only when a trade opens while nothing is pinned, when the old one was deleted, or with /pin.
state.pin ||= {};
let pinJob = null;
const clock = () => new Date().toLocaleTimeString('en-GB', { timeZone: process.env.TZ_NAME || 'Africa/Lagos', hour: '2-digit', minute: '2-digit' });
function refreshPin(resend = false) {
  if (!cfg().pin) return Promise.resolve();
  if (pinJob) return pinJob.then(() => (resend ? refreshPin(true) : undefined));
  pinJob = (async () => {
    const v = await positionsView();
    const P = state.pin;
    if (!v.list?.length) {
      if (P.id) {
        await tg('editMessageText', { chat_id: OWNER, message_id: P.id, text: `📌 No open trades · ${clock()}`, parse_mode: 'HTML' });
        await tg('unpinChatMessage', { chat_id: OWNER, message_id: P.id });
        state.pin = {}; save();
      }
      return;
    }
    const tot = v.list.reduce((a, x) => a + (x.v || 0), 0);
    const text = `📌 <b>Open trades</b> · ${v.list.length} · ${fmtH(tot)}${usd(tot, v.px)} · ${clock()}\n` + v.text.replace(/^<b>Open bags<\/b>\n/, '');
    const sig = v.list.map((x) => `${x.t}:${(x.v || 0).toPrecision(3)}:${x.pl != null ? x.pl.toFixed(2) : ''}:${x.n}`).join('|');
    if (!resend && P.id && P.sig === sig && Date.now() - (P.at || 0) < 5 * 60e3) return; // nothing moved: leave it alone
    if (P.id && !resend) {
      const r = await tg('editMessageText', { chat_id: OWNER, message_id: P.id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kb(v.rows) });
      if (!r?.gone) { state.pin = { id: P.id, sig, at: Date.now() }; save(); return; }
    }
    // a fresh panel at the bottom, pinned without a notification; the old one is unpinned and removed
    const m = await tg('sendMessage', { chat_id: OWNER, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: true, ...kb(v.rows) });
    if (!m?.message_id) return;
    await tg('pinChatMessage', { chat_id: OWNER, message_id: m.message_id, disable_notification: true });
    if (P.id && P.id !== m.message_id) { await tg('unpinChatMessage', { chat_id: OWNER, message_id: P.id }); await tg('deleteMessage', { chat_id: OWNER, message_id: P.id }); }
    state.pin = { id: m.message_id, sig, at: Date.now() }; save();
  })().catch((e) => console.error('pin', e.message)).finally(() => { pinJob = null; });
  return pinJob;
}

async function onMessage(msg) {
  const text = (msg.text || '').trim();
  const [cmd0, ...args] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@\S+$/, '');
  const reply = msg.message_id;
  // an answer to a 📒 note question: saved on that trade (or on both wallets' buys of the same coin)
  const noteFor = noteAsk[msg.reply_to_message?.message_id];
  if (noteFor && !text.startsWith('/')) {
    const hit = state.journal.filter((e) => noteFor.includes(e.id));
    for (const e of hit) e.note = text.slice(0, 500);
    save();
    return say(hit.length ? `📝 Noted on ${esc(hit[0].sym)}. /journal shows it beside the trade.` : 'That trade is no longer in the journal.', null, reply);
  }
  // an answer to a ⚡ X question: how much HYPE to buy
  const xFor = buyAsk[msg.reply_to_message?.message_id];
  if (xFor && !text.startsWith('/')) {
    const h = Number(text.replace(/hype/i, '').replace(',', '.').trim());
    if (!(h > 0)) return say('Reply with just the HYPE amount, for example <code>2.5</code>.', null, reply);
    delete buyAsk[msg.reply_to_message.message_id]; // one answer, one buy
    return buy(xFor.t, h, reply, false, xFor.src);
  }
  // an answer to a card's 📤 Send question: address and amount, in any order
  const sendFor = sendAsk[msg.reply_to_message?.message_id];
  if (sendFor && !text.startsWith('/')) {
    const to = addrIn(text);
    const a = text.replace(/0x[0-9a-fA-F]{40}/g, ' ').trim().split(/\s+/)[0];
    if (!to || !a) return say('Reply again with the address and the amount, for example <code>0xabc… 50%</code> or <code>0xabc… all</code>.', null, reply);
    return askSend(sendFor, to, a, reply);
  }
  // an answer to a card's 🎯 Limit question
  const asked = limitAsk[msg.reply_to_message?.message_id];
  if (asked && !text.startsWith('/')) {
    const w = text.split(/\s+/), side = lc(w[0]).replace(/^(b)$/, 'buy').replace(/^(s)$/, 'sell');
    const L = side === 'buy' || side === 'sell' ? parseLimit(side, w.slice(1)) : null;
    if (!L) return say(`Not understood. Reply to the question again with, for example:\n<code>buy 1 20k</code> · <code>buy 1 above 50k</code> · <code>sell 50 100k</code> · <code>sell 100 below 3k</code> · <code>sell 50 2x</code>`, null, reply);
    return addLimit(asked, L, reply);
  }
  if (cmd === '/pos') { const v = await positionsView(); return say(v.text, v.rows); }
  if (cmd === '/pin') { if (!cfg().pin) return say('The pinned panel is off. /set pin on turns it back on.'); await refreshPin(true); if (!state.pin.id) return say('No open trades to pin.'); return; }
  if (cmd === '/start' || cmd === '/help') {
    const b = await hypeBal().catch(() => null);
    return say(HELP + `\n\nWallet <code>${account.address}</code>${b != null ? ` · ${fmtH(num(b))}` : ''}\nPools indexed: ${poolCount()} (up to block ${state.poolsBlock})`);
  }
  if (cmd === '/wallet') {
    await inboxRefresh().catch(() => {});
    const ib = !cfg().inbox ? 'off (/set inbox on)' : inboxReady() ? `on at ${inboxGwei()} gwei (about ${fmtH(93000 * inboxGwei() / 1e9)} a trade) · ${fmtH(num(inbox.bal))} on HyperEVM for gas · ${inbox.posts} posts since start` : `waiting for gas: ${inbox.bal == null ? 'HyperEVM balance unknown' : fmtH(num(inbox.bal))} on HyperEVM, needs ${fmtH(num(INBOX_GAS * inboxWei()))}+`;
    return say(`<code>${account.address}</code>\nFund it with HYPE on Elysium for trading. The same address on HyperEVM pays the Inbox route's gas (0.5 HYPE is about 25 trades at 200 gwei).\nInbox route: ${ib}\nThe key only lives on your VPS.`);
  }
  if (cmd === '/bal') return say(await balances());
  if (cmd === '/pnl') return say(await pnl());
  if (cmd === '/stats') return say(await statsCommand(args));
  if (cmd === '/journal') return say(journalText());
  if (cmd === '/bagwatch') {
    const t = addrIn(args[0] || '');
    if (!t) return say(bagWatchView());
    const on = bwToggle(t), sym = esc(await symOf(t));
    return say(on ? `👀 Watching <b>${sym}</b>: its dev and top ${BW_TOP} holders. A post comes when the dev sells ${BW_DEV * 100}%+ of their bag, a top holder ${BW_HOLDER * 100}%+, or either ${BW_BIG * 100}%+ of supply.` : `🔕 Stopped watching <b>${sym}</b>.`, [watchRow(t)]);
  }
  if (cmd === '/export') return exportJournal();
  if (cmd === '/report') return dailyReport();
  if (cmd === '/nonce') { inflight.clear(); const n = await resyncNonce(); return say(`Nonce resynced from the chain: next is ${n}.`); }
  if (cmd === '/set') {
    const [k, v] = args;
    const lv = lc(v || '');
    if (k === 'slip' && Number(v) > 0 && Number(v) <= 50) state.set.slip = Math.round(Number(v) * 100);
    else if (k === 'max' && Number(v) > 0) state.set.max = Number(v);
    else if (k === 'sizes' && args.slice(1).join(',').split(/[\s,]+/).some((x) => Number(x) > 0)) state.set.sizes = args.slice(1).join(',').split(/[\s,]+/).filter((x) => Number(x) > 0).slice(0, 6).join(','); // "1,2,3,5" or "1 2 3 5"
    else if (k === 'tax' && Number(v) > 0 && Number(v) <= 100) state.set.tax = Number(v);
    else if (k === 'check' && /^(on|off)$/.test(lv)) state.set.check = lv;
    else if (k === 'stale' && Number(v) >= 0) state.set.stale = Number(v);
    else if (k === 'report' && /^(on|off|quiet)$/.test(lv)) state.set.report = lv;
    else if (k === 'devsell' && (lv === 'off' || (Number(v) >= 0 && Number(v) <= 100))) state.set.devsell = lv === 'off' ? 0 : Number(v);
    else if (k === 'rug' && /^(on|off)$/.test(lv)) state.set.rug = lv;
    else if (k === 'bagwatch' && /^(on|off)$/.test(lv)) state.set.bagwatch = lv;
    else if (k === 'preapprove' && /^(on|off)$/.test(lv)) state.set.preapprove = lv;
    else if (k === 'pairbuy' && /^(on|off)$/.test(lv)) state.set.pairbuy = lv;
    else if (k === 'copymax' && Number(v) >= 0) state.set.copymax = Number(v);
    else if (k === 'inbox' && /^(on|off)$/.test(lv)) { state.set.inbox = lv; inbox.warned = false; }
    else if (k === 'gwei' && Number(v) >= 0.1 && Number(v) <= 2000) { state.set.gwei = Number(v); inbox.warned = false; }
    else if (k === 'pin' && /^(on|off)$/.test(lv)) { state.set.pin = lv; if (lv === 'off' && state.pin?.id) { await tg('unpinChatMessage', { chat_id: OWNER, message_id: state.pin.id }); state.pin = {}; } }
    else return say('Usage: /set slip 15 · max 5 · sizes 1,2,3,5 · tax 25 · check on|off · stale 5 · report quiet|on|off · devsell 50 · rug on|off · bagwatch on|off · preapprove on|off · pairbuy on|off · copymax 10 · pin on|off · inbox on|off · gwei 200 (Inbox post gas price on HyperEVM)');
    save();
    const c = cfg();
    return say(`Saved. Slippage ${Number(c.slip) / 100}% · max ${c.max} HYPE · sizes ${c.sizes.join(', ')} · sell check ${c.check ? `on (limit ${c.tax}%)` : 'OFF'} · stale taps ${c.stale ? `after ${c.stale} min` : 'off'} · report ${c.report}\n` +
      `Dev guard ${c.devsell ? c.devsell + '%' : 'off'} · rug guard ${c.rug ? 'on' : 'off'} · bag watch ${c.bagwatch ? 'every bag' : 'armed coins'} · pre-approve ${c.preapprove ? 'on' : 'off'} · token pairs ${c.pairbuy ? 'bought with HYPE' : 'need the token'} · auto-sell ${c.auto === 'off' ? 'off' : esc(c.auto)} · copy cap ${c.copymax}/day`);
  }
  if (cmd === '/fire') {
    const sub = lc(args[0] || '');
    if (!sub) return say(fires.size ? [...fires.values()].map(fireText).join('\n\n') : FIRE_HELP);
    if (sub === 'stop') { const n = fires.size; for (const f of fires.values()) { f.done = true; f.stopped = true; } return say(n ? '⏹ Stopping. Attempts already sent still land or fail.' : 'Nothing is firing.'); }
    const opt = { every: 2, mins: 15, k: 1 }, rest = [];
    for (const a of args.slice(1)) {
      const x = lc(a);
      if (/^\d*\.?\d+s$/.test(x)) opt.every = Number(x.slice(0, -1));
      else if (/^\d+m$/.test(x)) opt.mins = Number(x.slice(0, -1));
      else if (/^x[1-3]$/.test(x)) opt.k = Number(x.slice(1));
      else if (/^gas=\d*\.?\d+[mk]?$/.test(x)) opt.gas = Number(x.slice(4).replace(/[mk]$/, '')) * (x.endsWith('m') ? 1e6 : x.endsWith('k') ? 1e3 : 1);
      else rest.push(a);
    }
    try {
      if (sub === 'copy') {
        const h = rest[0], hype = Number(rest[1]);
        if (!/^0x[0-9a-fA-F]{64}$/.test(h || '') || !(hype >= 0)) return say(FIRE_HELP);
        if (hype > cfg().max) return say(`Max per buy is ${cfg().max} HYPE (/set max).`);
        const tx = await rpc('eth_getTransactionByHash', [h]);
        if (!tx?.to) return say('That transaction was not found, or it is a contract deploy.');
        const theirs = lc(tx.from).slice(2);
        let data = lc(tx.input || '0x');
        const swapped = data.slice(10).includes(theirs);
        data = data.slice(0, 10) + data.slice(10).split(theirs).join(me.slice(2)); // their address in the call (a recipient) becomes this wallet's
        if (!args.some((a) => /^gas=/i.test(a))) opt.gas = parseInt(tx.gas, 16);
        return await fireStart({ to: lc(tx.to), value: toWei(String(hype)), data, ...opt, label: `same call as ${short(lc(tx.from))}${swapped ? ' (their address in it swapped for yours)' : ''}` }, reply);
      }
      const to = addrIn(args[0]), hype = Number(rest[0]), data = rest[1];
      if (!to || !(hype >= 0) || !/^0x([0-9a-fA-F]{2})*$/.test(data || '')) return say(FIRE_HELP);
      if (hype > cfg().max) return say(`Max per buy is ${cfg().max} HYPE (/set max).`);
      return await fireStart({ to, value: toWei(String(hype)), data: lc(data), ...opt }, reply);
    } catch (e) { return say(`❌ /fire: ${esc(e.message).slice(0, 200)}`); }
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
    const side = lc(args[0]) === 'sell' ? 'sell' : lc(args[0]) === 'buy' ? 'buy' : null;
    const rest = side ? args.slice(1) : args;
    const t = coinArg(rest[0]);
    const L = t ? parseLimit(side || 'buy', rest.slice(1)) : null;
    if (!t || !L) return say(LIMIT_HELP);
    return addLimit(t, L, reply);
  }
  if (cmd === '/snipe') {
    const sub = lc(args[0] || '');
    const usage = 'Usage:\n/snipe 0xTOKEN 1 · buys when its pool opens\n/snipe dev 0xWALLET 1 [count] · the next coin(s) that wallet launches\n/snipe new 1 [count] · the first coin(s) on a pool manager never used before (a new launchpad)\n/snipe ascend 1 [count] · the next Ascend launch(es), bought once the anti-snipe fee is gone\n/snipe signal 1 [count] [tax%] · the next Signal launch(es) on Elysium, bought once the round trip is within tax% (default: /set tax)\n/snipe off · cancel all';
    if (sub === 'off') { state.snipes = []; snipeOffAt = Date.now(); save(); return say('All snipes cancelled.'); }
    let s;
    if (sub === 'dev') { const w = addrIn(args[1]), h = Number(args[2]); if (!w || !(h > 0)) return say(usage); s = { k: 'dev', w, hype: h, left: Math.max(1, Math.min(20, Math.floor(Number(args[3]) || 1))) }; }
    else if (sub === 'new') { const h = Number(args[1]); if (!(h > 0)) return say(usage); s = { k: 'new', hype: h, left: Math.max(1, Math.min(20, Math.floor(Number(args[2]) || 1))) }; }
    else if (sub === 'signal' || sub === 'sig') {
      const h = Number(args[1]), tx = Number(args[3]);
      if (!(h > 0)) return say(usage);
      s = { k: 'sig', hype: h, left: Math.max(1, Math.min(20, Math.floor(Number(args[2]) || 1))) };
      if (tx > 0 && tx <= 90) s.tax = tx; // this snipe's own round-trip limit; /set tax stays as it is for every other buy
    }
    else if (sub === 'ascend' || sub === 'asc') { const h = Number(args[1]); if (!(h > 0)) return say(usage); s = { k: 'asc', hype: h, left: Math.max(1, Math.min(20, Math.floor(Number(args[2]) || 1))) }; }
    else { const t = addrIn(args[0]), h = Number(args[1]); if (!t || !(h > 0)) return say(usage); s = { k: 'token', w: t, hype: h, left: 1 }; }
    if (s.hype > cfg().max) throw new Error(`max per buy is ${cfg().max} HYPE (change with /set max)`);
    s.id = oid(); s.at = Date.now(); s.b = Number(BigInt(await rpc('eth_blockNumber', [])));
    state.snipes.push(s); save();
    const already = s.k === 'token' && state.pools[s.w]?.length ? `\nIt already has ${state.pools[s.w].length} pool${state.pools[s.w].length > 1 ? 's' : ''}: this fires on its next new one (a migration). To buy now, paste it for a card.` : '';
    return say(`🎯 Snipe armed: ${snipeText(s)}. The pool index now checks every 0.4 s; the sell check still runs first.${already}`, [[{ text: '✖ Cancel', callback_data: `n:${s.id}` }]]);
  }
  if (cmd === '/ascend') {
    const sub = lc(args[0] || '');
    const a = addrIn(args[1] || '');
    if (sub === 'router' && a) { state.set.ascrouter = a; save(); }
    else if (sub === 'quote' && a) { state.set.ascquote = a; save(); }
    else if (sub === 'alerts' && ['off', 'on'].includes(lc(args[1]))) { if (lc(args[1]) === 'on') delete state.set.ascalerts; else state.set.ascalerts = 'off'; save(); }
    else if (sub === 'alerts' && Number(args[1]) >= 1 && Number(args[1]) <= 120) { state.set.ascalerts = Math.floor(Number(args[1])); save(); }
    else if (sub === 'delay' && lc(args[1]) === 'auto') { delete state.set.ascdelay; save(); }
    else if (sub === 'delay' && args[1] !== '' && Number(args[1]) >= 0 && Number(args[1]) <= 120) { state.set.ascdelay = Number(args[1]); save(); }
    else if (sub === 'approve') {
      const q = state.set.ascquote || Object.keys(state.asc.quotes).find((x) => x !== ZERO);
      const ur = state.set.ascrouter || Object.values(state.asc.ur)[0];
      if (!q || !ur) return say('Needs the quote token and the router first: /ascend quote 0x… · /ascend router 0x…');
      const txs = await ascApprovals(q, ur, 1n << 128n);
      if (!txs.length) return say('The quote is already approved for Ascend.');
      const hs = await serial(async () => { const o = []; for (const x of txs) o.push(await sendRaw(x)); return o; });
      return say(`Approving the quote for Ascend: ${hs.map((h) => txLink(h)).join(' ')}`);
    }
    else if (sub) return say('Usage: /ascend · /ascend router 0x… · /ascend quote 0x… · /ascend alerts off|on|20 · /ascend delay auto|5 · /ascend approve');
    return say(await ascStatus());
  }
  if (cmd === '/snipes') { const v = snipesView(); return say(v.text, v.rows); }
  if (cmd === '/mine') {
    const sub = lc(args[0] || '');
    if (!sub) { const v = mineView(); return say(v.text, v.rows); }
    if (sub === 'notes') {
      const v = lc(args[1] || '');
      if (!/^(on|off)$/.test(v)) return say('Usage: /mine notes on|off');
      state.set.notes = v; save();
      return say(v === 'on' ? '📒 Each buy in your wallets asks why, and each coin you close shows the result and asks what you learned. Replies are saved on the trade.' : 'Trade notes off. Your wallets are still journaled and counted in /stats.');
    }
    if (sub === 'del' || sub === 'off' || sub === 'remove') {
      const x = lc(args.slice(1).join(' '));
      const w = addrIn(x) || Object.keys(state.mine).find((k) => lc(state.mine[k].name) === x);
      if (!w || !state.mine[w]) return say('Not one of your wallets. /mine lists them.');
      const name = mineName(w);
      mineDrop(w);
      return say(`Removed <b>${esc(name)}</b> and its trades from the journal and /stats.`);
    }
    if (sub === 'name') {
      const w = addrIn(args[1] || '') || Object.keys(state.mine).find((k) => lc(state.mine[k].name) === lc(args[1] || ''));
      const name = args.slice(2).join(' ').replace(/[<>&]/g, '').slice(0, 24);
      if (!w || !state.mine[w] || !name) return say('Usage: /mine name 0xWALLET main');
      state.mine[w].name = name;
      for (const e of state.journal) if (e.w === w) e.src = name;
      save();
      return say(`Renamed to <b>${esc(name)}</b>.`);
    }
    if (sub === 'sync') {
      const ws = Object.keys(state.mine);
      if (!ws.length) return say('No wallets of yours added yet. /mine add 0xWALLET [name]');
      await say(`📒 Rebuilding ${ws.length} wallet${ws.length > 1 ? 's' : ''} from the chain. A few minutes; a summary comes when it is done. Your trade notes are kept.`);
      mineRebuild();
      return;
    }
    const addrs = [...text.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());
    if (sub !== 'add' && !addrIn(sub)) return say('Usage: /mine add 0xWALLET [name] (several addresses work too) · /mine · /mine name 0x… main · /mine del &lt;name|address&gt; · /mine notes on|off · /mine sync');
    if (!addrs.length) return say('Usage: /mine add 0xWALLET [name]');
    const fresh = [];
    for (const w of [...new Set(addrs)]) {
      if (w === me) { await say('That is the bot wallet; its trades are already in the journal.'); continue; }
      if (state.mine[w]) continue;
      const code = await rpc('eth_getCode', [w, 'latest']).catch(() => '0x');
      if (code && code !== '0x') { await say(`<code>${w}</code> is a contract, not a wallet. Skipped.`); continue; }
      const name = addrs.length === 1 ? text.replace(/0x[0-9a-fA-F]{40}/g, ' ').split(/\s+/).slice(1).filter((x) => !/^add$/i.test(x)).join(' ').replace(/[<>&]/g, '').slice(0, 24) : '';
      state.mine[w] = { name: name || short(w), at: Date.now(), imported: 0 };
      fresh.push(w);
    }
    save();
    if (!fresh.length) { const v = mineView(); return say(v.text, v.rows); }
    await say(`📒 Added ${fresh.map((w) => `<b>${esc(mineName(w))}</b>`).join(', ')} (watch-only: no key, the bot never trades from ${fresh.length > 1 ? 'them' : 'it'}). Importing ${fresh.length > 1 ? 'their' : 'its'} Elysium history now: a few minutes, a summary comes when it is done.`);
    mineImport(fresh).catch((e) => console.error('mine import', e.message));
    return;
  }
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
  if (cmd === '/send') {
    const t = coinArg(args[0]), rest = args.slice(1);
    const to = addrIn(rest.join(' ')), a = rest.find((x) => !/0x[0-9a-fA-F]{40}/.test(x));
    if (args[0] && !t) return say(`No coin matches <code>${esc(args[0])}</code>. Use its address, its symbol if you traded it, or its code.`);
    return askSend(t, to, a);
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
      const old = age >= 3600 ? (age / 3600).toFixed(1) + ' h' : Math.round(age / 60) + ' min';
      await ack(`Not bought: alert is ${old} old`);
      // said in the chat, not only in the toast, so a skipped tap never looks like a buy
      return showCard(t, null, `⏸ <b>Not bought.</b> That alert is ${old} old (stale limit ${cfg().stale} min, /set stale). Price now below; tap a buy on this card to buy.`);
    }
    const h = Number(b) / 10;
    ack(`Buying ${h} HYPE…`); // the toast goes out alongside the trade, not before it
    return buy(t, h, reply, kind === 'f', kind === 'f' ? 'override' : srcOf(q.message?.text || ''));
  }
  if (kind === 'h' && t) {
    const on = bwToggle(t), sym = await symOf(t);
    await ack(on ? `👀 Watching ${sym}: dev and top ${BW_TOP} holders` : `🔕 Stopped watching ${sym}`);
    const rows = q.message?.reply_markup?.inline_keyboard || [];
    return tg('editMessageReplyMarkup', { chat_id: OWNER, message_id: reply, reply_markup: { inline_keyboard: rows.length > 1 ? cardButtons(t) : [watchRow(t)] } });
  }
  if (kind === 'k' && t) {
    // ⚡ X: ask for the amount; the reply buys (same sell check and max as the fixed buttons)
    await ack('');
    const sym = esc(await symOf(t));
    const age = Math.floor(Date.now() / 1000) - (q.message?.date || 0);
    const old = cfg().stale > 0 && age > cfg().stale * 60 ? `\nThat alert is ${age >= 3600 ? (age / 3600).toFixed(1) + ' h' : Math.round(age / 60) + ' min'} old; the price may have moved.` : '';
    const q2 = await tg('sendMessage', { chat_id: OWNER, parse_mode: 'HTML', text: `⚡ How much HYPE of <b>${sym}</b>? Reply with the amount (max ${cfg().max}).${old}`, reply_markup: { force_reply: true, input_field_placeholder: '2.5' } });
    if (q2?.message_id) { buyAsk[q2.message_id] = { t, src: srcOf(q.message?.text || '') }; const ks = Object.keys(buyAsk); if (ks.length > 50) delete buyAsk[ks[0]]; }
    return;
  }
  if (kind === 's' && t) {
    const key = `${reply}:${q.data}`;
    if (Date.now() - (taps[key] || 0) < 5000) return ack('Already selling');
    taps[key] = Date.now();
    ack(`Selling ${b}%…`); return sell(t, Number(b), reply);
  }
  if (kind === 'm' && t) {
    await ack('');
    const sym = esc(await symOf(t));
    const held = (state.pos[t]?.balW || '0') !== '0';
    const q2 = await tg('sendMessage', { chat_id: OWNER, parse_mode: 'HTML', text: `🎯 Limit order on <b>${sym}</b>: reply to this message with\n<code>buy 1 20k</code> buy 1 HYPE when MC falls to $20K\n<code>buy 1 above 50k</code> buy on a breakout${held ? '\n<code>sell 50 100k</code> sell 50% when MC reaches $100K\n<code>sell 100 below 3k</code> sell all if MC falls to $3K\n<code>sell 50 2x</code> sell 50% at 2× your entry' : ''}`, reply_markup: { force_reply: true, input_field_placeholder: held ? 'sell 50 100k' : 'buy 1 20k' } });
    if (q2?.message_id) { limitAsk[q2.message_id] = t; const ks = Object.keys(limitAsk); if (ks.length > 50) delete limitAsk[ks[0]]; }
    return;
  }
  if (kind === 'i' && t) {
    const key = `${reply}:${q.data}`;
    if (Date.now() - (taps[key] || 0) < 5000) return ack('Already selling');
    taps[key] = Date.now();
    ack('Taking initials…'); return initials(t, reply);
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
  if (kind === 'u' && t) { if (state.mine[t]) mineDrop(t); await ack('Removed'); const v = mineView(); return edit(q.message, v.text, v.rows); }
  if (kind === 'r' && t) { await ack('Refreshing…'); delete state.routes[t]; return showCard(t, q.message); }
  if (kind === 'c' && t) { await ack('Loading…'); return showCard(t); }
  if (kind === 'w' && pending[a] && !pending[a].kind) { const p = pending[a]; delete pending[a]; await ack('Sending…'); return withdraw(p.to, p.a); }
  if (kind === 'v' && pending[a]?.kind === 'tok') { const p = pending[a]; delete pending[a]; await ack('Sending…'); return sendToken(p.t, p.to, BigInt(p.amt)); }
  if (kind === 'g' && t) {
    await ack('');
    const sym = esc(await symOf(t));
    const q2 = await tg('sendMessage', { chat_id: OWNER, parse_mode: 'HTML', text: `📤 Send <b>${sym}</b> to another wallet: reply to this message with the address and how much\n<code>0xabc… all</code> · <code>0xabc… 50%</code> · <code>0xabc… 12500</code>\nYou confirm with one more tap before anything moves.`, reply_markup: { force_reply: true, input_field_placeholder: '0x… 50%' } });
    if (q2?.message_id) { sendAsk[q2.message_id] = t; const ks = Object.keys(sendAsk); if (ks.length > 50) delete sendAsk[ks[0]]; }
    return;
  }
  if (kind === 'x') { delete pending[a]; await ack('Cancelled'); return edit(q.message, 'Cancelled.'); }
  return ack('');
}

async function main() {
  console.log(`ely-router · wallet ${account.address} · RPCs ${RPCS.length}`);
  await tg('setMyCommands', { commands: [
    { command: 'pos', description: 'Open bags with one-tap sells' }, { command: 'pin', description: 'Re-pin the open trades panel' },
    { command: 'buy', description: '/buy <token> <HYPE>' }, { command: 'sell', description: '/sell <coin> <percent>' },
    { command: 'limit', description: '/limit <coin> 1 20k · /limit sell <coin> 50 100k' }, { command: 'orders', description: 'Limit orders: see and cancel' },
    { command: 'initials', description: '/initials <coin>: sell just enough to take your HYPE back' },
    { command: 'bal', description: 'Wallet balance and bags' }, { command: 'pnl', description: 'Profit and loss of bot trades' },
    { command: 'stats', description: 'Performance and tips: /stats 24h|7d|30d|all [bot|mine]' }, { command: 'journal', description: 'Last 15 trades' },
    { command: 'mine', description: 'Your other wallets, watch-only, for the journal and tips' },
    { command: 'bagwatch', description: 'Watch a coin\'s dev and top holders: /bagwatch 0xCOIN' },
    { command: 'set', description: 'slip, max, sizes and more' }, { command: 'withdraw', description: '/withdraw <address> <HYPE|all>' },
    { command: 'send', description: '/send <coin> <amount|50%|all> <address>: move tokens' },
    { command: 'wallet', description: 'Bot wallet address' }, { command: 'nonce', description: 'Resync after a stuck tx' },
    { command: 'help', description: 'Every command' },
  ] });
  // taps and messages sent while the bot was down are dropped, so an old ⚡ tap never buys hours later
  const backlog = await tg('getUpdates', { offset: -1, timeout: 0 });
  if (backlog?.length) state.offset = backlog[backlog.length - 1].update_id + 1;
  const b = await hypeBal().catch(() => null);
  // nonce and gas price ready before the first tap, gas price kept warm
  await Promise.all([resyncNonce().catch(() => {}), gasPrice().catch(() => {})]);
  setInterval(() => fetchGas().catch(() => {}), 25000);
  await checkHeads().catch(() => {});
  setInterval(() => checkHeads().catch(() => {}), 10000);
  // Inbox route: HyperEVM balance and nonce read now and every 5 min, so a send never waits on them
  await inboxRefresh().catch((e) => console.error('inbox refresh', e.message));
  console.log(`inbox route: ${!cfg().inbox ? 'off' : inboxReady() ? `on (${fmtH(num(inbox.bal))} on HyperEVM)` : `waiting for HyperEVM gas (${inbox.bal == null ? '?' : fmtH(num(inbox.bal))})`}`);
  setInterval(() => inboxRefresh().catch(() => {}), 300000);
  // pool index: first run reads the whole chain (a minute or two), then every few seconds keeps it live
  // ElysPump WHYPE pools were skipped by older versions: read the chain once more for them (known pools are kept)
  if (!state.wrapIdx) { state.poolsBlock = 0; state.wrapIdx = 1; save(); }
  // Uniswap WHYPE and KNTQ pools were skipped before: read the blocks since the first ones again (seen pools are skipped)
  if (!state.uniIdx) { state.poolsBlock = Math.min(state.poolsBlock || 0, 370000); state.uniIdx = 1; for (const t of Object.keys(state.routes)) if (!state.routes[t]) delete state.routes[t]; save(); }
  const first = !state.poolsBlock;
  if (first) console.log('indexing every v4 pool on Elysium…');
  await indexPools().catch((e) => console.error('index', e.message));
  for (const l of Object.values(state.pools)) for (const p of l) knownPms.add(p.pm);
  live = true; // from here on, new pools are live events for snipes
  // Signal snipes that were waiting on a coin when the bot stopped carry on, inside their first 11 minutes
  for (const s of state.snipes.filter((x) => x.k === 'sig')) {
    for (const w of [...(s.wait || [])]) {
      if (Date.now() - w.at < 11 * 60000) sigSnipe(w.f, s, w.at, true).catch((e) => { console.error('signal snipe', e.message); sigDone(s, w.f.t, false); });
      else sigDone(s, w.f.t, false);
    }
  }
  // Signal's factory, every 0.4 s while a Signal snipe is armed (sigWatch)
  (async () => { for (;;) { await sleep(400); await sigWatch().catch((e) => console.error('signal watch', e.message)); } })();
  // the index tails the chain every 1.5 s, every 0.4 s while a snipe is armed
  (async () => { for (;;) { await sleep(state.snipes.length ? 400 : 1500); await indexPools().catch(() => {}); await handleFresh().catch((e) => console.error('snipes', e.message)); } })();
  // orders and guards every 2 s; copied wallets every second
  (async () => { for (;;) { await sleep(2000); await guardTick().catch((e) => console.error('guard', e.message)); } })();
  // bag watch: dev and top holder sells on every coin you hold, every 5 s
  (async () => { for (;;) { await sleep(5000); await bagWatchTick().catch((e) => console.error('bag watch', e.message)); } })();
  (async () => { for (;;) { await sleep(Object.keys(state.copy).length ? 1000 : 5000); await copyTick().catch((e) => console.error('copy', e.message)); } })();
  // your other wallets: imports a restart cut short are run again, then the live tail every 4 s
  // the first version of the import skipped trades when the archive node answered "missing trie node": read once more
  if ((state.mineV || 1) < 2 && Object.values(state.mine).some((x) => x.imported)) { state.mineV = 2; mineRebuild(); }
  else {
    state.mineV = 2;
    const left = Object.keys(state.mine).filter((w) => !state.mine[w].imported);
    if (left.length) mineImport(left, true).catch((e) => console.error('mine import', e.message));
  }
  (async () => { for (;;) { await sleep(4000); await mineTick().catch((e) => console.error('mine', e.message)); } })();
  // open bags valued every 10 minutes; the daily report goes out once a day at REPORT_HOUR_UTC
  (async () => { for (;;) { await sleep(600000); await valuePositions().catch(() => {}); } })();
  // the pinned open-trades panel: up to date at start, then every minute
  refreshPin();
  (async () => { for (;;) { await sleep(60000); await refreshPin(); } })();
  (async () => {
    for (;;) {
      await sleep(60000);
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (cfg().report !== 'off' && d.getUTCHours() === REPORT_HOUR_UTC && state.reportDay !== day) { state.reportDay = day; save(); await dailyReport(cfg().report === 'on').catch((e) => console.error('report', e.message)); }
    }
  })();
  await say(`🟢 ely-router online · <code>${account.address}</code>${b != null ? ` · ${fmtH(num(b))}` : ''}\nPools indexed: ${poolCount()} across ${knownPms.size} pool managers, kept live.${(() => { const c = cfg(), n = Object.values(state.orders).reduce((a, l) => a + l.length, 0), x = [n ? `${n} limit order${n > 1 ? 's' : ''}` : '', state.snipes.length ? `${state.snipes.length} snipes` : '', Object.keys(state.copy).length ? `copying ${Object.keys(state.copy).length}` : '', c.auto !== 'off' ? `auto-sell ${esc(c.auto)}` : '', c.devsell ? `dev guard ${c.devsell}%` : '', c.rug ? 'rug guard' : '', c.bagwatch ? 'bag watch: every bag' : Object.keys(state.bwArm).length ? `bag watch: ${Object.keys(state.bwArm).length} armed` : ''].filter(Boolean); return x.length ? '\n' + x.join(' · ') : ''; })()}${backlog?.length ? '\nTaps sent while it was offline were skipped.' : ''}`);
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
