#!/bin/bash
set -o pipefail

VERSION="__VERSION__"
EXPECTED_ARCH="__ARCH__"
ARCH_LABEL="__ARCH_LABEL__"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD_DIR="$SELF_DIR/payload"
TRANSACTION_ACTIVE=0

pause() {
  if [ "$AE_AI_SKIP_PAUSE" != "1" ]; then
    echo
    read -r -p "Presiona Return para cerrar esta ventana..."
  fi
}

fail() {
  if [ "${TRANSACTION_ACTIVE:-0}" = "1" ]; then
    rollback_install
    TRANSACTION_ACTIVE=0
  fi
  echo
  echo "No se pudo instalar AE AI: $1" >&2
  pause
  exit 1
}

exists_path() {
  [ -e "$1" ] || [ -L "$1" ]
}

echo "AE AI $VERSION — instalador para macOS ($ARCH_LABEL)"
echo

[ "$(uname -s)" = "Darwin" ] || fail "este instalador solo funciona en macOS."
[ "$(uname -m)" = "$EXPECTED_ARCH" ] || fail "esta Mac usa $(uname -m); descarga la edición correcta."

if pgrep -x "After Effects" >/dev/null 2>&1; then
  fail "cierra After Effects completamente y vuelve a abrir el instalador."
fi

if [ -n "$AE_AI_HOME_OVERRIDE" ]; then
  APP_ROOT="$AE_AI_HOME_OVERRIDE"
else
  APP_ROOT="$HOME/Library/Application Support/AE AI"
fi
if [ -n "$AE_AI_CEP_ROOT_OVERRIDE" ]; then
  CEP_ROOT="$AE_AI_CEP_ROOT_OVERRIDE"
else
  CEP_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
fi

BIN_DIR="$APP_ROOT/bin"
CODEX_HOME_DIR="$APP_ROOT/codex"
RUNTIME_DIR="$APP_ROOT/runtime"
MCP_BIN="$BIN_DIR/after-effects-mcp"
CODEX_BIN="$BIN_DIR/codex"
CODEX_HOST_BIN="$BIN_DIR/codex-code-mode-host"
CODEX_RG_BIN="$BIN_DIR/rg"
CONFIG_FILE="$CODEX_HOME_DIR/config.toml"
INFO_FILE="$APP_ROOT/install-info.txt"
PANEL_DIR="$CEP_ROOT/games.engine-room.ae-mcp"

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
MCP_STAGE="$BIN_DIR/.after-effects-mcp.install-$STAMP"
CODEX_BIN_STAGE="$BIN_DIR/.codex.install-$STAMP"
CODEX_HOST_STAGE="$BIN_DIR/.codex-code-mode-host.install-$STAMP"
CODEX_RG_STAGE="$BIN_DIR/.rg.install-$STAMP"
CONFIG_STAGE="$CODEX_HOME_DIR/.config.toml.install-$STAMP"
INFO_STAGE="$APP_ROOT/.install-info.txt.install-$STAMP"
PANEL_STAGE="$CEP_ROOT/.games.engine-room.ae-mcp.install-$STAMP"

MCP_BACKUP="$MCP_BIN.backup-$STAMP"
CODEX_BIN_BACKUP="$CODEX_BIN.backup-$STAMP"
CODEX_HOST_BACKUP="$CODEX_HOST_BIN.backup-$STAMP"
CODEX_RG_BACKUP="$CODEX_RG_BIN.backup-$STAMP"
CONFIG_BACKUP="$CONFIG_FILE.backup-$STAMP"
INFO_BACKUP="$INFO_FILE.backup-$STAMP"
PANEL_BACKUP="$CEP_ROOT/games.engine-room.ae-mcp.backup-$STAMP"

