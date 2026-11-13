// zero-watch: LayerZero's Zero ahead of its Nov 30, 2026 mainnet, in its own job (one check every 2 minutes).
//
// The Elysium tracker's zero.mjs already watches LayerZero's registry (an eid, chain id or RPC appearing), Ethereum's
// endpoint, the docs page, new certificates and new repos. This job adds what that one does not see:
//   1. Hosts. Every *.zero.layerzero.network name from the certificate logs, plus the mainnet names they imply
//      (rpc.testnet.zero… implies rpc.mainnet.zero… and rpc.zero…), is asked what it is: no DNS, down, a web page
//      (401/403 = gated) or an RPC answering eth_chainId. A ping goes out when an RPC answers, when a gated page
//      opens (the explorer, the testnet) and when a guessed mainnet name starts to exist.
//   2. LayerZero Scan. Messages into and out of Zero's chains are public there even while the RPC is private, so the
//      first apps wired to Zero and the first wallets bridging in show up here first.
//   3. The registry's long form: tokens, DVNs and named apps listed for Zero's chains (the short form the tracker
//      reads does not carry them), and any change to the testnet entries.
// The first run only takes a baseline and says what it found. Every alert fires once. State: zero-watch/state.json.

import fs from 'node:fs';
import dnsp from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

// ── config ──
const ROOT = 'zero.layerzero.network';
const META = 'https://metadata.layerzero-api.com/v1/metadata';
const SCAN = {
  testnet: { api: 'https://scan-testnet.layerzero-api.com/v1', site: 'https://testnet.layerzeroscan.com' },
  mainnet: { api: 'https://scan.layerzero-api.com/v1', site: 'https://layerzeroscan.com' },
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const HOSTS_EVERY = 110;      // seconds between host rounds (every tick)
const SCAN_EVERY = 110;
const META_EVERY = 600;       // the long registry is 4.6 MB
const CT_EVERY = 1800;        // certificate logs: free lookups are rationed per IP
const SCAN_PAGES = 4;         // pages of 150 newest messages read per tick at most
const APP_ALERTS_PER_TICK = 4;
const APP_ALERTS_PER_HOUR = 12;
const EARLY_HOURS = 72;       // after the first mainnet message: hourly list of new wallets bridging in

// names seen in the certificate logs by Nov 13, 2026 (the job works even when the logs cannot be read)
const KNOWN_HOSTS = [
  'testnet', 'rpc.testnet', 'archive.testnet', 'explorer.testnet', 'faucet.testnet', 'dashboard.testnet',
  'store.testnet', 'store-api.testnet', 'exoware.testnet', 'dtcc-demo.testnet', 'monitor.beacon.testnet',
  'og.testnet.prover', 'ops.testnet.prover', 'og.devnet.prover', 'ops.devnet.prover',
  'partnernet', 'rpc.partnernet', 'archive.partnernet', 'store.partnernet', 'store-api.partnernet',
  'explorer', 'og.mainnet.prover', 'ops.mainnet.prover',
].map((h) => `${h}.${ROOT}`);
// names nothing implies yet, worth asking anyway
const EXTRA_GUESSES = ['app', 'bridge', 'stake', 'staking', 'atlas', 'scan', 'api', 'portal', 'docs', 'rpc.atlas', 'rpc.interop'].map((h) => `${h}.${ROOT}`);
const ENVS = ['testnet', 'partnernet', 'devnet'];
const KNOWN_EIDS = [40003, 43002]; // zeroatlas-testnet, zerointerop-testnet
// apps already on Zero's side of the testnet on Nov 13, 2026 (LayerZero's own test contracts)
const KNOWN_APPS = ['testnet|0x1ced7d571059a30db0fc9adc40346d2a1ce55b31', 'testnet|0x610178da211fef7d417bc0e6fed39f05609ad788'];
const ZERO_KEY = /^zero(atlas|interop)/i; // used until the registry has been read once

const lc = (a) => String(a || '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (a) => [...new Set(a)];
const envOf = (h) => ENVS.find((e) => h.split('.').includes(e)) || 'mainnet';
const zoneOf = (k) => (/atlas/i.test(k || '') ? 'atlas zone' : /interop/i.test(k || '') ? 'interop zone' : String(k || 'zone not named yet'));
const clip = (t, n = 3900) => (t.length <= n ? t : t.slice(0, t.lastIndexOf('\n', n)) + '\n…'); // never cuts inside a tag
const ago = (t, now) => { const m = Math.round((now - t) / 60); return m < 30 ? '' : m < 120 ? ` (${m} min ago)` : m < 2880 ? ` (${Math.round(m / 60)} h ago)` : ` (${Math.round(m / 1440)} days ago)`; };
const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// the mainnet names a testnet name implies: the label swapped for "mainnet", and the label dropped
function implied(names) {
  const out = new Set(EXTRA_GUESSES);
  for (const n of names) {
    const labels = n.split('.');
    const i = labels.findIndex((l) => ENVS.includes(l));
    if (i < 0) continue;
    out.add(labels.map((l, k) => (k === i ? 'mainnet' : l)).join('.'));
    out.add(labels.filter((_, k) => k !== i).join('.'));
  }
  return [...out].filter((h) => h.endsWith(ROOT));
}

async function getJson(io, url, ms = 20000) {
  const r = await io.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── 1. hosts ──
// what a host is right now: 'nodns', 'down', 'http <status>' (plus ' gate' for a 200 that is a login or holding page)
// or 'rpc <chain id>'. null = could not tell this round (a DNS hiccup), keep the last answer.
async function askRpc(io, url) {
  try {
    const ask = async (method) => {
      const r = await io.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const v = (await r.json())?.result;
      return /^0x[0-9a-f]+$/i.test(String(v)) ? parseInt(v, 16) : null;
    };
    const id = await ask('eth_chainId');
    if (id == null) return null;
    return { id, block: await ask('eth_blockNumber').catch(() => null) };
  } catch { return null; }
}
async function probe(io, host) {
  try { await timed(io.lookup(host), 5000); } catch (e) {
    return /ENOTFOUND|ENODATA|NXDOMAIN/i.test(String(e?.code || e?.message)) ? { s: 'nodns' } : null;
  }
  const page = (async () => {
    try {
      const r = await io.fetch(`https://${host}/`, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(8000) });
      let title = '';
      if (r.status === 200) title = ((await r.text()).match(/<title[^>]*>([^<]{0,80})/i)?.[1] || '').trim();
      return { status: r.status, title };
    } catch { return null; }
  })();
  const [p, r] = await Promise.all([page, askRpc(io, `https://${host}/`)]);
  if (r) return { s: 'rpc ' + r.id, block: r.block };
  if (!p) return { s: 'down' };
  const gate = p.status === 200 && /protected|checkpoint|coming soon|forbidden|sign in|log ?in|password|access denied/i.test(p.title);
  return { s: 'http ' + p.status + (gate ? ' gate' : ''), title: p.title };
}

const isRpc = (s) => /^rpc /.test(s || '');
const isOpen = (s) => s === 'http 200';
const isUp = (s) => !!s && s !== 'nodns' && s !== 'down';
const say = (s) => (s == null ? 'not seen before' : s === 'nodns' ? 'no DNS' : s === 'down' ? 'not answering' : /^http (401|403)/.test(s) || / gate$/.test(s) ? `gated (${s.replace('http ', '').replace(' gate', '')})` : s.replace('http ', 'HTTP '));

async function hosts(io, z, msgs, base) {
  const names = uniq([...KNOWN_HOSTS, ...(z.ct || [])]);
  const list = uniq([...names, ...implied(names), ...Object.keys(z.regEnv || {})]);
  const envOfHost = (h) => z.regEnv?.[h] || envOf(h);
  z.hosts ||= {};
  const found = {};
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < list.length) { const h = list[next++]; found[h] = await probe(io, h).catch(() => null); }
  }));
  const lines = { hot: [], warm: [] };
  for (const h of list) {
    const got = found[h];
    if (!got) continue;
    const rec = (z.hosts[h] ||= { s: null, p: null, c: 0, up: false });
    const first = rec.s == null;
    // a change counts once it has been seen twice in a row (an RPC answering counts at once)
    let change = null;
    if (got.s === rec.s) { rec.p = null; rec.c = 0; }
    else {
      if (rec.p === got.s) rec.c++; else { rec.p = got.s; rec.c = 1; }
      if (first || rec.c >= 2 || isRpc(got.s)) { change = { from: rec.s, to: got.s }; rec.s = got.s; rec.p = null; rec.c = 0; }
    }
    const wasUp = rec.up;
    rec.up ||= isUp(rec.s);
    if (!change || base) continue;
    const env = envOfHost(h);
    const tag = `<code>${esc(h)}</code>`;
    if (isRpc(change.to) && !isRpc(change.from)) {
      const id = change.to.slice(4);
      (env === 'mainnet' ? lines.hot : lines.warm).push(env === 'mainnet'
        ? `🚨 <b>A Zero mainnet RPC is answering</b>\n${tag} · chain id <b>${esc(id)}</b>${got.block != null ? ` · block ${got.block}` : ''}\nBefore: ${say(change.from)}. Gas is ZRO. Public launch is set for Nov 30.`
        : `🛰 <b>Zero ${env} RPC is open to the public</b>\n${tag} · chain id <b>${esc(id)}</b>${got.block != null ? ` · block ${got.block}` : ''}\nBefore: ${say(change.from)}.`);
    } else if (isOpen(change.to) && !isOpen(change.from)) {
      const what = /^explorer\./.test(h) ? 'explorer' : /^faucet\./.test(h) ? 'faucet' : /^dashboard\./.test(h) ? 'dashboard' : /^(app|bridge|stake|staking|portal)\./.test(h) ? h.split('.')[0] + ' page' : 'host';
      (env === 'mainnet' ? lines.hot : lines.warm).push(
        `${env === 'mainnet' ? '🚨' : '🛰'} <b>Zero ${env} ${what} is open</b>\n<a href="https://${esc(h)}/">${esc(h)}</a>${got.title ? ` · "${esc(got.title)}"` : ''}\nBefore: ${say(change.from)}.`);
    } else if (env === 'mainnet' && isUp(change.to) && !wasUp && !first) {
      lines.warm.push(`🛰 <b>New Zero mainnet host is up</b>\n${tag} now exists: ${say(change.to)}. It did not exist before.`);
    }
  }
  // RPC addresses the registry lists with a path (the host round above only asks the root of a host)
  z.rpcUrls ||= {};
  for (const [url, env] of Object.entries(z.regRpc || {}).slice(0, 8)) {
    const rec = (z.rpcUrls[url] ||= { ok: false });
    if (rec.ok) continue;
    const r = await askRpc(io, url);
    if (!r) continue;
    rec.ok = true;
    if (!base) lines.hot.push(`${env === 'mainnet' ? '🚨' : '🛰'} <b>The Zero ${esc(env)} RPC in LayerZero's registry is answering</b>\n<code>${esc(url)}</code> · chain id <b>${r.id}</b>${r.block != null ? ` · block ${r.block}` : ''}`);
  }
  for (const m of lines.hot) msgs.push(m);
  if (lines.warm.length <= 3) msgs.push(...lines.warm);
  else msgs.push(clip(lines.warm.map((m) => m.replace(/\n/g, ' · ')).join('\n')));
  const by = (f) => list.filter((h) => f(z.hosts[h]?.s)).length;
  return `hosts ${list.length} (rpc ${by(isRpc)}, open ${by(isOpen)}, gated/other ${by((s) => isUp(s) && !isRpc(s) && !isOpen(s))}, down ${by((s) => s === 'down')}, no dns ${by((s) => s === 'nodns')})`;
}

