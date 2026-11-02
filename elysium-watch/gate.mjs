// gate.mjs: catch Ascend and Signal going live on Elysium mainnet (chain 99901) the moment they touch it.
//
// Runs inside elysium-watch on every tick (10 s), on the same blocks and logs, so it never sleeps and keeps
// its place across restarts. Nothing here needs a browser or your computer.
//   1. Every new contract: deployed by a wallet, through a CREATE2 deployer, or made inside another contract
//      (caught as a first-time event emitter). Each is fingerprinted (function selectors, proxies followed)
//      against Ascend's and Signal's real code: Ascend's testnet builds (every contract its deployers made),
//      Signal's live HyperEVM builds and its testnet ones. Code every launchpad shares (tokens, Ownable,
//      stock Uniswap v4) is filtered out first, and selectors common on Elysium are learned and ignored.
//   2. Team wallets: Ascend's deployers, Signal's factory owner, fee wallet and testnet deployer. Their first
//      move on Elysium (bridge in, any tx) pings at once, so do deploys and fresh wallets they fund. The
//      addresses their first contracts will land at are checked for code every couple of minutes.
//   3. Uniswap v4 pools: a pool whose hook matches Ascend or Signal pings on the first pool, and its pool
//      manager joins the launchpad list so its coins flow into the normal launch and volume alerts.
//   4. Off-chain tells every few minutes: Signal's app adding Elysium, Ascend's site changing or showing
//      addresses, Kinetiq's docs and partner gate, new TLS certificates (new subdomains), chain registries
//      listing 99901, and new posts from the X accounts.
//
// node elysium-watch/gate.mjs --selftest   checks every source from wherever it runs and prints a report.

const TESTNET_RPC = process.env.ELY_TESTNET_RPC || 'https://testnet-rpc.elysium.kinetiq.xyz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const T_INIT_V4 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

// wallets behind Ascend and Signal. testnet: true = nonce 0 on HyperEVM too, so any HyperEVM move is news
const TEAM = [
  { a: '0x5fa637713b819d6314e139291de2bfa7b7cd70eb', label: 'Ascend deployer (owns the testnet launchpad)', fam: 'Ascend', testnet: true },
  { a: '0xabd08eb33d972302d0b3fc588e4676cb8514f547', label: 'Ascend deployer 2', fam: 'Ascend', testnet: true },
  { a: '0xf88929028c0d0932c6c6fafe77267f94c97d3e36', label: 'Signal testnet deployer', fam: 'Signal', testnet: true },
  { a: '0x5164fea61d99c1eaf8c5591fd18928b8f61f0995', label: 'Signal factory owner (HyperEVM)', fam: 'Signal' },
  { a: '0x9c611d6cef58f0353178e981e02461b458acd133', label: 'Signal fee wallet (Ethereum, Base, Robinhood)', fam: 'Signal' },
  { a: '0x2d09d0c2f82c59b19b3c65a48ce2c550bf0921f9', label: 'Signal pool manager owner (HyperEVM contract)', fam: 'Signal', contract: true },
];

// reference contracts. t = Elysium testnet (99801), h = HyperEVM (999). Signal's HyperEVM set comes from its app.
const NAMED = [
  ['t', '0xe2f6254508deb93da081837f545e0baf7b00d8e9', 'Ascend launchpad', 'Ascend'],
  ['t', '0x6d01f6644bbf1b5074472d3e85aa1465b4d2bf3d', 'Ascend launchpad (older)', 'Ascend'],
  ['t', '0xbd903344f61e5e4b738108bc7069c4a0afb5e6aa', 'Ascend router', 'Ascend'],
  ['t', '0x33006c19f7aeda679ef9097d9a6684a064e9a91f', 'Ascend fee controller', 'Ascend'],
  ['t', '0x39cc4dd18d4d00e996afe06c7180c173aa768ad0', 'Ascend swapper', 'Ascend'],
  ['t', '0x7e5fe12b78305d2d1e5deef0bed88cc46f19764e', 'Ascend newest contract', 'Ascend'],
  ['t', '0x6a95a3e0dfcd4b0aaa15c6dcbffc0d28e38ebd4f', 'Ascend newest contract 2', 'Ascend'],
  ['t', '0x89593cf10d68a0d7d0c2bba3ced12f55fad0adeb', 'Signal factory (testnet)', 'Signal'],
  ['t', '0xda605da70bff4b32a9b379c614a6d9e4a09baaec', 'Signal hook (testnet)', 'Signal'],
  ['t', '0x1ec9a7e83fbfb67b478632d0a759ec64840780b4', 'Signal router (testnet)', 'Signal'],
  ['t', '0x75d98c98f92d1f5d65ca6a962f36476be34c64ae', 'Signal curve router (testnet)', 'Signal'],
  ['t', '0xe7d6263e09a4691d58dca528043efdfeec4db2c0', 'Signal curve quote factory (testnet)', 'Signal'],
  ['h', '0x16a80b08dedfea44495d47e378702297db366d5a', 'Signal factory v2', 'Signal'],
  ['h', '0x115dd9bfdc0c63ae2fd4ed661c0f52ed15b30591', 'Signal factory v3', 'Signal'],
  ['h', '0x39e08190857ff41c2939e5ee31635887b487dd91', 'Signal factory v4', 'Signal'],
  ['h', '0xfe485edbb6db2936349b67530c667a2b9905dc16', 'Signal factory v4b', 'Signal'],
  ['h', '0xbacc34d380c82a9c504afac2f74d02f16acfcbb3', 'Signal factory r3', 'Signal'],
  ['h', '0xf201641ea2985f079791c6a28c0d3ebfdebdeaec', 'Signal hook v2', 'Signal'],
  ['h', '0x3b9537072b40ed0f1aff754740259ec0afd5aaec', 'Signal hook v3', 'Signal'],
  ['h', '0x50c42fd2b1c73a4416535068b9a3a4c5732aeaec', 'Signal hook v4', 'Signal'],
  ['h', '0x6227f0128935079abc6993f1166dc5d716032aec', 'Signal hook v4b', 'Signal'],
  ['h', '0x3f7c902b0d49a2eed3e03a9f518036a284756aec', 'Signal hook r3', 'Signal'],
  ['h', '0xcf9d5f4dc9860060db528bc9722cc3d828fc807c', 'Signal router', 'Signal'],
  ['h', '0x9c4bdf29bfa05c8c7f4625745477e337877fb3d5', 'Signal router 2', 'Signal'],
  ['h', '0x547b9bcf603e1ed1082c39f7ecae313cdc319e62', 'Signal rules', 'Signal'],
  ['h', '0xc21ffa66550deeae5177675a58ee422a17c8b8f6', 'Signal rules v4', 'Signal'],
  ['h', '0xdc61c99d5fb7348c9c9c609938a353a02bd0fe07', 'Signal tokens', 'Signal'],
  ['h', '0xa93268b44b07c279958fc42a8d03d448bc6ecf61', 'Signal tokens v4', 'Signal'],
  ['h', '0x8ef05423031855d06e523977a4071880233711c7', 'Signal tokens v4b', 'Signal'],
  ['h', '0x2ce534beb6446934d770ff5ec1911d67ebc6531d', 'Signal flush', 'Signal'],
  ['h', '0x9aba14985867f1501db0672a4612582f9135751b', 'Signal flush v4', 'Signal'],
];

// code already live on Elysium that every launchpad shares: its selectors never count as a match
const INFRA_99901 = [
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc', // BOXA
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', '0xe11cafa5901b0aab51eb78251488400f9e4320cc', // elyspump
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490', '0x0c835e6a51717a514144d95c7f0a1c640179e0cc', // Kleos
  '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc', // eleos
  '0x04c6b3b5f11ff5f7ef3635f23e9697e4be8443ad', // eleos v4 router
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81', // WHYPE
];
// stock Uniswap v4 periphery (Ethereum deployments): anyone can deploy these, so they never count either
const GENERIC_ETH = [
  '0x000000000004444c5dc75cb358380d2e3de08a90', // PoolManager
  '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', // PositionManager
  '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203', // V4Quoter
  '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', // StateView
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', // UniversalRouter
];
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
const COMMON_SIGS = [
  'name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
  'approve(address,uint256)', 'allowance(address,address)', 'increaseAllowance(address,uint256)', 'decreaseAllowance(address,uint256)',
  'burn(uint256)', 'burnFrom(address,uint256)', 'mint(address,uint256)', 'owner()', 'transferOwnership(address)', 'renounceOwnership()',
  'pendingOwner()', 'acceptOwnership()', 'paused()', 'pause()', 'unpause()', 'supportsInterface(bytes4)', 'getRoleAdmin(bytes32)',
  'grantRole(bytes32,address)', 'hasRole(bytes32,address)', 'renounceRole(bytes32,address)', 'revokeRole(bytes32,address)',
  'DEFAULT_ADMIN_ROLE()', 'proxiableUUID()', 'upgradeToAndCall(address,bytes)', 'upgradeTo(address)', 'UPGRADE_INTERFACE_VERSION()',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'nonces(address)', 'DOMAIN_SEPARATOR()', 'eip712Domain()',
  'multicall(bytes[])', 'initialize()', 'implementation()', 'version()', 'onERC721Received(address,address,uint256,bytes)',
  'onERC1155Received(address,address,uint256,uint256,bytes)', 'onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)',
  'Error(string)', 'Panic(uint256)', 'unlockCallback(bytes)', 'poolManager()', 'WETH9()', 'refundETH()', 'sweepToken(address,uint256,address)',
  // OpenZeppelin TimelockController (Ascend's deployer made one on testnet; anyone can deploy the same)
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)', 'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'execute(address,uint256,bytes,bytes32,bytes32)', 'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)', 'cancel(bytes32)',
  'getMinDelay()', 'updateDelay(uint256)', 'isOperation(bytes32)', 'isOperationPending(bytes32)', 'isOperationReady(bytes32)',
  'isOperationDone(bytes32)', 'getTimestamp(bytes32)', 'hashOperation(address,uint256,bytes,bytes32,bytes32)',
  'hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)', 'PROPOSER_ROLE()', 'EXECUTOR_ROLE()', 'CANCELLER_ROLE()',
  'getOperationState(bytes32)', 'TIMELOCK_ADMIN_ROLE()',
  // OpenZeppelin VestingWallet, Multicall3, ERC-4626 vaults
  'release()', 'release(address)', 'released()', 'released(address)', 'releasable()', 'releasable(address)', 'vestedAmount(uint64)',
  'vestedAmount(address,uint64)', 'start()', 'duration()', 'end()',
  'aggregate((address,bytes)[])', 'aggregate3((address,bool,bytes)[])', 'aggregate3Value((address,bool,uint256,bytes)[])',
  'tryAggregate(bool,(address,bytes)[])', 'tryBlockAndAggregate(bool,(address,bytes)[])', 'blockAndAggregate((address,bytes)[])',
  'getBlockHash(uint256)', 'getBlockNumber()', 'getCurrentBlockCoinbase()', 'getCurrentBlockTimestamp()', 'getEthBalance(address)',
  'getLastBlockHash()', 'getChainId()', 'getBasefee()', 'getCurrentBlockDifficulty()', 'getCurrentBlockGasLimit()',
  'asset()', 'totalAssets()', 'convertToShares(uint256)', 'convertToAssets(uint256)', 'maxDeposit(address)', 'previewDeposit(uint256)',
  'deposit(uint256,address)', 'maxMint(address)', 'previewMint(uint256)', 'mint(uint256,address)', 'maxWithdraw(address)',
  'previewWithdraw(uint256)', 'withdraw(uint256,address,address)', 'maxRedeem(address)', 'previewRedeem(uint256)', 'redeem(uint256,address,address)',
];
const CREATE2_DEPLOYERS = new Set(['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0x914d7fec6aac8cd542e72bca78b30650d45643d7']); // input = salt ++ initcode