MCP_ACTIVATED=0; MCP_HAD_OLD=0
CODEX_BIN_ACTIVATED=0; CODEX_BIN_HAD_OLD=0
CODEX_HOST_ACTIVATED=0; CODEX_HOST_HAD_OLD=0
CODEX_RG_ACTIVATED=0; CODEX_RG_HAD_OLD=0
CONFIG_ACTIVATED=0; CONFIG_HAD_OLD=0
INFO_ACTIVATED=0; INFO_HAD_OLD=0
PANEL_ACTIVATED=0; PANEL_HAD_OLD=0

cleanup_stages() {
  rm -rf "$MCP_STAGE" "$CODEX_BIN_STAGE" "$CODEX_HOST_STAGE" "$CODEX_RG_STAGE" \
    "$CONFIG_STAGE" "$INFO_STAGE" "$PANEL_STAGE" >/dev/null 2>&1 || true
}

restore_path() {
  local target="$1" backup="$2" activated="$3" had_old="$4"
  [ "$activated" = "1" ] || return 0
  rm -rf "$target" >/dev/null 2>&1 || true
  if [ "$had_old" = "1" ] && exists_path "$backup"; then
    mv "$backup" "$target" >/dev/null 2>&1 || true
  fi
}

rollback_install() {
  echo "Revirtiendo la instalación incompleta…" >&2
  restore_path "$INFO_FILE" "$INFO_BACKUP" "$INFO_ACTIVATED" "$INFO_HAD_OLD"
  restore_path "$CONFIG_FILE" "$CONFIG_BACKUP" "$CONFIG_ACTIVATED" "$CONFIG_HAD_OLD"
  restore_path "$CODEX_RG_BIN" "$CODEX_RG_BACKUP" "$CODEX_RG_ACTIVATED" "$CODEX_RG_HAD_OLD"
  restore_path "$CODEX_HOST_BIN" "$CODEX_HOST_BACKUP" "$CODEX_HOST_ACTIVATED" "$CODEX_HOST_HAD_OLD"
  restore_path "$CODEX_BIN" "$CODEX_BIN_BACKUP" "$CODEX_BIN_ACTIVATED" "$CODEX_BIN_HAD_OLD"
  restore_path "$PANEL_DIR" "$PANEL_BACKUP" "$PANEL_ACTIVATED" "$PANEL_HAD_OLD"
  restore_path "$MCP_BIN" "$MCP_BACKUP" "$MCP_ACTIVATED" "$MCP_HAD_OLD"
}

cleanup_on_exit() {
  if [ "${TRANSACTION_ACTIVE:-0}" = "1" ]; then rollback_install; fi
  cleanup_stages
}
trap cleanup_on_exit EXIT INT TERM

activate_path() {
  local staged="$1" target="$2" backup="$3"
  LAST_HAD_OLD=0
  rm -rf "$backup" >/dev/null 2>&1 || true
  if exists_path "$target"; then
    mv "$target" "$backup" || return 1
    LAST_HAD_OLD=1
  fi
  if ! mv "$staged" "$target"; then
    if [ "$LAST_HAD_OLD" = "1" ] && exists_path "$backup"; then mv "$backup" "$target" >/dev/null 2>&1 || true; fi
    return 1
  fi
  return 0
}

[ -x "$PAYLOAD_DIR/after-effects-mcp" ] || fail "falta el Bridge/MCP en el instalador."
[ -d "$PAYLOAD_DIR/panel" ] || fail "falta el panel de After Effects."
[ -d "$PAYLOAD_DIR/node_modules/ws" ] || fail "falta la dependencia del panel."

mkdir -p "$BIN_DIR" "$CODEX_HOME_DIR" "$RUNTIME_DIR" "$CEP_ROOT" ||
  fail "no se pudieron crear las carpetas."

# Stage every AE AI-owned payload before replacing anything the user already has.
install -m 755 "$PAYLOAD_DIR/after-effects-mcp" "$MCP_STAGE" ||
  fail "no se pudo preparar el Bridge/MCP."
rm -rf "$PANEL_STAGE"
ditto "$PAYLOAD_DIR/panel" "$PANEL_STAGE" ||
  fail "no se pudo preparar el panel."
