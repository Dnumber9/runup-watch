// wallet-report: grade every tracked wallet on its Elysium trades over the last REPORT_HOURS and send the
// result to Telegram (CSV + a short summary with ready-to-copy /remove lines for the noisy ones).
// It reads the watcher's saved state (restored from the Actions cache) for auto-found, Cielo and /add wallets.
// Nothing about individual wallets is printed to the (public) Actions log.

import fs from 'node:fs';

const HOURS = Number(process.env.REPORT_HOURS || 48);
const RPCS = (process.env.ELY_RPCS || 'https://rpc-live.elysp.com,https://rpc-live.elyspump.com').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = process.env.WATCH_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WHYPE = new Set(['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81']);
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const lc = (a) => String(a || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const f2 = (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));

let idx = 0;
async function rpc(method, params, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(idx + i) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      idx = (idx + i) % RPCS.length;
      return j.result;
    } catch (e) { last = e; await sleep(500 * (i + 1)); }
  }
  throw new Error(`${method}: ${last?.message}`);
}
// JSON-RPC batch, 50 calls per request, falls back to single calls
async function batch(calls) {
  const out = new Array(calls.length).fill(null);
  for (let s = 0; s < calls.length; s += 50) {
    const part = calls.slice(s, s + 50);
    let ok = false;
    for (let t = 0; t < 3 && !ok; t++) {
      try {
        const url = RPCS[(idx + t) % RPCS.length];
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part.map(([m, p], k) => ({ jsonrpc: '2.0', id: k, method: m, params: p }))), signal: AbortSignal.timeout(30000) });
        const j = await r.json();
        if (!Array.isArray(j)) throw new Error('no batch');
        for (const x of j) out[s + x.id] = x.result ?? null;
        ok = true;
      } catch { await sleep(800); }
    }
    if (!ok) for (let k = 0; k < part.length; k++) out[s + k] = await rpc(part[k][0], part[k][1]).catch(() => null);
  }
  return out;
}
async function logs(filter, from, to, span = 5000) {
  const out = [];
  for (let s = from; s <= to; s += span) {
    const e = Math.min(to, s + span - 1);
    try {
      out.push(...await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16) }], 2));
    } catch (err) {
      if (e - s < 50) throw err;
      const mid = Math.floor((s + e) / 2);
      out.push(...await logs(filter, s, mid, mid - s + 1), ...await logs(filter, mid + 1, e, e - mid));
    }
  }
  return out;
}

