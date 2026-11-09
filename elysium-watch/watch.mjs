// elysium-watch: launch and volume radar for Elysium mainnet (chain 99901, HYPE gas).
//
// Every scan reads every block since the last one, straight from the chain:
//   1. Pool Initialize events on the launchpads' Uniswap v4 PoolManagers (BOXA, elyspump, Kleos):
//      every new coin, which launchpad, who launched it.
//   2. v4 and v3 Swap events, valued in HYPE, rolled up per coin: volume, buy share, unique buyers.
//   3. Tracked wallets (wallets.json): swaps, token transfers, HYPE moves, contract deploys, launches.
// Alerts go to Telegram: launches that get real traction, tracked-wallet moves (volume-run alerts were removed Nov 9),
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
const EXIT_GROUPS = new Set(String(process.env.EXIT_GROUPS || 'eosteam,eosholder,standsteam,letheteam,maxteam,elytagteam').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// treasury watch: a contract holding a coin's backing that its owner can withdraw (a "strategy" hook's buys).
// Any of that token leaving the contract pings, with who got it and what is left
const TREASURIES = {
  // '0xcontract': { token: '0xbacking token', sym: 'KNTQ', name: 'XYZ hook treasury', coin: '0xthe coin' },
};
// team multisigs that live on other chains: one ping, ever, when each gets code on Elysium (Safes made with the same
// factory and salt land at the same address on every chain). Checked once a minute
const CODE_WATCH = {
  '0x18a82c968b992d28d4d812920eb7b4305306f8f1': 'Kinetiq governance multisig (4 of 8 on HyperEVM)',
  '0x64bd77698ab7c3fd0a1f54497b228ed7a02098e3': 'Kinetiq treasury multisig (4 of 7 on HyperEVM)',
  '0xba85f851202a0b301f62e9139a74c1c3336e21b2': 'Kinetiq Ethereum multisig (3 of 6)',
  '0xc030cee9e03a6dfbda0a817c8bdb4ba44d6d61d0': 'Elysium upgrade multisig (4 of 11)',
  '0xc3205dd89da0b652df64c273c87501dc206dad06': 'Elysium ops multisig 2',
};
// auto-tracking: a tracked wallet funding a fresh wallet
const FUND_MIN_HYPE = 0.2;
const FRESH_MAX_NONCE = 5;       // recipient has sent at most this many txs = fresh wallet
const AUTO_MAX = 500;            // auto-found wallets kept (dead ones are pruned, see housekeeping)
const AUTO_DEAD_DAYS = 3;        // an auto-found wallet that sent no tx for this long is dropped (Cielo wallets stay)

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
  // the official Uniswap v4 PoolManager: several launchpads share it, told apart by their pool hook (HOOK_NAMES)
  '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1': { name: 'Uniswap v4', hook: null, busy: true },
};
// Obol: a bonding-curve launchpad (deployer 0x48ad71ab6467b0d0d9c5e23caf77452a343cdeeb; Elyxa names the venue Obol).
// A coin lives on one of its curve contracts until the curve sells out, with no pool, so pool-based launch alerts
// never saw it: CACHE went from 65 to 870 HYPE market cap on the curve (Nov 7, 05:25 to 06:19) before its first alert.
// Every curve emits TokenCreated(token, creator, …) and Trade(token, trader, isBuy, hype, tokens, fee, reserveHype,
// reserveTokens). The three older curves graduate a coin into a v2 pair of their own and then emit AmmTrade(token,
// trader, isBuy, hype, tokens); 0x4de0 graduates into a Uniswap v4 pool with itself as hook (read as v4 swaps).
// The curves join the launchpad table: a token leaving one is a buy, and the busy-launchpad bar applies.
const OBOL = {
  '0x51d9243d87ad13d7eca55ab57357b2b5fc8241f2': { pair: true },
  '0x7d1904bfb2472a0ef97d886139a4236060e064ab': { pair: true },
  '0xfee823be55ee12b8c3a76aff0bd69470afaf2348': { pair: true }, // VEINS
  '0x4de07902f28d00736e29aa5739dea2d4ce98aacc': { pair: false }, // CACHE
};
const T_OBOL_CREATE = '0x4cd0a4d462d6b9c3511654dab03f7e5b54c5b9197caf767152c81cbe388b4e7b';
const T_OBOL_TRADE = '0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3';
const T_OBOL_AMM = '0x290ae2862e8e7543cd14f560071d8cabd86c52a8308a8f155a759d1e18765c1e';
const OBOL_SELS = ['1622dbe4', '92cdbac5', '0d7a94f6', '7d0f7a88']; // buy, sell, quoteBuy, info: a new Obol curve has them all
const addObol = (a, pair = false) => { OBOL[a] ||= { pair }; LAUNCHPADS[a] ||= { name: 'Obol', hook: null, busy: true }; };
for (const a of Object.keys(OBOL)) addObol(a, OBOL[a].pair);
// Obol deployer: takes 1% of the tokens on every trade through Obol's router, so that leg of a sell is a fee, not a move
const FEE_TAKERS = new Set(['0x48ad71ab6467b0d0d9c5e23caf77452a343cdeeb']);
const HOOK_NAMES = {
  '0xe0def4221b9840a610d4e7d55812a79a6431a8ec': 'Ascend',                // app.ascendlaunch.xyz (CHAMELEON, e/acc, NMEOWS, YUM)
  '0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec': 'Montra',                // montramarkets.xyz, HOBBES and ~80 launches an hour
  '0xe928f2336051cbd5b9d4531c25eadd13f9a82aec': 'Mesa',                  // mesa.cx
  '0x3ea9581a32a396f69b177b65b91149cf887beacc': 'Clanker v5',            // Clanker's own v5 factory, live on Elysium since Nov 4 (TALOS first)
  '0x1bdc2b4dafb0fc46df834559675f8c3308e668cc': 'Boursely',              // one-dev launchpad, fee-sharing hook
  '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': 'a Flaunch fork',        // VOLTA
  '0xb67656ce894ac93c0164d8490ad23161a77ee000': 'PerpMe',                // perpme.fun/elysium, live since Nov 3, coins end in 0999 (also launches on Uniswap v3 and Ramses v3)
  '0x4de07902f28d00736e29aa5739dea2d4ce98aacc': 'Obol',                  // Obol's v4 curve: graduated coins trade on a pool it hooks (CACHE)
};
// launchpads that were already on Elysium before new-launchpad detection: never "new"
const OLD_HOOKS = new Set(['0xe0def4221b9840a610d4e7d55812a79a6431a8ec', '0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec', '0xe928f2336051cbd5b9d4531c25eadd13f9a82aec', '0xb67656ce894ac93c0164d8490ad23161a77ee000', '0x4de07902f28d00736e29aa5739dea2d4ce98aacc']);
// New launchpads: a pool hook never seen before on a shared PoolManager, or a new PoolManager. Only its first coin
// posts (the signal is a new player arriving on chain); later coins follow the usual rules. The contract the launch
// transaction called and the hook are looked up on other chains: the same contracts on Base, BNB, Arbitrum,
// Ethereum or HyperEVM mean an established launchpad moving to Elysium.
const KNOWN_FACTORIES = { '0xca111dcdd2ce924c3378d6514fdcbc46217bca16': 'Clanker v5' };
// Launch contracts with no hook: they mint a coin and open its Uniswap v3 pool (or v2 pair) in the same transaction.
// The hook-only check never saw them, so ORBIT (Nov 8), the first coin of a launch contract that outside wallets use,
// never posted. The 116 such contracts that had launched on Elysium by Nov 8 (a scan of every PoolCreated and
// PairCreated log since genesis) count as known.
const T_POOL_V3 = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
const T_PAIR_V2 = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
const OLD_PADS = new Set(('5afe876a625a6fe230dd361b9a5bef8e9bea6fe3 56f810328a4e42e983f7f487f34776680d6cd7ab b85b1d403ff40f2af77753484b4546abe57788d3 718af7e914c01a6385986d7009e62ba557a8993e 5b8a01a2a99f77ff78a2a68a94e4cf125b3f0150 450fa91b21971c605abe31ee479d46cb1182dd7b e235028fb32cf2ea0577729f7613f504ee7e8888 55c7fcc06339e2d2fc5b444f52c24085c1da2549 8ca88b12bc89b58034c583f1a5df02f7e67d62e1 7700cb672bbd853cf57e82ea14c3ebbaac3ec470 29e30681d02295b59106baae3e42a0e4a8a48888 a4ca8b38f071030dd8ea4e8a3d75a694970ea62e dd9ece123c8c9ee95122b412871c52987e4abcdd 6e3afddc49f5d43858a1fdd48184426ded11029b ab45a955068bd0bc032e1f8f85f9b8136b9ab85d 157b05e438d1aefa6c62e9b42740e3ec0d1904b3 014079a13dc2d84f51807ff73cc86a6c293c5719 f8333ae8817f18ba59cfec27ffde7838e48a695a ea9ccd7d93f75a2a567d418be14d573e12e58888 c9326ed94b44fab87b3eda4e8f66208c90740d53 5742c7c64a31ffff501cfcfd2c4ad152bdc763cd d3b65d20e991a732af81c2f42c86d2c1619e56f8 6ca3eb5f8f1c59d192ca7e798583a884f488f66a a5d26111d563831cbe437c77a1e519697c505a37 f296bb0eaeab6703d876b1bfe9d5693ef302b855 04c6149e93e15358019e19b7e16a92428807da5a 5992a1c109a5f73d44566bc6f679abc4a60e49b7 f3596955a363fd5a3ad8b59999aa7d6df367ec97 c6f9c98e05ede0368dd55602e35c221ceb59e2a0 b0abce39ec602131214954c2203676e27ea33279 dff0fa8b98ef8a4beb3240f5f8af435ad3e94db0 1fae25daaecc5e7946d57f9a34014950a36ca2ac 6f17db548544a19162e82b20c67abee99960a89a a3cb3e57af0aeb4f11049fcc6f336e1f10a67116 017c51147443c5788d6afc34b3f3a813eec828ae 1202a2608f47772b6865e74fa3ce0b5421e89bf3 44dd6598fbef17c4260d3ef66cdba0b403f36b1b e2b349e31c452a68d7a1b03821c38dce0c62791d a5373d105a0ee457cc1d4febe45f7a972f456b2a fb7bc8ed90993d99d0ee77a405f5e7ff41f323f6 2743b771659fd9ce13970d7367e7e84af6a31049 27414ac278111c7f02aec2b82afdd8575e53964f d3fecb7a734bf6e7ea4b41d6d5e57caefde8229c 371811b06bd66c93b46f2f1ffd45b65455a2d2a2 3c5caa33d02c78935fc682a8eb295f0e67b93ced 02eb798f863762c91d38b5d42901f5ec095be3f7 84db5ab5d19bf44ac5f7a2d764a38df678562b5a b0da6e43e5811dd4b16e35abb541190879098eca 3318b09e6e4d222513d8fbcf76205b3c5566d76c b5ab9f0f84d62ac44f56c4f7d6b5081aec9f8fd8 83bb4005d77541837a68d0b1419cedcac6f58050 36f08c044e70d2715cf8de1f15a8853cc2df9192 5106a320982a3c20c241b7050f0d314ae04f21b4 3a529de06ca24b8be26450df38a6490855ac6540 682dc0458815d1f4927d366fa91e645c71024d7b e35b622b0d37d57bf3e4d6930a057e58e7ba30be b7f444558a6ae7ded39e859769bf4497d3feffc5 67fe373f00fe334477f6b923d7a494ebf6a93d83 bc6c6ae19ef7a1ffc71862baaa1e6605cf534561 e3826ce0f0e827d22723b144f1bf1b56a2116563 88e457c64dfa01afe135ea8d8a890ab4ff572f5e ab7cf5084fd979e779890e29af428c5e76cf3042 f43c7a653c06f68e40bcf54fc0a58997466e2463 7a8ef70c8905f0ff9fb93f17f2cc983c6fcd1698 cb0af609ac3de6503789f4826b7e14d9797b9138 7c667328aa8620f8af65748a6b1c521214077e6c cce5d43eade30bec7dc0b314c4bc0f600a670ae4 5e94349a566808bac6150ba3e96452d297545ac6 80d94d0b1c51b3aada498b995e5fe488272fcacf 85c564dfd505a10c7f0ab8de6d476e4283943f94 bf23e9f76c5a1c4dacc3863766681bcc16a3421f c95d9516c88671da94fa977018fc08b8b6e94c5f 39e9300b0057fe09227bc38f6be95518908e558b 0810f6c34794f58e4565675eb197544869bef5ae 0ac9c9446c6b1b79d1eada321a9a0faa282a4326 a405dda37db35ebe4b1cb794495b85fa62b80aa2 71423df77ded296e20267c1f4b480ffd9212cbc4 9216154b5e75fe4f1b40d847607cedc4b56b1a8a e1dec38a4f46230eea5d340ce2dd83be72a36ea9 653c10c2fd77d2b89f67ee29aa712189532263ff c6baf12ccb17f87b8dbbe653ef8eaf5df25a4f5f bdc5a4dcaed4d33735ed440e35a8ef4c97fec07a 76eaf0442045be3f36bf37b3731f5f1f1e947161 ad3e7deee80af3e4fd8c3c58baa7510bce58a969 e783de89a7f0408687f051e3e6d0beb62719ebad b9995773667e5868e7951a46bf840127502484e5 b7485e256796e9079cc1ad32784e1ca2d91102e5 1db2bd4467dca2ab420841348526a5f77b94bc0b 07d544d096e2bf730920d1c9f97faf6f2b144f33 90c9703273e0e6b0be527ad0695cdd98eafe90f7 317885f1133ec0799fd18a23c629e2f787e408e0 e301fc228f83af3cecfdeec54913b11e41ef2430 087203ede0c5af3673dff9de1ef1f2872bc8c4af bbf17b53380e2776d987a1bf3dc8cc600f4a2621 c6dc519451f58dfd27bb2920eefae57597bd91f5 b389e7f7c89dcd17afef88c2a2ec686b20f1f849 0369b8eeb92f1f49a6f446b2b6cb57381484ab7e 4039d2fe39827f1ecc5c78765c36ced638d7348b b0b2a4874893dbc6af39ca7e0b6c2e4c0dc2f59c b3390a61123e05f9bc70ac2e5e4c003fad1aeb9d cf138f449a0f5926db603c89d7be169876cb9ea6 06af211d88e2980c8c86cf8d11277442ce432843 4a026c873e8e4796b3a78a69bd5beeb0f438e622 333d92d95f9abb5e851f84dae136e12beb4e0c86 c392f5a1b8bc1385725baec807a354747ab92927 dcaa92a2d3c538c448eeaa6a354f3e62ecfcbd2e 694bab604491d08dcdb7d9166499f00d7e8bd367 373adbb2b9bae4a519e58075828faec36102190e 706e612487cd67fa727c93a5a4c9657b1346eb67 6c9f6a7ca3ca84e0eb1a3b809ae83c056e990a2f b0e31e1258f13080b3c909798b46f686af76db7e a79b5fe706fda9aa55b642c7c56a00ab912963d8 b045959d289dba0d2e4403ba9e7ecc1cbf8ac0a5 54345d7640c4fdea5b14e8fdb2777d747e41de07 cbe0a1fc5293ceec51ea31681f2e045df6173b1a 853d133bd1a2ecb6b7f80de225bf370cd0ef7851').split(' ').map((a) => '0x' + a));
const PAD_NAMES = { '0xcbe0a1fc5293ceec51ea31681f2e045df6173b1a': 'Bankr' }; // ORBIT and 6 more, each by a different wallet
// A new launchpad posts on its first coin, whoever launched it (the pad's own deployer or an outside wallet, the alert
// says which). Coins named test or canary are held, and named when the next coin posts.
const TEST_NAME = /test|canary/i;
// A launchpad's name, when the lists above don't have it: the coin's own metadata usually says where it was made
// (ORBIT's says launch_provider bankr, SZN's schema is chainzy.launch-token-metadata.v1, Clanker coins carry an
// interface), else a name the launch contract or hook reports about itself, else the tracked label of its deployer.
const META_SELS = ['3c130d90', 'eac989f8', 'e8a3d485', '392f37e9', 'd0496d6a', 'f5b2cad7', '7a5b4f59']; // tokenURI uri contractURI metadata context tokenMetadata getMetadata
const NAME_SELS = ['d721fe02', 'f3a9b2bc', 'e567e869', '4bde38c8', 'a3f4df7e', '06fdde03']; // platformName launchpadName protocolName platform NAME name
const PAD_KEYS = ['launch_provider', 'launchprovider', 'launchpad', 'launch_pad', 'interface', 'deployed_via', 'deployedvia', 'created_on', 'createdon', 'created_with', 'platform', 'provider', 'app', 'source'];
const NOT_A_PAD = /^(x|twitter|farcaster|telegram|web|website|unknown|none|n\/a|null|elysium|hyperevm|erc20|token)$/i;
const strOf = (hex) => {
  const w = words(hex || '0x');
  try { if (w.length >= 2 && BigInt('0x' + w[0]) === 32n) { const n = Number(BigInt('0x' + w[1])); if (n > 0 && n < 20000) return Buffer.from(hex.slice(130, 130 + n * 2), 'hex').toString('utf8').replace(/\0/g, '').trim(); } } catch {}
  return '';
};
async function readMeta(u) {
  try {
    if (u.startsWith('{')) return JSON.parse(u);
    const d = /^data:application\/json(;base64)?,([\s\S]*)$/i.exec(u);
    if (d) return JSON.parse(d[1] ? Buffer.from(d[2], 'base64').toString('utf8') : decodeURIComponent(d[2]));
    const cid = /^ipfs:\/\/(?:ipfs\/)?(\S+)$/.exec(u)?.[1];
    for (const url of cid ? ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'].map((g) => g + cid) : /^https:\/\//.test(u) ? [u] : []) {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
      if (r?.ok) return await r.json().catch(() => null);
    }
  } catch {}
  return null;
}
function padNameIn(m) {
  if (!m || typeof m !== 'object') return null;
  const ok = (v) => typeof v === 'string' && v.trim() && v.length <= 40 && !NOT_A_PAD.test(v.trim()) && !/^0x[0-9a-f]{40}$/i.test(v.trim());
  const norm = (k) => lc(k).replace(/[\s-]/g, '_');
  const attrs = Array.isArray(m.attributes) ? m.attributes : [];
  for (const k of PAD_KEYS) {
    const a = attrs.find((x) => norm(x?.trait_type) === k);
    if (ok(a?.value)) return [a.value.trim(), `${a.trait_type} in the coin's metadata`];
    const key = Object.keys(m).find((x) => norm(x) === k);
    if (key && ok(m[key])) return [m[key].trim(), `${key} in the coin's metadata`];
  }
  if (typeof m.schema === 'string' && /^[a-z][\w-]{2,}\./i.test(m.schema)) return [m.schema.split('.')[0], "the coin's metadata schema"];
  const by = /\b(?:deployed|launched|created|made|minted)\s+(?:using|on|via|with|through)\s+(@?[\w.-]{3,30})/i.exec(String(m.description || ''));
  if (by && ok(by[1])) return [by[1], "the coin's description"];
  for (const u of [m.external_url, m.website, m.url]) {
    try { const h = new URL(u).hostname.replace(/^www\./, ''); if (!/(^|\.)(x|twitter|t|github|imgur|pinata|ipfs|arweave|dexscreener|elyxa)\.(com|me|io|cloud|net|trade)$/.test(h)) return [h, "the coin's website"]; } catch {}
  }
  return null;
}
const titled = (s) => (/^[a-z0-9]+$/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);
async function padName(coin, addrs, coinName) {
  for (const sel of META_SELS) {
    const u = strOf(await rpc('eth_call', [{ to: coin, data: '0x' + sel }, 'latest'], 2).catch(() => '0x'));
    const hit = u ? padNameIn(await readMeta(u)) : null;
    if (hit) return [titled(hit[0]), hit[1]];
  }
  for (const a of addrs.filter((x) => x && x !== coin)) for (const sel of NAME_SELS) {
    const s = strOf(await rpc('eth_call', [{ to: a, data: '0x' + sel }, 'latest'], 2).catch(() => '0x'));
    if (s && s.length <= 40 && s !== coinName && !NOT_A_PAD.test(s)) return [s, 'the contract names itself'];
  }
  return null;
}
// the wallet that deployed a contract: the first block holding its code (a binary search over archive state), then the
// creation tx in that block, or the one user tx it holds (Elysium blocks carry one, and CREATE2 deploys through
// 0x4e59…956c or CreateX are sent by the deployer). Null when the RPC has no archive state or the block is ambiguous.
const PM_V4 = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1'; // live since block 256083: its code at an old block proves archive state
const depCache = {};
async function deployerOf(addr) {
  if (!addr || addr === ZERO) return null;
  if (addr in depCache) return depCache[addr];
  let dep = null;
  try {
    const hx = (b) => '0x' + b.toString(16);
    const has = async (a, b) => String(await rpc('eth_getCode', [a, hx(b)], 2)).length > 2;
    let hi = parseInt(await rpc('eth_blockNumber', [], 2), 16), lo = 0;
    if (await has(addr, hi)) {
      while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await has(addr, m)) hi = m; else lo = m; }
      if (hi > 256084 && (await has(PM_V4, hi - 1))) {
        const txs = ((await rpc('eth_getBlockByNumber', [hx(hi), true], 2))?.transactions || []).filter((t) => parseInt(t.type, 16) !== 0x6a);
        for (const t of txs) if (!t.to && !dep) { const r = await rpc('eth_getTransactionReceipt', [t.hash], 2); if (lc(r?.contractAddress) === addr) dep = lc(t.from); }
        if (!dep && txs.length === 1) dep = lc(txs[0].from);
      }
    }
  } catch {}
  return (depCache[addr] = dep);
}
const XCHAINS = [['Base', 'https://base-rpc.publicnode.com'], ['BNB', 'https://bsc-rpc.publicnode.com'], ['Arbitrum', 'https://arbitrum-one-rpc.publicnode.com'], ['Ethereum', 'https://ethereum-rpc.publicnode.com'], ['HyperEVM', 'https://rpc.hyperliquid.xyz/evm']];
// contracts that sit at the same address on every chain and say nothing about a launchpad (multicall, Permit2,
// CREATE2 deployers)
const XCHAIN_SKIP = new Set(['0xca11bde05977b3631167028862be2a173976ca11', '0x000000000022d473030f116ddee9f6b43ac78ba3', '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', '0x4e59b44847b379578588920ca78fbf26c0b4956c', '0x914d7fec6aac8cd542e72bca78b30650d45643d7', '0x0000000000ffe8b47b3e2130213b802212439497']);
const MAX_NEW_LP_ALERTS = 3;      // per scan
// Rug kits: launch contracts that can pull the whole pool back to their owner (an owner-only
// removeAllLiquidity(address,uint256)). Seen Nov 6 as CITADEL, KALOS, BUNNY and KINAGENT, each on a pool manager of
// its own and pulled 1 to 2 minutes after launch. They never post as a new launchpad, and every coin they launch is
// muted, so a tracked wallet buying one stays quiet too.
const RUG_SELECTORS = ['66e2d97e'];
async function rugKit(addrs) {
  for (const a of addrs.filter((x) => x && x !== ZERO)) {
    try { const c = lc(await rpc('eth_getCode', [a, 'latest'])); if (RUG_SELECTORS.some((sel) => c.includes('63' + sel))) return a; } catch {}
  }
  return null;
}
async function deployedElsewhere(addrs) {
  const list = [...new Set(addrs.filter((a) => a && a !== ZERO && !XCHAIN_SKIP.has(a)))];
  const hits = new Set(), answered = new Set();
  await Promise.all(XCHAINS.flatMap(([name, url]) => list.map(async (a) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [a, 'latest'] }), signal: AbortSignal.timeout(6000) }).then((x) => x.json());
      if (typeof r.result === 'string') answered.add(name);
      if (typeof r.result === 'string' && r.result.length > 4) hits.add(name);
    } catch {}
  })));
  // chains: where the contracts also live; checked: how many chains answered (0 = the lookup itself failed)
  return { chains: XCHAINS.map(([n]) => n).filter((n) => hits.has(n)), checked: list.length ? answered.size : -1 };
}
// a coin's launchpad: the launch contract for a coin minted with its v3 pool or v2 pair, its hook on a shared
// PoolManager, else its PoolManager
const lpKeyOf = (rec) => (rec?.pad ? 'v:' + rec.via : rec?.hook && rec.hook !== ZERO && LAUNCHPADS[rec.lp]?.busy ? 'h:' + rec.hook : 'pm:' + rec?.lp);
const oldLp = (key) => (key.startsWith('v:') ? OLD_PADS.has(key.slice(2)) : key.startsWith('h:') ? OLD_HOOKS.has(key.slice(2)) : !!LAUNCHPADS[key.slice(3)] && !LAUNCHPADS[key.slice(3)].fresh);
// a launchpad name for a coin: its pool's hook when that hook is a known launchpad, else its PoolManager
const lpNameOf = (rec, dflt = 'unknown launchpad') => HOOK_NAMES[rec?.hook] || LAUNCHPADS[rec?.lp]?.name || (rec?.pad && PAD_NAMES[rec.via]) || (rec?.lp === 'uniswap' ? (rec.pad ? `Uniswap ${rec.pad}` : 'Uniswap') : dflt);
// a launch on a busy shared PoolManager needs more traction before 🚀 (about 80 coins an hour launch there)
const BUSY_MIN_BUYERS = 25;
const BUSY_MIN_USD = 5000;
const BOXA_PM = '0x06c63714fbf1f5753017123e2fcfdede4540b2c4';
const LP_NAMES = [...new Set(Object.values(LAUNCHPADS).map((x) => x.name))].join(', ');
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
const T_SAFE_PROXY = '0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235'; // Safe factory ProxyCreation(address,address)
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
// a coin opens on the launchpad it launched on (its pool hook first, then its PoolManager), else on Elyxa.
// Token page formats as each launchpad's own site links them.
const LP_PAGES = {
  '0xe0def4221b9840a610d4e7d55812a79a6431a8ec': ['Ascend', (t) => `https://app.ascendlaunch.xyz/tokens/${t}`],
  '0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec': ['Montra', (t) => `https://montramarkets.xyz/token/${t}`],
  '0xe928f2336051cbd5b9d4531c25eadd13f9a82aec': ['Mesa', (t) => `https://mesa.cx/markets/elysium/${t}`],
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4': ['BOXA', (t) => `https://boxa.club/asset?address=${t}`],
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490': ['Kleos', (t) => `https://www.thekleos.xyz/token/${t}`],
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600': ['ElysPump', (t) => `https://elysp.com/#/token/${t}`],
  '0xb67656ce894ac93c0164d8490ad23161a77ee000': ['PerpMe', (t) => `https://perpme.fun/elysium/token/${t}`],
};
// PerpMe also launches straight into Uniswap v3 and Ramses v3 pools (no hook to go by): its coins all end in 0999
const PERPME_V3 = (t, r) => r.lp === 'uniswap' && t.endsWith('0999') && LP_PAGES['0xb67656ce894ac93c0164d8490ad23161a77ee000'];
const ELYXA_PAGE = ['Elyxa', (t) => `${ELYXA}/#/terminal/${t}`];
let TOKS = {};           // coin → { lp, hook }: the main scan's state.tok (the fast lane's copy of it)
const LIVE_TOKS = {};    // coins whose pool the fast lane saw open since its last read of state.json
// an Initialize log seen by the fast lane: its coin's launchpad, until the main scan has recorded the coin
const noteLaunchpad = (tok, l) => {
  const c0 = lc(topicAddr(l.topics[2])), c1 = lc(topicAddr(l.topics[3])), coin = isHype(c0) ? c1 : isHype(c1) ? c0 : null;
  if (coin && !tok[coin]) LIVE_TOKS[coin] = { lp: lc(l.address), hook: lc('0x' + (words(l.data)[2] || '').slice(24)) };
};
const pageOf = (t) => { const r = LIVE_TOKS[t] || TOKS[t]; return (r && (LP_PAGES[r.hook] || LP_PAGES[r.lp] || PERPME_V3(t, r))) || ELYXA_PAGE; };
const assetLink = (t, label = 'chart') => `<a href="${pageOf(t)[1](t)}">${label}</a>`;
// wallets open on Elyxa's portfolio page; tx links go to Kinetiq's explorer (partner-only until public launch)
const EXPLORER = 'https://elysium.kinetiq.xyz/explorer';
const walletLink = (a, label) => `<a href="${ELYXA}/#/portfolio?w=${a}">${label || short(a)}</a>`;
const txLink = (h) => (h ? ` · <a href="${EXPLORER}/transaction/${h}">tx</a>` : '');

