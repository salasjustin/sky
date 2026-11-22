import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveConfig } from "./config.js";

const home = () => mkdtempSync(join(tmpdir(), "sky-cli-"));
const withConfigFile = (contents: string) => {
  const dir = home();
  mkdirSync(join(dir, ".config", "sky"), { recursive: true });
  writeFileSync(join(dir, ".config", "sky", "config.json"), contents);
  return dir;
};

test("flags beat env beat the config file", () => {
  const dir = withConfigFile(
    JSON.stringify({ url: "https://file.example", apiKey: "file-key" }),
  );
  expect(resolveConfig({}, {}, dir)).toEqual({
    ok: true,
    config: {
      url: "https://file.example",
      apiKey: "file-key",
      apiKeySource: `apiKey in ${join(dir, ".config", "sky", "config.json")}`,
    },
  });
  const env = {
    SKY_URL: "https://env.example",
    SKY_API_KEY: "env-key",
    OTHER_KEY: "other-key",
  };
  expect(resolveConfig({}, env, dir)).toEqual({
    ok: true,
    config: {
      url: "https://env.example",
      apiKey: "env-key",
      apiKeySource: "SKY_API_KEY",
    },
  });
  expect(
    resolveConfig(
      { url: "https://flag.example", apiKeyEnv: "OTHER_KEY" },
      env,
      dir,
    ),
  ).toEqual({
    ok: true,
    config: {
      url: "https://flag.example",
      apiKey: "other-key",
      apiKeySource: "OTHER_KEY (--api-key-env)",
    },
  });
});

test("an empty env var doesn't count as set", () => {
  const dir = withConfigFile(
    JSON.stringify({ url: "https://file.example", apiKey: "file-key" }),
  );
  expect(resolveConfig({}, { SKY_URL: "", SKY_API_KEY: "" }, dir)).toEqual({
    ok: true,
    config: {
      url: "https://file.example",
      apiKey: "file-key",
      apiKeySource: `apiKey in ${join(dir, ".config", "sky", "config.json")}`,
    },
  });
});

test("honors XDG_CONFIG_HOME", () => {
  const xdg = home();
  mkdirSync(join(xdg, "sky"));
  writeFileSync(
    join(xdg, "sky", "config.json"),
    JSON.stringify({ url: "https://xdg.example", apiKey: "k" }),
  );
  expect(resolveConfig({}, { XDG_CONFIG_HOME: xdg }, home())).toMatchObject({
    ok: true,
    config: { url: "https://xdg.example" },
  });
});

test("--api-key-env naming an unset variable is an error, not a fallback", () => {
  const result = resolveConfig(
    { apiKeyEnv: "MISSING" },
    { SKY_URL: "https://env.example", SKY_API_KEY: "env-key" },
    home(),
  );
  expect(result).toEqual({
    ok: false,
    error: "--api-key-env names MISSING, which is not set",
  });
});

// fetch quotes a header value it refuses, so each of these would print the key
test.each([
  ["an inner LF", "secret\nkey"],
  ["an inner CR", "secret\rkey"],
  ["an inner CRLF before a trailing one", "secret\r\nkey\r\n"],
  ["a leading LF", "\nsecret-key"],
  ["a leading CR", "\rsecret-key"],
  ["an inner NUL", "secret\0key"],
  ["a trailing NUL", "secret-key\0"],
])("a key with %s is an error that doesn't show it", (_, key) => {
  const env = { SKY_URL: "https://env.example", SKY_API_KEY: key };
  expect(resolveConfig({}, env, home())).toEqual({
    ok: false,
    error:
      "SKY_API_KEY has a line break or NUL that a header can't carry; set it to the key alone",
  });
});

test("a key a header can't carry is named by where it came from", () => {
  const dir = withConfigFile(
    JSON.stringify({ url: "https://file.example", apiKey: "secret\0key" }),
  );
  const path = join(dir, ".config", "sky", "config.json");
  expect(resolveConfig({}, {}, dir)).toEqual({
    ok: false,
    error: `apiKey in ${path} has a line break or NUL that a header can't carry; set it to the key alone`,
  });
  const env = { SKY_URL: "https://env.example", OTHER_KEY: "secret\nkey" };
  expect(resolveConfig({ apiKeyEnv: "OTHER_KEY" }, env, dir)).toEqual({
    ok: false,
    error:
      "OTHER_KEY (--api-key-env) has a line break or NUL that a header can't carry; set it to the key alone",
  });
});

test.each([
  ["LF", "key\n"],
  ["CR", "key\r"],
  ["CRLF and blanks", "key \r\n\t\n"],
])("a key with a trailing %s is accepted as it is", (_, key) => {
  const env = { SKY_URL: "https://env.example", SKY_API_KEY: key };
  expect(resolveConfig({}, env, home())).toMatchObject({
    ok: true,
    config: { apiKey: key },
  });
});

test("nothing configured names where to put it", () => {
  const result = resolveConfig({}, {}, home());
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/no API URL/);
  expect(result.error).toMatch(/SKY_URL/);
});

test("a malformed config file is an error naming the file", () => {
  const dir = withConfigFile("{not json");
  const result = resolveConfig({}, {}, dir);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(join(dir, ".config", "sky", "config.json"));
});

test("a trailing slash on the URL is dropped", () => {
  expect(
    resolveConfig(
      {},
      { SKY_URL: "https://env.example/", SKY_API_KEY: "k" },
      home(),
    ),
  ).toMatchObject({ config: { url: "https://env.example" } });
});

test("the URL must be https, except on localhost", () => {
  const env = { SKY_API_KEY: "k" };
  for (const url of ["http://localhost:8080", "http://127.0.0.1:8080"]) {
    expect(resolveConfig({ url }, env, home()).ok, url).toBe(true);
  }
  expect(resolveConfig({ url: "http://sky.example" }, env, home())).toEqual({
    ok: false,
    error:
      '--url "http://sky.example" must use https (http only for localhost)',
  });
  const dir = withConfigFile(JSON.stringify({ url: "ftp://x" }));
  expect(resolveConfig({}, env, dir)).toMatchObject({
    ok: false,
    error: expect.stringMatching(
      /^url in .*config\.json "ftp:\/\/x" must use https/,
    ),
  });
});