// names from the certificate logs: crt.sh first (no ration, often slow), then Cert Spotter
async function certs(io, z) {
  let names = null;
  try {
    const j = await getJson(io, `https://crt.sh/?q=%25.${ROOT}&output=json`, 20000);
    names = j.flatMap((x) => String(x.name_value).split('\n'));
  } catch {}
  if (!names) {
    try {
      const j = await getJson(io, `https://api.certspotter.com/v1/issuances?domain=${ROOT}&include_subdomains=true&expand=dns_names`, 20000);
      names = j.flatMap((x) => x.dns_names || []);
    } catch (e) { console.log('certificate logs not readable:', e.message); return; }
  }
  const clean = uniq(names.map((n) => lc(n).replace(/^\*\./, '')).filter((n) => n.endsWith(ROOT) && /^[a-z0-9.-]+$/.test(n)));
  z.ct = uniq([...(z.ct || []), ...clean]).slice(-400);
}

// ── 3. the registry's long form ──
let metaCache = null;
const getMeta = (io) => (metaCache ||= getJson(io, META, 40000).catch((e) => { metaCache = null; throw e; }));

function factsOf(e) {
  const f = [];
  for (const [a, t] of Object.entries(e.tokens || {})) f.push(`token ${t.symbol || '?'} ${a}${t.peggedTo ? ` = ${t.peggedTo.symbol || ''} on ${t.peggedTo.chainName || '?'}` : ''}`);
  for (const [a, d] of Object.entries(e.dvns || {})) f.push(`dvn ${d.canonicalName || d.id || '?'} ${a}`);
  for (const [a, o] of Object.entries(e.addressToOApp || {})) f.push(`app ${o.canonicalName || o.id || '?'} ${a}`);
  for (const k of Object.keys(e.dexContracts || {})) f.push(`dex ${k}`);
  for (const k of Object.keys(e.composers || {})) f.push(`composer ${k}`);
  for (const r of e.rpcs || []) f.push(`rpc ${typeof r === 'string' ? r : r?.url}`);
  for (const x of e.blockExplorers || []) f.push(`explorer ${typeof x === 'string' ? x : x?.url}`);
  for (const d of e.deployments || []) f.push(`eid ${d.eid} endpoint ${d.endpointV2?.address || d.endpoint?.address || '?'}`);
  if (e.chainDetails?.nativeChainId != null) f.push(`chain id ${e.chainDetails.nativeChainId}`);
  return f;
}