// off-chain sources
const CT_DOMAINS = ['ascendlaunch.xyz', 'signal.family', 'kinetiq.xyz'];
const X_ACCOUNTS = {
  AscendLaunch: null, // every post
  SignalFam: /elysium|kinetiq|ascend|99901/i,
  Kinetiq_xyz: /elysium|mainnet|live|bridge|rpc|chain id|ascend|signal|ecosystem|partner/i,
  Enter_Elysium: /mainnet|live|launch|bridge|rpc|chain|ascend|signal|ecosystem|partner/i,
};
const ELY_RX = /elysium|\b99901\b|0x1863d/i;

// thresholds: share of a reference's distinctive selectors that a new contract must carry
const HIGH = 0.6, HIGH_EXTRA = 0.75, POSSIBLE = 0.35, MIN_SHARED = 10, MIN_SHARED_HIGH = 10, MIN_REF = 10;
const MIN_CODE = 1000;           // bytes; smaller contracts are proxies (followed) or trivia
const FREQ_COMMON = 3;           // a selector in this many unrelated Elysium contracts is generic
const CAND_PER_TICK = 40, REF_CALLS_PER_TICK = 120, GAP_PER_TICK = 3000;

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);
const lc = (s) => String(s || '').toLowerCase();
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const within = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timed out')), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
const words = (d) => (String(d).slice(2).match(/.{64}/g) || []);
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const EXPLORER = 'https://www.thekleos.xyz/scan';
const addrLink = (a, label) => `<a href="${EXPLORER}/address/${a}">${label || short(a)}</a>`;
const txLink = (h) => (h ? ` · <a href="${EXPLORER}/tx/${h}">tx</a>` : '');

// keccak256 (Ethereum's) on 64-bit BigInt lanes
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const rotl = (x, n) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & M64);
function kf(s) {
  const C = new Array(5), B = new Array(25);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = B[x + y] ^ (~B[(x + 1) % 5 + y] & M64 & B[(x + 2) % 5 + y]);
    s[0] ^= RC[r];
  }
}
export const hexBytes = (h) => { h = String(h).replace(/^0x/, ''); if (h.length % 2) h = '0' + h; const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; };
export function keccak256(input) {
  const bytes = typeof input === 'string' ? (input.startsWith('0x') ? hexBytes(input) : new TextEncoder().encode(input)) : input;
  const rate = 136, s = new Array(25).fill(0n);
  const p = new Uint8Array(bytes.length + (rate - (bytes.length % rate)));
  p.set(bytes); p[bytes.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  for (let o = 0; o < p.length; o += rate) {
    for (let i = 0; i < rate / 8; i++) { let v = 0n; for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(p[o + i * 8 + b]); s[i] ^= v; }
    kf(s);
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return '0x' + out;
}
const sel = (sig) => keccak256(sig).slice(2, 10);
export function createAddress(deployer, nonce) {
  const rlp = (b) => (b.length === 1 && b[0] < 0x80 ? [...b] : [0x80 + b.length, ...b]);
  const n = nonce === 0 ? [] : [...hexBytes(nonce.toString(16))];
  const items = [...rlp([...hexBytes(deployer)]), ...rlp(n)];
  return '0x' + keccak256(Uint8Array.from([0xc0 + items.length, ...items])).slice(26);
}
export const create2Address = (factory, salt, initHash) => '0x' + keccak256('0x' + 'ff' + factory.slice(2) + salt.replace(/^0x/, '') + initHash.slice(2)).slice(26);
// Arbitrum aliases a contract that sends from the parent chain: L2 sender = address + 0x1111…1111
const alias = (a) => '0x' + ((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, '0');

// ── bytecode fingerprint ───────────────────────────────────────────────────────────────────────────
// selectors = PUSH4 constants; skeleton = opcodes with 20+ byte constants (addresses, immutables) blanked
// and the compiler metadata cut off, so the same source built again hashes the same.
export function analyze(code) {
  const b = hexBytes(code);
  let end = b.length;
  if (end > 2) {
    const L = (b[end - 2] << 8) | b[end - 1];
    if (L > 0 && L + 2 < end && b[end - 2 - L] >= 0xa1 && b[end - 2 - L] <= 0xa5) end -= L + 2;
  }
  const sels = new Set(), consts = new Set(), sk = [];
  for (let i = 0; i < end;) {
    const op = b[i++];
    sk.push(op);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f, d = b.subarray(i, i + n);
      const h = [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
      if (n === 4) sels.add(h);
      if (n === 20 && !/^0+$/.test(h)) consts.add('0x' + h);
      if (n === 32 && h.startsWith('000000000000000000000000') && !h.startsWith('0000000000000000000000000000000')) consts.add('0x' + h.slice(24));
      for (let k = 0; k < n; k++) sk.push(n >= 20 ? 0 : d[k] ?? 0);
      i += n;
    }
  }
  return { size: b.length, sels: [...sels], consts: [...consts], skel: keccak256(Uint8Array.from(sk)).slice(2, 18) };
}
const CLONE = [/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/, /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/];
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
// the code that actually runs at an address (implementation behind a clone, ERC-1967 or beacon proxy)
export async function realCode(call, addr) {
  const code = lc(await call('eth_getCode', [addr, 'latest']));
  if (!code || code === '0x') return { code: '0x' };
  for (const rx of CLONE) {
    const m = code.match(rx);
    if (m) return { code: lc(await call('eth_getCode', ['0x' + m[1], 'latest'])), impl: '0x' + m[1], proxy: 'clone' };
  }
  if (code.length < 2 * 4000) {
    const s = await call('eth_getStorageAt', [addr, SLOT_IMPL, 'latest']).catch(() => null);
    if (s && /[1-9a-f]/.test(s.slice(2))) {
      const impl = '0x' + s.slice(-40), c = lc(await call('eth_getCode', [impl, 'latest']));
      if (c.length > 2) return { code: c, impl, proxy: 'ERC-1967' };
    }
    const bs = await call('eth_getStorageAt', [addr, SLOT_BEACON, 'latest']).catch(() => null);
    if (bs && /[1-9a-f]/.test(bs.slice(2))) {
      const r = await call('eth_call', [{ to: '0x' + bs.slice(-40), data: '0x5c60da1b' }, 'latest']).catch(() => null);
      if (r && r.length >= 66) {
        const impl = '0x' + r.slice(26, 66), c = lc(await call('eth_getCode', [impl, 'latest']));
        if (c.length > 2) return { code: c, impl, proxy: 'beacon' };
      }
    }
  }
  return { code };
}

async function rpcAt(url, method, params, ms = 15000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
async function pmap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = undefined; } }
  }));
  return out;
}
async function web(url, { ms = 20000, accept = 'text/html,application/xhtml+xml,*\/*', headers = {} } = {}) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9', ...headers }, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  return { status: r.status, url: r.url || url, text };
}
// Cloudflare or Vercel bot walls answer datacenter IPs with a challenge page: never baseline those
const blocked = (r) => [403, 429, 503].includes(r.status) && /just a moment|challenge|cf-chl|vercel|too many requests|attention required/i.test(r.text.slice(0, 5000) + ' ' + r.status) || r.status === 429;
const addrsIn = (t) => [...new Set((String(t).match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) || []).map(lc))].filter((a) => !/^0x0{30}/.test(a) && !/^0x(e{40}|f{40})$/.test(a));
const scriptsIn = (html, base) => {
  const out = new Set();
  for (const m of html.matchAll(/<(?:script[^>]+src|link[^>]+href)=["']([^"']+\.m?js(?:\?[^"']*)?)["']/gi)) {
    try { const u = new URL(m[1], base); if (u.host === new URL(base).host) out.add(u.href); } catch {}
  }
  return [...out];
};
// key:"0x…" pairs with the nearest chain id before them (how Next.js apps ship their contract configs)
function chainConfigs(t) {
  const rows = [];
  for (const m of t.matchAll(/([A-Za-z_$][\w$]{1,40})\s*:\s*"(0x[0-9a-fA-F]{40})"/g)) {
    const near = t.slice(Math.max(0, m.index - 1500), m.index);
    const ch = ((near.match(/(?:chainId|id)\s*:\s*(\d{1,6})/g) || []).pop() || '').replace(/\D/g, '');
    rows.push({ ch, k: m[1], a: lc(m[2]) });
  }
  return rows;
}

