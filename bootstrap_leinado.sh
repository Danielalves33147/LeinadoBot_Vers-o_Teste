#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG SIMPLES ======
REPO_URL="${REPO_URL:-https://github.com/Danielalves33147/LeinadoBot_Vers-o_Teste.git}"
APP_DIR="${APP_DIR:-/home/daniel/apps/LeinadoBot}"
NODE_VERSION="${NODE_VERSION:-20}"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-1475}"
DB_NAME="${DB_NAME:-santana}"
OWNER_JID="${OWNER_JID:-85156417241313@lid}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"

log(){ echo -e "\033[1;32m[+] $*\033[0m"; }

# ====== 1) DEPENDÊNCIAS ======
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates build-essential python3 make g++ postgresql postgresql-contrib

# ====== 2) NODE via NVM + PM2 ======
if [[ ! -d "$HOME/.nvm" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
# shellcheck disable=SC1090
. "$HOME/.nvm/nvm.sh"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
npm i -g pm2@latest

# ====== 3) REPO (clonar/atualizar) ======
mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
  (cd "$APP_DIR" && git pull --rebase)
else
  git clone "$REPO_URL" "$APP_DIR"
fi

# ====== 4) .ENV ======
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<EOF
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_NAME=${DB_NAME}
OWNER_JID=${OWNER_JID}
GEMINI_API_KEY=${GEMINI_API_KEY}
LOG_LEVEL=info
EOF
fi

# ====== 5) CRIAR DB (se faltar) e senha do postgres ======
sudo -u postgres psql -tc "SELECT 1" >/dev/null
sudo -u postgres psql -c "ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';" >/dev/null || true
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  log "Criando database ${DB_NAME}…"
  sudo -u postgres createdb "${DB_NAME}"
fi

# ====== 6) SCHEMA ======
SCHEMA_FILE="$APP_DIR/banco_setup.sql"
[[ ! -f "$SCHEMA_FILE" && -f "$APP_DIR/banco_backup" ]] && cp "$APP_DIR/banco_backup" "$SCHEMA_FILE"
if [[ -f "$SCHEMA_FILE" ]]; then
  log "Aplicando schema…"
  PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -U "${DB_USER}" -d "${DB_NAME}" -f "$SCHEMA_FILE" >/dev/null
fi

# Garantir Dono
if [[ -n "$OWNER_JID" ]]; then
  PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -U "${DB_USER}" -d "${DB_NAME}" -c "
    INSERT INTO users (jid, cargo_id, rank_giver_id, last_rank_date, is_blocked)
    VALUES ('${OWNER_JID}', (SELECT id FROM cargos WHERE nome='Dono'), NULL, NOW(), FALSE)
    ON CONFLICT (jid) DO UPDATE
    SET cargo_id=EXCLUDED.cargo_id, last_rank_date=NOW(), is_blocked=FALSE;
  " >/dev/null || true
fi

# ====== 7) DEPENDÊNCIAS NODE ======
(cd "$APP_DIR" && rm -rf node_modules package-lock.json && npm install)

# ====== 8) PM2 (Node certo + CWD certo) ======
pm2 delete bot || true
pm2 start "$APP_DIR/bot.js" --name bot --cwd "$APP_DIR" --interpreter "$(which node)"
pm2 save

log "✅ Pronto. Veja logs: pm2 logs bot --lines 200"
