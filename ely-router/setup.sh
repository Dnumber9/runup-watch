#!/usr/bin/env bash
# ely-router setup for a fresh Ubuntu or Debian VPS. Run it as your normal user (it uses sudo where needed):
#
#   curl -fsSL https://raw.githubusercontent.com/Dnumber9/runup-watch/main/ely-router/setup.sh -o setup.sh && bash setup.sh
#
# Run the same command again later to update the bot. Your .env (bot token, burner key) is kept.
#
# A second, separate bot on the same machine (someone else's bot token, Telegram id and burner wallet):
#   ELY_DIR=$HOME/ely-router-sam ELY_NAME=ely-router-sam bash setup.sh
# Each copy keeps its own .env and state.json in its own folder; use the same two variables when updating it.
set -euo pipefail

DIR="${ELY_DIR:-$HOME/ely-router}"
NAME="${ELY_NAME:-ely-router}"
RAW="https://raw.githubusercontent.com/Dnumber9/runup-watch/main/ely-router"

echo "== Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== Bot files"
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "$RAW/router.mjs" -o router.mjs
curl -fsSL "$RAW/package.json" -o package.json
npm install --omit=dev --no-fund --no-audit --loglevel=error

echo "== Settings"
touch .env
chmod 600 .env
if ! grep -q '^TRADE_BOT_TOKEN=.' .env; then
  read -rp "Trade bot token from @BotFather: " TOKEN </dev/tty
  sed -i '/^TRADE_BOT_TOKEN=/d' .env
  echo "TRADE_BOT_TOKEN=$TOKEN" >> .env
fi
if ! grep -q '^OWNER_ID=.' .env; then
  read -rp "Your Telegram user id (ask @userinfobot): " OWNER </dev/tty
  sed -i '/^OWNER_ID=/d' .env
  echo "OWNER_ID=$OWNER" >> .env
fi
grep -q '^MAX_BUY_HYPE=' .env || echo "MAX_BUY_HYPE=5" >> .env

echo "== Burner wallet (the key stays in $DIR/.env on this machine)"
node router.mjs --new-wallet

echo "== Keep it running"
if ! command -v pm2 >/dev/null 2>&1; then sudo npm install -g pm2 --no-fund --no-audit --loglevel=error; fi
if pm2 describe "$NAME" >/dev/null 2>&1; then pm2 restart "$NAME" --update-env; else pm2 start router.mjs --name "$NAME" --time; fi
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null
echo
echo "Done. Send HYPE on Elysium to the wallet address above, then open your trade bot in Telegram and send /start."
echo "Logs: pm2 logs $NAME    Restart: pm2 restart $NAME"