// ── state ──────────────────────────────────────────────────────────────────────────────────────────
function init(state) {
  const g = (state.gate ||= {});
  g.v ||= 1;
  for (const k of ['refs', 'refTry', 'seen', 'sk', 'freq', 'found', 'pms', 'team', 'tn', 'codewatch', 'web', 'next', 'alerted', 'hyper']) g[k] ||= {};
  g.q ||= [];
  g.depq ||= [];
  for (const [a, w] of Object.entries(g.codewatch)) if (/shown on status\./.test(w)) delete g.codewatch[a]; // old noise from Signal's keeper page
  for (const t of TEAM) if (!g.team[t.a]) g.team[t.a] = { label: t.label, fam: t.fam, testnet: !!t.testnet, contract: !!t.contract, woke: 0, n: null, b: null };
  return g;
}
const once = (g, key) => { if (g.alerted[key]) return false; g.alerted[key] = now(); return true; };
const due = (g, key, every) => { if ((g.next[key] || 0) > now()) return false; g.next[key] = now() + every; return true; };

// ── references ─────────────────────────────────────────────────────────────────────────────────────
function addRef(g, chain, addr, name, fam, an, extra) {
  g.refs[chain + ':' + addr] = { n: name, f: fam, x: extra ? 1 : 0, s: an.sels, k: an.skel, z: an.size };
}
async function buildRefs(ctx, g, budget) {
  let calls = 0;
  const callOn = (chain) => (chain === 't' ? (m, p) => rpcAt(TESTNET_RPC, m, p) : ctx.hrpc);
  // 1. named references (and the contracts their code points at, one level deep)
  for (const [chain, a, name, fam] of NAMED.concat(g.appRefs || [])) {
    if (calls >= budget) return false;
    const key = chain + ':' + a;
    if (g.refs[key] || (g.refTry[key] || 0) >= 3) continue;
    calls += 3;
    try {
      const rc = await realCode(callOn(chain), a);
      if (rc.code.length <= 2) { g.refTry[key] = (g.refTry[key] || 0) + 1; continue; }
      const an = analyze(rc.code);
      addRef(g, chain, a, name, fam, an, false);
      // (contracts its code points at used to be added as references too; they are shared infrastructure, so no longer)
    } catch { g.refTry[key] = (g.refTry[key] || 0) + 1; }
  }
  // 2. dependencies (pool managers, implementations, oracles…): stricter matching, they are often generic
  while (g.depq.length && calls < budget) {
    const [chain, a, name, fam] = g.depq.shift();
    const key = chain + ':' + a;
    if (g.refs[key] || g.refTry[key]) continue;
    calls += 2;
    try {
      const rc = await realCode(callOn(chain), a);
      const an = rc.code.length > 2 ? analyze(rc.code) : null;
      if (an && an.size >= MIN_CODE) addRef(g, chain, a, name, fam, an, true);
      else g.refTry[key] = 9;
    } catch { g.refTry[key] = 9; }
  }
  // 3. everything the testnet deployers ever created (they keep shipping new builds there)
  for (const t of TEAM.filter((x) => x.testnet)) {
    if (calls >= budget) return false;
    const st = (g.tn[t.a] ||= { done: 0, nonce: null, at: 0 });
    if (st.nonce == null || now() - st.at > 6 * 3600) {
      try { st.nonce = Number(BigInt(await rpcAt(TESTNET_RPC, 'eth_getTransactionCount', [t.a, 'latest']))); st.at = now(); calls++; } catch { continue; }
    }
    const todo = [];
    for (let k = st.done; k < st.nonce && todo.length < budget - calls; k++) todo.push(k);
    if (!todo.length) continue;
    const codes = await pmap(todo, 8, (k) => rpcAt(TESTNET_RPC, 'eth_getCode', [createAddress(t.a, k), 'latest']));
    calls += todo.length;
    let ok = st.done;
    for (let i = 0; i < todo.length; i++) {
      if (codes[i] === undefined) break; // RPC hiccup: retry from here next time
      ok = todo[i] + 1;
      const c = lc(codes[i]);
      if (c.length / 2 - 1 < MIN_CODE) continue;
      const an = analyze(c);
      const key = 't:' + createAddress(t.a, todo[i]);
      if (!g.refs[key]) addRef(g, 't', key.slice(2), `${t.fam} testnet build (${short(t.a)} nonce ${todo[i]}, ${(an.size / 1024).toFixed(1)} KB)`, t.fam, an, true);
    }
    st.done = ok;
  }
  return calls < budget && !g.depq.length;
}
// selectors that say nothing: standard interfaces, code already on Elysium, and ones learned as common here
async function commonSet(ctx, g) {
  if (!g.common || now() - g.common.at > 24 * 3600 || g.common.v !== 2) {
    const s = new Set(COMMON_SIGS.map(sel));
    for (const x of ['00000000', 'ffffffff', '4e487b71', '08c379a0']) s.add(x);
    const k = new Set();
    const codes = await pmap(INFRA_99901, 6, (a) => realCode(ctx.call, a));
    const ethCall = async (m, p) => { let e; for (const u of ETH_RPCS) { try { return await rpcAt(u, m, p, 12000); } catch (x) { e = x; } } throw e; };
    const generic = await pmap(GENERIC_ETH, 3, (a) => realCode(ethCall, a));
    let got = 0;
    for (const rc of [...codes, ...generic]) if (rc && rc.code.length > 2) { got++; const an = analyze(rc.code); k.add(an.skel); for (const x of an.sels) s.add(x); }
    if (got >= 4 || !g.common) g.common = { v: 2, at: got >= 10 ? now() : now() - 23 * 3600, s: [...s], k: [...k] };
  }
  const set = new Set(g.common.s);
  set.skel = new Set(g.common.k || []);
  for (const [x, n] of Object.entries(g.freq)) if (n >= FREQ_COMMON) set.add(x);
  return set;
}
// best reference for a fingerprint. Named references (their launchpad, router, hook, factory…) can raise a
// "possible"; the bulk testnet builds (often stock contracts like timelocks) only count on a strong match.
function evaluate(g, an, common) {
  if (common.skel?.has(an.skel)) return { lvl: 0 }; // stock code already on Elysium (pool managers, WHYPE…)
  const cand = new Set(an.sels.filter((s) => !common.has(s)));
  let core = null, extra = null;
  for (const [key, r] of Object.entries(g.refs)) {
    if (common.skel?.has(r.k)) continue;
    // contracts their code merely points at (a PancakeSwap Infinity vault, a pool manager, Permit2…) are
    // shared infrastructure anyone can deploy: never evidence on their own
    if (/dependency$/.test(r.n)) continue;
    const D = r.s.filter((s) => !common.has(s));
    if (D.length < MIN_REF) continue; // generic reference: nothing distinctive left to match on
    if (r.k === an.skel) return { key, sc: 1, sh: D.length, same: true, lvl: 2 };
    let sh = 0;
    for (const s of D) if (cand.has(s)) sh++;
    const sc = sh / Math.max(D.length, cand.size);
    const cur = r.x ? extra : core;
    if (!cur || sc > cur.sc || (sc === cur.sc && sh > cur.sh)) { if (r.x) extra = { key, sc, sh }; else core = { key, sc, sh }; }
  }
  if (core && core.sc >= HIGH && core.sh >= MIN_SHARED_HIGH) return { ...core, lvl: 2 };
  if (extra && extra.sc >= HIGH_EXTRA && extra.sh >= MIN_SHARED_HIGH) return { ...extra, lvl: 2 };
  if (core && core.sc >= POSSIBLE && core.sh >= MIN_SHARED) return { ...core, lvl: 1 };
  const best = [core, extra].filter(Boolean).sort((x, y) => y.sc - x.sc)[0];
  return best ? { ...best, lvl: 0 } : { lvl: 0 };
}