async function registry(io, z, msgs, base) {
  const j = await getMeta(io);
  // LayerZero's Zero only: its chains pay gas in ZRO (another project's "zero" chain would not)
  const keys = Object.keys(j).filter((k) => ZERO_KEY.test(k) || (/^zero/i.test(k) && j[k]?.chainDetails?.nativeCurrency?.symbol === 'ZRO'));
  z.facts ||= {};
  const eids = new Set(KNOWN_EIDS), chainKeys = { testnet: new Set(), mainnet: new Set() }, regEnv = {}, regRpc = {}, eidKey = {};
  for (const k of keys) {
    const e = j[k];
    const env = /testnet/i.test(k) || e.environment === 'testnet' ? 'testnet' : 'mainnet';
    for (const name of [k, e.chainKey, e.chainDetails?.chainKey]) if (name) { chainKeys[env].add(name); chainKeys[env].add(name.replace(/-custom$/, '')); }
    for (const d of e.deployments || []) if (Number(d.eid)) { eids.add(Number(d.eid)); eidKey[Number(d.eid)] = k; }
    for (const u of [...(e.rpcs || []), ...(e.blockExplorers || [])]) { try { regEnv[new URL(typeof u === 'string' ? u : u.url).hostname] = env; } catch {} }
    for (const u of e.rpcs || []) { try { const x = new URL(typeof u === 'string' ? u : u.url); if (x.pathname.length > 1 || x.search) regRpc[x.href] = env; } catch {} }
    const facts = factsOf(e);
    const prev = z.facts[k];
    z.facts[k] = uniq([...(prev || []), ...facts]).slice(-600);
    if (!prev || base) continue;
    // the tracker's zero.mjs already pings an eid, chain id, RPC or explorer filling in on the mainnet entries
    const added = facts.filter((f) => !prev.includes(f) && !(env === 'mainnet' && /^(eid|chain id|rpc|explorer) /.test(f)));
    if (!added.length) continue;
    const hot = env === 'mainnet' && added.some((f) => /^(token|app) /.test(f));
    msgs.push(`${hot ? '🚨' : '🛰'} <b>LayerZero's registry: new on ${esc(k)}</b>\n${added.slice(0, 12).map((f) => '• ' + esc(f)).join('\n')}${added.length > 12 ? `\n+${added.length - 12} more` : ''}`);
  }
  z.eids = [...eids];
  z.chainKeys = { testnet: [...chainKeys.testnet], mainnet: [...chainKeys.mainnet] };
  z.regEnv = regEnv; z.regRpc = regRpc; z.eidKey = eidKey;
  return `registry ${keys.length} zero entries, ${Object.values(z.facts).reduce((n, f) => n + f.length, 0)} facts`;
}

