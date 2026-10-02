#!/bin/bash
set -o pipefail

fail() {
  echo "No se pudo desinstalar AE AI: $1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "este desinstalador solo funciona en macOS."
if pgrep -x "After Effects" >/dev/null 2>&1; then
  fail "cierra After Effects completamente y vuelve a intentarlo."
fi

APP_ROOT="${AE_AI_HOME_OVERRIDE:-$HOME/Library/Application Support/AE AI}"
CEP_ROOT="${AE_AI_CEP_ROOT_OVERRIDE:-$HOME/Library/Application Support/Adobe/CEP/extensions}"
PANEL_DIR="$CEP_ROOT/games.engine-room.ae-mcp"

rm -rf "$PANEL_DIR" || fail "no se pudo eliminar el panel de After Effects."
rm -rf "$APP_ROOT" || fail "no se pudo eliminar el runtime de AE AI."

# Old panel backups belong to AE AI too. They are never loaded by CEP and can
# otherwise accumulate after repeated updates.
find "$CEP_ROOT" -maxdepth 1 -type d -name 'games.engine-room.ae-mcp.backup-*' -exec rm -rf {} + 2>/dev/null || true

echo "AE AI se desinstaló correctamente."
echo "ChatGPT/Codex y las preferencias compartidas de Adobe no fueron modificados."
