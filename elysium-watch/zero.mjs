// LayerZero's Zero going live (mainnet is set for Nov 30, 2026): catch it being wired before the public launch.
// Signals, strongest first, each on its own timer inside the 10 s watcher loop:
//   1. LayerZero's metadata API (what LayerZero's own apps read). It already holds empty "zeroatlas-mainnet" and
//      "zerointerop-mainnet" entries; a deployment (eid + endpoint), chain id, RPC or explorer appearing there means
//      mainnet is wired. Any new chain key with zero or atlas in it is reported too.
//   2. Ethereum's LayerZero EndpointV2: a chain must have default libraries set here before messages can flow.
//      isSupportedEid() over every mainnet eid (30000 to 31999) in two Multicall3 calls; an eid that turns supported
//      is a chain being wired, named from the registry when it is listed there, flagged as unlisted when not.
//   3. docs.layerzero.network/chain: its Testnet / Mainnet status lines, or a chain id / RPC showing up there.
//   4. New TLS certificates on layerzero.network subdomains named zero / atlas / rpc / explorer / scan; each new
//      RPC-looking host is asked eth_chainId.
//   5. New LayerZero-Labs GitHub repos named zero / atlas.
// Every alert fires once. The first run only takes a baseline.

const META = 'https://metadata.layerzero-api.com/v1/metadata/deployments';
const DOCS = 'https://docs.layerzero.network/chain';
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'];
const ENDPOINT = '0x1a44076050125825900e736c501f859c50fe728c'; // LayerZero EndpointV2, Ethereum
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const EID_RANGES = [[30000, 31000], [31000, 32000]];
const ZERO_KEYS = ['zeroatlas-mainnet', 'zerointerop-mainnet'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const now = () => Math.floor(Date.now() / 1000);
const lc = (a) => String(a || '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

async function web(url, { ms = 20000, accept = 'application/json', headers = {} } = {}) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept, ...headers }, signal: AbortSignal.timeout(ms) });
  return { status: r.status, text: await r.text() };
}
async function rpcAt(url, method, params, ms = 15000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
async function ethCall(to, data) {
  let last;
  for (const u of ETH_RPCS) {
    try { return await rpcAt(u, 'eth_call', [{ to, data }, 'latest'], 20000); } catch (e) { last = e; }
  }
  throw last;
}

// Multicall3.aggregate3 over isSupportedEid(eid) for eids [a, b): one eth_call, returns the supported eids
async function supportedEids(a, b) {
  const n = b - a;
  const sel = '6750cd4c'; // isSupportedEid(uint32)
  let body = word(32) + word(n);
  for (let i = 0; i < n; i++) body += word(n * 32 + i * 192);
  for (let i = 0; i < n; i++) body += word(ENDPOINT) + word(1) + word(96) + word(36) + (sel + word(a + i)).padEnd(128, '0');
  const res = String(await ethCall(MULTICALL3, '0x82ad56cb' + body)).slice(2);
  const at = (byte) => BigInt('0x' + res.slice(byte * 2, byte * 2 + 64));
  const arr = Number(at(0));
  const len = Number(at(arr));
  if (len !== n) throw new Error('multicall answered ' + len + ' of ' + n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = arr + 32 + Number(at(arr + 32 + i * 32));
    const ok = at(t) === 1n;
    const dl = Number(at(t + Number(at(t + 32))));
    if (ok && dl >= 32 && at(t + Number(at(t + 32)) + 32) === 1n) out.push(a + i);
  }
  return out;
}

function zeroView(entry) {
  const cd = entry?.chainDetails || {};
  const deps = (entry?.deployments || []).map((d) => ({ eid: d.eid, stage: d.stage, v: d.version, ep: d.endpointV2?.address || d.endpoint?.address || null }));
  const rpcs = [...(entry?.rpcs || []), ...(cd.rpcs || [])].map((r) => (typeof r === 'string' ? r : r?.url)).filter(Boolean);
  const expl = (entry?.blockExplorers || []).map((x) => (typeof x === 'string' ? x : x?.url)).filter(Boolean);
  return { deps, chainId: cd.nativeChainId ?? null, rpcs, expl, status: cd.chainStatus || null };
}
const viewSig = (v) => JSON.stringify([v.deps.map((d) => d.eid + ':' + d.ep), v.chainId, v.rpcs, v.expl]);

async function probeRpc(url) {
  try {
    const [cid, blk] = await Promise.all([rpcAt(url, 'eth_chainId', [], 8000), rpcAt(url, 'eth_blockNumber', [], 8000)]);
    return `chain id ${parseInt(cid, 16)}, block ${parseInt(blk, 16)}`;
  } catch { return null; }
}

export async function zeroWatch({ state, msgs }) {
  const z = (state.zero ||= { next: {}, sent: {} });
  const due = (k, sec) => { if ((z.next[k] || 0) > now()) return false; z.next[k] = now() + sec; return true; };
  const once = (k) => { if (z.sent[k]) return false; z.sent[k] = now(); return true; };
  const tasks = [];

  // 1. LayerZero's registry, every 5 minutes (awaited first, so the eid check below can name what it finds)
  if (due('meta', 300)) await (async () => {
    const r = await web(META, { ms: 30000 });
    if (r.status !== 200) throw new Error('metadata ' + r.status);
    const j = JSON.parse(r.text);
    const keys = Object.keys(j);
    const eidKey = {};
    for (const k of keys) for (const d of j[k].deployments || []) if (d.eid) eidKey[d.eid] = k;
    z.eidKey = eidKey;
    const zk = keys.filter((k) => /zero|atlas/i.test(k));
    if (!z.metaBase) {
      z.metaBase = 1; z.keys = zk; z.views = {};
      for (const k of ZERO_KEYS) z.views[k] = viewSig(zeroView(j[k]));
      if (once('armed')) msgs.push(`🛰 <b>Zero watch armed</b>\nLayerZero's registry already holds empty <code>${ZERO_KEYS.join('</code> and <code>')}</code> entries (no eid, endpoint, chain id or RPC yet). The moment one gets filled, Zero mainnet is being wired. Public launch is set for Nov 30.`);
      return;
    }
    for (const k of zk.filter((x) => !z.keys.includes(x))) {
      const v = zeroView(j[k]);
      if (once('key:' + k)) msgs.push(`🛰 <b>New Zero entry in LayerZero's registry: ${esc(k)}</b>\n${v.deps.length ? v.deps.map((d) => `eid ${d.eid} (${esc(d.stage)}) endpoint <code>${esc(d.ep)}</code>`).join('\n') : 'no deployment yet'}${v.chainId ? `\nchain id ${v.chainId}` : ''}`);
    }
    z.keys = [...new Set([...z.keys, ...zk])];
    for (const k of ZERO_KEYS) {
      const v = zeroView(j[k]);
      const sig = viewSig(v);
      if (sig === z.views[k]) continue;
      z.views[k] = sig;
      const probes = [];
      for (const u of v.rpcs.slice(0, 3)) { const p = await probeRpc(u); probes.push(`<code>${esc(u)}</code>${p ? ` answers: ${p}` : ' not answering yet'}`); }
      if (once('fill:' + k + ':' + sig)) msgs.push(
        `🚨 <b>Zero mainnet is being wired: ${esc(k)} filled in LayerZero's registry</b>\n` +
        (v.deps.length ? v.deps.map((d) => `eid <b>${esc(d.eid)}</b> (${esc(d.stage)}, v${esc(d.v)}) · endpoint <code>${esc(d.ep)}</code>`).join('\n') + '\n' : '') +
        (v.chainId ? `chain id <b>${v.chainId}</b>\n` : '') +
        (probes.length ? `RPC: ${probes.join('\n')}\n` : '') +
        (v.expl.length ? `explorer: ${v.expl.slice(0, 2).map(esc).join(', ')}\n` : '') +
        `Public launch is set for Nov 30; this is the early tell.`);
    }
  })().catch((e) => console.log('zero watch:', e.message));

  // 2. Ethereum's endpoint: newly supported mainnet eids, every 2 minutes
  if (due('eids', 120)) tasks.push((async () => {
    const found = (await Promise.all(EID_RANGES.map(([a, b]) => supportedEids(a, b)))).flat();
    if (found.length < 100) throw new Error('endpoint probe looks wrong: ' + found.length + ' eids');
    if (!z.eids) { z.eids = found; return; }
    const added = found.filter((e) => !z.eids.includes(e));
    z.eids = [...new Set([...z.eids, ...found])];
    for (const e of added) {
      const k = z.eidKey?.[e];
      const isZero = /zero|atlas/i.test(k || '');
      if (!once('eid:' + e)) continue;
      if (isZero) msgs.push(`🚨 <b>Zero is wired into LayerZero on Ethereum</b>\nEthereum's EndpointV2 now supports eid <b>${e}</b> (${esc(k)}). Messages and bridging to Zero can flow from here; public launch is set for Nov 30.`);
      else if (!k) msgs.push(`🛰 <b>LayerZero wired an unlisted chain: eid ${e}</b>\nEthereum's EndpointV2 now supports eid ${e}, and LayerZero's public registry does not name it yet. Could be Zero or another unannounced chain.`);
      // listed, non-Zero chains: ordinary LayerZero expansion, no ping
    }
  })());

  // 3. LayerZero's Zero docs page, every 15 minutes
  if (due('docs', 900)) tasks.push((async () => {
    const r = await web(DOCS, { accept: 'text/html' });
    if (r.status !== 200) return;
    const text = r.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').split('\n').map((s) => s.trim()).filter(Boolean);
    const lines = [];
    text.forEach((s, i) => { if (/^(testnet|mainnet|devnet)$/i.test(s) || /chain ?id|rpc url|block explorer|is live|now live/i.test(s)) lines.push((s + ' ' + (text[i + 1] || '')).slice(0, 160)); });
    const sig = lines.join(' | ');
    if (z.docs == null) { z.docs = sig; return; }
    if (sig !== z.docs && once('docs:' + sig)) {
      msgs.push(`🛰 <b>LayerZero's Zero docs changed</b>\n${lines.slice(0, 6).map((l) => '• ' + esc(l)).join('\n')}\n<a href="${DOCS}">docs.layerzero.network/chain</a>`);
    }
    z.docs = sig;
  })());

  // 4. New certificates on layerzero.network, every 30 minutes; RPC-looking hosts get asked eth_chainId
  if (due('ct', 1800)) tasks.push((async () => {
    let certs = null;
    try {
      const r = await web('https://crt.sh/?q=%25.layerzero.network&output=json', { ms: 40000 });
      if (r.status === 200) certs = JSON.parse(r.text).flatMap((x) => String(x.name_value).split('\n').map((n) => [lc(n).replace(/^\*\./, ''), Date.parse(x.not_before + 'Z')]));
    } catch {}
    if (!certs) {
      const r = await web('https://api.certspotter.com/v1/issuances?domain=layerzero.network&include_subdomains=true&expand=dns_names');
      if (r.status !== 200) return;
      certs = JSON.parse(r.text).flatMap((x) => (x.dns_names || []).map((n) => [lc(n).replace(/^\*\./, ''), Date.parse(x.not_before)]));
    }
    const names = [...new Set(certs.map(([n]) => n))];
    if (!z.ct) { z.ct = names; return; }
    const fresh = new Set(certs.filter(([, t]) => t > Date.now() - 3 * 86400e3).map(([n]) => n));
    const added = names.filter((n) => !z.ct.includes(n) && fresh.has(n) && /zero|atlas|rpc|explorer|scan|mainnet|chain|node/.test(n));
    z.ct = [...new Set([...z.ct, ...names])];
    if (added.length && once('ct:' + added.sort().join(','))) {
      const lines = [];
      for (const n of added.slice(0, 6)) { const p = /rpc|node|chain|mainnet|zero|atlas/.test(n) ? await probeRpc('https://' + n) : null; lines.push(`<code>${esc(n)}</code>${p ? ` · RPC answers: ${p}` : ''}`); }
      msgs.push(`🔐 <b>New LayerZero subdomain certificate</b>\n${lines.join('\n')}\nNew Zero/ATLAS hosts usually go live within days.`);
    }
  })());

  // 5. New LayerZero-Labs repos named zero / atlas, every 30 minutes
  if (due('gh', 1800)) tasks.push((async () => {
    const tok = process.env.GH_API_TOKEN;
    const r = await web('https://api.github.com/orgs/LayerZero-Labs/repos?sort=created&direction=desc&per_page=30', { accept: 'application/vnd.github+json', headers: tok ? { authorization: 'Bearer ' + tok } : {} });
    if (r.status !== 200) return;
    const repos = JSON.parse(r.text).map((x) => ({ n: x.name, u: x.html_url, d: x.description || '' }));
    if (!z.repos) { z.repos = repos.map((x) => x.n); return; }
    const added = repos.filter((x) => !z.repos.includes(x.n));
    z.repos = [...new Set([...z.repos, ...repos.map((x) => x.n)])];
    const hit = added.filter((x) => /zero|atlas/i.test(x.n + ' ' + x.d));
    if (hit.length && once('gh:' + hit.map((x) => x.n).join(','))) msgs.push(`🛰 <b>New LayerZero-Labs repo</b>\n${hit.slice(0, 3).map((x) => `<a href="${x.u}">${esc(x.n)}</a> ${esc(x.d).slice(0, 120)}`).join('\n')}`);
  })());

  const res = await Promise.allSettled(tasks);
  for (const x of res) if (x.status === 'rejected') console.log('zero watch:', x.reason?.message || x.reason);
}
