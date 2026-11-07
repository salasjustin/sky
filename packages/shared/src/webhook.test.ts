import { expect, test } from "vitest";
import { StandardWebhookSecret, Webhook } from "./webhook.js";

const hook = {
  id: "whk_1",
  url: "https://grok.example/hooks/sky",
  eventTypes: ["run.waiting", "run.finished"],
  format: "sky",
  hasSecret: false,
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

test("accepts an environment filter and a standard format, refusing an empty filter", () => {
  const filtered = { ...hook, format: "standard", hasSecret: true };
  expect(
    Webhook.safeParse({ ...filtered, environmentIds: ["env_1"] }).success,
  ).toBe(true);
  expect(Webhook.safeParse({ ...filtered, environmentIds: [] }).success).toBe(
    false,
  );
});

test.each([
  ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", true],
  ["whsec_", false],
  ["MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", false],
  ["whsec_not base64!", false],
  ["whsec_abc", false],
])("secret %s is valid: %s", (secret, ok) => {
  expect(StandardWebhookSecret.safeParse(secret).success).toBe(ok);
});
