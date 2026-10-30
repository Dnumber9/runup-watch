// ely-router: one-tap buys and sells from Telegram, for Stockium curves (HyperEVM) and StockiumSwap pools (Elysium).
//
// Runs on your own machine or VPS with a fresh burner wallet. The key lives only in .env there.
// The watcher's alerts carry "Buy 1 / 3 / 5 HYPE" buttons; tapping one sends a callback to this bot,
// which signs and sends the trade, then replies with the result and Sell buttons.
//
// Chat commands (only from your TELEGRAM_CHAT_ID):
//   /buy <curve or token address> <HYPE>     buy (curve on HyperEVM, or a token on Elysium)
//   /sell <curve or token address> [percent] sell your balance (default 100%)
//   /bal                                      HYPE balance on both chains
//   /help

import fs from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEther, formatEther, formatUnits, maxUint256, encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── config (.env next to this file, or real environment variables) ─────────────────────────────────
const envFile = new URL('./.env', import.meta.url);
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// dry run: `node router.mjs --dry buy|sell <address> <HYPE|percent>` quotes the trade and prints the call it would send
const DRY = process.argv[2] === '--dry';
const need = (k) => { if (DRY) return process.env[k] || ''; if (!process.env[k]) { console.error(`missing ${k} in .env`); process.exit(1); } return process.env[k]; };
const TG = need('TELEGRAM_BOT_TOKEN');
const CHAT = String(need('TELEGRAM_CHAT_ID'));
const KEY = need('PRIVATE_KEY') || '0x' + '11'.repeat(32);
const MAX_BUY = Number(process.env.MAX_BUY_HYPE || 5);          // hard cap per trade
const SLIP_BPS = BigInt(process.env.SLIPPAGE_BPS || 1500);       // 15% default; launches move fast
const HYPER_RPC = process.env.HYPER_RPC || 'https://rpc.hyperliquid.xyz/evm';
const ELY_RPC = process.env.ELY_RPC || 'https://rpc-live.elysp.com';

// ── chains and contracts ─────────────────────────────────────────────────────────────────────────
const native = { name: 'HYPE', symbol: 'HYPE', decimals: 18 };
const hyperevm = defineChain({ id: 999, name: 'HyperEVM', nativeCurrency: native, rpcUrls: { default: { http: [HYPER_RPC] } } });
const elysium = defineChain({ id: 99901, name: 'Elysium', nativeCurrency: native, rpcUrls: { default: { http: [ELY_RPC] } } });

const STK = {
  gatewayRouter: '0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0', // HyperEVM → Elysium token gateway
  factory: '0x4F66184A9FFabB7f7071D590C2c48DEDf41676f4',       // StockiumSwap (Uniswap v3 fork) on Elysium
  router: '0xf7d8d5f9B9125b3d29c5778Df5E54c1bbe77f224',
  quoter: '0x1947918B6bf36112F7bA8AA983e8D94ce574163a',
  whype: '0xba876237b0f021a6c6d852d6c26e107997cc5e81',          // the router's WETH9 on Elysium
};
const FEES = [10000, 3000, 500, 100];

const curveAbi = parseAbi([
  'function buy(uint256 minTokensOut, uint256 minPairOut) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minHypeOut) returns (uint256)',
  'function quoteBuy(uint256 hypeIn) view returns (uint256 tokensOut, uint256 fee)',
  'function quoteSell(uint256 tokensIn) view returns (uint256 hypeOut, uint256 fee)',
  'function token() view returns (address)',
  'function graduated() view returns (bool)',
]);
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const gatewayAbi = parseAbi(['function calculateL2TokenAddress(address l1Token) view returns (address)']);
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)']);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
]);

const account = privateKeyToAccount(KEY.startsWith('0x') ? KEY : '0x' + KEY);
const C = {
  h: { pub: createPublicClient({ chain: hyperevm, transport: http() }), wal: createWalletClient({ account, chain: hyperevm, transport: http() }), scan: 'https://hyperevmscan.io/tx/' },
  e: { pub: createPublicClient({ chain: elysium, transport: http() }), wal: createWalletClient({ account, chain: elysium, transport: http() }), scan: 'https://elysium.kinetiq.xyz/explorer/transaction/' },
};
const me = account.address;
const minOut = (x) => (x * (10000n - SLIP_BPS)) / 10000n;
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

// ── Telegram ─────────────────────────────────────────────────────────────────────────────────────
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const say = (text, buttons) => tg('sendMessage', { chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}) });
const sellButtons = (chain, addr) => [25, 50, 100].map((p) => ({ text: `Sell ${p}%`, callback_data: `s:${chain}:${addr.slice(2)}:${p}` }));

