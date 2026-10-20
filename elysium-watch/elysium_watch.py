#!/usr/bin/env python3
"""
elysium_watch.py
Fast watcher for the Elysium L2 (Kinetiq) launch and the Ascend launchpad.
Pings Telegram on:
  1. Changes to the 99901 rollup on HyperEVM (ownership, upgrades, proxy implementations, Safe signers).
  2. New 0x addresses or content changes on Kinetiq / Ascend pages (docs, ecosystem page, Ascend site + JS bundles).
  3. New contracts and new tokens on the Elysium L2 (tagged when created through an Ascend factory).

Stdlib only. No pip installs.

Run locally (loop, default every 30s):   python3 elysium_watch.py
Run once (GitHub Actions / cron):        python3 elysium_watch.py --once
Print instead of sending to Telegram:    python3 elysium_watch.py --dry-run
Send a test Telegram message and exit:   python3 elysium_watch.py --test

Config comes from environment variables or a .env file next to this script (see .env.example).
"""

import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

def load_dotenv(path):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


load_dotenv(os.path.join(HERE, ".env"))


def env(name, default=""):
    return os.environ.get(name, default).strip()


def env_list(name, default=""):
    raw = env(name, default)
    return [x.strip() for x in raw.split(",") if x.strip()]


TG_TOKEN = env("TELEGRAM_BOT_TOKEN")
TG_CHAT = env("TELEGRAM_CHAT_ID")

HYPEREVM_RPC = env("HYPEREVM_RPC", "https://rpc.hyperliquid.xyz/evm")
# Community node. Swap for Kinetiq's official mainnet RPC as soon as it is published.
ELYSIUM_RPC = env("ELYSIUM_RPC", "https://rpc.elysiumpump.com")
ELYSIUM_EXPLORER = env("ELYSIUM_EXPLORER", "")  # e.g. https://explorer.elysium.xyz (optional, for links)

STATE_FILE = env("STATE_FILE", os.path.join(HERE, "elysium_state.json"))

LOOP_SECONDS = int(env("LOOP_SECONDS", "30"))
WEB_EVERY_SECONDS = int(env("WEB_EVERY_SECONDS", "300"))
ROLLUP_EVERY_SECONDS = int(env("ROLLUP_EVERY_SECONDS", "120"))
L2_MAX_BLOCKS_PER_TICK = int(env("L2_MAX_BLOCKS_PER_TICK", "300"))

# Fill these in once Ascend publishes mainnet contracts (comma separated).
ASCEND_FACTORIES = [a.lower() for a in env_list("ASCEND_FACTORIES")]
# 1 = only alert on tokens created through ASCEND_FACTORIES. 0 = alert on every new token.
ONLY_ASCEND_TOKENS = env("ONLY_ASCEND_TOKENS", "0") == "1"
# 1 = alert on every new contract deployed on Elysium (useful pre-launch, noisy after).
ALERT_DEPLOYS = env("ALERT_DEPLOYS", "1") == "1"

WEB_TARGETS = env_list(
    "WEB_TARGETS",
    ",".join([
        "https://elysium.kinetiq.xyz/docs/",
        "https://elysium.kinetiq.xyz/docs/token-bridging-architecture",
        "https://elysium.kinetiq.xyz/ecosystem",
        "https://ascendlaunch.xyz/",
        "https://ascendlaunch.gitbook.io/docs",
        "https://ascendlaunch.gitbook.io/docs/llms.txt",
    ]),
)
# Pages whose same-origin JS bundles should also be grepped for addresses.
BUNDLE_TARGETS = env_list("BUNDLE_TARGETS", "https://ascendlaunch.xyz/")

# The 99901 rollup on HyperEVM (found 2026-10-20, not yet confirmed as Kinetiq's official mainnet).
INBOX = "0xce59f8b65ad41c9dae4c07a0571a39824bd92cff"
BRIDGE = "0x503d572157113faaad4dbed2647bb10b949216b6"
SEQ_INBOX = "0x7f3ff53aecb87261206ad3bdc27a88b6d8420fa6"
ROLLUP = "0x508c173dfe5f737b3493195bf785d71fa76fd217"
UPGRADE_EXECUTOR = "0xdd45a7a06cc21cfe442cf13dffeb8252b18c1441"
PROXY_ADMIN = "0x1394034554889fb60aade45fe38ab05ad6f53f24"
UPGRADE_SAFE = "0xc030cee9e03a6dfbda0a817c8bdb4ba44d6d61d0"
ROLLUP_DEPLOYER = "0xe7cb019b9ea946961207775f11cac8e3dbf1cb8a"