// ── the tick ───────────────────────────────────────────────────────────────────────────────────────
// ctx: { state, logs, blocks, from, head, rpc, getLogs, hrpc, msgs, known (Set of launchpad pool managers), buttons(token) }
export async function gate(ctx) {
  const t0 = Date.now();
  const g = init(ctx.state);
  ctx.call = (m, p) => ctx.rpc(m, p);
  const msgs = ctx.msgs;
  const fresh = !g.cursor;
  const teamSet = () => new Set(Object.keys(g.team));
  const aliases = () => new Map(Object.keys(g.team).map((a) => [alias(a), a]));

  // a. references (budgeted; finishes over the first few ticks)
  const refsReady = await buildRefs(ctx, g, REF_CALLS_PER_TICK).catch((e) => { console.log('gate refs:', e.message); return false; });
  const common = await commonSet(ctx, g);

  // b. blocks skipped by the main scan (long outage): catch up on emitters and pools in slices
  if (g.cursor && ctx.from > g.cursor + 1) g.gap = [Math.max(g.cursor + 1, ctx.from - 50000), ctx.from - 1];
  let logs = ctx.logs;
  if (g.gap && g.gap[0] <= g.gap[1]) {
    const a = g.gap[0], b = Math.min(g.gap[1], a + GAP_PER_TICK - 1);
    try { logs = logs.concat(await ctx.getLogs({}, a, b)); g.gap[0] = b + 1; } catch (e) { console.log('gate gap:', e.message); }
    if (g.gap[0] > g.gap[1]) delete g.gap;
  }

  // c. candidates from this tick's transactions
  const team = teamSet(), al = aliases();
  const push = (a, why, extra = {}) => { a = lc(a); if (isAddr(a) && !g.seen[a] && !g.q.some((x) => x.a === a)) g.q.push({ a, why, ...extra }); };
  const woke = [];
  for (const blk of ctx.blocks) {
    for (const tx of blk.transactions || []) {
      const f = lc(tx.from), to = lc(tx.to), val = Number(BigInt(tx.value || '0x0')) / 1e18;
      const type = lc(tx.type);
      if (!tx.to && !['0x6a', '0x64', '0x65', '0x66', '0x68', '0x69'].includes(type)) {
        try {
          const rc = await ctx.rpc('eth_getTransactionReceipt', [tx.hash]);
          if (rc?.contractAddress) push(rc.contractAddress, team.has(f) ? 'team' : 'create', { tx: tx.hash, by: f });
        } catch {}
      }
      if (CREATE2_DEPLOYERS.has(to) && (tx.input || '').length > 2 + 64 * 2) {
        const salt = tx.input.slice(2, 66), initHash = keccak256('0x' + tx.input.slice(66));
        push(create2Address(to, salt, initHash), team.has(f) ? 'team' : 'create2', { tx: tx.hash, by: f });
      }
      // team wallets: first move here (bridged in, sent, received), and fresh wallets they fund
      const who = team.has(f) ? f : team.has(to) ? to : al.get(f) || null;
      if (who) woke.push({ who, tx, val, out: who === f });
      if (team.has(f) && to && !team.has(to) && val >= 0.05 && (tx.input || '0x') === '0x') woke.push({ who: f, tx, val, fund: to });
    }
  }
  for (const l of logs) {
    const em = lc(l.address);
    if (!g.seen[em]) push(em, 'emitter', { tx: l.transactionHash });
    if (l.topics[0] === T_INIT_V4) {
      const pm = em, hook = '0x' + (words(l.data)[2] || '').slice(24);
      if (!ctx.known.has(pm) && !g.pms[pm]) {
        if (isAddr(hook) && hook !== ZERO) push(hook, 'hook', { tx: l.transactionHash, pm });
        const u = (g.pmSeen ||= {})[pm] ||= { n: 0, hook, t: now() };
        u.n++;
      }
    }
    if (l.topics[0] === T_TRANSFER && l.topics.length === 3) {
      const f = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26);
      if (team.has(f) || team.has(to)) woke.push({ who: team.has(f) ? f : to, tx: { hash: l.transactionHash }, token: em });
    }
  }

  // d. team wallets waking up on Elysium (also checked by nonce and balance, which survives any gap)
  if (due(g, 'teamPoll', 120)) {
    await pmap(Object.keys(g.team), 6, async (a) => {
      const [n, b] = await Promise.all([ctx.rpc('eth_getTransactionCount', [a, 'latest']), ctx.rpc('eth_getBalance', [a, 'latest'])]);
      const w = g.team[a], nn = Number(BigInt(n)), bb = Number(BigInt(b)) / 1e18;
      if (w.n != null && (nn > w.n || bb > (w.b || 0) + 0.001)) woke.push({ who: a, poll: { n: nn, b: bb } });
      w.n = nn; w.b = bb;
    });
  }
  for (const x of woke) {
    const w = g.team[x.who];
    if (!w) continue;
    if (x.fund) {
      if (g.team[x.fund] || !once(g, 'fund:' + x.fund)) continue;
      g.team[x.fund] = { label: `${w.label.replace(/\s*\(.*\)$/, '')} alt`, fam: w.fam, woke: now(), n: null, b: null };
      (ctx.state.auto ||= {})[x.fund] = { label: `${w.fam} team alt ${x.fund.slice(2, 6)}`, group: w.fam.toLowerCase(), from: 'gate', t: now() };
      msgs.push(`🧬 <b>${esc(w.label)}</b> funded a fresh wallet on Elysium\n${addrLink(x.fund)} got ${x.val.toFixed(2)} HYPE${txLink(x.tx.hash)}\nTracking it as a ${esc(w.fam)} team wallet.`);
      continue;
    }
    if (w.woke) continue;
    w.woke = now();
    (ctx.state.auto ||= {})[x.who] ||= { label: `${w.fam} team ${x.who.slice(2, 6)}`, group: w.fam.toLowerCase(), from: 'gate', t: now() };
    const bridged = x.tx && (lc(x.tx.type) === '0x64' || al.has(lc(x.tx.from)));
    const what = x.poll ? `now has ${x.poll.n} txs and ${x.poll.b.toFixed(2)} HYPE here` : x.token ? 'moved a token here' : bridged ? `bridged in ${x.val.toFixed(2)} HYPE from HyperEVM` : x.out ? `sent its first transaction here${x.val ? ` (${x.val.toFixed(2)} HYPE)` : ''}` : `received ${x.val.toFixed(2)} HYPE`;
    msgs.push(`🚨 <b>${esc(w.fam)} team wallet is active on Elysium</b>\n${esc(w.label)} ${addrLink(x.who)} ${what}${txLink(x.tx?.hash)}\nA deploy usually follows. Every contract it makes is checked on the spot.`);
  }

  // e. HyperEVM: deployers that were never used there moving at all (the step before bridging)
  if (due(g, 'hyperPoll', 300)) {
    await pmap(Object.entries(g.team).filter(([, w]) => w.testnet), 3, async ([a, w]) => {
      const [n, b] = await Promise.all([ctx.hrpc('eth_getTransactionCount', [a, 'latest']), ctx.hrpc('eth_getBalance', [a, 'latest'])]);
      const h = (g.hyper[a] ||= { n: null, b: null });
      const nn = Number(BigInt(n)), bb = Number(BigInt(b)) / 1e18;
      if (h.n != null && (nn > h.n || bb > h.b + 0.001) && (h.alerts || 0) < 3) {
        h.alerts = (h.alerts || 0) + 1;
        msgs.push(`🚨 <b>${esc(w.label)} moved on HyperEVM</b>\n${addrLink(a)} · ${nn} txs · ${bb.toFixed(2)} HYPE (was ${h.n} txs, ${h.b.toFixed(2)} HYPE). It had never been used outside testnet. Bridging to Elysium is the usual next step.`);
      }
      h.n = nn; h.b = bb;
    });
  }

  // f. addresses their first contracts will land at, plus addresses announced off-chain
  if (due(g, 'codewatch', 120)) {
    const list = new Map();
    for (const [a, w] of Object.entries(g.team)) if (!w.contract) for (let k = 0; k < 5; k++) list.set(createAddress(a, (w.n || 0) + k), [`${w.label} contract #${(w.n || 0) + k + 1}`, w.fam]);
    for (const [a, why] of Object.entries(g.codewatch)) list.set(a, [why, /ascend/i.test(why) ? 'Ascend' : /signal/i.test(why) ? 'Signal' : null]);
    for (const [key, r] of Object.entries(g.refs)) if (!r.x && key.startsWith('t:')) list.set(key.slice(2), [`same address as ${r.n}`, r.f]);
    const entries = [...list].filter(([a]) => !g.seen[a]);
    const codes = await pmap(entries, 8, ([a]) => ctx.rpc('eth_getCode', [a, 'latest']));
    entries.forEach(([a, [why, fam]], i) => { if (codes[i] && codes[i].length > 2) push(a, 'watched', { note: why, fam }); });
  }

  // g. fingerprint the queue (team, direct deploys and CREATE2 first; then hooks; then first-time emitters)
  const order = { team: 0, watched: 0, create: 1, create2: 1, hook: 2, emitter: 3 };
  g.q.sort((x, y) => order[x.why] - order[y.why]);
  if (fresh) { for (const c of g.q) if (c.why === 'emitter') g.seen[c.a] = now(); g.q = g.q.filter((c) => c.why !== 'emitter'); } // first run: current emitters are the baseline
  // until the references are loaded only team and watched addresses are checked (the rest wait in the queue)
  const batch = refsReady ? g.q.splice(0, CAND_PER_TICK) : (() => { const urgent = g.q.filter((c) => c.why === 'team' || c.why === 'watched'); g.q = g.q.filter((c) => !urgent.includes(c)); return urgent; })();
  const results = await pmap(batch, 6, async (c) => {
    const rc = await realCode(ctx.call, c.a);
    return { c, rc };
  });
  for (const x of results) {
    if (!x) continue;
    const { c, rc } = x;
    if (rc.code.length <= 2) { if ((c.tries = (c.tries || 0) + 1) < 3 && c.why !== 'emitter') g.q.push(c); else g.seen[c.a] = now(); continue; }
    g.seen[c.a] = now();
    const an = analyze(rc.code);
    if (an.size < MIN_CODE && c.why !== 'team') continue;
    let v = g.sk[an.skel];
    if (!v || (v.lvl === 0 && v.r < Object.keys(g.refs).length)) {
      v = { ...evaluate(g, an, common), t: now(), r: Object.keys(g.refs).length };
      if (v.lvl === 0 && refsReady && !g.sk[an.skel]) for (const s of new Set(an.sels)) g.freq[s] = (g.freq[s] || 0) + 1;
      g.sk[an.skel] = v;
    }
    const byTeam = c.why === 'team' || (c.by && g.team[c.by]);
    if (v.lvl === 0 && !byTeam && c.why !== 'watched') continue;
    await report(ctx, g, c, rc, an, v, byTeam);
  }

  // h. pools on a pool manager we do not know: register it once its hook or the manager itself matched
  for (const [pm, u] of Object.entries(g.pmSeen || {})) {
    if (g.pms[pm] || ctx.known.has(pm) || now() - (u.t || 0) > 2 * 86400) { delete g.pmSeen[pm]; continue; }
    const f = g.found[u.hook] || g.found[pm];
    if (f) {
      g.pms[pm] = { name: f.fam, hook: u.hook, t: now() };
      msgs.push(`🚀 <b>First ${esc(f.fam)} pools on Elysium</b>\n${u.n} pool${u.n > 1 ? 's' : ''} on pool manager ${addrLink(pm)} with the ${esc(f.fam)} hook ${addrLink(u.hook)}.\nIts coins now flow into the normal launch and volume alerts.`);
      delete g.pmSeen[pm];
    }
  }

  // i. activity on contracts already identified as Ascend or Signal: the first launches, one by one
  const byTx = {};
  for (const l of logs) if (g.found[lc(l.address)]) (byTx[l.transactionHash] ||= []).push(l);
  for (const [h, ls] of Object.entries(byTx)) {
    const f = g.found[lc(ls[0].address)];
    if ((f.launches || 0) >= 30 || (f.first && now() - f.first > 48 * 3600)) continue; // after that the normal alerts take over
    const minted = logs.filter((l) => l.transactionHash === h && l.topics[0] === T_TRANSFER && l.topics[1] === '0x' + '0'.repeat(64) && !g.found[lc(l.address)]);
    const token = minted.length ? lc(minted[0].address) : null;
    if (!token || !once(g, 'launch:' + token)) continue;
    f.first ||= now();
    f.launches = (f.launches || 0) + 1;
    let sym = '?', creator = null;
    try { sym = decodeStr(await ctx.rpc('eth_call', [{ to: token, data: '0x95d89b41' }, 'latest'])) || '?'; } catch {}
    try { creator = lc((await ctx.rpc('eth_getTransactionByHash', [h]))?.from); } catch {}
    msgs.push({
      text: `🚀 <b>${esc(f.fam)} launch on Elysium: ${esc(sym)}</b>\nThrough ${esc(f.name)} ${addrLink(lc(ls[0].address))}${creator ? `\nCreator ${addrLink(creator)}${g.team[creator] ? ` (${esc(g.team[creator].label)})` : ''}` : ''}\n<code>${token}</code>${txLink(h)}`,
      buttons: ctx.buttons ? ctx.buttons(token) : undefined,
    });
  }

  // j. off-chain checks (time-boxed)
  if (!ctx.noWeb) await webChecks(ctx, g, msgs, t0);

  // k. armed message, once references are in and the web baselines are taken
  if (!g.armed && refsReady && g.web.sigapp?.at && g.web.ascend?.at) {
    g.armed = now();
    msgs.push(armedText(g));
  }

  // housekeeping
  g.cursor = Math.max(g.cursor || 0, ctx.head);
  const old = now() - 10 * 86400;
  for (const [a, t] of Object.entries(g.seen)) if (t < old) delete g.seen[a];
  for (const [k, v] of Object.entries(g.sk)) if (v.t < old && !v.lvl) delete g.sk[k];
  if (g.q.length > 3000) g.q = g.q.filter((c) => c.why !== 'emitter').concat(g.q.filter((c) => c.why === 'emitter').slice(-2000));
  console.log(`gate: ${Object.keys(g.refs).length} refs, ${batch.length} checked, ${g.q.length} queued, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function decodeStr(hex) {
  const h = String(hex || '').slice(2);
  try {
    if (h.length >= 128 && BigInt('0x' + h.slice(0, 64)) === 32n) { const n = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + n * 2), 'hex').toString('utf8').replace(/\0/g, '').slice(0, 20); }
    return Buffer.from(h.slice(0, 64), 'hex').toString('utf8').replace(/\0/g, '').slice(0, 20);
  } catch { return ''; }
}

async function report(ctx, g, c, rc, an, v, byTeam) {
  const r = v.key && v.lvl ? g.refs[v.key] : null;
  let by = c.by || null, via = null;
  if (!by && c.tx) {
    try { const tx = await ctx.rpc('eth_getTransactionByHash', [c.tx]); by = lc(tx?.from); via = tx?.to ? lc(tx.to) : null; } catch {}
  }
  const linked = by && g.team[by] ? g.team[by] : null;
  const fam = r?.f || c.fam || linked?.fam || famOf(g, c.a) || 'Ascend/Signal';
  const hi = v.lvl === 2 || byTeam || c.why === 'watched';
  const key = (hi ? 'hit:' : 'maybe:') + (hi ? c.a : an.skel);
  if (!once(g, key)) return;
  const how = { team: 'deployed by a team wallet', create: 'deployed directly', create2: 'deployed through a CREATE2 deployer', hook: `hook of a new pool on ${short(c.pm || '')}`, emitter: 'first seen emitting events', watched: `code appeared at a watched address (${c.note || ''})` }[c.why] || c.why;
  const match = r ? `${v.same ? 'Identical build to' : `Matches ${Math.round(v.sc * 100)}% of the distinctive functions of`} <b>${esc(r.n)}</b>${v.same ? '' : ` (${v.sh} shared)`}` : 'No close match to their known code (new build, or not theirs)';
  const who = by ? `\nFrom ${addrLink(by)}${linked ? ` = <b>${esc(linked.label)}</b>` : ' (not a known team wallet: could be a copycat)'}${via && via !== c.a ? ` via ${addrLink(via)}` : ''}` : '';
  const head = hi ? `🚨 <b>${esc(fam)} contract on Elysium</b>` : `👀 <b>Possible ${esc(fam)} contract on Elysium</b>`;
  ctx.msgs.push(`${head}\n${addrLink(c.a)} · ${(an.size / 1024).toFixed(1)} KB${rc.proxy ? ` (${rc.proxy} proxy → ${short(rc.impl)})` : ''} · ${how}\n${match}${who}${txLink(c.tx)}`);
  if (hi) {
    g.found[c.a] = { fam, name: r?.n || 'team contract', t: now() };
    if (rc.impl) g.found[rc.impl] = g.found[c.a];
    if (by && !g.team[by]) {
      g.team[by] = { label: `${fam} deployer on Elysium${linked ? '' : ' (unconfirmed)'}`, fam, woke: now(), n: null, b: null };
      (ctx.state.auto ||= {})[by] ||= { label: `${fam} deployer ${by.slice(2, 6)}`, group: fam.toLowerCase(), from: 'gate', t: now() };
    }
  }
}
const famOf = (g, a) => (a && g.team[a] ? g.team[a].fam : null);

// ── off-chain ──────────────────────────────────────────────────────────────────────────────────────
async function webChecks(ctx, g, msgs, t0) {
  const jobs = [];
  if (due(g, 'w:sigapp', 180)) jobs.push(['sigapp', () => checkSignalApp(ctx, g, msgs)]);
  if (due(g, 'w:sigely', 180)) jobs.push(['sigely', () => checkSignalEly(g, msgs)]);
  if (due(g, 'w:ascend', 180)) jobs.push(['ascend', () => checkSite(ctx, g, msgs, 'ascend', 'https://ascendlaunch.xyz/', 'Ascend')]);
  for (const s of Object.keys(g.web.extra || {})) if (due(g, 'w:site:' + s, 300)) jobs.push(['site:' + s, () => checkSite(ctx, g, msgs, 'site:' + s, 'https://' + s + '/', s)]);
  if (due(g, 'w:docs', 600)) jobs.push(['docs', () => checkDocs(g, msgs)]);
  const ctIdx = Math.floor(now() / 300) % CT_DOMAINS.length;
  if (due(g, 'w:ct' + ctIdx, 900)) jobs.push(['ct:' + CT_DOMAINS[ctIdx], () => checkCT(g, msgs, CT_DOMAINS[ctIdx])]);
  if (due(g, 'w:registry', 1800)) jobs.push(['registry', () => checkRegistry(g, msgs)]);
  const handles = Object.keys(X_ACCOUNTS);
  const xi = Math.floor(now() / 120) % handles.length;
  if (process.env.GATE_X === '1' && due(g, 'w:x:' + handles[xi], 300)) jobs.push(['x:' + handles[xi], () => checkX(g, msgs, handles[xi])]);
  const left = Math.max(5000, 35000 - (Date.now() - t0));
  await Promise.all(jobs.map(async ([k, fn]) => {
    const st = (g.web[k] ||= {});
    try { await within(fn(), left); st.ok = 1; st.err = null; }
    catch (e) { st.ok = 0; st.err = String(e.message || e).slice(0, 80); }
    st.at = now();
  }));
}

async function checkSignalApp(ctx, g, msgs) {
  const st = (g.web.sigapp ||= {});
  const page = await web('https://signal.family/');
  if (page.status !== 200) throw new Error('HTTP ' + page.status);
  const scripts = scriptsIn(page.text, page.url);
  const seen = new Set(st.urls || []);
  const fresh = scripts.filter((u) => !seen.has(u));
  // the page embeds live coin data (names can contain "Elysium"), so only chain fields count there
  const chains = [...new Set([...page.text.matchAll(/\\?"chain\\?":\\?"([a-z0-9_-]{2,20})/gi)].map((m) => lc(m[1])))];
  const newChains = st.chains ? chains.filter((c) => !st.chains.includes(c)) : [];
  st.chains = [...new Set([...(st.chains || []), ...chains])];
  const elyChain = newChains.find((c) => /ely|99901/.test(c));
  if (elyChain && once(g, 'sigchain:' + elyChain)) msgs.push(`🌐 <b>Signal is listing Elysium coins</b>\nIts live coin feed now has chain "${esc(elyChain)}" next to ${esc(chains.filter((c) => c !== elyChain).join(', '))}.`);
  let ely = null;
  const rows = [];
  for (const u of fresh.slice(0, 40)) {
    const t = (await web(u, { accept: '*\/*' }).catch(() => null))?.text || '';
    if (ELY_RX.test(t)) ely ||= u.split('/').pop();
    rows.push(...chainConfigs(t));
  }
  st.urls = scripts;
  // Signal's live HyperEVM contracts from the app become references too (new versions get picked up)
  for (const r of rows) {
    if (r.ch === '999' && /factory|hook|router|rules|tokens|flush|implementation|pons/i.test(r.k) && !g.refs['h:' + r.a] && !NAMED.some((n) => n[1] === r.a) && !(g.appRefs ||= []).some((n) => n[1] === r.a)) {
      g.appRefs.push(['h', r.a, `Signal ${r.k} (HyperEVM, from its app)`, 'Signal']);
    }
  }
  const mainnet = rows.filter((r) => r.ch === '99901');
  for (const r of mainnet) g.codewatch[r.a] = `Signal app ${r.k} for Elysium`;
  if ((ely || mainnet.length) && !st.ely) {
    st.ely = now();
    ely ||= 'its contract config';
    if (st.at) msgs.push(`🌐 <b>Signal's app now mentions Elysium</b>\nFound in ${esc(ely)} on signal.family.${mainnet.length ? `\nElysium contracts in its config:\n${mainnet.slice(0, 10).map((r) => `• ${esc(r.k)} <code>${r.a}</code>`).join('\n')}\nWatching them for code.` : '\nNo Elysium contract addresses in it yet.'}`);
  }
  st.n = scripts.length;
}

