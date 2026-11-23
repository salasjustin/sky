import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { envFile, RUN_STORE_SETUP } from "./provision.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sky-store-setup-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("the store's setup script runs with no GitHub connector and no env secret in its environment or on disk", () => {
  const store = join(home, ".sky-store");
  mkdirSync(store);
  const seen = join(home, "seen.txt");
  const onDisk = join(home, "on-disk.txt");
  const file = join(home, "store.env");
  // the env file sits at a fixed path the script could read the secrets back from
  writeFileSync(
    join(store, "setup.sh"),
    `env > ${JSON.stringify(seen)}\nif [ -e ${JSON.stringify(file)} ]; then echo present; else echo gone; fi > ${JSON.stringify(onDisk)}\n`,
  );
  // what the provisioner writes for the step: the env's secrets, the connector among them
  writeFileSync(
    file,
    envFile([
      ["HOME", home],
      ["GITHUB_CONNECTOR", "conn_secret_value"],
      ["GITHUB_GATEWAY_URL", "https://gateway.test"],
      ["PROJECT_SECRET", "project_secret_value"],
    ]),
  );

  // a bare env of its own, as the sprite's exec has: the machine's env is never printed by a failure
  execFileSync("bash", ["-c", RUN_STORE_SETUP, "bash", file], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    stdio: "ignore",
  });

  const names = readFileSync(seen, "utf8")
    .split("\n")
    .map((line) => line.split("=")[0]);
  expect(names).toContain("HOME");
  expect(names).not.toContain("GITHUB_CONNECTOR");
  expect(names).not.toContain("GITHUB_GATEWAY_URL");
  expect(names).not.toContain("PROJECT_SECRET");
  expect(readFileSync(onDisk, "utf8").trim()).toBe("gone");
});