KNOWN_ADDRESSES = {
    INBOX, BRIDGE, SEQ_INBOX, ROLLUP, UPGRADE_EXECUTOR, PROXY_ADMIN, UPGRADE_SAFE, ROLLUP_DEPLOYER,
    "0x0000000000000000000000000000000000000000",
}

IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
EXECUTOR_ROLE = "d8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63"
ADMIN_ROLE = "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775"

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO_TOPIC = "0x" + "0" * 64

UA = "Mozilla/5.0 (elysium-watch; +https://github.com)"
ADDR_RE = re.compile(r"0x[a-fA-F0-9]{40}")


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def http_post_json(url, payload, timeout=20):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json", "User-Agent": UA}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


class RPCError(Exception):
    pass


def rpc(url, method, params, retries=3):
    last = None
    for i in range(retries):
        try:
            res = http_post_json(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            if "error" in res:
                raise RPCError(f"{method}: {res['error']}")
            return res.get("result")
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RPCError(f"{method} failed after {retries} tries: {last}")


def eth_call(url, to, data):
    return rpc(url, "eth_call", [{"to": to, "data": data}, "latest"])


def pad_addr(a):
    return a.lower().replace("0x", "").rjust(64, "0")


def word_to_addr(w):
    if not w or len(w) < 42:
        return None
    return "0x" + w[-40:].lower()


def decode_string(hexdata):
    """Decode an ABI string return (or bytes32 fallback)."""
    if not hexdata or hexdata == "0x":
        return ""
    h = hexdata[2:]
    try:
        if len(h) >= 128:
            off = int(h[0:64], 16) * 2
            ln = int(h[off:off + 64], 16)
            raw = bytes.fromhex(h[off + 64: off + 64 + ln * 2])
            return raw.decode("utf-8", errors="replace").strip("\x00").strip()
        raw = bytes.fromhex(h[:64])
        return raw.rstrip(b"\x00").decode("utf-8", errors="replace").strip()
    except (ValueError, IndexError):
        return ""


def decode_address_array(hexdata):
    if not hexdata or len(hexdata) < 130:
        return []
    h = hexdata[2:]
    try:
        off = int(h[0:64], 16) * 2
        n = int(h[off:off + 64], 16)
        out = []
        for i in range(n):
            w = h[off + 64 + i * 64: off + 128 + i * 64]
            out.append("0x" + w[-40:].lower())
        return out
    except (ValueError, IndexError):
        return []


def esc(s):
    return html.escape(str(s), quote=False)


def short(a):
    return f"{a[:6]}…{a[-4:]}" if a and len(a) > 12 else str(a)


def link_l2(addr):
    if ELYSIUM_EXPLORER:
        return f'<a href="{ELYSIUM_EXPLORER.rstrip("/")}/address/{addr}">{esc(addr)}</a>'
    return f"<code>{esc(addr)}</code>"


def link_hyperevm(addr):
    return f'<a href="https://hyperevmscan.io/address/{addr}">{esc(addr)}</a>'


# ----------------------------------------------------------------------------
# State
# ----------------------------------------------------------------------------

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            log("State file unreadable, starting fresh.")
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, STATE_FILE)


# ----------------------------------------------------------------------------
# Telegram
# ----------------------------------------------------------------------------

DRY_RUN = "--dry-run" in sys.argv


def send_telegram(text):
    header = "<b>⚡ Elysium watch</b>\n"
    body = header + text
    chunks = []
    while body:
        chunks.append(body[:3900])
        body = body[3900:]
    for c in chunks:
        if DRY_RUN or not TG_TOKEN or not TG_CHAT:
            print("----- ALERT -----\n" + c + "\n-----------------", flush=True)
            continue
        url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
        payload = {"chat_id": TG_CHAT, "text": c, "parse_mode": "HTML", "disable_web_page_preview": True}
        for attempt in range(3):
            try:
                res = http_post_json(url, payload)
                if res.get("ok"):
                    break
                log(f"Telegram error: {res}")
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    try:
                        retry = json.loads(e.read().decode()).get("parameters", {}).get("retry_after", 5)
                    except Exception:
                        retry = 5
                    time.sleep(int(retry) + 1)
                    continue
                log(f"Telegram HTTP {e.code}")
            except Exception as e:  # network blip
                log(f"Telegram send failed: {e}")
            time.sleep(2)
        time.sleep(1.1)  # stay under 1 msg/sec to the same chat


