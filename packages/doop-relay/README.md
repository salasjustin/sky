# doop-relay

A small Cloudflare Worker that relays Doop comment webhooks to an OpenBot webhook listener. The two sign differently, so it verifies Doop's signature and re-signs for OpenBot. Sky's API and runner don't depend on it, and it isn't part of Sky's image.

It forwards `comment.created` and `comment.replied`. Everything else (Doop's `ping`, events from an agent actor) is answered 200 and dropped, so a PM's own reply wakes no one. Failures answer a non-2xx so Doop retries: 401 bad signature or a timestamp more than 5 minutes off, 413 over 64 KB, 503 missing config or OpenBot unreachable. OpenBot's own status passes through.

## Deploy

Run from `packages/doop-relay`, logged in to the target Cloudflare account (`wrangler.toml` carries no account id):

1. Set the var `OPENBOT_WEBHOOK_URL` in `wrangler.toml` to OpenBot's webhook listener URL.
2. Set the secrets:
   - `wrangler secret put DOOP_WEBHOOK_SECRET` — the signing secret Doop shows for the webhook.
   - `wrangler secret put OPENBOT_WEBHOOK_SECRET` — OpenBot's webhook secret.
3. `wrangler deploy`.

Then in Doop, Settings → Webhooks, add the Worker's URL (`https://doop-relay.<subdomain>.workers.dev`) and subscribe the three comment events.

The Worker logs only the delivery id, event type and outcome — never secrets, comment text or the body.
