// runup-watch: pings Telegram when the RUNUP $RUNNER market leaves maintenance,
// and flags any other admin action on it (re-pause, upgrade, pending Safe approvals).
//
// Source of truth is on-chain: the 2-of-2 admin Safe flips maintenance by calling
// setMaintenance(bool) on the market. We read the Safe's transactions from Blockscout
// and decode each execTransaction ourselves (no reliance on Blockscout's ABI decoding).

import fs from 'node:fs';

const API = 'https://blockscout.injective.network/api/v2';
const EXPLORER = 'https://blockscout.injective.network';
const SAFE = '0xF0A84E55b4D76CD33127c13BdE38664ABa96ae2B'.toLowerCase();
const MARKET = '0x8399aF15A225314d7bE75BEeBf1E83D001380074'.toLowerCase();
const COIN_URL = 'https://runup.fun/coin/0x8399aF15A225314d7bE75BEeBf1E83D001380074';

const SEL_EXEC = '0x6a761202';      // Safe execTransaction(...)
const SEL_APPROVE_HASH = '0xd4d9bdcd'; // Safe approveHash(bytes32)
const SEL_MAINT = '0x612f2f37';     // setMaintenance(bool), matched against the 16:16 UTC Oct 1 tx
const SEL_UPGRADE = '0x4f1ef286';   // upgradeToAndCall(address,bytes)

const STATE = new URL('./seen.json', import.meta.url);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txLink = (h) => `${EXPLORER}/tx/${h}`;

async function get(path) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + path, { headers: { accept: 'application/json' } });
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${path} -> gave up after retries`);
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[no telegram creds]\n' + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram HTTP ${r.status}: ${await r.text()}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}

// Decode the inner call of a Safe execTransaction from raw calldata.
// execTransaction(address to, uint256 value, bytes data, uint8 operation, ...)
function innerCall(raw) {
  const h = raw.slice(10);
  const word = (i) => h.slice(i * 64, i * 64 + 64);
  const to = ('0x' + word(0).slice(24)).toLowerCase();
  const off = parseInt(word(2), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  const data = ('0x' + h.slice(off + 64, off + 64 + len)).toLowerCase();
  return { to, data };
}

function classify(tx) {
  const raw = String(tx.raw_input || '').toLowerCase();
  if (raw.startsWith(SEL_APPROVE_HASH)) return { kind: 'pending' };
  if (!raw.startsWith(SEL_EXEC)) return { kind: 'other', method: tx.method || raw.slice(0, 10) || 'transfer' };
  const { to, data } = innerCall(raw);
  if (to === MARKET && data.startsWith(SEL_MAINT)) {
    const on = BigInt('0x' + (data.slice(10, 74) || '0')) !== 0n;
    return { kind: on ? 'maint_on' : 'maint_off' };
  }
  if (to === MARKET && data.startsWith(SEL_UPGRADE)) {
    return { kind: 'upgrade', impl: '0x' + data.slice(34, 74) };
  }
  return { kind: 'exec', to, sel: data.slice(0, 10) || '(no data)' };
}

function message(c, hash, when) {
  const tx = `<a href="${txLink(hash)}">tx</a>`;
  switch (c.kind) {
    case 'maint_off':
      return `🟢 <b>RUNUP $RUNNER is back up</b>\nMaintenance switched OFF at ${when}.\nThe public curve can open now and may fill within seconds.\n<a href="${COIN_URL}">Open coin</a> · ${tx}`;
    case 'maint_on':
      return `🔴 <b>RUNUP $RUNNER market put into maintenance</b> at ${when}.\n${tx}`;
    case 'upgrade':
      return `⚠️ <b>RUNUP market contract UPGRADED</b> at ${when}\nNew implementation: <code>${c.impl}</code>\nRe-check before trading. ${tx}`;
    case 'pending':
      return `🟡 One Safe signer approved a pending admin action at ${when}. An execution (unpause, upgrade, or other) may follow shortly. ${tx}`;
    case 'exec':
      return `ℹ️ RUNUP admin Safe executed a call at ${when}\nTarget: <code>${c.to}</code>\nSelector: <code>${c.sel}</code>\n${tx}`;
    default:
      return `ℹ️ RUNUP admin Safe activity (${c.method}) at ${when}. ${tx}`;
  }
}

async function main() {
  const list = await get(`/addresses/${SAFE}/transactions`);
  const items = list.items || [];

  let state = loadState();
  const firstRun = !state;
  state ||= { seen: [], maintenance: true, lastChange: null };
  const seen = new Set(state.seen);

  const fresh = items.filter((t) => !seen.has(t.hash)).reverse(); // oldest first
  const alerts = [];

  for (const t of fresh) {
    const tx = await get(`/transactions/${t.hash}`);
    seen.add(t.hash);
    if (tx.status === 'error') continue; // reverted, nothing changed on-chain

    const c = classify(tx);
    const when = String(tx.timestamp || '').replace('T', ' ').slice(0, 16) + ' UTC';

    if (c.kind === 'maint_on' || c.kind === 'maint_off') {
      state.maintenance = c.kind === 'maint_on';
      state.lastChange = { hash: t.hash, when };
    }
    if (!firstRun) alerts.push(message(c, t.hash, when));
  }

  state.seen = [...seen].slice(-500);
  saveState(state);

  if (firstRun) {
    const status = state.maintenance ? '🔴 in maintenance' : '🟢 open';
    const since = state.lastChange ? ` since ${state.lastChange.when}` : '';
    await tg(`👀 <b>runup-watch armed</b>\n$RUNNER market is ${status}${since}.\nYou'll get a ping when that changes or the admin Safe does anything else.`);
    return;
  }
  for (const a of alerts) await tg(a);
  console.log(`checked ${items.length} txs, ${fresh.length} new, maintenance=${state.maintenance}`);
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