# ----------------------------------------------------------------------------
# 1. Rollup watch (HyperEVM)
# ----------------------------------------------------------------------------

def rollup_snapshot():
    u = HYPEREVM_RPC
    snap = {}

    def st(addr, slot):
        return word_to_addr(rpc(u, "eth_getStorageAt", [addr, slot, "latest"]))

    for name, addr in [("inbox", INBOX), ("bridge", BRIDGE), ("seq_inbox", SEQ_INBOX), ("rollup", ROLLUP)]:
        snap[f"{name}.impl"] = st(addr, IMPL_SLOT)
        snap[f"{name}.proxy_admin"] = st(addr, ADMIN_SLOT)

    snap["inbox.bridge"] = word_to_addr(eth_call(u, INBOX, "0xe78cea92"))
    snap["bridge.rollup"] = word_to_addr(eth_call(u, BRIDGE, "0xcb23bcb5"))
    snap["bridge.sequencer_inbox"] = word_to_addr(eth_call(u, BRIDGE, "0xee35f327"))
    snap["rollup.owner"] = word_to_addr(eth_call(u, ROLLUP, "0x8da5cb5b"))
    try:
        snap["rollup.chain_id"] = int(eth_call(u, ROLLUP, "0x9a8a0592"), 16)
    except (RPCError, ValueError, TypeError):
        snap["rollup.chain_id"] = None
    snap["proxy_admin.owner"] = word_to_addr(eth_call(u, PROXY_ADMIN, "0x8da5cb5b"))

    def has_role(role, who):
        r = eth_call(u, UPGRADE_EXECUTOR, "0x91d14854" + role + pad_addr(who))
        return bool(r) and r.endswith("1")

    snap["executor_role.safe"] = has_role(EXECUTOR_ROLE, UPGRADE_SAFE)
    snap["executor_role.deployer"] = has_role(EXECUTOR_ROLE, ROLLUP_DEPLOYER)

    owners = decode_address_array(eth_call(u, UPGRADE_SAFE, "0xa0e67e2b"))
    snap["safe.owners"] = sorted(owners)
    try:
        snap["safe.threshold"] = int(eth_call(u, UPGRADE_SAFE, "0xe75235b8"), 16)
    except (RPCError, ValueError, TypeError):
        snap["safe.threshold"] = None

    # Info only (not alerted on change): activity counters and bridge balance.
    info = {}
    try:
        info["batches"] = int(eth_call(u, SEQ_INBOX, "0x06f13056"), 16)
    except (RPCError, ValueError, TypeError):
        info["batches"] = None
    try:
        info["bridge_hype"] = round(int(rpc(u, "eth_getBalance", [BRIDGE, "latest"]), 16) / 1e18, 3)
    except (RPCError, ValueError, TypeError):
        info["bridge_hype"] = None
    return snap, info


def check_rollup(state, baseline):
    try:
        snap, info = rollup_snapshot()
    except RPCError as e:
        log(f"Rollup check failed: {e}")
        return
    prev = state.get("rollup", {})
    prev_info = state.get("rollup_info", {})
    state["rollup"] = snap
    state["rollup_info"] = info
    if baseline or not prev:
        log(f"Rollup baseline: chain {snap.get('rollup.chain_id')}, batches {info.get('batches')}, bridge {info.get('bridge_hype')} HYPE")
        return
    changes = []
    for k, v in snap.items():
        if prev.get(k) != v:
            changes.append((k, prev.get(k), v))
    # Large bridge inflow is worth knowing about (whale deposits / official opening).
    jump = None
    if prev_info.get("bridge_hype") is not None and info.get("bridge_hype") is not None:
        delta = info["bridge_hype"] - prev_info["bridge_hype"]
        if delta >= float(env("BRIDGE_JUMP_HYPE", "250")):
            jump = delta
    if not changes and jump is None:
        return
    lines = [f"<b>99901 rollup change</b> ({now_iso()})"]
    for k, a, b in changes:
        if isinstance(b, list):
            added = sorted(set(b) - set(a or []))
            removed = sorted(set(a or []) - set(b))
            lines.append(f"• <b>{esc(k)}</b>: +{len(added)} / -{len(removed)}")
            for x in added:
                lines.append(f"   + {link_hyperevm(x)}")
            for x in removed:
                lines.append(f"   - {link_hyperevm(x)}")
        else:
            lines.append(f"• <b>{esc(k)}</b>: {esc(a)} → {esc(b)}")
    if jump is not None:
        lines.append(f"• Bridge balance jumped +{jump:.2f} HYPE (now {info['bridge_hype']} HYPE)")
    risky = [k for k, _, _ in changes if k.endswith(".impl") or "owner" in k or "executor_role" in k or k.startswith("safe.")]
    if risky:
        lines.append("⚠️ Control/upgrade change. Do not deposit until this is explained.")
    send_telegram("\n".join(lines))