// a name for an app or token address on a listed chain, when the registry has one
async function nameOf(io, chain, addr) {
  try {
    const e = (await getMeta(io))[chain];
    if (!e) return '';
    const app = e.addressToOApp?.[addr]?.canonicalName;
    if (app) return app;
    for (const [a, t] of Object.entries(e.tokens || {})) if (a === addr || (t.proxyAddresses || []).map(lc).includes(addr)) return t.symbol || t.name || '';
  } catch {}
  return '';
}

// ── 2. LayerZero Scan ──
const fromApi = (m) => ({
  id: `${m.pathway?.id}-${m.pathway?.nonce}`,
  srcChain: m.pathway?.sender?.chain || '', dstChain: m.pathway?.receiver?.chain || '',
  srcEid: Number(m.pathway?.srcEid), dstEid: Number(m.pathway?.dstEid),
  srcApp: lc(m.pathway?.sender?.address), dstApp: lc(m.pathway?.receiver?.address),
  from: lc(m.source?.tx?.from), t: Math.floor(Date.parse(m.created) / 1000) || Number(m.source?.tx?.blockTimestamp) || 0, tx: m.source?.tx?.txHash || '',
});
const fromSite = (m) => ({
  id: m.id, srcChain: m.srcChainKey || '', dstChain: m.dstChainKey || '', srcEid: Number(m.srcChainId), dstEid: Number(m.dstChainId),
  srcApp: lc(m.srcUaAddress), dstApp: lc(m.dstUaAddress), from: lc(m.from), t: Number(m.created) || 0, tx: m.srcTxHash || '',
});

