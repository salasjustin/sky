import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { ApiKey, ApiKeySecret, CreatedApiKey, KeyInput } from "./key.js";

const secret = `sky_${randomBytes(32).toString("base64url")}`;

const key = {
  id: "key_1",
  name: "grok",
  role: "runs",
  environmentIds: ["env_1"],
  createdAt: "2026-11-12T00:00:00Z",
  revokedAt: null,
  lastUsedAt: null,
};

test("accepts an issued key, with or without revocation and last use", () => {
  expect(ApiKey.parse(key)).toEqual(key);
  const used = {
    ...key,
    role: "admin",
    revokedAt: "2026-11-12T01:00:00Z",
    lastUsedAt: "2026-11-12T00:30:00Z",
  };
  expect(ApiKey.parse(used)).toEqual(used);
});

test("a listed key carries no secret; a created one carries it", () => {
  expect(ApiKey.parse({ ...key, secret })).not.toHaveProperty("secret");
  expect(CreatedApiKey.parse({ ...key, secret })).toEqual({ ...key, secret });
  expect(CreatedApiKey.safeParse(key).success).toBe(false);
});

test.each([
  ["an unknown role", { role: "owner" }],
  ["no environments", { environmentIds: [] }],
  ["a bad environment id", { environmentIds: ["key_1"] }],
  ["a bad id", { id: "env_1" }],
  ["a blank name", { name: "   " }],
  ["a long name", { name: "x".repeat(101) }],
  ["a non-iso createdAt", { createdAt: "yesterday" }],
])("an ApiKey rejects %s", (_, patch) => {
  expect(ApiKey.safeParse({ ...key, ...patch }).success).toBe(false);
});

const input = { name: "  grok  ", role: "runs", environmentIds: ["env_1"] };

test("KeyInput takes a trimmed name, the runs role and environments", () => {
  expect(KeyInput.parse(input)).toEqual({ ...input, name: "grok" });
});

test.each([
  ["the admin role", { role: "admin" }],
  ["no role", { role: undefined }],
  ["no environments", { environmentIds: [] }],
  ["a blank name", { name: " " }],
  ["an unknown field", { secret }],
])("KeyInput rejects %s", (_, patch) => {
  expect(KeyInput.safeParse({ ...input, ...patch }).success).toBe(false);
});

test.each([
  [secret, true],
  [`sky_${"A".repeat(42)}-`, true],
  [`sky_${"_".repeat(43)}`, true],
  [`sky_${"A".repeat(42)}`, false],
  [`sky_${"A".repeat(44)}`, false],
  [`sky_${"A".repeat(42)}=`, false],
  [`sky_${"A".repeat(42)}+`, false],
  [`key_${"A".repeat(43)}`, false],
  ["sky_", false],
])("secret %s is valid: %s", (s, ok) => {
  expect(ApiKeySecret.safeParse(s).success).toBe(ok);
});