let rpcIdx = 0;
const FAST_MODE = process.argv.includes('--fast');
const rpcStats = { retries: 0 }; // calls that needed a second try or another RPC (fast lane timing line)
async function rpc(method, params, tries = 6) {
  let lastErr;
  if (FAST_MODE) rpcIdx = 0; // the fast lane always starts on the first (fastest) RPC instead of staying on a fallback
  for (let i = 0; i < tries; i++) {
    if (i > 0) rpcStats.retries++;
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(FAST_MODE ? 5000 : 20000), // the fast lane gives up on a hung RPC quickly and tries the next
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

// run fn over items, n at a time (per-coin reads in a launch flood: Nov 7, ~1,000 Montra launches an hour, and one
// RPC round trip after another put the main scan half an hour behind the chain)
async function pmap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
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
const coinLink = (state, t) => `${assetLink(t, `open on ${pageOf(t)[0]}`)} · <a href="${BUY_PAGE}?t=${t}">quick buy</a>`;

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
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(FAST_MODE ? 5000 : 15000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      hIdx = (hIdx + i) % HYPER_RPCS.length;
      return j.result;
    } catch (e) { last = e; await sleep(300); }
  }
  throw new Error(`hyperevm ${method}: ${last?.message}`);
}

// who really sent a bridge deposit: Elysium only shows the HyperEVM sender aliased, and when that sender is a helper
// contract (bridge(address,uint256,uint256,uint256) at 0xa401…) the person behind it is lost. The receipt names the
// HyperEVM block the message came from and the ticket carries its message number, so one log query on Elysium's Inbox
// finds the HyperEVM tx and its sender. A few lookups per run, cached.
const ELY_INBOX = '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff';
const T_INBOX_MSG = '0xff64905f73a67fb594e0f940a8075a860db489ad991e032f48c81123eb52d60b'; // InboxMessageDelivered(uint256,bytes)
const hsend = new Map();
let hsendLeft = 12;
// a tracked wallet's call made from HyperEVM straight into an Elysium contract (a retryable ticket carrying calldata,
// like sprucecliff buying an NFT on Elysian Fields' marketplace on Nov 7): what it did, from the tokens that reached
// the wallet in that tx. Not HYPE sent to another wallet.
async function bridgedCall(state, tx, to, src, val, logs, px) {
  const got = logs.filter((l) => l.transactionHash === tx.hash && l.topics[0] === T_TRANSFER && l.topics[2] && lc(topicAddr(l.topics[2])) === src);
  const paid = `${hype(val)}${px ? ` (${usd(val * px)})` : ''}`;
  const nft = got.find((l) => l.topics.length === 4);
  if (nft) {
    const m = await tokenMeta(state, lc(nft.address)).catch(() => null);
    return `🌉 <b>bought ${esc(m?.n || 'an NFT')} #${BigInt(nft.topics[3]).toString()}</b> for ${paid} straight from HyperEVM (marketplace ${walletLink(to)})`;
  }
  const ft = got.find((l) => l.topics.length === 3 && (l.data || '0x') !== '0x');
  if (ft) {
    const t = lc(ft.address), m = await tokenMeta(state, t).catch(() => null);
    return `🌉 <b>bought ${fmtAmt(Number(BigInt(ft.data)) / 10 ** (m?.d ?? 18))} ${esc(m?.s || 'tokens')}</b> for ${paid} straight from HyperEVM · ${coinLink(state, t)}`;
  }
  return `🌉 <b>called ${walletLink(to)}</b> with ${paid} straight from HyperEVM (a contract call, not a transfer)`;
}
async function hyperSender(tx, blk) {
  const key = tx.ticketId || tx.hash;
  if (hsend.has(key)) return hsend.get(key);
  if (hsendLeft <= 0) return null;
  hsendLeft--;
  let who = null;
  try {
    // a retry (0x68) points at its ticket (0x69, same block), which holds the message number; a deposit (0x64) holds it itself
    const sub = tx.ticketId ? ((blk?.transactions || []).find((x) => x.hash === tx.ticketId) || await rpc('eth_getTransactionByHash', [tx.ticketId])) : tx;
    const rc = await rpc('eth_getTransactionReceipt', [tx.ticketId || tx.hash]);
    if (sub?.requestId && rc?.l1BlockNumber) {
      const logs = await hrpc('eth_getLogs', [{ address: ELY_INBOX, fromBlock: rc.l1BlockNumber, toBlock: rc.l1BlockNumber, topics: [T_INBOX_MSG, '0x' + BigInt(sub.requestId).toString(16).padStart(64, '0')] }]);
      const h = logs?.[0]?.transactionHash;
      if (h) { const ht = await hrpc('eth_getTransactionByHash', [h]); if (ht?.from) who = lc(ht.from); }
    }
  } catch {}
  hsend.set(key, who);
  return who;
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
  TOKS = (state.tok ||= {}); // coin links open on each coin's own launchpad
  // pool managers the gate identified as Ascend or Signal join the launchpad list
  for (const [pm, x] of Object.entries(gatePms(state))) if (!LAUNCHPADS[pm]) { LAUNCHPADS[pm] = { name: x.name, hook: x.hook }; INFRA.add(pm); }
  // Obol curves found in earlier runs (a new curve contract with the same code)
  for (const [a, x] of Object.entries(state.obolSeen || {})) if (x) { addObol(a, !!x.pair); INFRA.add(a); }
  // new-launchpad detection, first start: every launchpad already seen counts as known (before this scan adds
  // anything), Clanker v5 included (TALOS was its first coin here, Nov 6)
  state.lpSeen ||= {};
  if (!state.lpSeedV) {
    for (const r of Object.values(state.tok)) if (r.lp) state.lpSeen[lpKeyOf(r)] ||= { at: r.born || now(), n: 0, seeded: 1 };
    state.lpSeen['h:0x3ea9581a32a396f69b177b65b91149cf887beacc'] ||= { at: now(), n: 0, seeded: 1 };
    state.lpSeedV = 1;
  }
  // new-launchpad detection v2 posts on the first coin from an outside wallet instead of the first coin: launchpads
  // that already posted (or were passed over) stay done
  if (state.lpSeedV !== 2) {
    for (const x of Object.values(state.lpSeen)) if (x.n >= 1 && !x.seeded) x.posted ||= x.at || now();
    state.lpSeedV = 2;
  }
  // names found by new-launchpad detection carry over to later coins from the same hook or launch contract
  for (const [k, x] of Object.entries(state.lpSeen || {})) if (x.name && !x.seeded) { if (k.startsWith('h:') && k.slice(2) !== x.first) HOOK_NAMES[k.slice(2)] ||= x.name; if (k.startsWith('v:')) PAD_NAMES[k.slice(2)] ||= x.name; }
  // PoolManagers found by new-launchpad detection join the list too
  for (const [k, x] of Object.entries(state.lpSeen || {})) if (k.startsWith('pm:') && !LAUNCHPADS[k.slice(3)] && !x.seeded) { LAUNCHPADS[k.slice(3)] = { name: x.name || `a new launchpad (${short(k.slice(3))})`, hook: null, fresh: true }; INFRA.add(k.slice(3)); }
  let wallets = [];
  try { wallets = JSON.parse(fs.readFileSync(WALLETS, 'utf8')); } catch {}
  const okW = wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address));
  const W = new Map(okW.map((w) => [lc(w.address), w.label || short(w.address)]));
  const G = new Map(okW.filter((w) => w.group).map((w) => [lc(w.address), String(w.group)]));
  // dev wallets watched for launches only (wallets.json "watch": "launch", "coins": the runners they made): a new coin,
  // a contract deploy, a bundle split, 25+ HYPE moved, and sells of their own coins. Their routine
  // trading stays quiet; their group still counts toward group buys.
  const DEVW = new Map(okW.filter((w) => w.watch === 'launch').map((w) => [lc(w.address), new Set((w.coins || []).map(lc))]));
  // "watch": "all" (team and insider wallets): every normal ping stays, plus the 🛬 first move on Elysium that
  // launch-watched devs get. Multisig work (a Safe made, a Safe tx executed) pings for every tracked wallet
  const FIRSTW = new Set(okW.filter((w) => w.watch === 'launch' || w.watch === 'all').map((w) => lc(w.address)));
  const { noCluster, owner } = walletLinks(okW);
  // wallets the watcher found on its own (fresh wallets funded by tracked ones) live in state
  state.auto ||= {};
  state.gbuys ||= {};
  for (const a of FEE_WALLETS) delete state.auto[a]; // followed by mistake as an alt before the bot-fee pattern was known
  // bridge tracking is off (Nov 9): the auto-found bridgers and the alts found through them are dropped for good
  for (const [a, x] of Object.entries(state.auto)) if (x.from === 'bridge' || /^bridger \d/.test(x.label || '')) delete state.auto[a];
  // the ORPHEUS early snipers left wallets.json (Nov 9, spam): any alts found through them go too (the dev's stay)
  for (const [a, x] of Object.entries(state.auto)) if (/^ORPHEUS (early|block-1 sniper|sniper cluster|bundle)/.test(x.label || '')) delete state.auto[a];
  delete state.bridged; delete state.bridgerDump;
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

  const tStart = Date.now();
  let tLogs = 0, tGate = 0, tGateEnd = 0; // where a tick's time goes (the done line), to see a slow phase at once
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
  tLogs = Date.now();
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
    }
    if (!state.tok[coin]) {
      const b = parseInt(l.blockNumber, 16);
      const born = Math.round(tFrom + ((b - from) / Math.max(head - from, 1)) * (tTo - tFrom));
      const hook = lc('0x' + (words(l.data)[2] || '').slice(24)); // Initialize data: fee, tickSpacing, hooks, sqrtPrice, tick
      state.tok[coin] = { lp: pm, hook, born, vol: 0, buyVol: 0, swaps: 0, buyers: [], creator: null };
      launchTxs.push({ coin, tx: l.transactionHash, block: parseInt(l.blockNumber, 16) });
    }
  }
  // 1b. Obol coins: born on a curve with no pool. A new curve contract (an Obol log from an address with Obol's code)
  // joins the list once and posts once.
  state.obolSeen ||= {};
  for (const a of [...new Set(logs.filter((l) => l.topics[0] === T_OBOL_CREATE || l.topics[0] === T_OBOL_TRADE).map((l) => lc(l.address)))]) {
    if (OBOL[a] || a in state.obolSeen) continue;
    let code = '';
    try { code = lc(await rpc('eth_getCode', [a, 'latest'])); } catch { continue; }
    const ok = OBOL_SELS.every((sel) => code.includes('63' + sel));
    state.obolSeen[a] = ok ? { at: now(), pair: false } : 0;
    if (!ok) continue;
    addObol(a); INFRA.add(a);
    bump('obol new curve');
    if (!firstRun) msgs.push(`🧪 <b>Obol has a new curve contract</b>
Its coins now count as Obol launches.
<code>${a}</code>`);
  }
  for (const l of logs) {
    if (l.topics[0] !== T_OBOL_CREATE || l.topics.length < 3 || !OBOL[lc(l.address)]) continue;
    const coin = lc(topicAddr(l.topics[1]));
    if (state.tok[coin]) continue;
    const b = parseInt(l.blockNumber, 16);
    const born = Math.round(tFrom + ((b - from) / Math.max(head - from, 1)) * (tTo - tFrom));
    state.tok[coin] = { lp: lc(l.address), hook: null, born, vol: 0, buyVol: 0, swaps: 0, buyers: [], creator: lc(topicAddr(l.topics[2])) };
    launchTxs.push({ coin, tx: l.transactionHash, block: b });
  }
  // 1c. coins minted and given a Uniswap v3 pool or v2 pair in the same tx (a launch contract with no hook). A pair
  // opened for a coin minted earlier is a plain listing and stays out. These go first: the lookups below take 40.
  const mintedIn = {};
  for (const l of logs) if (l.topics[0] === T_TRANSFER && l.topics.length === 3 && lc(topicAddr(l.topics[1])) === ZERO) (mintedIn[l.transactionHash] ||= new Set()).add(lc(l.address));
  const padTxs = [];
  for (const l of logs) {
    const v3 = l.topics[0] === T_POOL_V3;
    if ((!v3 && l.topics[0] !== T_PAIR_V2) || l.topics.length < 3) continue;
    const m = mintedIn[l.transactionHash];
    if (!m) continue;
    const t0 = lc(topicAddr(l.topics[1])), t1 = lc(topicAddr(l.topics[2]));
    const coin = m.has(t0) && !m.has(t1) && !isHype(t0) ? t0 : m.has(t1) && !m.has(t0) && !isHype(t1) ? t1 : null;
    if (!coin || state.tok[coin]) continue;
    const pool = lc('0x' + (words(l.data)[v3 ? 1 : 0] || '').slice(24)); // PoolCreated data: tickSpacing, pool; PairCreated: pair, count
    if (v3 && /^0x[0-9a-f]{40}$/.test(pool)) state.v3[pool] = { t0, t1 };
    const b = parseInt(l.blockNumber, 16);
    const born = Math.round(tFrom + ((b - from) / Math.max(head - from, 1)) * (tTo - tFrom));
    state.tok[coin] = { lp: 'uniswap', hook: null, pad: v3 ? 'v3' : 'v2', factory: lc(l.address), born, vol: 0, buyVol: 0, swaps: 0, buyers: [], creator: null };
    padTxs.push({ coin, tx: l.transactionHash, block: b });
  }
  launchTxs.unshift(...padTxs);
  // who launched each new coin (one tx lookup per launch, 12 at a time: a flood can bring dozens a tick)
  const tLaunch = Date.now();
  await pmap(launchTxs.slice(0, 40), 12, async ({ coin, tx }) => {
    try { const x = await rpc('eth_getTransactionByHash', [tx]); state.tok[coin].creator = lc(x?.from); state.tok[coin].via = lc(x?.to); } catch {}
  });
  // launchpads new to Elysium: their first coin that isn't a test posts, nothing after that
  let newLpAlerts = 0, newLpChecks = 0;
  for (const { coin, block } of launchTxs.slice(0, 40)) {
    const rec = state.tok[coin];
    if (!rec) continue;
    // a coin that opens its own pool from its constructor, or through a shared helper, has no launch contract to follow
    if (rec.pad && (!rec.via || XCHAIN_SKIP.has(rec.via))) continue;
    const key = lpKeyOf(rec);
    // PerpMe's v3 launches (coins ending in 0999): a known launchpad, whichever launch contract version it uses
    if (rec.pad && coin.endsWith('0999') && !state.lpSeen[key]) { state.lpSeen[key] = { at: now(), n: 0, seeded: 1 }; continue; }
    if (oldLp(key) && !state.lpSeen[key]) continue;
    let s = state.lpSeen[key];
    // each new launch contract or hook costs about 50 RPC calls (deployer search, other chains): at most 6 a tick, so a
    // flood of one-off coins that are their own hook (AGENTS, BLURB, AELYNT) cannot stall the scan
    if (!s && ++newLpChecks > 6) continue;
    if (!s) {
      const addr = key.slice(key.indexOf(':') + 1);
      const rug = await rugKit([rec.via, addr]);
      if (rug) { s = state.lpSeen[key] = { at: now(), n: 0, first: coin, via: rec.via || null, rug }; console.log('new-launchpad check: a rug kit (its launch contract can pull the pool), muted'); }
    }
    if (s?.rug) { (state.mutedCoins ||= {})[coin] = now(); bump('rug kit muted'); continue; }
    if (!s) {
      const addr = key.slice(key.indexOf(':') + 1);
      // a launch contract that had already created several contracts before this coin has launched coins before: a
      // launchpad the watcher never saw (PerpMe had 243 coins when its first one here posted as "new"), not a new one.
      // A router or the PoolManager itself stays at nonce 1, so those still count as new.
      let made = 0;
      if (rec.via && block > 1) try { made = parseInt(await rpc('eth_getTransactionCount', [rec.via, '0x' + (block - 1).toString(16)]), 16) - 1; } catch {}
      if (made >= 3) { state.lpSeen[key] = { at: now(), n: 0, first: coin, via: rec.via, seeded: 1, made }; console.log(`new-launchpad check: an established launcher (${made} contracts made before), skipped`); continue; }
      const known = KNOWN_FACTORIES[rec.via] || PAD_NAMES[rec.via] || null;
      // who deployed the launch contract and the hook (or PoolManager), and what the launchpad calls itself
      const meta0 = await tokenMeta(state, coin);
      const [{ chains, checked }, deps, named] = await Promise.all([
        deployedElsewhere([rec.via, addr]),
        Promise.all([...new Set([rec.via, addr].filter(Boolean))].map(deployerOf)),
        known ? null : padName(coin, [rec.via, addr], meta0.n),
      ]);
      const dep = [...new Set(deps.filter(Boolean))];
      const tracked = dep.find((d) => W.has(d));
      const fromLabel = tracked ? W.get(tracked).replace(/\s*\(.*$/, '').replace(/\s+(mainnet\s+|vanity\s+)?(dev|deployer|team|main|alt|wallet)\b.*$/i, '').trim() : '';
      const name = known || named?.[0] || fromLabel || null;
      const nameSrc = known ? '' : named ? named[1] : fromLabel ? 'your label for its deployer' : '';
      s = state.lpSeen[key] = { at: now(), n: 0, first: coin, via: rec.via || null, name, nameSrc, chains, checked, migrated: !!known || chains.length > 0, dep };
      console.log(`new-launchpad check: deployer ${dep.length ? 'found' : 'not found'}, name ${name ? 'found' : 'not found'}`);
      // later coins from it carry the name too (launch lines, /stats)
      if (name && key.startsWith('h:') && key.slice(2) !== coin) HOOK_NAMES[key.slice(2)] ||= name;
      if (name && key.startsWith('v:')) PAD_NAMES[key.slice(2)] ||= name;
      if (key.startsWith('pm:') && !LAUNCHPADS[addr]) { LAUNCHPADS[addr] = { name: name || `a new launchpad (${short(addr)})`, hook: null, fresh: true }; INFRA.add(addr); if (state.unknownPm[addr]) state.unknownPm[addr].alerted = now(); }
    }
    if (s.seeded) continue;
    s.n++;
    if (s.posted) continue;
    if (firstRun) { s.posted = now(); continue; }
    const meta = await tokenMeta(state, coin);
    // a test or canary coin: held, and named when the next coin posts
    if (TEST_NAME.test(`${meta.s} ${meta.n}`)) {
      s.held ||= { coin, s: meta.s };
      bump('new launchpad held');
      continue;
    }
    if (newLpAlerts >= MAX_NEW_LP_ALERTS) continue;
    newLpAlerts++;
    s.posted = now();
    state.alerted['n:' + coin] = { t: now() };
    const v = key.startsWith('v:'), h = key.startsWith('h:');
    const self = h && key.slice(2) === coin; // the coin is its own hook: a contract set built for this one coin
    const where = s.name || (self ? 'unnamed, a one-off' : v ? `unnamed launch contract ${short(key.slice(2))}` : h ? `unnamed hook ${short(key.slice(2))}` : `unnamed PoolManager ${short(key.slice(3))}`);
    const team = (s.dep || []).filter((d) => W.has(d));
    const byDev = !!rec.creator && !!s.dep?.includes(rec.creator);
    const depLine = s.dep?.length ? `Deployed by ${s.dep.map((d) => walletLink(d) + (W.has(d) ? ` (👛 ${esc(W.get(d))})` : '')).join(' and ')}\n` : '';
    const text =
      `🆕 <b>New launchpad: ${esc(where)}</b>\n` +
      (s.nameSrc ? `Name from ${esc(s.nameSrc)}.\n` : !s.name ? `No name on chain: the coin carries no metadata and the contracts don't name themselves.\n` : '') +
      (self ? 'The coin is its own hook, launched through a factory made for it.\n' : v ? `Mints each coin and opens its Uniswap ${rec.pad === 'v2' ? 'v2 pair' : 'v3 pool'} in one tx.\n` : '') +
      (s.migrated ? `Established elsewhere: ${s.chains.length ? `the same contracts are live on ${s.chains.join(', ')}` : 'a known launchpad'}. A new player arriving on Elysium.\n` : s.checked === 0 ? 'Could not reach other chains to check where else it lives.\n' : team.length ? 'Not found on Base, BNB, Arbitrum, Ethereum or HyperEVM: built by a tracked team.\n' : 'Not found on Base, BNB, Arbitrum, Ethereum or HyperEVM: a new team.\n') +
      depLine +
      (s.held ? `Before this: ${esc(s.held.s)}, a test coin.\n` : '') +
      `First coin: <b>${esc(meta.s)}</b> (${esc(meta.n)})${rec.creator ? ` · launched by ${walletLink(rec.creator)}${W.has(rec.creator) ? ` (👛 ${esc(W.get(rec.creator))})` : ''}${s.dep?.length ? (byDev ? ', the launchpad\'s own dev' : ', an outside wallet') : ''}` : ''}\n` +
      (v ? `Launch contract <code>${key.slice(2)}</code>${rec.factory ? ` · pool factory <code>${rec.factory}</code>` : ''}\n` : `Factory <code>${s.via || '?'}</code>${h && !self ? ` · hook <code>${key.slice(2)}</code>` : ''}\n`) +
      `<code>${coin}</code>\n${coinLink(state, coin)}`;
    msgs.push(s.migrated ? { text, buttons: buyButtons('e', coin) } : text);
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
  const obolBuys = []; // Obol curve buys: the buyer is the tx sender (a router in between would hide them)
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
    } else if ((l.topics[0] === T_OBOL_TRADE || l.topics[0] === T_OBOL_AMM) && l.topics.length === 3 && OBOL[lc(l.address)]) {
      // an Obol curve trade (or a trade on an older curve's own pair after graduation; 0x4de0's graduated coins
      // trade on a v4 pool and are read there instead)
      const curve = lc(l.address);
      if (l.topics[0] === T_OBOL_AMM && !OBOL[curve].pair) continue;
      const t = lc(topicAddr(l.topics[1]));
      const w = words(l.data);
      const isBuy = BigInt('0x' + (w[0] || '0')) === 1n;
      const h = Number(BigInt('0x' + (w[1] || '0'))) / 1e18;
      const r = R(t);
      r.lp ||= curve;
      r.vol += h; r.swaps++;
      if (isBuy) { r.buyVol += h; r.buys++; txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + h; obolBuys.push({ t, h: l.transactionHash }); }
      if (l.topics[0] === T_OBOL_TRADE && w[5]) {
        const rh = Number(BigInt('0x' + w[4])), rt = Number(BigInt('0x' + w[5])); // virtual reserves: HYPE per coin
        if (rh > 0 && rt > 0) r.price = rh / rt;
      } else if (w[2]) {
        const tk = Number(BigInt('0x' + w[2])) / 1e18;
        if (tk > 0 && h > 0) r.price = h / tk;
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

  // Obol buys through a router: the curve hands the coin to the router, so the buyer is the sender of the tx
  const obolFrom = {};
  await pmap([...new Set(obolBuys.slice(0, 80).map((x) => x.h))], 12, async (h) => {
    try { obolFrom[h] = lc((await rpc('eth_getTransactionByHash', [h]))?.from || ''); } catch { obolFrom[h] = ''; }
  });
  for (const { t, h } of obolBuys.slice(0, 80)) if (obolFrom[h] && !INFRA.has(obolFrom[h])) roll[t]?.buyers.add(obolFrom[h]);
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

  // 3. per-coin alerts (names and supplies of coins seen for the first time read 16 at a time first)
  const tRoll = Date.now();
  await pmap(Object.keys(roll).filter((t) => !WHYPE.has(t) && state.meta[t]?.v !== 2), 16, (t) => tokenMeta(state, t).catch(() => null));
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
    const lpName = lpNameOf(rec);

    // launch with traction: first hours only, once per coin
    if (age != null && age < LAUNCH_WINDOW_H * 3600 && !rec.launchAlert && !firstRun) {
      const volUsd = toUsd(rec.vol) ?? 0;
      const share = rec.vol ? rec.buyVol / rec.vol : 0;
      const busy = LAUNCHPADS[rec.lp]?.busy;
      if (rec.buyers.length >= (busy ? BUSY_MIN_BUYERS : LAUNCH_MIN_BUYERS) && volUsd >= (busy ? BUSY_MIN_USD : LAUNCH_MIN_USD) && share >= LAUNCH_MIN_BUY_SHARE) {
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

    // (the 🔥 volume-run alerts were removed Nov 9; the pace baseline above is still kept per coin)
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
        if (bridged) note(to, `arrived with ${hype(val)}${px ? ` (${usd(val * px)})` : ''} from HyperEVM${txLink(tx.hash)}`);
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

  // 3d. (the fresh-bridger watch was removed Nov 9: bridging in alone is no signal)

  // 3e. launch-watched devs that have never been on Elysium (the old HyperCore and HyperEVM meme devs): each is
  // checked once, so its first move here leads its alert (🛬). 0 = never here yet, 1 = already active when first checked
  state.devHere ||= {};
  if (state.hyper) for (const k of ['tokens', 'nonces', 'at']) delete state.hyper[k]; // left by the old HyperCore/HyperEVM deploy watch
  for (const a of [...FIRSTW].filter((x) => !(x in state.devHere)).slice(0, 8)) {
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
    const SWAPS = new Set([T_SWAP_V2, T_SWAP_V3, T_SWAP_V4, T_SOLD, T_WITHDRAW, T_OBOL_TRADE, T_OBOL_AMM]);
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
          for (const g of noCluster.has(to) ? [] : [G.get(to), '*'].filter(Boolean)) {
            const k = g + '|' + t;
            (state.gbuys[k] ||= []).push({ w: to, t: now(), h: paid });
          }
        }
      }
      if (W.has(f) && !dustOut && !(FEE_TAKERS.has(to) && swapTx.has(l.transactionHash))) {
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
    // native HYPE moves, deploys and launches: read every block with its transactions.
    // A reverted tx is still in its block with its value, but nothing moved (a failed buy is not a 4 HYPE send):
    // ask the receipt for every tracked-wallet tx that would make a line here, and skip the failed ones.
    const failed = new Set();
    const toCheck = [];
    for (const blk of blocks) for (const tx of blk.transactions || []) {
      const val = BigInt(tx.value || '0x0');
      if ((W.has(lc(tx.from)) && (val > 0n || !tx.to)) || (W.has(lc(tx.to)) && val > 0n)) toCheck.push(tx.hash);
    }
    for (let i = 0; i < Math.min(toCheck.length, 200); i += 10) {
      await Promise.all(toCheck.slice(i, i + 10).map(async (h) => {
        try { const rc = await rpc('eth_getTransactionReceipt', [h], 3); if (rc && rc.status === '0x0') failed.add(h); } catch {}
      }));
    }
    const funded = []; // tracked wallet → untracked recipient, checked for freshness below
    // Safe multisigs made in this range (Safe factory ProxyCreation: the proxy is in the data, or topic 1 on v1.4)
    const safeMade = {};
    for (const l of logs) {
      if (l.topics[0] !== T_SAFE_PROXY) continue;
      const p = lc('0x' + (l.topics[1] || l.data.slice(0, 66)).slice(-40));
      (safeMade[l.transactionHash] ||= []).push(p);
    }
    const safeShape = async (p) => {
      try {
        const [o, t] = await Promise.all([rpc('eth_call', [{ to: p, data: '0xa0e67e2b' }, 'latest']), rpc('eth_call', [{ to: p, data: '0xe75235b8' }, 'latest'])]);
        return ` (${parseInt(t, 16)} of ${parseInt(o.slice(66, 130), 16)})`;
      } catch { return ''; }
    };
    for (const blk of blocks) {
      for (const tx of blk.transactions || []) {
        if (failed.has(tx.hash)) continue;
        const f = lc(tx.from);
        const to = lc(tx.to);
        const val = Number(BigInt(tx.value || '0x0')) / 1e18;
        if (W.has(f) && !tx.to) M(f).push(`deployed a contract${txLink(tx.hash)}`);
        if (W.has(f) && safeMade[tx.hash]) for (const p of safeMade[tx.hash]) M(f).push(`<b>made a Safe multisig</b> ${walletLink(p)}${await safeShape(p)}${txLink(tx.hash)}`);
        if (W.has(f) && to && (tx.input || '').startsWith('0x6a761202')) M(f).push(`<b>executed a Safe tx</b> on ${walletLink(to)}${W.has(to) ? ` (${esc(W.get(to))})` : ''}${txLink(tx.hash)}`);
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
          let src = unalias(f);
          // bridged through a contract on HyperEVM (the bridge UI's helper 0xa401…, used by Mesa's bridge too): the alias
          // is that contract, so read the HyperEVM tx behind the ticket to see who really sent it
          if (src !== to && !W.has(src)) src = (await hyperSender(tx, blk)) || src;
          // with calldata it is a call into a contract (a buy, a mint), not HYPE for another wallet
          if ((tx.input || '0x') !== '0x' && src !== to && W.has(src)) M(src).push(`${await bridgedCall(state, tx, to, src, val, logs, px)}${txLink(tx.hash)}`);
          else if (src !== to && W.has(src) && !W.has(to) && !INFRA.has(to)) {
            M(src).push(`🌉 <b>bridged ${hype(val)}</b>${px ? ` (${usd(val * px)})` : ''} from HyperEVM to another wallet ${walletLink(to)}${txLink(tx.hash)}`);
            funded.push({ f: src, to, val, hash: tx.hash, via: 'bridge' });
          }
        }
        // HYPE a tracked wallet bridges in for itself stays quiet (bridge tracking is off); plain transfers still ping
        if (W.has(to) && !bridged && val >= WALLET_MIN_HYPE) M(to).push(`received ${hype(val)}${px ? ` (${usd(val * px)})` : ''} from ${walletLink(f)}${txLink(tx.hash)}`);
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
        M(c).push(`launched <b>${esc(meta.s)}</b> (${esc(meta.n)}) on ${lpNameOf(state.tok[coin], '?')} · <code>${coin}</code> · ${assetLink(coin, 'chart')} · <a href="${BUY_PAGE}?t=${coin}">⚡ buy</a>${txLink(lt)}`);
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
    for (const w of FIRSTW) {
      if (!moves[w]?.length || state.devHere[w] !== 0) continue;
      state.devHere[w] = 1;
      landed.add(w);
      moves[w].unshift('🛬 <b>first move on Elysium</b> (never active here before)');
    }
    for (const [w, own] of DEVW) {
      if (!moves[w] || landed.has(w)) continue;
      moves[w] = moves[w].filter((x) => {
        if (/^(launched|deployed a contract|<b>split|🌉|<b>made a Safe|<b>executed a Safe)/.test(x)) return true;
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
    let r = owner.get(w) || w;
    for (let i = 0; i < 8; i++) { const f = state.auto[r]?.from; if (!/^0x[0-9a-f]{40}$/.test(f || '') || f === r) break; r = owner.get(f) || f; }
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
    tGate = Date.now();
    await gate({ state, logs, blocks, from, head, rpc, getLogs, hrpc, msgs, known: new Set(Object.keys(LAUNCHPADS)), buttons: (t) => buyButtons('e', t) });
  } catch (e) { console.log('gate failed:', e.message); }
  tGateEnd = Date.now();

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

  // 5a. team multisigs from other chains appearing on Elysium (CODE_WATCH, one ping each, ever)
  state.codeSeen ||= {};
  if (now() - (state.codeCheckedAt || 0) >= 60) {
    state.codeCheckedAt = now();
    for (const [a, name] of Object.entries(CODE_WATCH)) {
      if (state.codeSeen[a]) continue;
      try {
        const c = await rpc('eth_getCode', [a, 'latest']);
        if (!c || c === '0x') continue;
        state.codeSeen[a] = now();
        bump('multisig landed');
        msgs.push(`🏛 <b>${esc(name)}</b> now exists on Elysium\n${walletLink(a)} · the team is setting up its admin keys here`);
      } catch {}
    }
  }

  // 5b. treasury watch (TREASURIES): the backing leaving its contract
  for (const l of logs) {
    if (l.topics[0] !== T_TRANSFER || l.topics.length !== 3) continue;
    const src = lc(topicAddr(l.topics[1])), tr = TREASURIES[src];
    if (!tr || lc(l.address) !== tr.token) continue;
    const to = lc(topicAddr(l.topics[2]));
    const amt = Number(BigInt(l.data)) / 1e18;
    let left = null;
    try { left = Number(BigInt(await rpc('eth_call', [{ to: tr.token, data: '0x70a08231' + src.slice(2).padStart(64, '0') }, 'latest']))) / 1e18; } catch {}
    bump('treasury out');
    msgs.push(
      `🏦 <b>${esc(tr.name)}</b>: ${fmtAmt(amt)} ${tr.sym} left the contract\n` +
      `to ${W.has(to) ? `<b>${esc(W.get(to))}</b> ` : ''}${walletLink(to)}${left != null ? ` · ${fmtAmt(left)} ${tr.sym} left in it` : ''}${txLink(l.transactionHash)}\n` +
      coinLink(state, tr.coin)
    );
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
      lines.push(`${lines.length + 1}. ${assetLink(t, esc(m.s))} · MC ${mc ? (px ? usd(mc * px) : hype(mc)) : 'n/a'} · ${px ? usd(r.dvol * px) : hype(r.dvol)} vol · ${lpNameOf(r, 'Uniswap')}`);
    }
    const launches = {};
    for (const r of Object.values(state.tok)) if (r.born && r.born >= since) { const k = lpNameOf(r, 'other'); launches[k] = (launches[k] || 0) + 1; }
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

  // the auto-found list stays useful and under AUTO_MAX:
  // - muted wallets and wallets now named in wallets.json leave it (silenced, or tracked from the repo anyway;
  //   a muted wallet's alts still go quiet, that only needs it in state.muted)
  // - dead wallets: no tx sent for AUTO_DEAD_DAYS (nonce watched, a few wallets per tick); Cielo wallets stay
  const pruned = { muted: 0, listed: 0, dead: 0 };
  for (const a of Object.keys(state.auto)) {
    if (state.muted[a] && !state.manual[a]) { delete state.auto[a]; pruned.muted++; }
    else if (listed.has(a)) { delete state.auto[a]; pruned.listed++; }
  }
  const check = Object.entries(state.auto).filter(([, x]) => x.from !== 'cielo').sort((a, b) => (a[1].ck || 0) - (b[1].ck || 0)).slice(0, 15);
  await Promise.all(check.map(async ([a, x]) => {
    try {
      const n = parseInt(await rpc('eth_getTransactionCount', [a, 'latest'], 2), 16);
      x.ck = now();
      if (x.nc !== n) { x.nc = n; x.nct = now(); }
      const age = now() - (x.t || 0);
      if (age > AUTO_DEAD_DAYS * 86400 && now() - x.nct > AUTO_DEAD_DAYS * 86400) { delete state.auto[a]; pruned.dead++; }
    } catch {}
  }));
  if (Object.values(pruned).some(Boolean)) console.log(`auto list: dropped ${Object.entries(pruned).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')}, ${Object.keys(state.auto).length} left`);

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
  console.log(`done: ${Object.keys(roll).length} coins traded, ${launchTxs.length} launches, ${msgs.length} alerts · gate ${Object.keys(state.gate?.refs || {}).length} refs, ${state.gate?.q?.length || 0} queued · kinds ${kinds || 'none'} · auto ${Object.entries(autoBy).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} · manual ${Object.keys(state.manual).length} · by icon ${Object.entries(heads).map(([k, v]) => `${k}${v}`).join(' ') || 'none'} · ${head - from + 1} blocks, ${chainHead - head} behind · s logs ${((tLogs - tStart) / 1000).toFixed(1)}, launches ${((tRoll - tLaunch) / 1000).toFixed(1)}, coins+wallets ${(((tGate || tGateEnd || Date.now()) - tRoll) / 1000).toFixed(1)}, gate ${(tGate ? (tGateEnd - tGate) / 1000 : 0).toFixed(1)}, total ${((Date.now() - tStart) / 1000).toFixed(1)}`);
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
    // whole lines per message: a cut through a <code> tag makes Telegram drop the message (a /bridgers list of 130
    // wallets got no answer at all, Nov 7). A part Telegram still refuses goes again as plain text.
    const reply = async (text) => {
      const parts = [];
      let cur = '';
      for (const line of text.split('\n')) {
        if (cur && cur.length + line.length + 1 > 3800) { parts.push(cur); cur = ''; }
        cur += (cur ? '\n' : '') + line;
      }
      if (cur) parts.push(cur);
      for (const p of parts) {
        const r = await cmdApi('sendMessage', { chat_id: m.chat.id, text: p, parse_mode: 'HTML', disable_web_page_preview: true });
        if (!r.ok) {
          console.log('command reply refused:', r.description);
          await cmdApi('sendMessage', { chat_id: m.chat.id, text: p.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), disable_web_page_preview: true });
        }
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
  return { W, G, DEVW, auto, muted, ...walletLinks(okW) };
}

// wallets.json extras: "cluster": false keeps a wallet out of group buys (a trading bot that buys everything),
// "owner": "0x…" counts a wallet as that wallet in group buys (one person's wallets are one buyer, not several)
function walletLinks(okW) {
  const noCluster = new Set(okW.filter((w) => w.cluster === false).map((w) => lc(w.address)));
  const owner = new Map(okW.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.owner || '')).map((w) => [lc(w.address), lc(w.owner)]));
  return { noCluster, owner };
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
    TOKS = st.tok; for (const t of Object.keys(LIVE_TOKS)) if (st.tok[t]) delete LIVE_TOKS[t];
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
  if (!fst.px?.v && st.px?.v) fst.px = { ...st.px }; // start from the main scan's HYPE price, refresh in the background
  refreshPx(pxBox);
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
      noteLaunchpad(st.tok, l);
    }
  } catch (e) { console.log('fast: pool seed failed:', e.message); }

  const stats = { polls: 0, blocks: 0, alerts: 0, trades: 0, errs: 0, lags: [], at: Date.now(), tHead: [], tLogs: [], tBuild: [], tSend: [] };
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const mx = (a) => (a.length ? Math.max(...a) : 0);
  const blockTime = {};
  const rootOf = (w) => {
    let r = view.owner.get(w) || w;
    for (let i = 0; i < 8; i++) { const f = view.auto[r]?.from; if (!/^0x[0-9a-f]{40}$/.test(f || '') || f === r) break; r = view.owner.get(f) || f; }
    return r;
  };
  console.log(`fast: started at block ${fst.block + 1}, polling every ${FAST_POLL_MS} ms`);

  while (Date.now() < stopAt) {
    const t0 = Date.now();
    rpcIdx = 0; // back to the first (fastest) RPC every poll, after a hiccup moved us to a slower one
    try {
      if (now() - refreshedAt >= FAST_REFRESH_S) refresh();
      let ta = Date.now();
      const head = parseInt(await rpc('eth_blockNumber', [], 3), 16);
      stats.tHead.push(Date.now() - ta);
      if (head > fst.block) {
        const from = fst.block + 1, to = Math.min(head, from + FAST_RANGE - 1);
        ta = Date.now();
        const logs = await getLogs({ topics: [[T_TRANSFER, T_SWAP_V4, T_SWAP_V3, T_SWAP_V2, T_INIT_V4, T_OBOL_TRADE, T_OBOL_AMM]] }, from, to, FAST_RANGE);
        stats.tLogs.push(Date.now() - ta);
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
      console.log(`fast: ${stats.polls} polls, ${stats.blocks} blocks, ${stats.trades} trades seen, ${stats.alerts} alerts` +
        (stats.lags.length ? `, chain-to-Telegram ${med(stats.lags)}s median, ${mx(stats.lags)}s max` : '') +
        ` · ms median/max: head ${med(stats.tHead)}/${mx(stats.tHead)}, logs ${med(stats.tLogs)}/${mx(stats.tLogs)}` +
        (stats.tBuild.length ? `, alert build ${med(stats.tBuild)}/${mx(stats.tBuild)}, telegram ${med(stats.tSend)}/${mx(stats.tSend)}` : '') +
        ` · rpc retries ${rpcStats.retries}, ${stats.errs} errors`);
      rpcStats.retries = 0;
      Object.assign(stats, { polls: 0, blocks: 0, alerts: 0, trades: 0, errs: 0, lags: [], at: Date.now(), tHead: [], tLogs: [], tBuild: [], tSend: [] });
    }
    await sleep(Math.max(200, FAST_POLL_MS - (Date.now() - t0)));
  }
  console.log('fast: time is up, exiting');
}

let pxBusy = false;
function refreshPx(box) {
  if (pxBusy) return;
  pxBusy = true;
  hypeUsd(box).catch(() => {}).finally(() => { pxBusy = false; });
}

// one batch of new logs: trades by tracked wallets → 👛 lines, and 🎯 group buys
async function fastTick({ logs, fst, st, view, poolOf, priceOf, metaBox, pxBox, rootOf, stats, blockTime }) {
  const { W, G, DEVW } = view;
  // new pools first, so a coin launched in this batch can be priced and its swaps read
  for (const l of logs) {
    if (l.topics[0] !== T_INIT_V4) continue;
    const id = lc(l.topics[1]);
    if (!poolOf(id)) fst.pools[id] = poolEntry({ tok: st.tok }, lc(l.address), lc(topicAddr(l.topics[2])), lc(topicAddr(l.topics[3])), parseInt(l.blockNumber, 16));
    noteLaunchpad(st.tok, l); // a new coin's launchpad, for its links before the main scan has recorded it
  }
  const mine = logs.filter((l) => l.topics[0] === T_TRANSFER && l.topics.length === 3 && (W.has(lc(topicAddr(l.topics[1]))) || W.has(lc(topicAddr(l.topics[2])))) && !WHYPE.has(lc(l.address)));
  if (!mine.length) return;
  const tb = Date.now();
  const hot = new Set(mine.map((l) => l.transactionHash));
  // swaps in the txs we care about: HYPE paid per tx, which addresses are pools, the coin's latest price
  const txBuy = {}, emitters = {}, swapTx = new Set();
  for (const l of logs) {
    const obol = (l.topics[0] === T_OBOL_TRADE || l.topics[0] === T_OBOL_AMM) && l.topics.length === 3 && (OBOL[lc(l.address)] || st.obolSeen?.[lc(l.address)]);
    if (l.topics[0] !== T_SWAP_V4 && l.topics[0] !== T_SWAP_V3 && l.topics[0] !== T_SWAP_V2 && !obol) continue;
    const b = parseInt(l.blockNumber, 16);
    const inHot = hot.has(l.transactionHash);
    if (inHot) { swapTx.add(l.transactionHash); (emitters[l.transactionHash] ||= new Set()).add(lc(l.address)); }
    if (obol) {
      // an Obol curve trade: isBuy, HYPE, tokens (then fee and the curve's virtual reserves on a curve trade)
      const w = words(l.data);
      const t = lc(topicAddr(l.topics[1]));
      const h = Number(BigInt('0x' + (w[1] || '0'))) / 1e18;
      if (inHot && BigInt('0x' + (w[0] || '0')) === 1n) txBuy[l.transactionHash] = (txBuy[l.transactionHash] || 0) + h;
      const p = l.topics[0] === T_OBOL_TRADE && w[5] ? Number(BigInt('0x' + w[4])) / Number(BigInt('0x' + w[5])) : w[2] && BigInt('0x' + w[2]) > 0n ? h / (Number(BigInt('0x' + w[2])) / 1e18) : 0;
      if (p > 0 && (!fst.price[t] || fst.price[t].b <= b)) fst.price[t] = { p, b, t: now() };
      continue;
    }
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
  // the HYPE price never holds up an alert: use the last one and refresh it in the background
  const px = fst.px?.v || null;
  if (!fst.px || now() - fst.px.t >= 900) refreshPx(pxBox);
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
      for (const g of view.noCluster.has(to) ? [] : [G.get(to), '*'].filter(Boolean)) (fst.gbuys[g + '|' + t] ||= []).push({ w: to, t: now(), h: paidH || val || 0 });
      touched.add(t);
      if (exitOf(to)) continue; // the main scan sends exit-group moves as one alert per group
      fst.sent[`${h}|${to}|${t}`] = now();
      if (dust || DEVW.has(to)) continue; // launch-watched devs: their buys count toward group buys but are not pinged
      (moves[to] ||= []).push(`bought ${fmtAmt(amt)} <b>${esc(meta.s)}</b>${shown != null ? ` (~${px ? usd(shown * px) : hype(shown)})` : ''} · ${assetLink(t, 'chart')}${txLink(h)}${HOLD(to, t)}`);
      lastBuy[to] = t;
      firstBlock[to] ??= b;
    }
    if (W.has(f) && !(FEE_TAKERS.has(to) && swapTx.has(h))) {
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
  await Promise.all([...new Set(Object.values(moves).flat().join('').match(/\u0000H:[^\u0000]+\u0000/g) || [])].slice(0, 20).map(async (k) => {
    const [, w, t] = k.slice(1, -1).split(':');
    try {
      const meta = await tokenMeta(metaBox, t);
      const bal = Number(BigInt(await rpc('eth_call', [{ to: t, data: '0x70a08231' + w.slice(2).padStart(64, '0') }, 'latest'], 3))) / 10 ** meta.d;
      const price = priceOf(t);
      held[k] = holdLine(bal, meta, price ? bal * price : null, px);
    } catch { held[k] = ''; }
  }));
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
  const nBefore = msgs.length;
  msgs = dropMutedCoins(msgs, coinMutes({ mutedCoins: { ...(st.mutedCoins || {}) }, unmutedCoins: { ...(st.unmutedCoins || {}) } }));
  if (msgs.length !== nBefore) lagFrom.length = 0; // a muted alert dropped out: skip this batch's timing sample
  stats.tBuild.push(Date.now() - tb);
  // send first, time it, then work out the chain-to-Telegram delay (block of the first trade in each 👛 alert → sent)
  const sentAt = [];
  for (const m of msgs) {
    const ts = Date.now();
    await tg(m);
    stats.tSend.push(Date.now() - ts);
    sentAt.push(Date.now() / 1000);
    stats.alerts++;
  }
  for (let i = 0; i < Math.min(lagFrom.length, sentAt.length, 5); i++) {
    const b = lagFrom[i];
    if (b == null) continue;
    try {
      blockTime[b] ??= parseInt((await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false], 2)).timestamp, 16);
      stats.lags.push(Math.round(sentAt[i] - blockTime[b]));
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