// the newest messages of every chain from the public API (no filter by chain there), read back to the last tick
async function scanLatest(io, z, env) {
  const since = (z.scanTs?.[env] || 0) - 900;
  const out = [];
  let token = null;
  for (let p = 0; p < (z.scanTs?.[env] ? SCAN_PAGES : 1); p++) {
    const j = await getJson(io, `${SCAN[env].api}/messages/latest?limit=150${token ? '&nextToken=' + encodeURIComponent(token) : ''}`, 20000);
    const rows = (j?.data || []).map(fromApi);
    out.push(...rows);
    token = j?.nextToken;
    if (!token || !rows.length || rows[rows.length - 1].t < since) break;
  }
  return out;
}
// Zero's own history from the Scan site, which can filter by chain. A server may get a bot check instead: then [].
async function scanSite(io, z, env) {
  const keys = z.chainKeys?.[env] || [];
  if (!keys.length) return [];
  const got = await Promise.all(['dstChainKey', 'srcChainKey'].map(async (side) => {
    try {
      const j = await getJson(io, `${SCAN[env].site}/api/trpc/messages.list?input=${encodeURIComponent(JSON.stringify({ filters: { [side]: keys, stage: env } }))}`, 15000);
      return (j?.result?.data?.messages || j?.result?.data?.entries || []).map(fromSite);
    } catch { return []; }
  }));
  return got.flat();
}

