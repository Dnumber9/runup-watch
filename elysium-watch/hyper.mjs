// Launches on Hyperliquid's two halves by the deployers we follow (meme runner devs from HyperCore, HyperEVM and
// Elysium, and the wallets that funded several of them: wallets.json entries with "watch": "launch"). Each check
// runs on its own timer inside the 10 s watcher loop:
//   1. HyperCore (HIP-1), every 2 min: the spot token list. A token never seen before is posted with its deployer
//      (tokenDetails). Deploys are rare (one gas auction about every 31 h), so every new token is posted, and one
//      deployed by any tracked wallet leads with that wallet's name.
//   2. HyperEVM, every 5 min: the nonce of each launch-watched wallet. When it moved, the CREATE addresses of the
//      new nonces are checked for code: a contract that wallet just deployed, named when it is a token.
// The first run only takes a baseline, so nothing old is posted.
import { createAddress } from './gate.mjs';

const HL = 'https://api.hyperliquid.xyz/info';
const HC_EVERY = 120, EVM_EVERY = 300;
const now = () => Math.floor(Date.now() / 1000);
const lc = (a) => String(a || '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '?');
const num = (x) => { const n = Number(x); return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)); };
const coreAddr = (a) => `<a href="https://app.hyperliquid.xyz/explorer/address/${a}">${short(a)}</a>`;

async function hl(body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 3000)); continue; }
    if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
    return r.json();
  }
  throw new Error('hyperliquid rate limited');
}
// ABI string (or bytes32) from an eth_call result
function str(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (!h) return '';
  const utf = (x) => Buffer.from(x, 'hex').toString('utf8').replace(/\0/g, '').trim();
  try {
    if (h.length >= 128) { const o = Number(BigInt('0x' + h.slice(0, 64))) * 2, n = Number(BigInt('0x' + h.slice(o, o + 64))); return utf(h.slice(o + 64, o + 64 + n * 2)); }
    return utf(h.slice(0, 64));
  } catch { return ''; }
}

// 1. new HIP-1 tokens
async function coreTokens(H, msgs, W) {
  const meta = await hl({ type: 'spotMeta' });
  const list = meta?.tokens || [];
  if (!list.length) return;
  const known = new Set(H.tokens || []);
  H.tokens = list.map((x) => x.index);
  if (!known.size) return; // first run: baseline only
  for (const tk of list.filter((x) => !known.has(x.index)).slice(0, 8)) {
    let d = null;
    try { d = await hl({ type: 'tokenDetails', tokenId: tk.tokenId }); } catch {}
    const dep = lc(d?.deployer);
    const who = dep && W.has(dep) ? W.get(dep) : null;
    const head = who ? `🚨🟣 <b>${esc(who)}</b> deployed a new HyperCore token` : '🟣 <b>New HyperCore token</b>';
    const supply = d?.maxSupply ? `Max supply ${num(d.maxSupply)}${Number(d.seededUsdc) > 0 ? ` · seeded ${num(d.seededUsdc)} USDC` : ''}\n` : '';
    msgs.push(
      `${head}: <b>${esc(tk.name)}</b>${tk.fullName ? ` (${esc(tk.fullName)})` : ''}\n` +
      (dep ? `Deployer ${coreAddr(dep)}${who ? '' : ' (not tracked)'}\n` : '') + supply +
      `<a href="https://app.hyperliquid.xyz/explorer/token/${tk.tokenId}">token</a>${tk.evmContract?.address ? ` · linked to HyperEVM <code>${lc(tk.evmContract.address)}</code>` : ''}`
    );
  }
}

// 2. contracts deployed on HyperEVM by launch-watched wallets
async function evmDeploys(H, msgs, W, DEVW, hrpc) {
  for (const a of [...DEVW.keys()].slice(0, 200)) {
    let n;
    try { n = parseInt(await hrpc('eth_getTransactionCount', [a, 'latest']), 16); } catch { continue; }
    if (!Number.isFinite(n)) continue;
    const prev = H.nonces[a];
    H.nonces[a] = n;
    if (prev == null || n <= prev) continue; // first sight is the baseline
    for (let k = prev; k < Math.min(n, prev + 6); k++) {
      const c = createAddress(a, k);
      let code = '0x';
      try { code = await hrpc('eth_getCode', [c, 'latest']); } catch {}
      if (!code || code === '0x') continue;
      const [sym, name] = await Promise.all(['0x95d89b41', '0x06fdde03'].map((data) => hrpc('eth_call', [{ to: c, data }, 'latest']).then(str).catch(() => '')));
      msgs.push(
        `🚨🟢 <b>${esc(W.get(a) || short(a))}</b> deployed a contract on HyperEVM${sym ? `: token <b>${esc(sym)}</b>${name ? ` (${esc(name)})` : ''}` : ''}\n` +
        `<code>${c}</code> · <a href="https://hyperevmscan.io/address/${c}">hyperevmscan</a>`
      );
    }
  }
}

export async function hyperWatch({ state, msgs, W, DEVW, hrpc }) {
  const H = (state.hyper ||= { tokens: null, nonces: {}, at: {} });
  const t = now();
  if (t - (H.at.core || 0) >= HC_EVERY) { H.at.core = t; try { await coreTokens(H, msgs, W); } catch (e) { console.log('hyper core:', e.message); } }
  if (DEVW.size && t - (H.at.evm || 0) >= EVM_EVERY) { H.at.evm = t; try { await evmDeploys(H, msgs, W, DEVW, hrpc); } catch (e) { console.log('hyper evm:', e.message); } }
}
