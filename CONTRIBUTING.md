# Contributing

## Prerequisites

- Node 24 or newer (`@fly/sprites` requires it)
- pnpm 10.19.0 (`corepack enable` picks it up from `packageManager`)

## Install and check

```
pnpm install
pnpm typecheck && pnpm lint   # tsc -b; biome, plus a check that each custom lint rule still fires
pnpm test                     # vitest; Sprites, GitHub and Anthropic are mocked, nothing is called live
pnpm build                    # bundles the API, the runner and the CLI
```

All four commands must pass before a pull request is ready to merge.

## Running it locally

The tests need no keys. A running API does: it drives real Sprites and real Claude sessions, so it needs the same secrets a deploy does (listed at the top of [`fly.toml`](fly.toml)) as environment variables, plus `DATA_DIR` for the SQLite file and `PUBLIC_BASE_URL`, an address your sprites can reach. After `pnpm build`:

```
node apps/api/dist/bundle/main.js
node packages/cli/dist/bundle/sky.mjs --help
```

## Deploy

Sky runs as one Fly machine with a volume for its SQLite database. [`fly.toml`](fly.toml) names every secret and how to generate it; set your app name and region there, then `fly volumes create sky_data`, `fly secrets set …`, and `fly deploy`. Take volume snapshots: the database is a single copy.

Repo access goes through a Sprites connector, never a raw GitHub token in the sprite. An agent publishes with `node /opt/sky/runner.mjs publish` ([`packages/runner/src/publish.ts`](packages/runner/src/publish.ts)), which recreates its commits through GitHub's REST API at the Sprites gateway, since the gateway carries no git push. It reads the connection id from `GITHUB_CONNECTOR`, and the gateway from `GITHUB_GATEWAY_URL` (default `https://api.sprites.dev/v1/gateway/github`).

### Store sync

A base profile's `storeRepo` (README → Base profiles) is a GitHub repo an agent keeps shared files in, such as an inbox or plan files. The gateway speaks REST only, so `git clone` and `git push` can't reach it from a sprite; [`packages/runner/src/store.ts`](packages/runner/src/store.ts) syncs it through the same API `publish` uses, keeping a local git repo in the checkout for merging. The checkout is `storeLayout.home` under `$HOME` (`.sky-store` by default).

- **Provisioning** runs `runner.mjs store-sync pull` when the env's profile has a `storeRepo` and the env has a `GITHUB_CONNECTOR` connector (a value secret by that name doesn't count), then the store's own `setup.sh`. The pull sources the env's secrets as a run does, so an env's `GITHUB_GATEWAY_URL` applies to it. Files already in the checkout are committed and merged with the remote's (the layout's `lineFiles` by its `mergeScript` when present, else `git merge-file --union`; on any other conflict the local copy wins and the remote's stays in history), never discarded. A failure is logged and doesn't fail provisioning. Repeating it changes nothing.
- **Every run** pulls before the session and pushes after it, under an exclusive `flock` on `.sky-store.lock` in the checkout so agents on one sprite take turns. A push that finds the remote moved pulls (rebase) and retries up to four times. A failed sync is logged to the runner's stderr and never fails the run.
- **The session** reads the profile from the env file, after the env's secrets so none can override it: `SKY_STORE_REPO`, `SKY_STORE_HOME` and `SKY_STORE_LAYOUT` (only with the connector), `SKY_SESSION_ENV`, `SKY_CHECKS` and `SKY_MCP_SERVERS` (the profile's MCP servers, secrets by name). These names are reserved. The runner resolves those servers' secrets from the run's env and gives the session the servers directly, so a run has them even if another `claude` process on the sprite clobbered `~/.claude.json`; one missing from that file, or left out because its secret isn't set, is a `runner.warning`. A profile's `sessionEnv` is how a plugin's own sync hook is told to stay off, so it doesn't race the runner's sync on the same checkout. Setting `SKY_NO_STORE_SYNC` (or its earlier name `KRU_NO_STORE_SYNC`) on the env turns the runner's sync off too, and provisioning's pull and `setup.sh`.

## Brand

`brand/` holds the hand-drawn masters (`sky-mark.svg`, `sky-mark-16.svg`, `sky-tile.svg`, `sky-wordmark.svg`); every other file there comes from `node brand/build.mjs`.