// ── resolve what an address is ───────────────────────────────────────────────────────────────────
async function isCurve(addr) {
  try { await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'quoteBuy', args: [parseEther('0.01')] }); return true; } catch { return false; }
}
async function elyPool(token) {
  let best = null;
  for (const fee of FEES) {
    const pool = await C.e.pub.readContract({ address: STK.factory, abi: factoryAbi, functionName: 'getPool', args: [token, STK.whype, fee] }).catch(() => null);
    if (!pool || /^0x0+$/.test(pool)) continue;
    const liq = await C.e.pub.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }).catch(() => 0n);
    if (!best || liq > best.liq) best = { pool, fee, liq };
  }
  return best && best.liq > 0n ? best : null;
}
// a graduated curve's token lives on Elysium at the gateway's L2 address
async function curveToEly(curve) {
  const l1 = await C.h.pub.readContract({ address: curve, abi: curveAbi, functionName: 'token' });
  return C.h.pub.readContract({ address: STK.gatewayRouter, abi: gatewayAbi, functionName: 'calculateL2TokenAddress', args: [l1] });
}

async function send(chain, req) {
  if (DRY) { console.log(`[dry] ${chain === 'h' ? 'HyperEVM' : 'Elysium'} ${req.functionName} on ${req.address}${req.value ? ` value ${formatEther(req.value)} HYPE` : ''}`, JSON.stringify(req.args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); return '0xdry'; }
  const hash = await C[chain].wal.writeContract(req);
  const rcpt = await C[chain].pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rcpt.status !== 'success') throw new Error(`reverted: ${C[chain].scan}${hash}`);
  return hash;
}
async function approveIfNeeded(chain, token, spender, amount) {
  if (DRY) return;
  const a = await C[chain].pub.readContract({ address: token, abi: erc20, functionName: 'allowance', args: [me, spender] });
  if (a < amount) await send(chain, { address: token, abi: erc20, functionName: 'approve', args: [spender, maxUint256] });
}

// ── trades ───────────────────────────────────────────────────────────────────────────────────────
async function buy(chain, addr, hypeAmt) {
  if (!(hypeAmt > 0) || hypeAmt > MAX_BUY) throw new Error(`amount must be between 0 and ${MAX_BUY} HYPE (MAX_BUY_HYPE)`);
  const value = parseEther(String(hypeAmt));
  if (chain === 'h' || (chain === '?' && await isCurve(addr))) {
    const graduated = await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'graduated' }).catch(() => false);
    if (graduated) return buy('e', await curveToEly(addr), hypeAmt);
    const [out] = await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'quoteBuy', args: [value] });
    const hash = await send('h', { address: addr, abi: curveAbi, functionName: 'buy', args: [minOut(out), 0n], value });
    const tok = await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'token' });
    const sym = await C.h.pub.readContract({ address: tok, abi: erc20, functionName: 'symbol' }).catch(() => '?');
    return { text: `✅ Bought ~${fmt(out)} <b>${sym}</b> for ${hypeAmt} HYPE on its Stockium curve\n<a href="${C.h.scan}${hash}">tx</a>`, buttons: sellButtons('h', addr) };
  }
  const p = await elyPool(addr);
  if (!p) throw new Error('no StockiumSwap HYPE pool for that token on Elysium (BOXA, elyspump and Kleos pools are not wired in yet)');
  const { result } = await C.e.pub.simulateContract({ address: STK.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: STK.whype, tokenOut: addr, amountIn: value, fee: p.fee, sqrtPriceLimitX96: 0n }], account: me });
  const out = result[0];
  const hash = await send('e', {
    address: STK.router, abi: routerAbi, functionName: 'exactInputSingle', value,
    args: [{ tokenIn: STK.whype, tokenOut: addr, fee: p.fee, recipient: me, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn: value, amountOutMinimum: minOut(out), sqrtPriceLimitX96: 0n }],
  });
  const sym = await C.e.pub.readContract({ address: addr, abi: erc20, functionName: 'symbol' }).catch(() => '?');
  return { text: `✅ Bought ~${fmt(out)} <b>${sym}</b> for ${hypeAmt} HYPE on StockiumSwap (Elysium)\n<a href="${C.e.scan}${hash}">tx</a>`, buttons: sellButtons('e', addr) };
}

