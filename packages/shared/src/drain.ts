import { z } from "zod";
import { RunId } from "./ids.js";

export const DRAIN_DEFAULT_TIMEOUT_S = 1_800;
export const DRAIN_MAX_TIMEOUT_S = 7_200;

/** The body of `POST /v1/admin/drain`. */
export const DrainInput = z.strictObject({
  timeoutSeconds: z
    .int()
    .min(1)
    .max(DRAIN_MAX_TIMEOUT_S)
    .default(DRAIN_DEFAULT_TIMEOUT_S),
});
export type DrainInput = z.input<typeof DrainInput>;

/** What `/v1/admin/drain` answers. */
export const DrainStatus = z.object({
  draining: z.boolean(),
  since: z.iso.datetime().nullable(),
  deadline: z.iso.datetime().nullable(),
  /** Runs still `starting` or `running`; a run waiting on an approval or an answer is quiet. */
  active: z.array(RunId),
  /** Launches held in the queue, to start when the drain ends. */
  held: z.int().nonnegative(),
  /** Nothing is starting or running. */
  ready: z.boolean(),
});
export type DrainStatus = z.infer<typeof DrainStatus>;