mkdir -p "$PANEL_STAGE/node_modules"
ditto "$PAYLOAD_DIR/node_modules/ws" "$PANEL_STAGE/node_modules/ws" ||
  fail "no se pudo preparar WebSocket."

detect_codex() {
  if [ -n "$AE_AI_CODEX_PATH" ] && [ -x "$AE_AI_CODEX_PATH" ]; then
    printf '%s\n' "$AE_AI_CODEX_PATH"
    return
  fi
  for candidate in \
    "/Applications/ChatGPT.app/Contents/Resources/codex" \
    "$HOME/.local/bin/codex" \
    "/usr/local/bin/codex" \
    "/opt/homebrew/bin/codex"
  do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  done
  command -v codex 2>/dev/null || true
}

CODEX_SOURCE="$(detect_codex)"
if [ -z "$CODEX_SOURCE" ]; then
  if [ "$AE_AI_SKIP_CODEX_DOWNLOAD" = "1" ]; then
    fail "Codex no está disponible y la descarga fue desactivada."
  fi
  command -v curl >/dev/null 2>&1 || fail "macOS no encontró curl para instalar Codex."
  echo "Instalando el componente oficial Codex de OpenAI..."
  curl -fsSL https://chatgpt.com/codex/install.sh | sh || fail "OpenAI no pudo instalar Codex."
  CODEX_SOURCE="$(detect_codex)"
fi
[ -x "$CODEX_SOURCE" ] || fail "Codex no quedó disponible después de la instalación."
"$CODEX_SOURCE" --version >/dev/null 2>&1 || fail "Codex no pudo iniciarse."

find_codex_support() {
  local name="$1" source_dir
  source_dir="$(dirname "$CODEX_SOURCE")"
  for candidate in \
    "$source_dir/$name" \
    "/Applications/ChatGPT.app/Contents/Resources/$name" \
    "$HOME/.codex/packages/standalone/current/bin/$name" \
    "$HOME/.codex/packages/standalone/current/codex-path/$name"
  do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  done
}

CODEX_HOST_SOURCE="$(find_codex_support codex-code-mode-host)"
[ -x "$CODEX_HOST_SOURCE" ] || fail "la instalación de Codex no incluye codex-code-mode-host."
CODEX_RG_SOURCE="$(find_codex_support rg)"

ln -s "$CODEX_SOURCE" "$CODEX_BIN_STAGE" || fail "no se pudo preparar Codex."
ln -s "$CODEX_HOST_SOURCE" "$CODEX_HOST_STAGE" || fail "no se pudo preparar codex-code-mode-host."
if [ -n "$CODEX_RG_SOURCE" ]; then
  ln -s "$CODEX_RG_SOURCE" "$CODEX_RG_STAGE" || fail "no se pudo preparar rg."
fi

case "$MCP_BIN" in
  *\"*) fail "la ruta de instalación contiene comillas." ;;
esac

cat > "$CONFIG_STAGE" <<EOF
# Administrado por AE AI. Codex guarda la autenticación por separado.
cli_auth_credentials_store = "auto"

[mcp_servers.after-effects]
command = "$MCP_BIN"
args = []
default_tools_approval_mode = "approve"
EOF

cat > "$INFO_STAGE" <<EOF
version=$VERSION
architecture=$EXPECTED_ARCH
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
panel=$PANEL_DIR
EOF

