import { DrainInput } from "@sky/shared";
import { adminOnly } from "./auth.js";
import { factory } from "./factory.js";
import type { Launcher } from "./launch.js";
import { body, jsonBody } from "./validation.js";

/**
 * `/v1/admin`, for the admin key only: the drain a deploy waits behind. While it is on, new launches
 * are held as `queued` runs; ending it, by `DELETE` or at its deadline, starts them.
 */
export function adminRoutes(launcher: Launcher) {
  return factory
    .createApp()
    .post("/drain", adminOnly, jsonBody, body(DrainInput), (c) =>
      c.json(
        launcher.startDrain(c.req.valid("json").timeoutSeconds * 1000),
        200,
      ),
    )
    .get("/drain", adminOnly, (c) => c.json(launcher.drainStatus(), 200))
    .delete("/drain", adminOnly, (c) => {
      launcher.endDrain();
      return c.json(launcher.drainStatus(), 200);
    });
}