async function sell(chain, addr, pct) {
  pct = Math.min(100, Math.max(1, Number(pct) || 100));
  if (chain === 'h' || (chain === '?' && await isCurve(addr))) {
    const graduated = await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'graduated' }).catch(() => false);
    const tok = await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'token' });
    if (graduated) throw new Error('this curve has graduated: bridge the tokens to Elysium and sell there with /sell <Elysium token address>');
    const bal = await C.h.pub.readContract({ address: tok, abi: erc20, functionName: 'balanceOf', args: [me] });
    const amt = (bal * BigInt(pct)) / 100n;
    if (amt === 0n) throw new Error('you hold none of this token on HyperEVM');
    await approveIfNeeded('h', tok, addr, amt);
    const [out] = await C.h.pub.readContract({ address: addr, abi: curveAbi, functionName: 'quoteSell', args: [amt] });
    const hash = await send('h', { address: addr, abi: curveAbi, functionName: 'sell', args: [amt, minOut(out)] });
    return { text: `✅ Sold ${pct}% for ~${formatEther(out)} HYPE on the Stockium curve\n<a href="${C.h.scan}${hash}">tx</a>` };
  }
  const p = await elyPool(addr);
  if (!p) throw new Error('no StockiumSwap HYPE pool for that token on Elysium');
  const bal = await C.e.pub.readContract({ address: addr, abi: erc20, functionName: 'balanceOf', args: [me] });
  const amt = (bal * BigInt(pct)) / 100n;
  if (amt === 0n) throw new Error('you hold none of this token on Elysium');
  await approveIfNeeded('e', addr, STK.router, amt);
  const { result } = await C.e.pub.simulateContract({ address: STK.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: addr, tokenOut: STK.whype, amountIn: amt, fee: p.fee, sqrtPriceLimitX96: 0n }], account: me });
  const min = minOut(result[0]);
  // swap into wrapped HYPE held by the router, then unwrap to native HYPE in the same transaction
  const swap = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: addr, tokenOut: STK.whype, fee: p.fee, recipient: STK.router, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn: amt, amountOutMinimum: min, sqrtPriceLimitX96: 0n }] });
  const unwrap = encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [min, me] });
  const hash = await send('e', { address: STK.router, abi: routerAbi, functionName: 'multicall', args: [[swap, unwrap]] });
  return { text: `✅ Sold ${pct}% for ~${formatEther(result[0])} HYPE on StockiumSwap\n<a href="${C.e.scan}${hash}">tx</a>` };
}

const fmt = (x) => { const n = Number(formatUnits(x, 18)); return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2); };

async function balances() {
  const [h, e] = await Promise.all([C.h.pub.getBalance({ address: me }).catch(() => null), C.e.pub.getBalance({ address: me }).catch(() => null)]);
  return `Wallet <code>${me}</code>\nHyperEVM: ${h == null ? 'unreachable' : formatEther(h)} HYPE\nElysium: ${e == null ? 'unreachable' : formatEther(e)} HYPE\nMax per buy: ${MAX_BUY} HYPE · slippage ${Number(SLIP_BPS) / 100}%`;
}

// ── loop ─────────────────────────────────────────────────────────────────────────────────────────
const recent = new Map(); // callback data → time, so a double tap doesn't buy twice
async function handle(kind, chain, addr, arg) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return say('That is not an address.');
  addr = addr.toLowerCase();
  await say(`⏳ ${kind === 'b' ? `Buying ${arg} HYPE of` : `Selling ${arg}% of`} <code>${short(addr)}</code>…`);
  try {
    const r = kind === 'b' ? await buy(chain, addr, Number(arg)) : await sell(chain, addr, arg);
    await say(r.text, r.buttons);
  } catch (e) {
    await say(`❌ ${String(e.shortMessage || e.message).slice(0, 300)}`);
  }
}

async function main() {
  if (DRY) {
    const [, , kind, addr, arg] = process.argv.slice(1);
    const r = kind === 'sell' ? await sell('?', addr.toLowerCase(), arg) : await buy('?', addr.toLowerCase(), Number(arg));
    console.log(r.text.replace(/<[^>]+>/g, ''));
    return;
  }
  console.log(`ely-router running for ${me}`);
  await say(`🟢 Router online\n${await balances()}`);
  let offset = 0;
  for (;;) {
    let up;
    try { up = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }); }
    catch { await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const u of up.result || []) {
      offset = u.update_id + 1;
      const cq = u.callback_query;
      if (cq) {
        tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
        if (String(cq.from.id) !== CHAT && String(cq.message?.chat?.id) !== CHAT) continue;
        const m = String(cq.data || '').match(/^([bs]):([he]):([0-9a-fA-F]{40}):([\d.]+)$/);
        if (!m) continue;
        if (Date.now() - (recent.get(cq.data) || 0) < 5000) continue;
        recent.set(cq.data, Date.now());
        handle(m[1], m[2], '0x' + m[3], m[4]);
        continue;
      }
      const msg = u.message;
      if (!msg?.text || String(msg.chat.id) !== CHAT) continue;
      const [cmd, a1, a2] = msg.text.trim().split(/\s+/);
      if (cmd === '/buy' && a1 && a2) handle('b', '?', a1, a2);
      else if (cmd === '/sell' && a1) handle('s', '?', a1, a2 || '100');
      else if (cmd === '/bal') say(await balances());
      else if (cmd === '/help' || cmd === '/start') say('Commands:\n/buy &lt;curve or token&gt; &lt;HYPE&gt;\n/sell &lt;curve or token&gt; [percent]\n/bal\nOr tap the Buy buttons on alerts.');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