async function scan(io, z, msgs, base, withSite) {
  z.apps ||= Object.fromEntries(KNOWN_APPS.map((k) => [k, { t: 0, n: 0, chain: 'zerointerop-testnet' }]));
  z.senders ||= {}; z.seen ||= []; z.scanTs ||= {}; z.scanBase ||= {}; z.msgN ||= {}; z.sent ||= []; z.backlog ||= []; z.early ||= { first: 0, last: 0, queue: [] };
  const seen = new Set(z.seen);
  const zeroKeys = new Set([...(z.chainKeys?.testnet || []), ...(z.chainKeys?.mainnet || [])]);
  const zero = (chain, eid) => zeroKeys.has(chain) || ZERO_KEY.test(chain) || (z.eids || KNOWN_EIDS).includes(eid);
  const fresh = [];
  const notes = [];
  const reads = await Promise.all(['testnet', 'mainnet'].map((env) => Promise.allSettled([scanLatest(io, z, env), withSite ? scanSite(io, z, env) : []])));
  for (const env of ['testnet', 'mainnet']) {
    let rows = [];
    const [a, b] = reads[env === 'testnet' ? 0 : 1];
    const quiet = base || !z.scanBase[env]; // the first good read of a network only sets its baseline
    if (a.status === 'fulfilled') z.scanBase[env] = true;
    if (a.status === 'fulfilled') { rows.push(...a.value); if (a.value.length) z.scanTs[env] = Math.max(z.scanTs[env] || 0, ...a.value.map((m) => m.t)); }
    else notes.push(`${env} api failed (${a.reason?.message})`);
    if (b.status === 'fulfilled') rows.push(...b.value);
    rows = rows.filter((m) => m.id && (zero(m.srcChain, m.srcEid) || zero(m.dstChain, m.dstEid))).sort((x, y) => x.t - y.t);
    for (const m of rows) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      z.msgN[env] = (z.msgN[env] || 0) + 1;
      const into = zero(m.dstChain, m.dstEid);
      const nm = (chain, eid) => chain || z.eidKey?.[eid] || 'eid ' + eid;
      const side = into ? { chain: nm(m.dstChain, m.dstEid), app: m.dstApp, peerChain: nm(m.srcChain, m.srcEid), peerApp: m.srcApp }
        : { chain: nm(m.srcChain, m.srcEid), app: m.srcApp, peerChain: nm(m.dstChain, m.dstEid), peerApp: m.dstApp };
      const k = `${env}|${side.app}`;
      const app = z.apps[k];
      if (!app) { z.apps[k] = { t: m.t, n: 1, chain: side.chain }; if (!quiet) fresh.push({ env, m, into, ...side }); }
      else app.n++;
      const sk = `${env}|${m.from}`;
      if (!z.senders[sk]) {
        z.senders[sk] = m.t;
        if (!quiet && env === 'mainnet' && into && m.from) z.early.queue.push({ w: m.from, chain: side.peerChain, app: side.peerApp });
      }
      if (env === 'mainnet' && !z.early.first) {
        z.early.first = m.t || io.now();
        if (!quiet) msgs.push(`🚨 <b>First LayerZero message on Zero mainnet</b>\n${into ? 'Into' : 'Out of'} Zero (${esc(zoneOf(side.chain))}), ${into ? 'from' : 'to'} ${esc(side.peerChain)} · sent by <code>${esc(m.from)}</code>\n<a href="${SCAN.mainnet.site}/tx/${esc(m.tx)}">open on LayerZero Scan</a>\nBridging is wired. Public launch is set for Nov 30.`);
      }
    }
  }
  z.seen = [...seen].slice(-6000);
  const sk = Object.keys(z.senders);
  if (sk.length > 8000) for (const k of sk.slice(0, sk.length - 8000)) delete z.senders[k];

  // a new app on Zero's side: a few at once, then one line each in a digest so a busy launch day stays readable
  const hourAgo = io.now() - 3600;
  z.sent = z.sent.filter((t) => t > hourAgo);
  let shown = 0;
  for (const f of fresh) {
    const [mine, peer] = await Promise.all([nameOf(io, f.chain, f.app), nameOf(io, f.peerChain, f.peerApp)]);
    const label = `${f.env} ${zoneOf(f.chain)}`;
    if (shown < APP_ALERTS_PER_TICK && z.sent.length < APP_ALERTS_PER_HOUR) {
      shown++; z.sent.push(io.now());
      msgs.push(`${f.env === 'mainnet' ? '🚨' : '🛰'} <b>New app wired to Zero ${esc(f.env)}</b> (${esc(zoneOf(f.chain))})\n` +
        `On Zero: <code>${esc(f.app)}</code>${mine ? ` · ${esc(mine)}` : ''}\n` +
        `Other side: ${esc(f.peerChain)} <code>${esc(f.peerApp)}</code>${peer ? ` · <b>${esc(peer)}</b>` : ''}\n` +
        `First message ${f.into ? 'into' : 'out of'} Zero${ago(f.m.t, io.now())}, sent by <code>${esc(f.m.from)}</code> · <a href="${SCAN[f.env].site}/tx/${esc(f.m.tx)}">Scan</a>`);
    } else z.backlog.push(`${label}: <code>${esc(f.app)}</code>${mine ? ` ${esc(mine)}` : ''} ↔ ${esc(f.peerChain)}${peer ? ` <b>${esc(peer)}</b>` : ''}`);
  }
  if (z.backlog.length && !shown && z.sent.length < APP_ALERTS_PER_HOUR) {
    const part = z.backlog.splice(0, 25);
    z.sent.push(io.now());
    msgs.push(clip(`🛰 <b>${part.length} more new apps wired to Zero</b>${z.backlog.length ? ` (${z.backlog.length} still queued)` : ''}\n${part.map((l) => '• ' + l).join('\n')}`));
  }
  z.backlog = z.backlog.slice(-300);

  // the first wallets bridging in, once an hour for the first days
  const e = z.early;
  if (e.first && io.now() - e.first > EARLY_HOURS * 3600) e.queue = [];
  if (e.queue.length && io.now() - e.last >= 3600) {
    const part = e.queue.splice(0, 15);
    e.last = io.now();
    msgs.push(`👛 <b>${part.length} new wallet${part.length > 1 ? 's' : ''} sent a message into Zero mainnet</b>${e.queue.length ? ` (+${e.queue.length} more)` : ''}\n${part.map((x) => `• <code>${esc(x.w)}</code> from ${esc(x.chain)}`).join('\n')}`);
    e.queue = e.queue.slice(-200);
  }
  const apps = (env) => Object.keys(z.apps).filter((k) => k.startsWith(env + '|')).length;
  return `scan testnet ${z.msgN.testnet || 0} msgs ${apps('testnet')} apps, mainnet ${z.msgN.mainnet || 0} msgs ${apps('mainnet')} apps${notes.length ? ' · ' + notes.join(', ') : ''}`;
}

