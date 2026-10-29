// swoop: insider sweep for chosen Elysium tokens.
// For every wallet that ever swapped the token: buys, sells, HYPE in/out, tokens held, PnL,
// entry order, who funded it, bridge-ins, and clusters of wallets that look like one operator.
// Usage: SWOOP_TOKENS="BOXA,KLEOS" node elysium-watch/swoop.mjs   (symbols or 0x addresses)
// Output: swoop-out/swoop.json and one CSV per token.

import fs from 'node:fs';

const RPC = process.env.ELY_RPC || 'https://rpc-live.elyspump.com';
const WANT = (process.env.SWOOP_TOKENS || 'BOXA,KLEOS').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = 'swoop-out';
const LOG_RANGE = 9000;
const BLOCK_BATCH = 40;
const CONC = 8;

const ZERO = '0x0000000000000000000000000000000000000000';
const LAUNCHPADS = {
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4': 'BOXA',
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600': 'elyspump',
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490': 'Kleos',
};
const WHYPE = new Set(['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81']);
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_INIT_V4 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const BRIDGE_TYPES = new Set(['0x64', '0x65', '0x68', '0x69']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => String(a || '').toLowerCase();
const hex = (n) => '0x' + n.toString(16);
const topicAddr = (t) => lc('0x' + t.slice(26));
const words = (d) => d.slice(2).match(/.{64}/g) || [];
const int256 = (h) => { const x = BigInt('0x' + h); return x >= 1n << 255n ? x - (1n << 256n) : x; };
const r2 = (x) => Math.round(x * 100) / 100;

let calls = 0;
async function batch(reqs) {
  for (let i = 0; i < 6; i++) {
    try {
      calls++;
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs), signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 200));
      const m = new Map(j.map((x) => [x.id, x]));
      return reqs.map((q) => m.get(q.id));
    } catch (e) {
      if (i === 5) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}
