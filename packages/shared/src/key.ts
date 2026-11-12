import { z } from "zod";
import { ApiKeyId, EnvironmentId } from "./ids.js";

/** `admin` is the `SKY_API_KEY` env var; `runs` keys are issued through `/v1/keys`. */
export const KeyRole = z.enum(["admin", "runs"]);
export type KeyRole = z.infer<typeof KeyRole>;

/** An issued key's secret: `sky_` and the unpadded base64url of 32 random bytes. */
export const ApiKeySecret = z
  .string()
  .regex(
    /^sky_[A-Za-z0-9_-]{43}$/,
    "expected sky_ followed by 43 base64url characters",
  );
export type ApiKeySecret = z.infer<typeof ApiKeySecret>;

const name = z.string().trim().min(1).max(100);
const environmentIds = z.array(EnvironmentId).nonempty();

/** A key as listed, shown or revoked: never its secret or hash. */
export const ApiKey = z.object({
  id: ApiKeyId,
  name,
  role: KeyRole,
  environmentIds,
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** The response to creating a key, the only time its secret is returned. */
export const CreatedApiKey = ApiKey.extend({ secret: ApiKeySecret });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

/** The body of `POST /v1/keys`: only `runs` keys are issued. */
export const KeyInput = z.strictObject({
  name,
  role: z.literal("runs"),
  environmentIds,
});
export type KeyInput = z.infer<typeof KeyInput>;