// ── one check ──
export async function run(state, io, msgs) {
  const z = (state.zero ||= { next: {} });
  const base = !z.armed;
  const due = (k, sec) => { if (!base && (z.next[k] || 0) > io.now()) return false; z.next[k] = io.now() + sec; return true; };
  const parts = [];
  const step = async (name, fn) => { try { const s = await fn(); if (s) parts.push(s); } catch (e) { parts.push(`${name} failed (${e.message})`); } };

  if (due('ct', CT_EVERY)) await step('certs', () => certs(io, z));
  if (due('meta', META_EVERY)) await step('registry', () => registry(io, z, msgs, base));
  await Promise.all([
    due('hosts', HOSTS_EVERY) ? step('hosts', () => hosts(io, z, msgs, base)) : null,
    due('scan', SCAN_EVERY) ? step('scan', () => scan(io, z, msgs, base, due('site', 900))) : null,
  ]);

  if (base && z.hosts && Object.keys(z.hosts).length) {
    z.armed = io.now();
    const st = (h) => z.hosts[`${h}.${ROOT}`]?.s;
    const rpcs = Object.entries(z.hosts).filter(([, r]) => isRpc(r.s)).map(([h, r]) => `${h} (${r.s.replace('rpc ', 'chain id ')})`);
    const mainUp = Object.entries(z.hosts).filter(([h, r]) => envOf(h) === 'mainnet' && isUp(r.s)).map(([h]) => h.replace('.' + ROOT, ''));
    const apps = (env) => Object.keys(z.apps || {}).filter((k) => k.startsWith(env + '|')).length;
    const tokens = Object.entries(z.facts || {}).filter(([k]) => !/testnet/i.test(k)).flatMap(([, f]) => f.filter((x) => x.startsWith('token ')).map((x) => x.split(' ')[1]));
    msgs.length = 0; // a baseline run never pings anything but this
    msgs.push(`🛰 <b>Zero watch is live in its own job</b> (a check every 2 minutes)\n` +
      `Hosts watched: ${Object.keys(z.hosts).length}. RPC answering: ${rpcs.length ? esc(rpcs.join(', ')) : 'none yet'}.\n` +
      `Mainnet explorer: ${say(st('explorer'))}. Testnet RPC: ${say(st('testnet'))}. Testnet faucet: ${say(st('faucet.testnet'))}.\n` +
      `Mainnet hosts that exist: ${mainUp.length ? esc(mainUp.join(', ')) : 'none'}.\n` +
      `LayerZero Scan: testnet ${z.msgN?.testnet || 0} messages over ${apps('testnet')} apps on Zero's side, mainnet ${z.msgN?.mainnet || 0}.\n` +
      `Registry tokens on Zero mainnet: ${tokens.length ? esc(uniq(tokens).join(', ')) : 'none'}.\n` +
      `You get a ping when an RPC answers, when the explorer or the testnet opens, when a new app is wired to Zero and when LayerZero lists a token there.`);
  }
  return parts.join(' · ');
}

