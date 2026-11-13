import { expect, test } from "vitest";
import {
  OpenBotWebhookSecret,
  StandardWebhookSecret,
  Webhook,
} from "./webhook.js";

const hook = {
  id: "whk_1",
  url: "https://grok.example/hooks/sky",
  eventTypes: ["run.waiting", "run.finished"],
  format: "sky",
};

test("accepts a webhook subscribed to known event types", () => {
  expect(Webhook.parse(hook)).toEqual(hook);
});

test("rejects a non-https url, an unknown event type and an empty subscription", () => {
  expect(
    Webhook.safeParse({ ...hook, url: "file:///etc/passwd" }).success,
  ).toBe(false);
  expect(
    Webhook.safeParse({ ...hook, url: "http://grok.example/hooks/sky" })
      .success,
  ).toBe(false);
  expect(
    Webhook.safeParse({ ...hook, eventTypes: ["run.exploded"] }).success,
  ).toBe(false);
  expect(Webhook.safeParse({ ...hook, eventTypes: [] }).success).toBe(false);
});

test("rejects an unknown format", () => {
  expect(Webhook.safeParse({ ...hook, format: "svix" }).success).toBe(false);
});

test("accepts an environment filter and a standard format, refusing an empty filter", () => {
  const filtered = { ...hook, format: "standard" };
  expect(
    Webhook.safeParse({ ...filtered, environmentIds: ["env_1"] }).success,
  ).toBe(true);
  expect(Webhook.safeParse({ ...filtered, environmentIds: [] }).success).toBe(
    false,
  );
});

const key = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

test.each([
  ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", true], // 24 bytes
  [`whsec_${key(32)}`, true], // 44 chars ending =
  [`whsec_${key(64)}`, true],
  ["whsec_", false],
  ["MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", false],
  ["whsec_not base64!", false],
  ["whsec_abc", false],
  ["whsec_AAAA", false],
  [`whsec_${key(16)}`, false],
  [`whsec_${key(65)}`, false],
  [`whsec_${key(32).replace(/=+$/, "")}`, false],
  [`whsec_${Buffer.alloc(32, 250).toString("base64url")}=`, false],
])("secret %s is valid: %s", (secret, ok) => {
  expect(StandardWebhookSecret.safeParse(secret).success).toBe(ok);
});

test.each(["s", `whsec_${key(32)}`, "clé-secrète-🔑", "a".repeat(256)])(
  "openbot secret %s is accepted as sent",
  (secret) => {
    expect(OpenBotWebhookSecret.parse(secret)).toBe(secret);
  },
);

const empty = "an openbot secret is a non-empty string";
const padded = "an openbot secret has no leading or trailing whitespace";
const long = "an openbot secret is at most 256 characters";

test.each([
  ["", empty],
  [" s", padded],
  ["s ", padded],
  ["s\n", padded],
  ["s\r\n", padded],
  ["\uFEFFs", padded],
  ["a".repeat(257), long],
])("openbot secret %j is rejected: %s", (secret, message) => {
  const result = OpenBotWebhookSecret.safeParse(secret);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((i) => i.message)).toEqual([message]);
});