# Commit. Every target gets a sibling backup first; any later failure restores
# the already-replaced targets in reverse order, so users never get a mixed
# server/panel/config installation.
TRANSACTION_ACTIVE=1
activate_path "$MCP_STAGE" "$MCP_BIN" "$MCP_BACKUP" || fail "no se pudo activar el Bridge/MCP."
MCP_ACTIVATED=1; MCP_HAD_OLD=$LAST_HAD_OLD
activate_path "$PANEL_STAGE" "$PANEL_DIR" "$PANEL_BACKUP" || fail "no se pudo activar el panel nuevo."
PANEL_ACTIVATED=1; PANEL_HAD_OLD=$LAST_HAD_OLD
activate_path "$CODEX_BIN_STAGE" "$CODEX_BIN" "$CODEX_BIN_BACKUP" || fail "no se pudo conectar Codex con AE AI."
CODEX_BIN_ACTIVATED=1; CODEX_BIN_HAD_OLD=$LAST_HAD_OLD
activate_path "$CODEX_HOST_STAGE" "$CODEX_HOST_BIN" "$CODEX_HOST_BACKUP" || fail "no se pudo conectar codex-code-mode-host con AE AI."
CODEX_HOST_ACTIVATED=1; CODEX_HOST_HAD_OLD=$LAST_HAD_OLD
if [ -n "$CODEX_RG_SOURCE" ]; then
  activate_path "$CODEX_RG_STAGE" "$CODEX_RG_BIN" "$CODEX_RG_BACKUP" || fail "no se pudo conectar rg con AE AI."
  CODEX_RG_ACTIVATED=1; CODEX_RG_HAD_OLD=$LAST_HAD_OLD
fi
activate_path "$CONFIG_STAGE" "$CONFIG_FILE" "$CONFIG_BACKUP" || fail "no se pudo activar la configuración de Codex."
CONFIG_ACTIVATED=1; CONFIG_HAD_OLD=$LAST_HAD_OLD
activate_path "$INFO_STAGE" "$INFO_FILE" "$INFO_BACKUP" || fail "no se pudo guardar la información de instalación."
INFO_ACTIVATED=1; INFO_HAD_OLD=$LAST_HAD_OLD
TRANSACTION_ACTIVE=0

# The panel backup is intentionally retained as the human-visible previous
# version. The file/symlink backups are only transaction journals and can go.
rm -rf "$MCP_BACKUP" "$CODEX_BIN_BACKUP" "$CODEX_HOST_BACKUP" "$CODEX_RG_BACKUP" \
  "$CONFIG_BACKUP" "$INFO_BACKUP" >/dev/null 2>&1 || true

AUTH_REUSED=0
DEFAULT_CODEX_HOME="$HOME/.codex"
if [ -f "$DEFAULT_CODEX_HOME/auth.json" ]; then
  cp "$DEFAULT_CODEX_HOME/auth.json" "$CODEX_HOME_DIR/auth.json" >/dev/null 2>&1 || true
  chmod 600 "$CODEX_HOME_DIR/auth.json" >/dev/null 2>&1 || true
  if [ -f "$DEFAULT_CODEX_HOME/installation_id" ]; then
    cp "$DEFAULT_CODEX_HOME/installation_id" "$CODEX_HOME_DIR/installation_id" >/dev/null 2>&1 || true
    chmod 600 "$CODEX_HOME_DIR/installation_id" >/dev/null 2>&1 || true
  fi
  if CODEX_HOME="$CODEX_HOME_DIR" "$CODEX_BIN" login status 2>&1 | grep -qi "logged in"; then
    AUTH_REUSED=1
  fi
fi

for csxs in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$csxs" PlayerDebugMode 1 >/dev/null 2>&1 || true
done

echo "Instalación completada."
echo
echo "  Panel:  $PANEL_DIR"
echo "  Bridge: $MCP_BIN"
echo "  Codex:  $CODEX_SOURCE"
if [ "$PANEL_HAD_OLD" = "1" ] && exists_path "$PANEL_BACKUP"; then
  echo "  Respaldo anterior: $PANEL_BACKUP"
fi
echo
echo "Ahora abre After Effects y ve a Ventana > Extensiones > AE AI."
if [ "$AUTH_REUSED" = "1" ]; then
  echo "AE AI detectó una sesión de ChatGPT/Codex activa y la reutilizará automáticamente."
else
  echo "Si todavía no hay una sesión activa en este equipo, conecta tu cuenta una vez desde AE AI."
fi
pause
