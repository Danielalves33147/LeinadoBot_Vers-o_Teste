#!/usr/bin/env bash
set -euo pipefail

### =========================
### CONFIG — EDITE AQUI
### =========================
REPO_URL="${REPO_URL:-https://github.com/Danielalves33147/LeinadoBot_Vers-o_Teste.git}"
APP_DIR="${APP_DIR:-/home/daniel/apps/LeinadoBot}"        # caminho final do app
NODE_VERSION="${NODE_VERSION:-20}"                         # LTS
DB_NAME="${DB_NAME:-santana}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-1475}"            # senha do usuário postgres
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
OWNER_JID="${OWNER_JID:-85156417241313@lid}"
ENV_GEMINI="${GEMINI_API_KEY:-}"                           # opcional

### =========================
### FUNÇÕES AUX
### =========================
log(){ echo -e "\033[1;32m[+] $*\033[0m"; }
warn(){ echo -e "\033[1;33m[!] $*\033[0m"; }
err(){ echo -e "\033[1;31m[x] $*\033[0m" >&2; }

require_root_or_sudo(){
  if [[ $EUID -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      err "Precisa rodar como root ou ter sudo."
      exit 1
    fi
  else
    SUDO=""
  fi
}

ensure_packages(){
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl git ca-certificates build-essential python3 make g++ \
    postgresql postgresql-contrib
}

install_nvm_node(){
  if [[ ! -d "${HOME}/.nvm" ]]; then
    log "Instalando NVM…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
  nvm install "${NODE_VERSION}"
  nvm use "${NODE_VERSION}"
  log "Node em uso: $(node -v)"
  log "NPM em uso:  $(npm -v)"
}

install_pm2(){
  npm i -g pm2@latest
  log "PM2: $(pm2 -v)"
}

pg_hba_to_scram(){
  local HBA
  HBA="$($SUDO -u postgres psql -tAc "SHOW hba_file;")"
  if [[ -z "$HBA" || ! -f "$HBA" ]]; then
    err "Não foi possível localizar o pg_hba.conf"
    exit 1
  fi
  $SUDO cp "$HBA" "${HBA}.bak.$(date +%s)"
  $SUDO awk '
  $1=="local" && $2=="all" && ($3=="postgres" || $3=="all"){ $NF="scram-sha-256"; print; next }
  { print }
  ' "$HBA" | $SUDO tee "$HBA" >/dev/null
  $SUDO systemctl restart postgresql || $SUDO systemctl restart postgresql@$(psql -tAc "SHOW server_version;")-main || true
}

set_postgres_password(){
  log "Definindo senha do usuário postgres…"
  $SUDO -u postgres psql -tc "SELECT 1" >/dev/null
  $SUDO -u postgres psql -c "ALTER ROLE postgres WITH PASSWORD '${DB_PASSWORD}';" >/dev/null
}

ensure_database(){
  if ! $SUDO -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    log "Criando database ${DB_NAME}…"
    $SUDO -u postgres createdb "${DB_NAME}"
  else
    log "Database ${DB_NAME} já existe."
  fi
}

ensure_app_dir(){
  mkdir -p "$(dirname "$APP_DIR")"
  if [[ -d "$APP_DIR/.git" ]]; then
    log "Atualizando repo em $APP_DIR…"
    (cd "$APP_DIR" && git pull --rebase)
  else
    log "Clonando repo em $APP_DIR…"
    git clone "$REPO_URL" "$APP_DIR"
  fi
  $SUDO chown -R "$USER":"$USER" "$APP_DIR"
}

ensure_env_file(){
  if [[ ! -f "$APP_DIR/.env" ]]; then
    log "Criando .env…"
    cat > "$APP_DIR/.env" <<EOF
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_NAME=${DB_NAME}
OWNER_JID=${OWNER_JID}
GEMINI_API_KEY=${ENV_GEMINI}
LOG_LEVEL=info
EOF
  else
    warn ".env já existe — mantendo como está."
  fi
}

ensure_schema_file(){
  # Se existir banco_setup.sql, beleza; senão, tenta usar banco_backup
  if [[ ! -f "$APP_DIR/banco_setup.sql" ]]; then
    if [[ -f "$APP_DIR/banco_backup" ]]; then
      warn "banco_setup.sql não encontrado; usando banco_backup"
      cp "$APP_DIR/banco_backup" "$APP_DIR/banco_setup.sql"
    else
      err "Nenhum schema SQL (banco_setup.sql/banco_backup) encontrado no repo."
      exit 1
    fi
  fi
}

apply_schema_and_owner(){
  log "Aplicando schema no ${DB_NAME}…"
  PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -U "${DB_USER}" -d "${DB_NAME}" -f "$APP_DIR/banco_setup.sql" >/dev/null

  if [[ -n "$OWNER_JID" ]]; then
    log "Garantindo Dono (${OWNER_JID})…"
    PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -U "${DB_USER}" -d "${DB_NAME}" -c "
      INSERT INTO users (jid, cargo_id, rank_giver_id, last_rank_date, is_blocked)
      VALUES ('${OWNER_JID}', (SELECT id FROM cargos WHERE nome='Dono'), NULL, NOW(), FALSE)
      ON CONFLICT (jid) DO UPDATE
      SET cargo_id=EXCLUDED.cargo_id, last_rank_date=NOW(), is_blocked=FALSE;
    " >/dev/null
  fi
}

install_deps(){
  # Usa Node (nvm) no shell atual
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
  nvm use "${NODE_VERSION}" >/dev/null
  (cd "$APP_DIR" && rm -rf node_modules package-lock.json && npm install)
}

patch_bot_paths(){
  # Garante .env e auth_info por caminho absoluto dentro do bot
  if ! grep -q "dotenv.*__dirname" "$APP_DIR/bot.js"; then
    sed -i "1i const path=require('path'); require('dotenv').config({path:path.join(__dirname,'.env')});" "$APP_DIR/bot.js"
  fi
  if ! grep -q "useMultiFileAuthState" "$APP_DIR/bot.js"; then
    warn "bot.js não encontrado no formato esperado; siga assim mesmo."
  else
    # injeta diretório auth_info absoluto se não existir
    if ! grep -q "auth_info" "$APP_DIR/bot.js"; then
      sed -i "s/useMultiFileAuthState('auth_info')/useMultiFileAuthState(require('path').join(__dirname,'auth_info'))/g" "$APP_DIR/bot.js"
    fi
  fi
  mkdir -p "$APP_DIR/auth_info"
}

start_pm2(){
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
  nvm use "${NODE_VERSION}" >/dev/null
  pm2 delete bot || true
  pm2 start "$APP_DIR/bot.js" --name bot --cwd "$APP_DIR" --interpreter "$(which node)"
  pm2 save
}

### =========================
### EXECUÇÃO
### =========================
require_root_or_sudo
ensure_packages
install_nvm_node
install_pm2
pg_hba_to_scram
set_postgres_password
ensure_database
ensure_app_dir
ensure_env_file
ensure_schema_file
apply_schema_and_owner
install_deps
patch_bot_paths
start_pm2

log "✅ Tudo pronto. Logs:  pm2 logs bot --lines 200"
