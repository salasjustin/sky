import type { Db } from "@sky/db";
import { createFactory } from "hono/factory";
import type { Principal } from "./auth.js";
import type { Config } from "./config.js";
import type { KnownSecrets } from "./redact.js";

export type AppEnv = {
  Variables: {
    /** The caller `/v1` and `/mcp` act as; set by their guard, absent on public and `/internal` routes. */
    principal: Principal;
    db: Db;
    config: Config;
    secrets: KnownSecrets;
    /** Wakes the delivery loop; call after the transaction that enqueued deliveries commits. */
    nudgeDeliveries: () => void;
    /** Aborts when the process begins shutting down; open streams and parked polls end on it. */
    closing: AbortSignal;
  };
};

/** Sub-apps built from this read the `c.var` fields above, which `createApp` sets. */
export const factory = createFactory<AppEnv>();
