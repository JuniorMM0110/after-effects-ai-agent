import fs from "node:fs";
import path from "node:path";
import { appPaths, confirmDialog, isAfterEffectsRunning, showDialog } from "./common.mjs";

const p = appPaths();
function fail(message) { showDialog("AE AI", message, "error"); process.exit(1); }

try {
  if (!confirmDialog("Desinstalar AE AI", "Esto eliminará AE AI y su panel de After Effects. ChatGPT y Codex no se eliminarán. ¿Continuar?")) process.exit(0);
  if (isAfterEffectsRunning()) fail("Cierra After Effects completamente y vuelve a abrir el desinstalador.");
  fs.rmSync(p.panelDir, { recursive: true, force: true });
  if (fs.existsSync(p.cepRoot)) {
    for (const name of fs.readdirSync(p.cepRoot)) {
      if (/^games\.engine-room\.ae-mcp\.backup-/i.test(name)) fs.rmSync(path.win32.join(p.cepRoot, name), { recursive: true, force: true });
    }
  }
  fs.rmSync(p.root, { recursive: true, force: true });
  showDialog("AE AI", "AE AI se desinstaló correctamente. ChatGPT/Codex y las preferencias compartidas de Adobe no fueron modificados.");
} catch (error) {
  fail(`No se pudo desinstalar AE AI.\n\n${error?.message || error}`);
}