async function main() {
  // ── who is tracked ──
  let state = {};
  try { state = JSON.parse(fs.readFileSync(new URL('./state.json', import.meta.url), 'utf8')); } catch { console.log('no saved state found, using the repo list only'); }
  const W = new Map();
  for (const w of JSON.parse(fs.readFileSync(new URL('./wallets.json', import.meta.url), 'utf8'))) {
    if (/^0x[0-9a-fA-F]{40}$/.test(w.address)) W.set(lc(w.address), { label: w.label || short(w.address), group: w.group || '', src: 'list' });
  }
  for (const [a, x] of Object.entries(state.auto || {})) if (!W.has(a)) W.set(a, { label: x.label, group: x.group || '', src: x.from === 'cielo' ? 'cielo' : 'auto' });
  for (const [a, x] of Object.entries(state.manual || {})) W.set(a, { label: x.label, group: x.group || '', src: 'added' });
  for (const a of Object.keys(state.muted || {})) W.delete(a);
  const addrs = [...W.keys()];
  console.log(`wallets: ${addrs.length}`);

  // ── window ──
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const [bh, bp] = await batch([['eth_getBlockByNumber', ['0x' + head.toString(16), false]], ['eth_getBlockByNumber', ['0x' + (head - 20000).toString(16), false]]]);
  const rate = 20000 / Math.max(1, parseInt(bh.timestamp, 16) - parseInt(bp.timestamp, 16)); // blocks per second
  const from = Math.max(1, Math.round(head - HOURS * 3600 * rate));
  console.log(`blocks ${from}..${head} (${(rate * 60).toFixed(0)} per minute)`);

  // ── every token transfer in or out of a tracked wallet ──
  const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
  const seen = new Set();
  const L = [];
  for (let i = 0; i < addrs.length; i += 40) {
    const topics = addrs.slice(i, i + 40).map(pad);
    for (const f of [{ topics: [T_TRANSFER, topics] }, { topics: [T_TRANSFER, null, topics] }]) {
      for (const l of await logs(f, from, head)) {
        if (l.topics.length !== 3) continue;
        const k = l.transactionHash + ':' + l.logIndex;
        if (!seen.has(k)) { seen.add(k); L.push(l); }
      }
    }
  }
  console.log(`transfers: ${L.length}`);

  // ── which counterparties are contracts (pools, routers, launchpads) ──
  const cps = new Set();
  for (const l of L) { cps.add(lc('0x' + l.topics[1].slice(26))); cps.add(lc('0x' + l.topics[2].slice(26))); }
  const cpList = [...cps].filter((a) => !W.has(a) && a !== ZERO && a !== DEAD);
  const codes = await batch(cpList.map((a) => ['eth_getCode', [a, 'latest']]));
  const isContract = new Set(cpList.filter((a, k) => codes[k] && codes[k] !== '0x'));

  // ── per wallet tallies ──
  const S = {};
  const get = (w) => (S[w] ||= { events: 0, buys: 0, sells: 0, received: 0, sent: 0, tokens: new Set(), spamTokens: new Set(), spent: 0, back: 0, buyTx: new Set(), sellTx: new Set(), bought: new Set(), first: Infinity, last: 0 });
  const whypeIn = {}; const whypeOut = {}; // tx|wallet → WHYPE moved
  const tokenOps = {}; // tx|wallet → token received/sent through a contract
  for (const l of L) {
    const t = lc(l.address), f = lc('0x' + l.topics[1].slice(26)), to = lc('0x' + l.topics[2].slice(26));
    const amt = Number(BigInt(l.data === '0x' ? 0 : l.data)) / 1e18;
    const b = parseInt(l.blockNumber, 16);
    for (const [w, dir, cp] of [[to, 'in', f], [f, 'out', to]]) {
      if (!W.has(w)) continue;
      const s = get(w);
      s.first = Math.min(s.first, b); s.last = Math.max(s.last, b);
      if (WHYPE.has(t)) { const k = l.transactionHash + '|' + w; if (dir === 'in') whypeIn[k] = (whypeIn[k] || 0) + amt; else whypeOut[k] = (whypeOut[k] || 0) + amt; continue; }
      s.events++;
      s.tokens.add(t);
      const viaContract = isContract.has(cp);
      if (dir === 'in' && viaContract) { s.buys++; s.buyTx.add(l.transactionHash); s.bought.add(t); }
      else if (dir === 'out' && viaContract) { s.sells++; s.sellTx.add(l.transactionHash); }
      else if (dir === 'in') { s.received++; if (cp !== ZERO) s.spamTokens.add(t); }
      else s.sent++;
      tokenOps[l.transactionHash + '|' + w] = 1;
    }
  }

  // ── HYPE spent on buys: tx value (+ WHYPE paid); HYPE back on sells: WHYPE in + native balance change ──
  const buyList = []; const sellList = [];
  for (const [w, s] of Object.entries(S)) {
    for (const h of [...s.buyTx].slice(0, 400)) buyList.push([w, h]);
    for (const h of [...s.sellTx].filter((h) => !s.buyTx.has(h)).slice(0, 400)) sellList.push([w, h]);
  }
  const btx = await batch(buyList.map(([, h]) => ['eth_getTransactionByHash', [h]]));
  buyList.forEach(([w, h], k) => {
    const tx = btx[k];
    const v = tx && lc(tx.from) === w ? Number(BigInt(tx.value || '0x0')) / 1e18 : 0;
    S[w].spent += v + (whypeOut[h + '|' + w] || 0);
  });
  const rc = await batch(sellList.map(([, h]) => ['eth_getTransactionReceipt', [h]]));
  const balCalls = [];
  sellList.forEach(([w], k) => {
    const b = rc[k] ? parseInt(rc[k].blockNumber, 16) : null;
    balCalls.push(['eth_getBalance', [w, '0x' + (b || head).toString(16)]], ['eth_getBalance', [w, '0x' + ((b || head) - 1).toString(16)]]);
  });
  const bals = await batch(balCalls);
  sellList.forEach(([w, h], k) => {
    const r = rc[k];
    const after = bals[2 * k], before = bals[2 * k + 1];
    let native = 0;
    if (after && before) {
      native = Number(BigInt(after) - BigInt(before)) / 1e18;
      if (r && lc(r.from) === w) native += Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice || '0x0')) / 1e18;
    }
    S[w].back += Math.max(0, native) + (whypeIn[h + '|' + w] || 0);
  });

  // ── value of what they still hold of coins bought in the window (watcher's last price, HYPE per coin) ──
  const holdCalls = [];
  for (const [w, s] of Object.entries(S)) for (const t of s.bought) holdCalls.push([w, t]);
  const hb = await batch(holdCalls.map(([w, t]) => ['eth_call', [{ to: t, data: '0x70a08231' + w.slice(2).padStart(64, '0') }, 'latest']]));
  const held = {};
  holdCalls.forEach(([w, t], k) => {
    const price = state.tok?.[t]?.price;
    const bal = hb[k] && hb[k] !== '0x' ? Number(BigInt(hb[k])) / 1e18 : 0;
    if (price && bal) held[w] = (held[w] || 0) + bal * price;
  });

  // ── grade ──
  const days = HOURS / 24;
  const rows = addrs.map((w) => {
    const m = W.get(w);
    const s = S[w] || { events: 0, buys: 0, sells: 0, received: 0, sent: 0, tokens: new Set(), spamTokens: new Set(), spent: 0, back: 0 };
    const hv = held[w] || 0;
    const net = s.back + hv - s.spent;
    const perDay = s.events / days;
    const trades = s.buys + s.sells;
    let grade, why;
    if (!s.events) { grade = 'dead'; why = 'no trades or transfers'; }
    else if (s.received >= 5 && s.received > 2 * trades) { grade = 'spam'; why = `${s.received} unsolicited token drops`; }
    else if (perDay > 60 || trades / days > 40) { grade = 'bot'; why = `${Math.round(perDay)} moves a day`; }
    else if (trades >= 2 && net >= 1) { grade = 'winner'; why = `+${f2(net)} HYPE`; }
    else if (trades >= 4 && net <= -1) { grade = 'loser'; why = `${f2(net)} HYPE over ${trades} trades`; }
    else { grade = 'ok'; why = `${trades} trades`; }
    const mute = grade === 'spam' || grade === 'bot' || (grade === 'loser' && net <= -5);
    return { w, ...m, grade, why, mute, events: s.events, perDay, buys: s.buys, sells: s.sells, received: s.received, sent: s.sent, tokens: s.tokens.size, spent: s.spent, back: s.back, held: hv, net };
  });
  const order = { bot: 0, spam: 1, loser: 2, dead: 3, ok: 4, winner: 5 };
  rows.sort((a, b) => order[a.grade] - order[b.grade] || b.events - a.events || b.net - a.net);
  const counts = {};
  for (const r of rows) counts[r.grade] = (counts[r.grade] || 0) + 1;
  console.log('grades', JSON.stringify(counts)); // counts only: no wallets in the public log

  // ── CSV ──
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const csv = ['grade,mute,label,group,source,address,moves,moves_per_day,buys,sells,unsolicited_drops,transfers_out,coins,hype_spent,hype_back,hype_still_held,net_hype,reason']
    .concat(rows.map((r) => [r.grade, r.mute ? 'yes' : '', r.label, r.group, r.src, r.w, r.events, r.perDay.toFixed(1), r.buys, r.sells, r.received, r.sent, r.tokens, f2(r.spent), f2(r.back), f2(r.held), f2(r.net), r.why].map(q).join(',')))
    .join('\n');
  fs.writeFileSync('wallet-report.csv', csv);

  // ── Telegram ──
  const chat = state.cmdChat || process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !chat) { console.log('no Telegram settings, report written to wallet-report.csv only'); return; }
  const send = (text) => fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }) }).then((r) => r.json());
  const winners = rows.filter((r) => r.grade === 'winner').sort((a, b) => b.net - a.net).slice(0, 10);
  const noisy = rows.filter((r) => r.mute);
  const line = (r) => `• <b>${esc(r.label)}</b> ${r.group ? `[${esc(r.group)}] ` : ''}${esc(r.why)}`;
  let msg = `📊 <b>Tracked wallets, last ${HOURS}h</b> (${rows.length} wallets)\n` +
    Object.entries(counts).map(([g, n]) => `${g}: ${n}`).join(' · ') + '\n\n' +
    (winners.length ? `🏆 <b>Best</b>\n${winners.map(line).join('\n')}\n\n` : '') +
    (noisy.length ? `🔇 <b>Noisy or losing (${noisy.length})</b>\n${noisy.slice(0, 25).map(line).join('\n')}${noisy.length > 25 ? `\n…and ${noisy.length - 25} more in the file` : ''}` : 'Nothing noisy.');
  for (let i = 0; i < msg.length; i += 3900) await send(msg.slice(i, i + 3900));
  if (noisy.length) {
    for (let i = 0; i < noisy.length; i += 80) {
      await send(`To mute ${i ? 'the next ' : ''}${Math.min(80, noisy.length - i)}, tap the block to copy it and send it to me as one message:\n<code>/remove ${noisy.slice(i, i + 80).map((r) => r.w).join(' ')}</code>`);
    }
  }
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('caption', `Full grades for all ${rows.length} tracked wallets (last ${HOURS}h). Net = HYPE back + value still held − HYPE spent, inside the window only.`);
  fd.append('document', new Blob([csv], { type: 'text/csv' }), `tracked-wallets-${HOURS}h.csv`);
  const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
  console.log('telegram file sent:', r.ok);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
