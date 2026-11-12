import { z } from "zod";

const prefixedId = <P extends string>(prefix: P) =>
  z
    .templateLiteral([z.literal(`${prefix}_`), z.string()])
    .check(
      z.regex(
        new RegExp(`^${prefix}_[0-9A-Za-z]+$`),
        `expected an id of the form ${prefix}_<alphanumeric>`,
      ),
    );

export const EnvironmentId = prefixedId("env");
export type EnvironmentId = z.infer<typeof EnvironmentId>;
export const AgentId = prefixedId("agt");
export type AgentId = z.infer<typeof AgentId>;
export const RunId = prefixedId("run");
export type RunId = z.infer<typeof RunId>;
export const EventId = prefixedId("evt");
export type EventId = z.infer<typeof EventId>;
export const WebhookId = prefixedId("whk");
export type WebhookId = z.infer<typeof WebhookId>;
export const RequestId = prefixedId("req");
export type RequestId = z.infer<typeof RequestId>;
export const ApiKeyId = prefixedId("key");
export type ApiKeyId = z.infer<typeof ApiKeyId>;