# ----------------------------------------------------------------------------
# 2. Web watch (Kinetiq / Ascend pages)
# ----------------------------------------------------------------------------

def normalize_text(raw):
    # Strip scripts/styles/tags and collapse whitespace so cosmetic churn does not alert.
    t = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def find_bundles(page_url, raw_html):
    base = re.match(r"(https?://[^/]+)", page_url).group(1)
    srcs = re.findall(r'<script[^>]+src=["\']([^"\']+\.js[^"\']*)["\']', raw_html, flags=re.I)
    srcs += re.findall(r'["\'](/_next/static/[^"\']+\.js)["\']', raw_html)
    out = []
    for s in srcs:
        if s.startswith("//"):
            s = "https:" + s
        elif s.startswith("/"):
            s = base + s
        elif not s.startswith("http"):
            s = base + "/" + s
        if s.startswith(base) and s not in out:
            out.append(s)
    return out[:40]


KEYWORD_RE = re.compile(r"(?i)(mainnet[^.]{0,80}(chain\s*id|contract|address|bridge|live))|(chain\s*id[:\s]*\d{4,7})")


def check_web(state, baseline):
    web = state.setdefault("web", {})
    alerts = []
    for url in WEB_TARGETS:
        try:
            raw = http_get(url)
        except Exception as e:
            log(f"Web fetch failed {url}: {e}")
            continue
        text = normalize_text(raw)
        h = hashlib.sha256(text.encode()).hexdigest()
        addrs = sorted({a.lower() for a in ADDR_RE.findall(raw)} - KNOWN_ADDRESSES)
        kw = sorted({m.group(0)[:140] for m in KEYWORD_RE.finditer(text)})
        prev = web.get(url)

        # Bundle grep for JS-rendered sites.
        bundle_addrs = []
        bundle_sig = ""
        if url in BUNDLE_TARGETS:
            sig_parts = []
            for b in find_bundles(url, raw):
                try:
                    js = http_get(b, timeout=25)
                except Exception:
                    continue
                sig_parts.append(b.split("/")[-1])
                bundle_addrs.extend(a.lower() for a in ADDR_RE.findall(js))
                for m in re.finditer(r"(?i)chain_?id[\"']?\s*[:=]\s*(\d{3,7})", js):
                    kw.append(f"chainId {m.group(1)}")
            bundle_addrs = sorted(set(bundle_addrs) - KNOWN_ADDRESSES)
            bundle_sig = hashlib.sha256("|".join(sorted(sig_parts)).encode()).hexdigest()[:16]
            kw = sorted(set(kw))

        cur = {"hash": h, "addrs": addrs, "bundle_addrs": bundle_addrs, "bundle_sig": bundle_sig, "kw": kw}
        web[url] = cur
        if baseline or prev is None:
            continue

        lines = []
        new_addrs = sorted(set(addrs) - set(prev.get("addrs", [])))
        new_bundle = sorted(set(bundle_addrs) - set(prev.get("bundle_addrs", [])))
        new_kw = sorted(set(kw) - set(prev.get("kw", [])))
        if new_addrs:
            lines.append(f"New addresses on page ({len(new_addrs)}):")
            lines += [f"   <code>{esc(a)}</code>" for a in new_addrs[:25]]
        if new_bundle:
            lines.append(f"New addresses in JS bundle ({len(new_bundle)}):")
            lines += [f"   <code>{esc(a)}</code>" for a in new_bundle[:25]]
        if new_kw:
            lines.append("New mainnet/chain-ID mentions:")
            lines += [f"   “{esc(k)}”" for k in new_kw[:8]]
        if bundle_sig and prev.get("bundle_sig") and bundle_sig != prev.get("bundle_sig") and not new_bundle:
            lines.append("Site redeployed (JS bundle changed), no new addresses.")
        if h != prev.get("hash") and not lines:
            lines.append("Page text changed.")
        if lines:
            alerts.append(f'<b>{esc(url)}</b>\n' + "\n".join(lines))

    if alerts:
        send_telegram(f"<b>Page changes</b> ({now_iso()})\n\n" + "\n\n".join(alerts))