const one = async (method, params) => {
  const [x] = await batch([{ jsonrpc: '2.0', id: 1, method, params }]);
  if (x.error) throw new Error(method + ': ' + JSON.stringify(x.error));
  return x.result;
};
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all([...Array(n)].map(async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
async function logs(filter, from, to) {
  const out = [];
  const ranges = [];
  for (let s = from; s <= to; s += LOG_RANGE) ranges.push([s, Math.min(to, s + LOG_RANGE - 1)]);
  await pool(ranges, 4, async ([a, b]) => {
    const r = await one('eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }]);
    out.push(...r);
  });
  return out.sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16));
}
function decStr(h) {
  if (!h || h === '0x') return '';
  const w = words(h);
  try {
    if (w.length >= 2 && BigInt('0x' + w[0]) === 32n) {
      const len = Number(BigInt('0x' + w[1]));
      return Buffer.from(h.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
    }
    return Buffer.from(h.slice(2, 66), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}
async function calls1(list) { // [{to,data}] → results
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const r = await batch(chunk.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })));
    out.push(...r.map((x) => x?.result || '0x'));
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const head = parseInt(await one('eth_blockNumber', []), 16);
  const headBlk = await one('eth_getBlockByNumber', [hex(head), false]);
  let px = null;
  try { px = (await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd')).json()).hyperliquid.usd; } catch {}
  console.log('head', head, 'HYPE $', px);

  // 1. every launchpad pool, then resolve the wanted tokens
  const pools = []; // {id, pm, token, block, tx}
  for (const pm of Object.keys(LAUNCHPADS)) {
    for (const l of await logs({ address: pm, topics: [T_INIT_V4] }, 0, head)) {
      const c0 = topicAddr(l.topics[2]);
      const c1 = topicAddr(l.topics[3]);
      if (c0 !== ZERO && !WHYPE.has(c0)) continue; // only HYPE pairs
      pools.push({ id: lc(l.topics[1]), pm, token: c1, block: parseInt(l.blockNumber, 16), tx: l.transactionHash });
    }
  }
  console.log('pools', pools.length);
  const toks = [...new Set(pools.map((p) => p.token))];
  const syms = await calls1(toks.map((t) => ({ to: t, data: '0x95d89b41' })));
  const names = await calls1(toks.map((t) => ({ to: t, data: '0x06fdde03' })));
  const symOf = Object.fromEntries(toks.map((t, i) => [t, decStr(syms[i])]));
  const nameOf = Object.fromEntries(toks.map((t, i) => [t, decStr(names[i])]));
  const targets = [];
  for (const w of WANT) {
    if (/^0x[0-9a-f]{40}$/i.test(w)) targets.push(lc(w));
    else for (const t of toks) if (symOf[t].toUpperCase() === w.toUpperCase()) targets.push(t);
  }
  console.log('targets', targets.map((t) => symOf[t] + ' ' + t));
  if (!targets.length) throw new Error('no matching tokens');

  // 2. full block scan with transactions: who signed each tx, native HYPE flows, bridge-ins
  const txFrom = new Map();     // hash → signer
  const nativeIn = new Map();   // addr → [{from, val, blk, type}]
  const nativeOut = new Map();  // addr → [{to, val, blk}]
  const blkTs = new Map();
  const ranges = [];
  for (let b = 0; b <= head; b += BLOCK_BATCH) ranges.push(b);
  let done = 0;
  await pool(ranges, CONC, async (b) => {
    const reqs = [];
    for (let i = b; i < Math.min(head + 1, b + BLOCK_BATCH); i++) reqs.push({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: [hex(i), true] });
    const res = await batch(reqs);
    for (const x of res) {
      const B = x?.result;
      if (!B) continue;
      const bn = parseInt(B.number, 16);
      blkTs.set(bn, parseInt(B.timestamp, 16));
      for (const t of B.transactions || []) {
        const f = lc(t.from), to = lc(t.to);
        txFrom.set(t.hash, f);
        const v = Number(BigInt(t.value || '0x0')) / 1e18;
        if (v > 0 && to) {
          const type = lc(t.type);
          (nativeIn.get(to) || nativeIn.set(to, []).get(to)).push({ from: f, val: v, blk: bn, type, input: (t.input || '0x').slice(0, 10) });
          (nativeOut.get(f) || nativeOut.set(f, []).get(f)).push({ to, val: v, blk: bn, input: (t.input || '0x').slice(0, 10) });
        }
      }
    }
    if (++done % 100 === 0) console.log('blocks', done * BLOCK_BATCH, '/', head);
  });
  const ts = (b) => blkTs.get(b) || null;

  // contract check helper (cached)
  const codeCache = new Map();
  async function isContract(addrs) {
    const need = addrs.filter((a) => !codeCache.has(a));
    for (let i = 0; i < need.length; i += 100) {
      const ch = need.slice(i, i + 100);
      const r = await batch(ch.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getCode', params: [a, 'latest'] })));
      ch.forEach((a, k) => codeCache.set(a, !!(r[k]?.result && r[k].result !== '0x')));
    }
  }

  const report = { head, headTime: parseInt(headBlk.timestamp, 16), hypeUsd: px, tokens: [] };

  for (const T of targets) {
    const tPools = pools.filter((p) => p.token === T);
    const firstBlock = Math.min(...tPools.map((p) => p.block), head);
    console.log('==', symOf[T], T, 'pools', tPools.length, 'from', firstBlock);
    const [decH, supH] = await calls1([{ to: T, data: '0x313ce567' }, { to: T, data: '0x18160ddd' }]);
    const dec = decH && decH !== '0x' ? Number(BigInt(decH)) : 18;
    const supply = supH && supH !== '0x' ? Number(BigInt(supH)) / 10 ** dec : 0;

    // swaps on the v4 pool(s)
    const swaps = []; // {tx, blk, hype (+ = wallet paid HYPE = buy), tok (+ = wallet got tokens), price}
    let lastPrice = null;
    for (const p of tPools) {
      for (const l of await logs({ address: p.pm, topics: [T_SWAP_V4, p.id] }, p.block, head)) {
        const w = words(l.data);
        const a0 = Number(int256(w[0])) / 1e18;           // HYPE delta for swapper (negative = paid)
        const a1 = Number(int256(w[1])) / 10 ** dec;      // token delta for swapper
        const sqrt = BigInt('0x' + w[2]);
        let price = null;
        if (sqrt > 0n) { const ratio = Number((sqrt * sqrt * 10n ** 18n) >> 192n) / 1e18; if (ratio > 0) price = (1 / ratio) * 10 ** (dec - 18); }
        if (price) lastPrice = price;
        swaps.push({ tx: l.transactionHash, blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), hype: -a0, tok: a1, price, venue: LAUNCHPADS[p.pm] });
      }
    }
    // token transfers (holders, wallet-to-wallet token moves, v3 pools)
    const tlogs = await logs({ address: T, topics: [T_TRANSFER] }, firstBlock > 0 ? Math.max(0, firstBlock - 50) : 0, head);
    // find Uniswap v3 HYPE pools holding the token
    const cps = new Set();
    for (const l of tlogs) { cps.add(topicAddr(l.topics[1])); cps.add(topicAddr(l.topics[2])); }
    const cpList = [...cps].filter((a) => a !== ZERO && !LAUNCHPADS[a]);
    await isContract(cpList);
    const contracts = cpList.filter((a) => codeCache.get(a));
    const t0s = await calls1(contracts.map((c) => ({ to: c, data: '0x0dfe1681' })));
    const t1s = await calls1(contracts.map((c) => ({ to: c, data: '0xd21220a7' })));
    const v3 = [];
    contracts.forEach((c, i) => {
      const a = t0s[i]?.length >= 66 ? topicAddr(t0s[i]) : null, b = t1s[i]?.length >= 66 ? topicAddr(t1s[i]) : null;
      if (a && b && ((a === T && WHYPE.has(b)) || (b === T && WHYPE.has(a)))) v3.push({ pool: c, hypeIs0: WHYPE.has(a) });
    });
    for (const v of v3) {
      for (const l of await logs({ address: v.pool, topics: [T_SWAP_V3] }, firstBlock, head)) {
        const w = words(l.data);
        const a0 = Number(int256(w[0])), a1 = Number(int256(w[1])); // pool deltas
        const hDelta = (v.hypeIs0 ? a0 : a1) / 1e18;                // + = pool got HYPE = buy
        const tDelta = (v.hypeIs0 ? a1 : a0) / 10 ** dec;           // - = pool paid tokens = buy
        const price = Math.abs(tDelta) > 0 ? Math.abs(hDelta / tDelta) : null;
        swaps.push({ tx: l.transactionHash, blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), hype: hDelta, tok: -tDelta, price, venue: 'uniswap v3' });
      }
    }
    swaps.sort((a, b) => a.blk - b.blk || a.li - b.li);
    if (swaps.length && swaps.at(-1).price) lastPrice = swaps.at(-1).price;
    const poolAddrs = new Set([...Object.keys(LAUNCHPADS), ...v3.map((v) => v.pool)]);
    console.log('swaps', swaps.length, 'transfers', tlogs.length, 'v3 pools', v3.length, 'price HYPE', lastPrice);

    // per-wallet rollup (wallet = tx signer)
    const W = new Map();
    const get = (a) => W.get(a) || W.set(a, { a, buys: 0, sells: 0, hIn: 0, hOut: 0, tBought: 0, tSold: 0, firstBuy: null, firstBuyRank: null, lastAct: 0, tRecv: 0, tSent: 0, recvFrom: new Set(), sentTo: new Set() }).get(a);
    let rank = 0;
    for (const s of swaps) {
      const who = txFrom.get(s.tx);
      if (!who) continue;
      const w = get(who);
      if (s.hype > 0) { w.buys++; w.hIn += s.hype; w.tBought += Math.max(0, s.tok); if (w.firstBuy == null) { w.firstBuy = s.blk; w.firstBuyRank = ++rank; } }
      else { w.sells++; w.hOut += -s.hype; w.tSold += Math.max(0, -s.tok); }
      w.lastAct = Math.max(w.lastAct, s.blk);
    }
    // wallet-to-wallet token moves (not via pools/routers): free tokens in, tokens moved out
    const swapTx = new Set(swaps.map((s) => s.tx));
    for (const l of tlogs) {
      if (swapTx.has(l.transactionHash)) continue;
      const f = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
      if (f === ZERO || poolAddrs.has(f) || poolAddrs.has(to)) continue;
      const amt = Number(BigInt(l.data)) / 10 ** dec;
      if (W.has(to) || W.has(f)) {
        const wt = get(to); wt.tRecv += amt; wt.recvFrom.add(f);
        const wf = get(f); wf.tSent += amt; wf.sentTo.add(to);
      }
    }
    // balances now
    const addrs = [...W.keys()];
    const bals = await calls1(addrs.map((a) => ({ to: T, data: '0x70a08231' + a.slice(2).padStart(64, '0') })));
    const hb = [];
    for (let i = 0; i < addrs.length; i += 100) {
      const ch = addrs.slice(i, i + 100);
      const r = await batch(ch.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getBalance', params: [a, 'latest'] })));
      hb.push(...r.map((x) => (x?.result ? Number(BigInt(x.result)) / 1e18 : 0)));
    }
    await isContract(addrs);

    // funding: first HYPE in, bridge-ins
    const creator = txFrom.get(tPools[0]?.tx) || null;
    addrs.forEach((a, i) => {
      const w = W.get(a);
      w.held = bals[i] && bals[i] !== '0x' ? Number(BigInt(bals[i])) / 10 ** dec : 0;
      w.hype = hb[i];
      w.contract = codeCache.get(a) || false;
      const ins = (nativeIn.get(a) || []).slice().sort((x, y) => x.blk - y.blk);
      const firstIn = ins[0];
      w.funder = firstIn ? (BRIDGE_TYPES.has(firstIn.type) ? 'bridge' : firstIn.from) : null;
      w.funderAddr = firstIn?.from || null;
      w.fundedAt = firstIn?.blk ?? null;
      w.firstFund = firstIn?.val ?? 0;
      w.bridged = r2(ins.filter((x) => BRIDGE_TYPES.has(x.type)).reduce((s, x) => s + x.val, 0));
      w.heldValue = lastPrice ? w.held * lastPrice : 0;
      w.realized = w.hOut - w.hIn;
      w.pnl = w.realized + w.heldValue;
      w.pctSupply = supply ? (w.held / supply) * 100 : 0;
      w.isCreator = a === creator;
    });

    // clusters: union-find over (shared non-bridge funder), (funded one another), (token moves between them)
    const parent = new Map(addrs.map((a) => [a, a]));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const union = (a, b) => { if (!parent.has(a) || !parent.has(b)) return; const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
    const set = new Set(addrs);
    const byFunder = new Map();
    for (const a of addrs) {
      const w = W.get(a);
      if (w.contract) continue;
      if (w.funderAddr && w.funder !== 'bridge') (byFunder.get(w.funderAddr) || byFunder.set(w.funderAddr, []).get(w.funderAddr)).push(a);
      // direct HYPE between two swappers (excluding contract calls)
      for (const o of nativeOut.get(a) || []) if (set.has(o.to) && o.input === '0x' && !W.get(o.to).contract) union(a, o.to);
      for (const t of W.get(a).sentTo) if (set.has(t) && !W.get(t).contract) union(a, t);
    }
    // bridge senders: the same parent-chain sender bridging to several wallets links them too
    const byBridger = new Map();
    for (const a of addrs) for (const x of nativeIn.get(a) || []) if (BRIDGE_TYPES.has(x.type)) (byBridger.get(x.from) || byBridger.set(x.from, new Set()).get(x.from)).add(a);
    const hubs = [];
    for (const [f, kids] of byFunder) {
      const fanout = (nativeOut.get(f) || []).filter((o) => o.input === '0x').length;
      if (fanout > 60) { hubs.push({ funder: f, kids: kids.length, fanout }); continue; } // looks like a bridge/faucet/service, not a person
      if (set.has(f) && !W.get(f).contract) for (const k of kids) union(f, k);
      for (const k of kids.slice(1)) union(kids[0], k);
    }
    for (const [b, kids] of byBridger) {
      const ks = [...kids];
      if (ks.length > 1 && ks.length <= 15) for (const k of ks.slice(1)) union(ks[0], k);
    }
    const groups = new Map();
    for (const a of addrs) { const r = find(a); (groups.get(r) || groups.set(r, []).get(r)).push(a); }
    let cid = 0;
    const clusters = [];
    for (const [, mem] of [...groups].sort((x, y) => y[1].length - x[1].length)) {
      if (mem.length < 2) continue;
      const id = 'C' + ++cid;
      for (const a of mem) W.get(a).cluster = id;
      const ws = mem.map((a) => W.get(a));
      clusters.push({
        id, n: mem.length,
        wallets: mem,
        hIn: r2(ws.reduce((s, w) => s + w.hIn, 0)),
        hOut: r2(ws.reduce((s, w) => s + w.hOut, 0)),
        heldValue: r2(ws.reduce((s, w) => s + w.heldValue, 0)),
        pnl: r2(ws.reduce((s, w) => s + w.pnl, 0)),
        pctSupply: Math.round(ws.reduce((s, w) => s + w.pctSupply, 0) * 100) / 100,
        firstRank: Math.min(...ws.map((w) => w.firstBuyRank ?? 1e9)),
        funders: [...new Set(ws.map((w) => w.funder).filter(Boolean))].slice(0, 6),
        creatorIn: ws.some((w) => w.isCreator),
        bridged: r2(ws.reduce((s, w) => s + w.bridged, 0)),
      });
    }
    clusters.sort((a, b) => b.pnl - a.pnl);

    const rows = [...W.values()]
      .filter((w) => w.buys || w.sells || w.tRecv > 0)
      .map((w) => ({
        wallet: w.a, cluster: w.cluster || '', contract: w.contract, creator: w.isCreator,
        entryRank: w.firstBuyRank, firstBuy: w.firstBuy, firstBuyTime: w.firstBuy != null ? ts(w.firstBuy) : null,
        blocksAfterLaunch: w.firstBuy != null ? w.firstBuy - firstBlock : null,
        buys: w.buys, sells: w.sells, hypeIn: r2(w.hIn), hypeOut: r2(w.hOut),
        tokensBought: Math.round(w.tBought), tokensSold: Math.round(w.tSold), tokensRecvP2P: Math.round(w.tRecv), tokensSentP2P: Math.round(w.tSent),
        held: Math.round(w.held), pctSupply: Math.round(w.pctSupply * 1000) / 1000, heldValue: r2(w.heldValue),
        realized: r2(w.realized), pnl: r2(w.pnl), hypeBal: r2(w.hype),
        funder: w.funder, fundedBlock: w.fundedAt, firstFund: r2(w.firstFund), bridged: w.bridged,
        lastAct: w.lastAct, lastActTime: ts(w.lastAct),
      }))
      .sort((a, b) => b.pnl - a.pnl);

    const vol = swaps.reduce((s, x) => s + Math.abs(x.hype), 0);
    report.tokens.push({
      token: T, symbol: symOf[T], name: nameOf[T], decimals: dec, supply,
      venues: [...new Set(swaps.map((s) => s.venue))], pools: tPools.map((p) => ({ id: p.id, launchpad: LAUNCHPADS[p.pm], block: p.block })), v3,
      launchBlock: firstBlock, launchTime: ts(firstBlock), creator,
      priceHype: lastPrice, mcHype: lastPrice ? lastPrice * supply : null,
      swaps: swaps.length, volumeHype: r2(vol), wallets: rows.length,
      hubs, clusters, rows,
    });
    const cols = Object.keys(rows[0] || { wallet: 1 });
    fs.writeFileSync(`${OUT}/${symOf[T] || T}-${T.slice(2, 8)}.csv`, [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n'));
    console.log(`${symOf[T]}: ${rows.length} wallets, ${clusters.length} clusters, vol ${r2(vol)} HYPE`);
  }
  fs.writeFileSync(`${OUT}/swoop.json`, JSON.stringify(report));
  console.log('rpc calls', calls);
}

main().catch((e) => { console.error(e); process.exit(1); });
