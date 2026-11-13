import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Seal } from "../seal.js";
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

/** A seal with nothing to report, for a test whose query never starts a Claude process. */
export const TEST_SEAL: Seal = {
  problem: undefined,
  spawn: () => {
    throw new Error("a test's query never spawns");
  },
  check: () => undefined,
};

type Deps = Parameters<typeof runSession>[1];

/**
 * `runSession`, reading settings from `HERMETIC_SETTINGS_DIRS` unless a test passes its own
 * `settingsDirs`, sealed by `TEST_SEAL` unless it passes a `seal`, and with no credential unless it
 * passes a `credentialEnv`: as in production, the runner's own env never holds one.
 */
export const hermeticRunSession = (
  config: Parameters<typeof runSession>[0],
  deps: Omit<Deps, "seal" | "credentialEnv"> &
    Partial<Pick<Deps, "seal" | "credentialEnv">>,
) =>
  runSession(config, {
    settingsDirs: HERMETIC_SETTINGS_DIRS,
    ...deps,
    seal: deps.seal ?? TEST_SEAL,
    credentialEnv: deps.credentialEnv ?? {},
  });
