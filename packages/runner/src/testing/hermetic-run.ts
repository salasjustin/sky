import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "../session.js";
import type { SettingsDirs } from "../settings-guard.js";

// empty directories no one writes to: a run's settings guard reads these, never the machine's own
// `~/.claude`, `CLAUDE_CONFIG_DIR` or `/etc/claude-code`, which a developer's settings could fill
const root = mkdtempSync(join(tmpdir(), "runner-hermetic-settings-"));
for (const name of ["config", "managed"]) mkdirSync(join(root, name));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

export const HERMETIC_SETTINGS_DIRS: SettingsDirs = {
  userDirs: [join(root, "config")],
  managedDir: join(root, "managed"),
};

/** `runSession`, reading settings from `HERMETIC_SETTINGS_DIRS` unless a test passes its own `settingsDirs`. */
export const hermeticRunSession: typeof runSession = (config, deps) =>
  runSession(config, { settingsDirs: HERMETIC_SETTINGS_DIRS, ...deps });
