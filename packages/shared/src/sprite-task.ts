import { createHash } from "node:crypto";

/**
 * The name of the sprite Tasks API task that keeps a run's sprite awake, hashed into the lowercase
 * letters, digits and hyphens the Sprites API takes for a name: a run id's capitals and underscore
 * fall outside them. The API takes its hold before the runner starts, and the runner's own PUT
 * refreshes the same task, so both must derive the name here.
 */
export const spriteTaskNameFor = (runId: string) =>
  `sky-run-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