// ── Telegram: the trade bot, then the command bot, then the old bot (the same order the Elysium tracker uses) ──
async function tg(text) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  const numeric = /^\d+$/.test(String(chat || ''));
  const routes = [numeric && process.env.TRADE_BOT_TOKEN, numeric && process.env.WATCH_BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN].filter(Boolean);
  if (!chat || !routes.length) { console.log('[telegram]\n' + text + '\n'); return; }
  for (const token of routes) {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: clip(text), parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (r.ok) return;
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      console.error('telegram', r.status, (await r.text()).slice(0, 200));
      break; // try the next route
    }
  }
}

async function main() {
  const file = fileURLToPath(new URL('./state.json', import.meta.url));
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const msgs = [];
  const t0 = Date.now();
  let summary = '';
  try {
    summary = await run(state, { fetch: (...a) => fetch(...a), lookup: (h) => dnsp.lookup(h), now: () => Math.floor(Date.now() / 1000) }, msgs);
  } finally {
    fs.writeFileSync(file, JSON.stringify(state));
  }
  for (const m of msgs) { try { await tg(m); } catch (e) { console.error('telegram failed:', e.message); } }
  console.log(`done: ${summary} · ${msgs.length} alerts · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => { console.error('zero-watch failed:', e); process.exit(1); });
}