async function checkSignalEly(g, msgs) {
  const st = (g.web.sigely ||= {});
  const page = await web('https://elysium.signal.family/');
  const closed = /testnet is closed/i.test(page.text);
  const scripts = scriptsIn(page.text, page.url).length;
  const sig = `${page.status}|${closed}|${scripts > 0}`;
  if (st.sig && st.sig !== sig && !closed && page.status === 200 && once(g, 'sigely:' + sig)) {
    msgs.push(`🌐 <b>elysium.signal.family changed</b>\nThe "testnet is closed" page is gone${scripts ? ` and the app is back (${scripts} scripts)` : ''}. Title: ${esc((page.text.match(/<title>([^<]*)/i) || [])[1] || '?')}`);
  }
  st.sig = sig;
}

async function checkSite(ctx, g, msgs, key, url, label) {
  const st = (g.web[key] ||= {});
  const page = await web(url);
  if (blocked(page)) throw new Error(`blocked from GitHub's servers (HTTP ${page.status})`);
  const title = ((page.text.match(/<title>([^<]*)/i) || [])[1] || '').trim();
  // a host that is down (Cloudflare tunnel or origin errors) has nothing to compare; its return is the news
  if (page.status >= 500 || /tunnel error|error 10\d\d|origin is unreachable|bad gateway|web server is down/i.test(title + ' ' + page.text.slice(0, 3000))) { st.down ||= now(); return; }
  const wasDown = st.down || /tunnel error|error 10\d\d/i.test(st.base?.title || '');
  delete st.down;
  const gated = /coming soon|private access|access code/i.test(page.text);
  const scripts = scriptsIn(page.text, page.url);
  // scripts: new URLs are read once; small ones (unhashed names like /gate/intro-v1.js) every time
  const cache = (st.sc ||= {});
  for (const u of scripts.slice(0, 40)) {
    if (cache[u] && cache[u].z > 60000) continue;
    const t = (await web(u, { accept: '*\/*' }).catch(() => null))?.text;
    if (t != null) cache[u] = { z: t.length, a: addrsIn(t).slice(0, 50), c: /\b99901\b|0x1863d/i.test(t) };
  }
  for (const u of Object.keys(cache)) if (!scripts.includes(u)) delete cache[u];
  const addrs = [...new Set([...addrsIn(page.text), ...scripts.flatMap((u) => cache[u]?.a || [])])];
  const chain = /\b99901\b|0x1863d/i.test(page.text) || scripts.some((u) => cache[u]?.c);
  // visible text only (pages embed live coin data whose names can say anything)
  const visible = page.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[\w.-]+\.[a-z]{2,}(\/\S*)?/gi, ' '); // hostnames do not count
  const ely = /\belysium\b/i.test(visible);
  const now1 = { s: page.status, title, gated, addrs, chain, ely, scripts: scripts.map((u) => new URL(u).pathname) };
  if (!st.base) {
    st.base = now1;
    if (wasDown && once(g, key + ':up:' + now1.title)) msgs.push(`🌐 <b>${esc(label)} is online</b> (${esc(url)})\nIt was down until now. Title: "${esc(title)}"`);
    return;
  }
  const b = st.base, notes = [];
  if (wasDown) notes.push('it is back online after being down');
  if (now1.s !== b.s) notes.push(`status ${b.s} → ${now1.s}`);
  if (now1.title !== b.title) notes.push(`title "${esc(b.title)}" → "${esc(now1.title)}"`);
  if (b.gated && !now1.gated && now1.s === 200) notes.push('the access gate is gone');
  // new addresses only count when they are contracts on Elysium (status pages and app feeds list HyperEVM coins all day)
  const cand = now1.addrs.filter((a) => !b.addrs.includes(a)).slice(0, 40);
  const codes = await pmap(cand, 6, (a) => ctx.rpc('eth_getCode', [a, 'latest']));
  const newA = cand.filter((a, i) => codes[i] && codes[i].length > 2);
  if (newA.length) notes.push(`new Elysium contract addresses:\n${newA.slice(0, 8).map((a) => `• <code>${a}</code>`).join('\n')}`);
  // Ascend's own site showing an address before anything is deployed there: watch it for code
  if (key === 'ascend') for (const a of cand.filter((a) => !newA.includes(a))) g.codewatch[a] = 'address shown on Ascend\'s site';
  if (now1.ely && b.ely === false) notes.push('the page now mentions Elysium'); // undefined = baseline from before this check existed
  if (now1.chain && !b.chain) notes.push('chain id 99901 appears in its code');
  const newS = now1.scripts.filter((p) => !b.scripts.includes(p));
  if (newS.length && !notes.length && newS.some((p) => !/_next\/static\/chunks\//.test(p))) notes.push(`new scripts: ${newS.slice(0, 4).map(esc).join(', ')}`);
  if (notes.length && once(g, key + ':' + JSON.stringify(notes).slice(0, 200))) {
    msgs.push(`🌐 <b>${esc(label)} site changed</b> (${esc(url)})\n${notes.join('\n')}`);
  }
  st.base = { ...now1, addrs: [...new Set([...b.addrs, ...now1.addrs])].slice(-3000), scripts: [...new Set([...b.scripts, ...now1.scripts])].slice(-200) };
}

async function checkDocs(g, msgs) {
  const st = (g.web.docs ||= {});
  const pages = ['/docs/connecting-to-elysium', '/docs/contract-addresses', '/ecosystem', '/ecosystem/ascend', '/ecosystem/signal', '/explorer'];
  const res = await pmap(pages, 3, (p) => web('https://elysium.kinetiq.xyz' + p));
  if (res.every((r) => !r || blocked(r))) throw new Error(`blocked from GitHub's servers (HTTP ${res.find(Boolean)?.status || '?'})`);
  const cur = {};
  pages.forEach((p, i) => {
    const r = res[i];
    if (!r || blocked(r)) return;
    const gate = /partner-access/.test(r.url) || /open to partners|access code/i.test(r.text);
    cur[p] = { gate, soon: (r.text.match(/coming soon/gi) || []).length, addrs: addrsIn(r.text).slice(0, 60), chain: /\b99901\b|0x1863d/.test(r.text), s: r.status };
  });
  if (!Object.keys(cur).length) throw new Error('no page answered');
  if (st.base) {
    const notes = [];
    for (const [p, c] of Object.entries(cur)) {
      const b = st.base[p];
      if (!b) continue;
      if (b.gate && !c.gate && c.s === 200) notes.push(`${p} is no longer behind the partner gate`);
      if (c.soon < b.soon) notes.push(`${p}: "Coming soon" ${b.soon} → ${c.soon}`);
      if (c.chain && !b.chain) notes.push(`${p} now mentions chain 99901`);
      const na = c.addrs.filter((a) => !b.addrs.includes(a));
      if (na.length) notes.push(`${p} new addresses: ${na.slice(0, 6).map((a) => `<code>${a}</code>`).join(', ')}`);
    }
    if (notes.length && once(g, 'docs:' + JSON.stringify(notes).slice(0, 200))) msgs.push(`🌐 <b>Kinetiq Elysium docs changed</b>\n${notes.map((n) => '• ' + n).join('\n')}`);
  }
  st.base = { ...(st.base || {}), ...cur };
}

async function checkCT(g, msgs, domain) {
  const st = ((g.web.ct ||= {})[domain] ||= {});
  // [name, issued] pairs; crt.sh and certspotter disagree on what they have, so only freshly issued
  // certificates count as news (a name merely missing from one source's earlier answer does not)
  let certs = null;
  try {
    const r = await web(`https://crt.sh/?q=%25.${domain}&output=json`, { accept: 'application/json', ms: 30000 });
    if (r.status === 200) certs = JSON.parse(r.text).flatMap((x) => String(x.name_value).split('\n').map((n) => [n, Date.parse(x.not_before + 'Z')]));
  } catch {}
  if (!certs) {
    const r = await web(`https://api.certspotter.com/v1/issuances?domain=${domain}&include_subdomains=true&expand=dns_names`, { accept: 'application/json' });
    if (r.status !== 200) throw new Error('crt.sh and certspotter failed (' + r.status + ')');
    certs = JSON.parse(r.text).flatMap((x) => (x.dns_names || []).map((n) => [n, Date.parse(x.not_before)]));
  }
  certs = certs.map(([n, t]) => [lc(n).replace(/^\*\./, ''), t]).filter(([n]) => n.endsWith(domain));
  const names = [...new Set(certs.map(([n]) => n))];
  if (!st.names) { st.names = names; st.at = now(); return; }
  const fresh = new Set(certs.filter(([, t]) => t > Date.now() - 3 * 86400 * 1000).map(([n]) => n));
  const added = names.filter((n) => !st.names.includes(n) && fresh.has(n));
  if (added.length && once(g, 'ct:' + added.sort().join(','))) {
    msgs.push(`🔐 <b>New certificate for ${esc(domain)}</b>\nNewly issued for: ${added.slice(0, 10).map((n) => `<code>${esc(n)}</code>`).join(', ')}\nA new subdomain usually goes live within days.`);
    if (domain !== 'kinetiq.xyz' || /elysium|ascend|signal|bridge|explorer|rpc/.test(added.join(' '))) for (const n of added.slice(0, 5)) (g.web.extra ||= {})[n] = now();
  }
  st.names = [...new Set([...st.names, ...names])];
  st.at = now();
}

async function checkRegistry(g, msgs) {
  const st = (g.web.registry ||= {});
  const f = await web('https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-99901.json', { accept: 'application/json' });
  if (f.status === 200 && !st.listed) {
    st.listed = now();
    let info = '';
    try { const j = JSON.parse(f.text); info = `${esc(j.name)} · RPC ${esc((j.rpc || []).slice(0, 2).join(', '))} · explorer ${esc(j.explorers?.[0]?.url || 'none')}`; } catch {}
    if (st.base) msgs.push(`📜 <b>Chain 99901 is now in the chain registry</b>\n${info}`);
  }
  const tok = process.env.GH_API_TOKEN;
  const s = await web('https://api.github.com/search/issues?q=99901+repo:ethereum-lists/chains&sort=created&order=desc', { accept: 'application/vnd.github+json', headers: tok ? { authorization: 'Bearer ' + tok } : {} });
  if (s.status === 200) {
    const items = (JSON.parse(s.text).items || []).map((i) => ({ n: i.number, t: i.title, u: i.html_url, s: i.state }));
    const known = new Set(st.prs || []);
    const added = items.filter((i) => !known.has(i.n));
    if (st.base && added.length) msgs.push(`📜 <b>New chain registry PR for 99901</b>\n${added.slice(0, 3).map((i) => `<a href="${i.u}">#${i.n}</a> ${esc(i.t)} (${i.s})`).join('\n')}`);
    st.prs = items.map((i) => i.n);
    st.found = items.slice(0, 3);
  }
  st.base = 1;
}

async function checkX(g, msgs, handle) {
  const st = ((g.web.xs ||= {})[handle] ||= {});
  const r = await web(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`);
  const m = r.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (r.status !== 200 || !m) throw new Error('X embed unavailable (' + r.status + ')');
  const tweets = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.id_str && (o.full_text || o.text) && o.user?.screen_name?.toLowerCase() === handle.toLowerCase()) tweets.push({ id: o.id_str, text: o.full_text || o.text });
    for (const v of Object.values(o)) walk(v);
  };
  walk(JSON.parse(m[1]));
  if (!tweets.length) throw new Error('X embed returned no posts');
  const max = tweets.reduce((a, t) => (BigInt(t.id) > BigInt(a) ? t.id : a), '0');
  if (st.last) {
    const rx = X_ACCOUNTS[handle];
    for (const t of tweets.filter((t) => BigInt(t.id) > BigInt(st.last)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
      if (rx && !rx.test(t.text)) continue;
      if (once(g, 'x:' + t.id)) msgs.push(`🐦 <b>@${handle}</b>\n${esc(t.text.slice(0, 500))}\n<a href="https://x.com/${handle}/status/${t.id}">open</a>`);
    }
  }
  if (!st.last || BigInt(max) > BigInt(st.last)) st.last = max;
}

// ── summaries ──────────────────────────────────────────────────────────────────────────────────────
function refCounts(g) {
  const c = { Ascend: 0, Signal: 0 };
  for (const r of Object.values(g.refs)) c[r.f] = (c[r.f] || 0) + 1;
  return c;
}
function webLine(g) {
  const names = { sigapp: 'Signal app', sigely: 'Signal Elysium page', ascend: 'Ascend site', docs: 'Kinetiq docs', registry: 'chain registry' };
  const ok = [], bad = [];
  for (const [k, n] of Object.entries(names)) { const s = g.web[k]; if (!s?.at) continue; (s.ok ? ok : bad).push(n + (!s.ok && /blocked/.test(s.err || '') ? ' (bot wall, hourly browser check covers it)' : '')); }
  const ct = Object.keys(g.web.ct || {}).length;
  const xs = Object.entries(g.web.xs || {}).filter(([, s]) => s.last).length;
  const xbad = Object.keys(X_ACCOUNTS).filter((h) => g.web['x:' + h] && !g.web['x:' + h].ok).length;
  return `${ok.length ? 'ok: ' + ok.join(', ') : ''}${bad.length ? ` · not reachable: ${bad.join(', ')}` : ''} · certificates ${ct}/${CT_DOMAINS.length} domains${process.env.GATE_X === '1' ? ` · X ${xs}/${Object.keys(X_ACCOUNTS).length}${xbad ? ' (embed blocked)' : ''}` : ' · X via the hourly task'}`;
}
function armedText(g) {
  const c = refCounts(g);
  const sig = g.web.sigapp?.ely ? 'already has Elysium in its code' : `no Elysium yet (chains: ${(g.web.sigapp?.chains || []).join(', ') || '?'})`;
  const asc = g.web.ascend?.base ? `"${esc(g.web.ascend.base.title || '?')}"${g.web.ascend.base.gated ? ', gated' : ''}` : 'behind a bot wall from GitHub (hourly browser check covers it)';
  const reg = g.web.registry?.listed ? 'listed' : g.web.registry?.found?.length ? `PR ${g.web.registry.found.map((i) => `#${i.n} (${i.s})`).join(', ')}` : 'not listed';
  return `🛡 <b>Ascend/Signal gate watch is armed</b>\n` +
    `References: ${c.Ascend} Ascend and ${c.Signal} Signal contracts.\n` +
    `Team wallets: ${Object.keys(g.team).length}, all quiet on Elysium.\n` +
    `Signal app: ${sig}. Ascend site: ${asc}. Chain registry: ${reg}.\n` +
    `Checks: ${webLine(g)}`;
}
export function gateDigest(state) {
  const g = state.gate;
  if (!g) return '';
  const c = refCounts(g);
  const awake = Object.values(g.team).filter((w) => w.woke).length;
  return `🛡 Gate: ${c.Ascend} Ascend + ${c.Signal} Signal refs · ${Object.keys(g.team).length} team wallets (${awake} active) · ${Object.keys(g.found).length} found · ${webLine(g)}`;
}
export const gatePms = (state) => state.gate?.pms || {};

// ── self test: node elysium-watch/gate.mjs --selftest ──────────────────────────────────────────────
if (process.argv[2] === '--selftest') {
  const out = (...a) => console.log(...a);
  const ok = (b) => (b ? 'OK  ' : 'FAIL');
  out(ok(keccak256('') === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'), 'keccak empty');
  out(ok(createAddress('0xf88929028c0d0932c6c6fafe77267f94c97d3e36', 53) === '0x1ec9a7e83fbfb67b478632d0a759ec64840780b4'), 'CREATE address');
  const ELY = (process.env.ELY_RPCS || 'https://rpc.eleos.fun,https://rpc-live.boxa.club').split(',');
  const call99901 = (m, p) => rpcAt(ELY[0], m, p);
  const hcall = (m, p) => rpcAt('https://rpc.hyperliquid.xyz/evm', m, p);
  for (const [n, f] of [['elysium', () => call99901('eth_blockNumber', [])], ['testnet', () => rpcAt(TESTNET_RPC, 'eth_blockNumber', [])], ['hyperevm', () => hcall('eth_blockNumber', [])]]) {
    try { out('OK  ', n, 'rpc head', Number(BigInt(await f()))); } catch (e) { out('FAIL', n, 'rpc', e.message); }
  }
  const state = {};
  const g = init(state);
  const ctx = { state, rpc: call99901, hrpc: hcall, call: call99901, msgs: [], known: new Set() };
  let done = false;
  for (let i = 0; i < 30 && !done; i++) done = await buildRefs(ctx, g, 150).catch((e) => (out('refs error', e.message), false));
  out(ok(done), 'references', JSON.stringify(refCounts(g)), 'tries left', Object.keys(g.refTry).length);
  const common = await commonSet(ctx, g);
  out('common selectors', common.size);
  const probe = async (label, call, a) => {
    try {
      const rc = await realCode(call, a);
      const an = analyze(rc.code);
      const self = Object.entries(g.refs).find(([k]) => k.endsWith(a));
      const saved = self ? g.refs[self[0]] : null;
      if (saved) delete g.refs[self[0]]; // score against the others, not itself
      const v = evaluate(g, an, common);
      if (saved) g.refs[self[0]] = saved;
      out(`${label}: ${an.size} B, ${an.sels.length} sels → lvl ${v.lvl} ${v.key ? g.refs[v.key].n : '-'} ${v.sc != null ? Math.round(v.sc * 100) + '%' : ''} ${v.sh ?? ''}${v.same ? ' identical' : ''}`);
    } catch (e) { out(label, 'error', e.message); }
  };
  await probe('Ascend launchpad vs rest', (m, p) => rpcAt(TESTNET_RPC, m, p), '0xe2f6254508deb93da081837f545e0baf7b00d8e9');
  await probe('Ascend newest vs rest', (m, p) => rpcAt(TESTNET_RPC, m, p), '0x7e5fe12b78305d2d1e5deef0bed88cc46f19764e');
  await probe('Signal hook testnet vs rest', (m, p) => rpcAt(TESTNET_RPC, m, p), '0xda605da70bff4b32a9b379c614a6d9e4a09baaec');
  await probe('Signal factory r3 (HyperEVM) vs rest', hcall, '0xbacc34d380c82a9c504afac2f74d02f16acfcbb3');
  for (const a of ['0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc', '0x04c6b3b5f11ff5f7ef3635f23e9697e4be8443ad']) await probe('Elysium ' + short(a), call99901, a);
  // recent Elysium contracts: none should match
  try {
    const head = Number(BigInt(await call99901('eth_blockNumber', [])));
    const logs = await call99901('eth_getLogs', [{ fromBlock: '0x' + (head - 1500).toString(16), toBlock: '0x' + head.toString(16) }]);
    const ems = [...new Set(logs.map((l) => lc(l.address)))].slice(0, 120);
    const hits = {};
    await pmap(ems, 6, async (a) => {
      const rc = await realCode(call99901, a);
      if (rc.code.length <= 2) return;
      const an = analyze(rc.code);
      if (an.size < MIN_CODE) return;
      const v = evaluate(g, an, common);
      hits[v.lvl] = (hits[v.lvl] || 0) + 1;
      if (v.lvl) out(`  ${v.lvl === 2 ? 'HIGH' : 'possible'} ${a} → ${g.refs[v.key].n} ${Math.round(v.sc * 100)}% (${v.sh})`);
    });
    out('recent Elysium emitters by level', JSON.stringify(hits));
  } catch (e) { out('recent scan error', e.message); }
  // off-chain sources, each one call
  const msgs = [];
  for (const [n, fn] of [['signal app', () => checkSignalApp(ctx, g, msgs)], ['signal elysium page', () => checkSignalEly(g, msgs)], ['ascend site', () => checkSite(ctx, g, msgs, 'ascend', 'https://ascendlaunch.xyz/', 'Ascend')], ['kinetiq docs', () => checkDocs(g, msgs)], ['ct ascendlaunch.xyz', () => checkCT(g, msgs, 'ascendlaunch.xyz')], ['ct signal.family', () => checkCT(g, msgs, 'signal.family')], ['registry', () => checkRegistry(g, msgs)], ['x AscendLaunch', () => checkX(g, msgs, 'AscendLaunch')], ['x SignalFam', () => checkX(g, msgs, 'SignalFam')]]) {
    const t = Date.now();
    try { await fn(); out('OK  ', n, `${Date.now() - t} ms`); } catch (e) { out('FAIL', n, e.message); }
  }
  out('signal app scripts', g.web.sigapp?.n, 'elysium in app:', !!g.web.sigapp?.ely, '· ascend', JSON.stringify(g.web.ascend?.base ? { s: g.web.ascend.base.s, title: g.web.ascend.base.title, gated: g.web.ascend.base.gated, addrs: g.web.ascend.base.addrs.length, scripts: g.web.ascend.base.scripts.length } : null));
  out('docs', JSON.stringify(Object.fromEntries(Object.entries(g.web.docs?.base || {}).map(([p, c]) => [p, `${c.s} gate=${c.gate} soon=${c.soon} addrs=${c.addrs.length}`]))));
  out('ct', JSON.stringify(Object.fromEntries(Object.entries(g.web.ct || {}).map(([d, s]) => [d, (s.names || []).length]))));
  out('registry', JSON.stringify(g.web.registry || {}));
  out('x', JSON.stringify(g.web.xs || {}));
  out('team on elysium:');
  for (const [a, w] of Object.entries(g.team)) {
    try { out(`  ${w.label}: nonce ${Number(BigInt(await call99901('eth_getTransactionCount', [a, 'latest'])))} · balance ${(Number(BigInt(await call99901('eth_getBalance', [a, 'latest']))) / 1e18).toFixed(3)}`); } catch (e) { out('  ', a, e.message); }
  }
  out('messages that would have been sent:', msgs.length);
  for (const m of msgs) out('---\n' + (typeof m === 'string' ? m : m.text));
  out('armed text preview:\n' + armedText(g));
}

// ── backtest: node elysium-watch/gate.mjs --backtest ────────────────────────────────────────────────
// 1. Recall: each named Ascend/Signal contract is hidden from the references and scored against the rest.
// 2. False alarms: every contract on Elysium that ever emitted an ownership, init, role or mint event is
//    scored in chain order with the live rules (including learning common selectors), and every alert it
//    would have sent is listed.
if (process.argv[2] === '--backtest') {
  const out = (...a) => console.log(...a);
  const ELY = (process.env.ELY_RPCS || 'https://rpc.eleos.fun,https://rpc-live.boxa.club').split(',');
  let ri = 0;
  const call99901 = async (m, p) => { let e; for (let i = 0; i < 4; i++) { try { return await rpcAt(ELY[(ri++) % ELY.length], m, p, 20000); } catch (x) { e = x; if (/revert/i.test(x.message)) throw x; } } throw e; };
  const hcall = (m, p) => rpcAt('https://rpc.hyperliquid.xyz/evm', m, p);
  const tcall = (m, p) => rpcAt(TESTNET_RPC, m, p);
  const state = {};
  const g = init(state);
  const ctx = { state, rpc: call99901, hrpc: hcall, call: call99901, msgs: [], known: new Set() };
  let done = false;
  for (let i = 0; i < 40 && !done; i++) done = await buildRefs(ctx, g, 200).catch(() => false);
  const common = await commonSet(ctx, g);
  out('references', JSON.stringify(refCounts(g)), 'complete:', done, '· common selectors', common.size);

  out('\n== 1. Recall: would each real contract be caught from its other versions? ==');
  for (const [chain, a, name] of NAMED) {
    const key = chain + ':' + a, saved = g.refs[key];
    if (!saved) { out(`  ?    ${name}: not loaded`); continue; }
    // hide it, and anything with the identical build, then score it
    const hidden = Object.entries(g.refs).filter(([k, r]) => k === key || r.k === saved.k);
    for (const [k] of hidden) delete g.refs[k];
    const v = evaluate(g, { sels: saved.s, skel: saved.k + 'x', size: saved.z }, common);
    for (const [k, r] of hidden) g.refs[k] = r;
    const tag = v.lvl === 2 ? 'ALERT' : v.lvl === 1 ? 'maybe' : 'MISS ';
    out(`  ${tag} ${name} (${(saved.z / 1024).toFixed(1)} KB)${v.key ? ` → ${g.refs[v.key].n} ${Math.round(v.sc * 100)}% (${v.sh} shared)` : ''}${hidden.length > 1 ? ` · ${hidden.length - 1} identical builds hidden too` : ''}`);
  }

  out('\n== 2. False alarms: every Elysium contract since block 1, scored in order ==');
  const head = Number(BigInt(await call99901('eth_blockNumber', [])));
  const T_OWN = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
  const T_INIT8 = '0x7f26b83ff96e1f2b6a682f133852f6798a09c465da95921460cefb3847402498';
  const T_INIT64 = '0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2';
  const T_ROLE = '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d';
  const Z = '0x' + '0'.repeat(64);
  const queries = [[T_OWN, Z], [T_TRANSFER, Z], [T_INIT8], [T_INIT64], [T_ROLE], [T_INIT_V4]];
  const first = new Map();
  const wins = [];
  for (let a = 1; a <= head; a += 2000) wins.push([a, Math.min(head, a + 1999)]);
  await pmap(wins, 6, async ([a, b]) => {
    for (const topics of queries) {
      const logs = await call99901('eth_getLogs', [{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics }]).catch(() => []);
      for (const l of logs) {
        const bn = parseInt(l.blockNumber, 16);
        const add = (x, why) => { x = lc(x); if (isAddr(x) && (!first.has(x) || first.get(x).b > bn)) first.set(x, { b: bn, why, tx: l.transactionHash }); };
        add(l.address, 'emitter');
        if (topics[0] === T_INIT_V4) add('0x' + (words(l.data)[2] || '').slice(24), 'hook');
      }
    }
  });
  const list = [...first.entries()].sort((x, y) => x[1].b - y[1].b);
  out(`  ${list.length} contracts found across ${head} blocks`);
  const res = await pmap(list, 8, async ([a]) => { const rc = await realCode(call99901, a); return rc.code.length > 2 ? analyze(rc.code) : null; });
  const levels = { 0: 0, 1: 0, 2: 0 }, small = { n: 0 }, seen = {};
  const hits = [];
  list.forEach(([a, info], i) => {
    const an = res[i];
    if (!an) return;
    if (an.size < MIN_CODE) { small.n++; return; }
    let v = seen[an.skel];
    if (!v) {
      v = evaluate(g, an, (() => { const c = new Set(common); for (const [x, n] of Object.entries(g.freq)) if (n >= FREQ_COMMON) c.add(x); c.skel = common.skel; return c; })());
      seen[an.skel] = v;
      if (v.lvl === 0) for (const s2 of new Set(an.sels)) g.freq[s2] = (g.freq[s2] || 0) + 1;
    }
    levels[v.lvl]++;
    if (v.lvl) hits.push(`  ${v.lvl === 2 ? 'ALERT' : 'maybe'} ${a} (${(an.size / 1024).toFixed(1)} KB, block ${info.b}, ${info.why}) → ${g.refs[v.key].n} ${Math.round(v.sc * 100)}% (${v.sh} shared)`);
  });
  out(`  scored ${levels[0] + levels[1] + levels[2]} (plus ${small.n} under 1 KB): silent ${levels[0]} · possible ${levels[1]} · alert ${levels[2]}`);
  for (const h of hits.slice(0, 40)) out(h);
}