# ----------------------------------------------------------------------------
# 3. Elysium L2 watch (new contracts + new tokens)
# ----------------------------------------------------------------------------

def token_meta(addr):
    u = ELYSIUM_RPC
    meta = {}
    for key, sel in [("name", "0x06fdde03"), ("symbol", "0x95d89b41")]:
        try:
            meta[key] = decode_string(eth_call(u, addr, sel))
        except RPCError:
            meta[key] = ""
    try:
        meta["decimals"] = int(eth_call(u, addr, "0x313ce567"), 16)
    except (RPCError, ValueError, TypeError):
        meta["decimals"] = None
    try:
        ts = int(eth_call(u, addr, "0x18160ddd"), 16)
        d = meta["decimals"] if isinstance(meta["decimals"], int) else 18
        meta["supply"] = ts / (10 ** d)
    except (RPCError, ValueError, TypeError):
        meta["supply"] = None
    return meta


def check_l2(state, baseline):
    u = ELYSIUM_RPC
    l2 = state.setdefault("l2", {"last_block": None, "tokens": [], "contracts": []})
    try:
        latest = int(rpc(u, "eth_blockNumber", []), 16)
        chain_id = int(rpc(u, "eth_chainId", []), 16)
    except (RPCError, ValueError, TypeError) as e:
        log(f"L2 RPC unavailable: {e}")
        return
    if l2.get("chain_id") and l2["chain_id"] != chain_id:
        send_telegram(f"<b>Elysium RPC chain ID changed</b>: {l2['chain_id']} → {chain_id}. Possible reset or redeploy.")
        l2["last_block"] = None
    l2["chain_id"] = chain_id

    if l2.get("last_block") is None:
        l2["last_block"] = latest
        log(f"L2 baseline at block {latest} (chain {chain_id})")
        return
    if latest < l2["last_block"]:
        send_telegram(f"<b>Elysium block height went backwards</b>: {l2['last_block']} → {latest}. Possible chain reset.")
        l2["last_block"] = latest
        return

    start = l2["last_block"] + 1
    end = min(latest, start + L2_MAX_BLOCKS_PER_TICK - 1)
    if start > end:
        return

    seen_tokens = set(l2.get("tokens", []))
    seen_contracts = set(l2.get("contracts", []))
    new_deploys = []
    new_tokens = []

    # New contracts: walk blocks (Elysium is quiet pre-launch; cap per tick keeps it light).
    if ALERT_DEPLOYS:
        for n in range(start, end + 1):
            try:
                blk = rpc(u, "eth_getBlockByNumber", [hex(n), True])
            except RPCError as e:
                log(f"Block {n} fetch failed: {e}")
                end = n - 1
                break
            for tx in (blk or {}).get("transactions", []):
                if tx.get("to") is None:
                    try:
                        rc = rpc(u, "eth_getTransactionReceipt", [tx["hash"]])
                    except RPCError:
                        continue
                    ca = (rc or {}).get("contractAddress")
                    if ca and ca.lower() not in seen_contracts:
                        seen_contracts.add(ca.lower())
                        new_deploys.append({"addr": ca.lower(), "from": tx["from"].lower(), "block": n, "tx": tx["hash"]})

    # New tokens: first mint (Transfer from 0x0) from a token address we have not seen.
    if end >= start:
        try:
            logs = rpc(u, "eth_getLogs", [{"fromBlock": hex(start), "toBlock": hex(end), "topics": [TRANSFER_TOPIC, ZERO_TOPIC]}])
        except RPCError as e:
            log(f"getLogs failed: {e}")
            logs = []
        for lg in logs or []:
            if len(lg.get("topics", [])) != 3:
                continue  # skip ERC-721 style (4 topics)
            t = lg["address"].lower()
            if t in seen_tokens:
                continue
            seen_tokens.add(t)
            try:
                tx = rpc(u, "eth_getTransactionByHash", [lg["transactionHash"]])
            except RPCError:
                tx = {}
            via = (tx.get("to") or "").lower() if tx else ""
            creator = (tx.get("from") or "").lower() if tx else ""
            new_tokens.append({"addr": t, "creator": creator, "via": via, "block": int(lg["blockNumber"], 16),
                               "ascend": via in ASCEND_FACTORIES or t in ASCEND_FACTORIES})

    l2["last_block"] = end
    l2["tokens"] = sorted(seen_tokens)[-5000:]
    l2["contracts"] = sorted(seen_contracts)[-5000:]
    if baseline:
        return

    if new_deploys:
        lines = [f"<b>New contracts on Elysium</b> (chain {chain_id}, blocks {start}-{end})"]
        for d in new_deploys[:20]:
            tag = " 🟢 deployer is an ASCEND factory" if d["from"] in ASCEND_FACTORIES else ""
            lines.append(f"• {link_l2(d['addr'])}\n   deployer <code>{esc(d['from'])}</code> · block {d['block']}{tag}")
        if len(new_deploys) > 20:
            lines.append(f"…and {len(new_deploys) - 20} more")
        send_telegram("\n".join(lines))

    to_alert = [t for t in new_tokens if t["ascend"] or not ONLY_ASCEND_TOKENS]
    for t in to_alert[:15]:
        m = token_meta(t["addr"])
        tag = "🟢 <b>ASCEND LAUNCH</b>\n" if t["ascend"] else ""
        supply = f"{m['supply']:,.0f}" if isinstance(m.get("supply"), (int, float)) else "?"
        send_telegram(
            f"{tag}<b>New token on Elysium</b>: {esc(m.get('name') or '?')} (<b>{esc(m.get('symbol') or '?')}</b>)\n"
            f"• token {link_l2(t['addr'])}\n"
            f"• creator <code>{esc(t['creator'])}</code>\n"
            f"• via <code>{esc(t['via'] or '?')}</code>\n"
            f"• supply {supply} · decimals {m.get('decimals')} · block {t['block']}\n"
            f"Check creator funding and early buyers before touching it."
        )


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def tick(state, force_all=False):
    now = time.time()
    baseline = not state.get("initialized")
    timers = state.setdefault("timers", {})

    if force_all or baseline or now - timers.get("rollup", 0) >= ROLLUP_EVERY_SECONDS:
        check_rollup(state, baseline)
        timers["rollup"] = now
    if force_all or baseline or now - timers.get("web", 0) >= WEB_EVERY_SECONDS:
        check_web(state, baseline)
        timers["web"] = now
    check_l2(state, baseline)

    if baseline:
        state["initialized"] = True
        info = state.get("rollup_info", {})
        send_telegram(
            "Watch started. Baseline recorded.\n"
            f"• 99901 rollup: {info.get('batches')} batches, bridge {info.get('bridge_hype')} HYPE\n"
            f"• Elysium RPC: {esc(ELYSIUM_RPC)} (block {state.get('l2', {}).get('last_block')})\n"
            f"• Pages: {len(WEB_TARGETS)} · Ascend factories set: {len(ASCEND_FACTORIES)}\n"
            "You will only hear from me when something changes."
        )
    save_state(state)


def main():
    if "--test" in sys.argv:
        send_telegram("Test message. Telegram delivery works.")
        return
    once = "--once" in sys.argv
    state = load_state()
    if once:
        # In CI every run is spaced minutes apart, so run every check each time.
        tick(state, force_all=True)
        return
    log(f"Watching. L2 every {LOOP_SECONDS}s, rollup every {ROLLUP_EVERY_SECONDS}s, pages every {WEB_EVERY_SECONDS}s. Ctrl+C to stop.")
    while True:
        try:
            tick(state)
        except KeyboardInterrupt:
            raise
        except Exception as e:  # never die on a bad tick
            log(f"Tick error: {e}")
        time.sleep(LOOP_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Stopped.")
