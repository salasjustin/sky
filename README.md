<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/sky-header-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/sky-header-light.svg">
  <img alt="sky" src="brand/sky-header-light.svg">
</picture>

Your Claude Code crew, in the cloud.

Sky runs Claude Code agents on your own servers while you're away. Point it at a GitHub repo, hand an agent a prompt, and it works in its own session and branch, asks you when it needs an answer or an approval, and tells you when it's done. You drive it from a REST API, a CLI, an MCP server (so a chat bot can dispatch work), and signed webhooks.

Sky is not affiliated with or endorsed by Anthropic.

[![Watch a 44-second film about Sky: agents move their builds off your computer and into sprites](https://marketing-justin.fly.storage.tigris.dev/sky/film/v6/sky-film-v6-poster.jpg)](https://marketing-justin.fly.storage.tigris.dev/sky/film/v6/sky-film-v6.mp4)

## Where to use it

Sky is self-hosted: there is no shared instance. Deploy your own with [CONTRIBUTING.md](CONTRIBUTING.md#deploy); every example below uses `https://<your-app>.fly.dev`.

## Auth

Every call carries the API key you set at deploy time:

```
Authorization: Bearer <SKY_API_KEY>
```

A missing, unknown or revoked key returns `401`.

### Keys and roles

`SKY_API_KEY` is the **admin** key: it can do everything, and only it can mint, list and revoke other keys. Issue a narrower **`runs`** key to give another system its own agents on chosen environments and nothing else:

```bash
sky key create better-giving --role=runs --env=bg-platform   # --env takes ids or names, comma-separated
sky key list                    # id, role, active|revoked, name and environments; secrets are never printed
sky key revoke key_…
sky env set-claude web personal   # admin only: the Claude credential web's runs use: a name, api-key, pool or default
sky claude-credentials            # admin only: each credential, its environments, limit and runs today
```

`create` prints `key_… sky_…` once. Sky stores only a hash of the secret, so it can't be shown again; lose it and revoke the key. Revoking takes effect on the next request and also deletes the webhooks that key created. Over REST: `POST /v1/keys` (`name`, `role: "runs"`, `environmentIds`), `GET /v1/keys`, `DELETE /v1/keys/:id`.

A `runs` key, within the environments on its list:

- can start agents (`POST /v1/agents`), follow up, read agents, runs, events and streams, approve, deny and answer, and stop and archive **its own** agents;
- can read the environments on its list (`GET` only, no secrets);
- can add, list and delete **its own** webhooks, which deliver only its own agents' events;
- is refused with `403 forbidden` on environment create, update, delete and retry, every secret route, and the key routes;
- gets `404 not_found` for an environment not on its list and for any agent that isn't its own, so it can't probe ids.

**Ownership.** Every agent records the key that started it; one started with the admin key is admin-owned, as is every agent created before keys existed. A `runs` key only ever sees and acts on its own agents, including in `GET /v1/events`, `GET /v1/stream` and through `/mcp`. The admin key sees and acts on all of them.

**The environment is the boundary inside the sprite.** These limits hold at the API. Every agent of an environment runs on its one sprite as the same user, so an agent a `runs` key starts can read what that sprite holds: the environment's secrets, the files, variables and agent tokens of other agents running there, and the run's Claude credential in the cases [What a repo's hooks, MCP servers and commands can see](#what-a-repos-hooks-mcp-servers-and-commands-can-see) lists. A prompt asking for them is enough. Put an environment on a key's list only when you'd hand that system the environment's secrets; for a system you trust less, give it an environment of its own.

## Install and configure

Your Sky API serves the CLI as one file. It needs Node 24 or later.

```
mkdir -p ~/.local/bin
curl -fsSL https://<your-app>.fly.dev/cli/sky.mjs -o ~/.local/bin/sky && chmod +x ~/.local/bin/sky
```

Make sure `~/.local/bin` is on your `PATH`, then check the install with `sky --version`. Rerun the `curl` to update; the file always matches the API you deployed. The route is public, and the file holds no keys.

Tell it where your API is and how to authenticate, with environment variables:

```
export SKY_URL=https://<your-app>.fly.dev
export SKY_API_KEY=<the key you set at deploy time>
```

or with the config file `~/.config/sky/config.json` (`$XDG_CONFIG_HOME/sky/config.json` when that is set):

```json
{ "url": "https://<your-app>.fly.dev", "apiKey": "<the key>" }
```

Flags beat environment variables, which beat the file. To check the URL and key, list your environments; a `401` means the key is wrong:

```
curl -fsS -H "Authorization: Bearer $SKY_API_KEY" "$SKY_URL/v1/environments"
```

## CLI

```
sky apply env.yaml
```

Creates or updates the environment `env.yaml` describes, waits until it's provisioned, and writes `sky-lock.json` beside it:

```yaml
name: web
repo: owner/name # GitHub repo, cloned once per environment
setup: pnpm install # shell script run once after the clone
base: team # optional: a base profile the server defines (see Base profiles)
concurrency: 3 # agents running at once (default 3)
approvalPolicy: [Bash] # tool names whose calls wait for your approval
autoApprove: # optional: Bash commands that skip approvalPolicy
  defaults: true # false drops the built-in list
  commands: [make check] # added to the built-ins (or all there is, with defaults: false)
claudeCredential: personal # optional: which Claude credential runs use (see Claude credentials)
claudePool: [work, personal] # optional, with claudeCredential: pool: the subscriptions it may use, in order
claudeFallback: api-key # optional: api-key or none, what a run does while its subscription is at its limit
```

The Claude fields are optional. A field the file omits keeps the environment's current value, so `sky apply` never undoes a `sky env set-claude`, and deleting `claudeCredential` from the file doesn't move an environment back to the default token: write `claudeCredential: default` for that. A new environment gets the defaults (the default token, every subscription if it is a pool, `api-key`).

`setup` runs in the clone with bash, with pnpm and yarn on `PATH` and `SKY_CLAUDE` set to the `claude` binary agents run. After it, Sky installs the plugins the repo's `.claude/settings.json` enables in `enabledPlugins`, from the marketplaces its `extraKnownMarketplaces` declares. If a plugin comes from a marketplace that isn't declared there, add the marketplace in `setup`:

```yaml
setup: |
  pnpm install
  "$SKY_CLAUDE" plugin marketplace add owner/marketplace-repo
```

Provisioning fails at the setup step, naming the plugin and its marketplace, if a plugin's marketplace is neither declared nor added.

**Memory and `concurrency`.** Every agent of an environment runs on its one sprite, and a sprite has a fixed amount of memory and no swap. A large monorepo (thousands of files, with a typecheck or test run per agent) can use several GB at a time, so set `concurrency` to 1-2 there; the default of 3 suits small repos. When a sprite runs out of memory the kernel kills processes, often the runner, and the run is lost with the work since its last commit. Sky guards against this two ways. Before it starts a run, it reads the sprite's available memory (`free -m`) and, below `SPRITE_MIN_FREE_MB` (an environment variable of the API; default `1024`, `0` turns the check off), refuses the launch with `sprite_low_memory`. And when a run ends, the runner ends every process the run's session started (dev servers, watchers, test workers, a nested `claude -p`), so they don't hold memory for the next run; other runs' processes on the sprite are left alone. A [preview](#previews) is the exception to that cleanup, and it counts against the same memory: its production build is a heavy job, and its app and proxy stay up past the run, so budget for them in `concurrency` and in `SPRITE_MIN_FREE_MB` like another agent's run, start a preview while no other heavy job runs on the environment, and stop a preview you no longer need.

```
sky secret set web NPM_TOKEN < token.txt
```

Stores a secret on an environment; on a terminal it prompts without echo. `sky --help` lists the options, the config file location, and exit codes.

```
sky secret list web             # names and kinds; values are never printed
sky secret delete web NPM_TOKEN
sky env list                    # id, status, repo and name per environment
sky env show web                # one env; a failed one shows its step and stderr
sky env retry web               # provision a failed env again
sky env delete web              # destroy its sandbox, agents, runs and events; asks first
sky env delete web --yes        # the same without asking; required off a terminal and with --json
                                # refused while a webhook added with --env=web exists; sky webhook delete it first
sky webhook add https://example.com/hook --events=run.waiting,run.finished   # a Sky-format webhook
sky webhook add https://example.com/hook --events=run.waiting --format=standard --secret=@secret.txt --env=web
sky webhook add https://example.com/hook --events=run.waiting --format=openbot --secret=@secret.txt --env=web
sky webhook list                # id, format, url, event types and environments, then the last attempt and a FAILING flag; secrets are never printed
sky webhook deliveries whk_…    # newest deliveries first (--limit=<1-100>, --cursor=<from the last page>)
sky webhook delete whk_…
sky key create <name> --role=runs --env=web,api   # admin only: a key limited to those environments; prints the secret once
sky key list
sky key revoke key_…
sky admin drain --wait            # admin only: hold new launches and wait for running ones; see "Draining before a restart"
sky admin drain --status
sky admin drain --cancel
```

`<env>` is an environment's name or id.

```
sky agent start web --prompt=@task.md
sky wait <agent>      # until it needs an answer or approval, or ends
sky inbox <agent>     # the pending question or approval
sky approve <agent> <requestId>   # or deny --reason=…, or answer -- <text>
sky status <agent>    # status, summary, error and compare link
sky agent list        # every live agent with its latest run's state
sky agent list --env=web --status=waiting_answer,waiting_approval
```

`sky agent list [--env=<id|name>,...] [--status=<state>,...] [--archived] [--limit=N] [--cursor=<c>] [--json]` finds an agent whose id you lost and shows what is running or stuck. It prints one line per agent, newest activity first:

```
<agent id> <state> <run id> <last event, UTC ISO> <open requests> <branch> <env name>
```

`<state>` is that of the agent's latest run (see [Listing agents](#listing-agents)), and `<branch>` is the GitHub branch the agent works on, or its own `claude/<agent id>` branch when it was started without one. `<env name>` comes last because a name may contain spaces: everything after the sixth field is the name. An agent with no run yet shows `-` for the state, run and last event. `--env` and `--status` repeat or take a comma list. Only live agents are listed unless you pass `--archived`, which lists archived agents too. When no agent matches, the exit status is still 0: stdout stays empty and stderr says `no agents match` (with `--json`, stdout gets the empty page). The API can't tell an env that doesn't exist apart from one your key may not use, so a mistyped `--env` also matches nothing. `--limit` is at most 200 (50 without it); when more agents match, a note on stderr gives the `--cursor=<c>` that fetches the next page: pass it with the same filters. `--json` prints the API's page, `{ "data": [...], "nextCursor"?: ... }`.

A deny's `--reason` is what the agent is told. `approve` takes one too: it is recorded with the decision and passed to the agent as a note.

[Driving agents](docs/driving-agents.md) walks a bot through an agent end to end: start, wait, answer or approve, follow up, read the result, archive.

### Claude credentials

Runs authenticate to Claude with a credential the server holds as a secret. Each credential has a name, and no value is ever returned, printed or logged: everything below refers to them by name.

| secret                      | credential                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE_CODE_OAUTH_TOKEN`   | `default`, a subscription token from `claude setup-token`; required, and what an environment uses until it is assigned another |
| `CLAUDE_OAUTH_TOKEN_<NAME>` | another subscription, named by `<NAME>` in lowercase: `CLAUDE_OAUTH_TOKEN_PERSONAL` is `personal`                              |
| `SKY_ANTHROPIC_API_KEY`     | `api-key`, a pay-per-use Anthropic API key                                                                                     |

A `<NAME>` is up to 64 letters, digits and `_`, and not `DEFAULT` or `POOL`. A token secret with any other name stops the API from booting.

**Each environment has one credential.** Assign it with `sky env set-claude <env> <name|api-key|pool|default>`, the `claudeCredential` field of `env.yaml`, or `PATCH /v1/environments/:id`; only the admin key can. `default`, or leaving it unset on a new environment, is the default token. A run records the name of the credential it used: `sky status` prints it and a run's `claudeCredential` carries it. `GET /v1/claude-credentials` (admin only) and `sky claude-credentials` list each credential with its kind (`subscription` or `api-key`), the environments assigned it, when its limit lifts if it is limited, how many runs started on it since midnight UTC, its last-seen 5-hour and 7-day usage, and the pool environments that may use it.

**Only a `pool` environment moves work between subscriptions, and pools are off by default.** An environment assigned a subscription, `api-key` or the default token uses that credential alone: Sky does not balance its runs across tokens, and a run that fails on its subscription is never retried on another. Its only fallback is the API key. Moving between subscriptions is something you opt an environment into, with `claudeCredential: pool` ([below](#opt-in-subscription-pool)).

**When a subscription reaches its usage limit** (the 5-hour or the weekly one), Sky marks it limited until the reset time Claude reports, kept across restarts, and:

- a run that fails with the limit is retried once, as a new run on the same agent (its `retryOf` names the failed one), resuming the same session so its worktree isn't lost, on `SKY_ANTHROPIC_API_KEY` (a pool run tries its pool's next subscription first);
- a launch while the subscription is limited goes straight to the API key, until the reset time passes;
- with no API key set, the launch fails at once with `claude_limited`, naming the reset time in UTC, instead of starting a run that would die.

If the message gives no reset time Sky can read, it holds the limit for 15 minutes. Set `claudeFallback: none` on an environment to turn the fallback off: its limited launches fail with the same error and the reset time, and no API money is spent. A run is retried from what Sky stored of its launch, so a restart between a run's launch and its limit failure doesn't lose the retry; a launch is remembered for 12 hours. What Sky stores is the run's prompt and its ids and settings, never its env vars or a credential, encrypted like the env vars with the same key and bound to the run, and deleted as soon as no retry can use it: when the run finishes or is stopped, fails in a way that isn't retried, or is retried. A stored launch that won't open or isn't the shape of a launch counts as no launch recorded. A stored launch still kept after 12 hours is deleted the next time a run starts. A runner that is still exiting is waited on for about four minutes before the retry gives up. A skipped retry leaves a `runner.warning` on the failed run saying why. Setting a Fly secret restarts the API, so stage it with `fly secrets set --stage` and run `fly secrets deploy` while no run is active.

**When Claude's login meets a Cloudflare challenge** (a 403 "Attention Required! | Cloudflare" from Anthropic's API), Sky treats it as a passing block, not a limit: the credential is never marked limited and a pool run stays on its subscription. The run is retried once after 60 seconds, as a new run on the same agent (its `retryOf` names the failed one) resuming the same session, on the same credential even if that subscription has reached its usage limit since. A second challenge in the same chain of retries fails the run with `upstream_blocked`. The waiting retry is dropped when the agent is stopped or gets a follow-up, or when its environment is no longer ready or no longer assigns that credential. It waits in the server's memory, so a restart during the 60 seconds loses it too, and the run stays failed with the challenge's own error. A dropped retry leaves a `runner.warning` on the failed run saying why.

**The API key stays out of the project's way.** Claude Code prefers `ANTHROPIC_API_KEY` over a subscription token, and an environment may hold its own `ANTHROPIC_API_KEY` secret for its commands. The runner gives the Claude session exactly the run's credential. On a subscription run no API key of any kind reaches it; the project's key still works for the commands the session runs. On an API-key run Sky's key goes to the Claude process alone: it isn't in the commands' own env, and they keep the project's own key, or have none. A nested `claude -p` (such as a Kru check) is logged in with the sandbox's subscription, so on an API-key run it isn't logged in and the agent is told to report such a check as not run.

#### Opt-in subscription pool

`claudeCredential: pool` lets one environment spread its runs over several subscriptions. It is the only assignment that does, and nothing is a pool until you set it. `claudePool: [work, personal]` (`sky env set-claude <env> pool --pool=work,personal`) lists the subscriptions it may use, in failover order; without a list the pool is every subscription the server holds, the default included. `sky env set-claude` changes the list only when `--pool` is given, so `--fallback=none` alone leaves an ordered pool as it is; `--pool=all` (any case) resets it to every subscription, as `claudePool: null` does in `env.yaml`, where `all` is not a keyword.

- **Usage.** For each subscription Sky keeps its last-seen 5-hour and 7-day usage and their reset times, read from the `anthropic-ratelimit-unified-*` headers of a one-token probe (`POST /v1/messages` on the cheapest model, with the Claude Code system prompt and the OAuth beta header). A pool launch probes the subscriptions whose reading is older than 5 minutes, one probe at a time per subscription and never more often than that, and stores the readings, so a restart keeps them. A probe that fails is logged by name and never fails the launch. A subscription the probe finds full is marked limited until that window resets. One the probe gets a `429` for with no window full is marked limited until the earliest reset the answer gives. Either is held 15 minutes when the answer gives no reset. A subscription whose token is refused (`401` or `403`) is logged by name, nothing is stored for it, and pool launches leave it out for 5 minutes. No reset is held further than 7 days ahead, from a probe or a limit message.
- **Pick.** A pool launch runs on the subscription in the pool that isn't limited and has the most headroom: the lowest of the larger of its 5-hour and 7-day use, a window already past its reset counting as unused. Ties go to the earlier in the list, and a subscription that was never probed, or whose last probe failed, ranks after those that answered.
- **Failover.** A pool run that fails with a usage limit, 5-hour or weekly, marks that subscription limited until its reset and is retried once on the next subscription in the pool's order that isn't limited, resuming the same session. A chain tries each subscription at most once. After the list it goes to the API key on the terms above, or, when the server has no key or `claudeFallback` is `none`, stays failed with a `runner.warning` naming the earliest reset in UTC. A pool launch with every subscription limited, or refused by the probe, goes straight to the key, or fails with `claude_limited` naming the earliest reset.

`sky claude-credentials` shows each subscription's usage and which pool environments use it. The API key rules above are unchanged for pools: the key reaches only the Claude session of a run that is on it.

### What Sky refuses in Claude settings

Sky holds subscription tokens and a paid API key, and Claude Code lets a settings file choose where it sends requests and with what it signs them. So a run that would let a settings file redirect the credential doesn't start.

Before Claude starts, the runner reads every settings file the session would load: the repo's `.claude/settings.json` and `.claude/settings.local.json` (in the worktree and in the main checkout), the user-level `settings.json` in the sandbox (under `~/.claude` or `CLAUDE_CONFIG_DIR`, where an environment's `setup` may have written one), and the managed `managed-settings.json` and `managed-settings.d/*.json` under `/etc/claude-code`. If any sets one of these keys, the run fails with `settings_redirect`:

- **`env` entries** that move the endpoint or swap the credential: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`, `ANTHROPIC_CUSTOM_HEADERS`, the provider switches (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`, `_MANTLE`) and their base URLs and keys (`ANTHROPIC_AWS_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`), workload identity (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_WORKSPACE_ID`, `ANTHROPIC_PROFILE`), `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and their lowercase names), `CLAUDE_CONFIG_DIR`, `HOME` (the session pins it, so `~` and the read-only command checks keep meaning the sandbox's home), and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, to any value;
- **settings keys** that run a command for a credential, compute the managed settings or change the login: `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `policyHelper`, `forceLoginMethod`, `forceLoginGatewayUrl`.

The error names the file and the key and never the value: `settings_redirect: .claude/settings.json sets env.ANTHROPIC_BASE_URL; Sky runs Claude only with its own credential. Remove it to run on Sky.` It is a final failure: Sky doesn't retry it or try another credential. Remove the key and launch again. Everything else in these files still works: `CLAUDE.md`, hooks, skills, permissions and other `env` entries.

Sky starts Claude, and a check's nested `claude`, with `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, so Claude ignores the endpoint and credential `env` entries a settings file gains mid-run. In that mode Claude also ignores a login stored in its config dir, so on a subscription or pool run the nested command is given the run's token in its env. The check above covers what is on disk when the run starts.

Sky also sets `KRU_NO_LEAD_GATE=1` for Claude and a check's nested `claude`, whatever an environment secret, a base profile or a settings file's `env` sets it to. A run's brief is its contract, so the kru plugin's lead-contract hook (`require-lead.sh`) would only block a held call a person approved. The switch turns off that block and kru's two session-start reminders (load the lead contract, run setup); kru's other hooks stay on. If another hook makes Claude Code turn down a call Sky let through, an approved one included, the run posts a `runner.warning` naming the tool, the call id and the refusal.

The `env` names listed above (less `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`) are kept out of the Claude process's own env when they come from the environment's secrets or a base profile's session env. The commands the session runs get the project's values back, except `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES`, which reach neither Claude nor its commands.

#### What a repo's hooks, MCP servers and commands can see

A repo chooses what runs next to Claude: hooks (`SessionStart`, `PreToolUse` and the rest), stdio MCP servers, helper commands in its settings, and every command the agent runs. On a subscription, pool or API-key run, none of them can read the run's Claude credential (the subscription token or Sky's API key) except in the cases listed under "What remains" below:

- **Not in their env.** In the host-managed mode Sky starts it in, Claude Code leaves the credential out of the env of its hooks, stdio MCP servers and Bash commands. Claude Code's docs don't promise this, so the probe at the end of this section checks it against the Claude Code version Sky bundles. Credential helpers are the exception: a settings file's `otelHeadersHelper` runs with Claude's own env, so Sky pins `apiKeyHelper`, `proxyAuthHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper` and `processWrapper` to empty in the settings it starts Claude with, which outrank the project's, the project-local and the user's files. A helper in any of them never runs, whether it was committed or a command wrote it mid-run, and a mid-run `apiKeyHelper` can't end an OAuth run either. The check above still fails a run that starts with `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport` or `gcpAuthRefresh` in a file; the other three are ignored. The runner also takes the credential out of its own env, so the git commands it runs, the `claude plugin` commands that refresh a base profile's plugins, and the repo's hooks and config they run, never inherit it.
- **Not through `/proc`.** Commands run as the same user as Claude, and `/proc/<pid>/environ` and `ps auxe` show a process's env to every other process of its user. The runner steps its effective user away and back at start, which makes the kernel keep its `/proc` entries from other processes of that user, and starts Claude from a mode `0111` copy of its binary (`setpriv` drops the one capability pair that reads around that mode), so Claude's entries are closed from its first instruction too. `setpriv` and the `sh` it runs are taken only from `/usr/bin` or `/bin`, and only when root alone can change them, never from `PATH`. The copy sits in the runner's own directory under the temp directory and is deleted when Claude exits or the runner ends, however it ends; a runner killed outright leaves it for the next runner to remove. If the sandbox can't do this (it is not Linux, has no such `setpriv` and `sh`, or its runner may not change its effective user), the run fails with `credential_exposed` before Claude starts, and it fails the same way if Claude's `/proc` entries turn out to be readable once it is running.

What they keep: the project's own secrets reach them as before (`NPM_TOKEN`, a token for a registry, the project's own `ANTHROPIC_API_KEY`), a GitHub connector, and proxies, which reach Bash through the command-env file. The sandbox's capabilities other than the two that read around file modes are left to the repo's commands as they were.

What remains, and why:

- A subscription or pool run with `checks` writes the run's token to a file in the runner's own directory under the temp directory, and points the agent's link at it, so a check's nested `claude -p` can log in, on a follow-up run too. The repo's commands run as the same user and can read the file and the link while the run lasts. Both are removed when the run ends, however it ends: the link only while it still points at this run's file. A runner killed outright leaves them for the next runner, which removes a dead runner's directory with its file, and every link whose file is gone. A run without `checks` writes none, and neither does an API-key run (see `checks` above).
- Sky doesn't store a Claude login in the sandbox (`~/.claude/.credentials.json`): Claude and the nested `claude` run in host-managed mode, which ignores one. A runner removes a login an earlier runner stored there, and leaves any other login and entry in that file alone.
- The credential reaches the runner in its env. Until the runner takes it out at start, and in `setpriv` and `sh` before they exec Claude, that env is readable by every process of the sandbox's user, such as another agent's commands on the same sprite.
- The boundary is the kernel's: it holds only while the repo's commands can't become root. A sandbox user with `sudo` can read every process's env through `sudo`, write a managed settings file under `/etc/claude-code` (which outranks Sky's pins and is reloaded mid-run), or reopen `/proc` for processes started after it, so none of this holds on such a sandbox. The same goes for a sandbox whose capabilities include `CAP_SYS_PTRACE`.
- The runner's bundle, Claude's binary, and the copy Claude starts from are files of the sandbox's user. A command can change them (the copy between its creation and Claude's start, the others for a later run), and whatever replaces them then receives the credential. Sky doesn't verify them, so a repo that runs on a sandbox can get the credential of any run there whose Claude starts while the repo's commands are running, and of any later run.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not turned on: on a sprite it makes Claude Code refuse to run Bash commands (it wants `bubblewrap`, which can't mount `/proc` there), removes the project's own secrets from hooks and MCP servers, and still leaves Claude's `/proc` entries readable.

`SKY_PROBE=1 pnpm test packages/runner/src/credential-scope.probe.test.ts` runs the bundled Claude Code binary against a local stand-in for the Anthropic API and checks all of this on the machine it runs on, a sprite included; its output names variables and processes, never values.

### Base profiles

A base profile is what every sprite gets before its own `setup`, defined once on the server so no client's tooling lives in Sky's code. The API reads them from `SKY_BASE_PROFILES`, a JSON object of profiles by name, empty by default; an environment picks one with `base: <name>`. A `base` the server doesn't have is rejected, and changing `base` rebuilds the sprite like changing `setup` (so it is refused with `agents_exist` while unarchived agents exist). With no `base`, an environment gets no plugins or MCP servers beyond its repo's, no store sync and no check instructions.

A profile holds:

- `marketplaces`: sources for `claude plugin marketplace add`. None may start with `-`.
- `plugins`: `name@marketplace`, installed at user scope, starting with a letter or digit. Provisioning installs and updates them after adding the marketplaces.
- `mcpServers`: user-scope MCP servers by name (letters, digits, `_` and `-`, starting with a letter or digit), each `command` (with `args`, `env`) or `url` (with `headers`). Credentials are never inline: an `env` or `headers` value is the **name** of an env secret (`sky secret set`). Each run resolves the names from its env and hands the session the servers directly. Sky also writes them into the sprite's config as `${NAME}`, so no secret value reaches the checkpoint. A header can only name a secret, so that secret holds the entire header value: for `Authorization`, store `Bearer <token>`, not the token alone.
- `storeRepo`: a GitHub `owner/name` synced through the env's `GITHUB_CONNECTOR`, as the next section describes. `storeLayout` says where the checkout lives under `$HOME` (`home`), which paths stay local (`exclude`), which are append-only line files to merge (`lineFiles`) and an optional merge script (`mergeScript`); it requires a `storeRepo`. `home` must be a directory below `$HOME`, neither `$HOME` itself nor anything under `.claude`. `exclude` and `lineFiles` patterns contain no whitespace. `mergeScript` is a path under `$HOME` of letters, digits and `.` `_` `/` `-`.
- `sessionEnv`: non-secret variables set in every session, such as a plugin's own switch. Never put a secret here. A name the runner sets or reads itself is rejected: `PATH`, `HOME`, `NODE_OPTIONS`, `AGENT_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the runner's own variables (the `SKY_` ones among them), and anything starting `GIT_`.
- `checks`: lines the runner tells the agent to follow before it finishes, each an instruction or a command on a single line, run in order from the repo root. A command that calls `claude -p` runs as a nested headless session on a subscription or pool run's own token, never the project's key. On a subscription or pool run with `checks`, before the session starts, the runner marks the repo root trusted (`projects[<path>].hasTrustDialogAccepted`) in the sprite user's `~/.claude.json` (the `.claude.json` in `CLAUDE_CONFIG_DIR` when the session's env sets it), merging into the file and leaving its other keys and mode alone. Claude Code applies a repo's `permissions.allow` entries only once it is trusted, and a nested session without them has just its built-in read-only allowances, so tests and builds are denied. Claude Code keys trust on the main checkout's root, so the entry covers a session in a worktree too. The trust is permanent and covers every Claude session in that repo on the sprite, the run's own included, not only nested ones. Beyond `permissions.allow` it adds only `additionalDirectories`, allow rules in a tracked `settings.local.json`, subagent frontmatter hooks and `mcpServers`, project skills-dir plugins, `extraKnownMarketplaces` and the `.mcp.json` `headersHelper`; deny and ask rules, settings hooks, `env`, `apiKeyHelper` and `.mcp.json` servers apply without it. The runner reads the file back right after writing, and if that write fails or the entry is already gone (another process rewrote the file in between) the run posts a `runner.warning` and goes on; a rewrite later in the run that drops the entry posts nothing. The nested command prints JSON (`--output-format json`): the agent finds the JSON object in the log (which also holds stderr), reads `.result` for the report, quotes `subtype` and `errors` when there is none, and treats a non-empty `permission_denials`, `is_error: true` or a missing `.result` as a gap to report, never as a clean pass. The nested command reads the run's token through a link named for the agent, in a directory of the sprite user's own (mode 0700) that holds every agent's link, which each run points at its own credential file in the runner's directory under the sprite's temp dir; the prompt names the link, so a follow-up that resumes the session finds a live login at the same path. The runner makes the link under a temporary name and renames it into place, and, before it writes into a directory, refuses one that isn't a directory of the sprite's user and sets it to mode 0700. Every process of the sprite's user can read the file and the link while they exist, other agents' sessions on the sprite included. The runner deletes the file, and the link while it still points there, when the run ends or the runner crashes, and a runner killed outright leaves them until the next runner starts on the sprite and sweeps them. An API-key run, the API-key retry of a run that hit its subscription limit included, writes no such file, since every process of the sprite's user could read Sky's key there: the agent is told not to run its checks that call `claude`, and to report them as not run.

Provisioning applies the profile after the clone and before `setup`, so `setup` can use what it installs; the env's own plugins from `.claude/settings.json` follow `setup`. Plugins are installed and updated on each provision. Each run also refreshes the user-scope ones before its session starts: the runner runs `claude plugin marketplace update`, then `claude plugin update <plugin> --scope user` for each, one run at a time per sprite. The refresh gets 30 seconds, plus up to 5 more to read the plugin list back after a refresh that ended early. It is best effort: a slow or unreachable marketplace, a failed update or a stop never fails the run, and the session starts with whatever is installed. `--scope user` moves only the user-scope install record, and a project-scope record of the same plugin keeps the version it was installed with. Sky never makes one, but Claude Code does: the first time a session opens a worktree whose `.claude/settings.json` enables a plugin that is installed for the user (a repo's own `enabledPlugins`, as in the environment section above), it writes a project-scope record for that worktree, pinned to the version then installed, in `~/.claude/plugins/installed_plugins.json`. A later refresh moves the user record on and leaves that one behind, so the runner also runs `claude plugin update <plugin> --scope project` from the agent's worktree for each plugin that has such a record for that worktree, inside the same 30 seconds. A run that starts while another run on the sprite is refreshing waits for it, then skips the marketplace and user-scope updates, which that run just made, but takes the lock itself to list the plugins, update its own worktree's records the same way and list them again; the wait counts against its 30 seconds. Other worktrees' records and the repo's own files are left alone. A worktree that doesn't exist yet has no record to update; its first session records the version the refresh just left. Claude Code also treats a `version` set in a plugin's manifest as a pin, so an update that finds the same version changes nothing. Claude Code loads plugins at session start, so the record described after the example says what each run actually loaded.

```json
{
  "team": {
    "marketplaces": ["acme/claude-plugins"],
    "plugins": ["review@claude-plugins"],
    "mcpServers": {
      "docs": {
        "command": "npx",
        "args": ["-y", "docs-mcp"],
        "env": { "DOCS_API_KEY": "DOCS_API_KEY" }
      },
      "search": {
        "url": "https://search.example.com/mcp",
        "headers": { "Authorization": "SEARCH_AUTH" }
      }
    },
    "storeRepo": "acme/agent-store",
    "checks": ["run `pnpm check` and fix what it reports"]
  }
}
```

Here `DOCS_API_KEY` on the left is the variable the server sees, and on the right the env secret that fills it; the `SEARCH_AUTH` secret holds `Bearer <token>`. [`docs/examples/base-profile.kru.json`](docs/examples/base-profile.kru.json) is a full profile with a store layout. Set it with `fly secrets set SKY_BASE_PROFILES="$(jq -c . profiles.json)"`. A bad value stops the API at boot, naming the field.

**Which plugin versions a run loaded.** The start-of-run refresh's record is on the run's `run.started` event as `plugins`, and on the run object as `plugins` (`null` before the run starts, and for a run from an older runner):

```json
{
  "outcome": "failed",
  "reason": "update failed for review@acme project scope (marketplace unreachable)",
  "durationMs": 4120,
  "before": [{ "name": "review", "marketplace": "acme", "version": "0.239.0" }],
  "after": [{ "name": "review", "marketplace": "acme", "version": "0.239.0" }],
  "steps": [
    { "name": "list before", "ms": 590 },
    { "name": "marketplace update", "ms": 2810 },
    { "name": "update review@acme", "ms": 580 },
    { "name": "update review@acme (project)", "ms": 40 },
    { "name": "list after", "ms": 100 }
  ],
  "loaded": [{ "name": "review", "marketplace": "acme", "version": "0.239.0" }]
}
```

- `outcome` is a code: `refreshed`, `timed_out`, `failed` or `skipped`. `reason`, set for `failed` and `skipped`, says why: for `failed` the first line of the command's error output (stderr when it has one, at most 200 characters), naming a plugin whose update failed, at user or project scope, while the others updated, and at most 300 characters in all; for `skipped`, `stopped` when the run was stopped before or during the refresh, or `another run refreshed the plugins` when it waited out another run's refresh on the same sprite and then had no worktree, or no record for its worktree, to update. A run that waited and did update its worktree's records has the outcome of those updates. A record written before the codes, whose `outcome` was `failed: <reason>` or `skipped: <reason>`, reads the same way, as a code and a reason.
- `before` and `after` list the user-scope plugins either side of the refresh, read from `claude plugin list`, at most 100 each. `null` means the refresh never read that list. Both are `null` when no listing finished: a run already stopped at start, a stop or timeout while waiting on another run's refresh, a run that waited with no worktree to update, or a first listing that hung, failed or was cut by a stop. `after` alone is `null` when a stop or a timeout cut the refresh after its first listing and no read-back finished (a stop skips the read-back). A run that waited and found no record for its worktree lists once, and that listing is both `before` and `after`. `[]` means it read the list and found no plugins. A record from before this distinction has `[]` for a list it never read. `loaded` is what the session itself reports loading, read from Claude Code's start message, so it is the version the run actually used: compare it with `after`. A `refreshed` outcome with `loaded` behind `after` is an update that landed without changing what the session loaded. No credential or token goes into the record.
- `steps` says where the time went: one `{ name, ms }` per `claude` command the refresh ran, in order (`list before`, `marketplace update`, `update <plugin>`, `update <plugin> (project)`, `list after`, and `list after (cut short)` for the read-back after a refresh that ended early), at most 50 and each name at most 100 characters. A command cut by a timeout counts up to the cut. One cut at its own 10 seconds is followed by the next command; after the overall timeout cuts one, the read-back `list after (cut short)` can follow it. A wait on another run's refresh is not a step: it is the part of `durationMs` the steps don't cover. `steps` is absent from a record made before it existed, and from a run that ran no command.
- **Budget.** The whole refresh, a wait on another run's refresh included, gets 30 seconds. The marketplace update and each plugin update also get 10 seconds of their own; `list before` and `list after` run under the overall budget only, and the read-back after a refresh that ended early gets 5 seconds of its own, so a refresh cut at 30 seconds can take up to 35 in all. On a sprite a whole refresh took about 5 seconds, with the marketplace update the longest command at about 3 seconds, so a refresh that hits 30 seconds was stalled on the network or on another run's lock, and a bigger budget would only make a stalled run wait longer. A marketplace update that stalls past its 10 seconds is recorded as a failed update (`update failed for marketplace (timed out after 10.0s)`) and the plugin updates after it still run from the marketplace's cached copy, the worktree's own records included, instead of the stall using up the budget. A plugin update that stalls is cut the same way, and the next one goes on.
- Any outcome but `refreshed` is also posted as a `runner.warning` ("plugin refresh timed_out; the session loaded review@0.214.0", or, for the record above, "plugin refresh failed: update failed for review@acme project scope (marketplace unreachable); the session loaded review@0.239.0"), the event for a problem that didn't end the run, so a client that watches warnings, such as the MCP `wait` tool, sees it without reading `run.started`.

`sky status <agent>` prints it without JSON, after the compare link:

```
plugins: failed: update failed for review@acme project scope (marketplace unreachable) (4.1s)
  review@acme  before 0.239.0  after 0.239.0  loaded 0.239.0
```

A list the refresh never read gets a line of its own, `  not read: before and after the refresh`, so it isn't mistaken for a list with no plugins.

If the API gets a `run.started` whose plugin record it can't read, it drops the record, logs a line and stores the event without it: the run starts and its `plugins` stays `null`.

A line ends with `(the session loaded X, not the installed Y)` when the two differ. `sky status --json` and `GET /v1/agents/:id/runs` carry the whole record.

### Approvals

`approvalPolicy` holds the listed tool calls until you approve or deny them. A wait that runs past its limit still fails the run with `waiting_timeout`. If Claude Code cancels a held call's wait while the run goes on, the agent is told no one answered in time, that this was not a refusal, and that it may retry the step; a `runner.warning` names the request when one was opened. A Bash command on the auto-approve list skips a bare `Bash` entry and runs at once, so `git status` or `grep` doesn't cost an approval. A `Bash(git diff:*)` entry still holds what it names, and `Read`, `Glob` and `Grep` are unaffected.

A command skips approval only when every simple command in it would skip approval on its own: each is plain words starting with a list entry, and none of the checks below asks. Simple commands may be joined by `;`, `&&`, `||` and `|`, so `git status -sb | head -3`, `ls a; cat b` and `cd packages/x && grep -n foo bar.ts` run at once, while `git status && git push` asks. Anything else waits for you, and so does a command the runner can't evaluate.

Built-in list (`defaults: true`), with what each asks on besides the checks on every command:

- `ls`, `cat`, `head`, `pwd`, `which`: nothing more.
- `wc`: asks on `--files0-from` and any `--f…`.
- `echo`: the syntax check only; it prints its arguments, so they aren't checked as paths.
- `grep`: asks on `-r`, `-R`, `-d` (also inside a bundle such as `-rn`), and any long option outside the plain matching and output ones.
- `rg`: asks on `--pre`, `--pre-glob`, `--hidden`, `--follow`, `--no-ignore*`, `--ignore-file`, `--type-add`, `--unrestricted`, `--search-zip`, `--hostname-bin`, `--trace`, `--debug`, and short options holding `z`, `u`, `L`, `g` or `.`. `-g`, `--glob` and `--iglob` take a pattern that only filters what is searched, so the paths are still checked: an exclusion (`'!node_modules'`) or one source or doc extension, lowercase (`'*.ts'`, `'**/*.md'`; `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `md`, `mdx`, `css`, `scss`, `html`, `svelte`, `vue`, `astro`, `sql`, `go`, `py`, `rs`, `zig`, `sh`, `graphql`, `prisma`), runs, and any other inclusion asks (`'*'`, `'.env'`, `'*.env'`, `'*.local'`, `'*.pem'`, and config or data extensions: `'*.json'`, `'*.jsonc'`, `'*.yml'`, `'*.yaml'`, `'*.toml'`, `'*.txt'`), since rg's `*` matches a leading dot and a matching glob searches hidden and ignored files, so `'*.json'` would reach a gitignored `credentials.json` or a hidden `.claude.json`.
- `sed`: runs `sed -n 'N,Mp' file…` and `sed -n 'Np' file…`; any other script asks, except with `-i` (below).
- `date`: runs `-u`, `--utc`, `-R` and a `+FORMAT`; `-s`, `-f` and other options ask. `true` takes no arguments. `sleep N` runs for up to 60 seconds. None of them checks its arguments as paths.
- `timeout <N> <command>` and `env -u NAME … <command>` are judged by the command they run, with its own checks, so `timeout 300 pnpm test` runs and `timeout 5 curl x` asks. Any other `timeout` or `env` option, `env NAME=value` and a bare `env` ask. These work with `defaults: false` too.
- `pnpm exec vitest`, `pnpm exec tsc`, `pnpm exec biome check|lint|format`, and the same after `-r` or `--filter <pkg>`, with any options but vitest's `--inspect*`, `--ui`, `--api*`, `--browser*` and `--open`, which open a network listener and ask: they run the code `pnpm test` and `pnpm lint` run, and their paths are checked as for a write (below). A single-quoted `$` in their arguments is plain text, as `pnpm exec` starts the program with no shell. `biome check|lint|format` without `pnpm exec` runs alike.
- `tail`: asks on following, `-f`/`-F` in any bundle and any `--f…`.
- `find`: asks on `-L`, `-follow`, `-files0-from`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`.
- `git status`, `git log`, `git diff`, `git show`, `git rev-parse`: asks on `-c`, `--config-env…`, `-O…`, `--output…`, `--ext-diff`, `--textconv`, `--no-index`, `--open-files-in-pager…`, `--exec-path…`, `--git-dir…`, `--work-tree…`.
- `git branch`: asks on the git options above, any flag but `-l`/`--list`, `-a`/`--all`, `-r`/`--remotes`, `-v`/`-vv`/`--verbose`, `--show-current`, `--color`/`--no-color`, and a name without `--list` or `-l`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`: see below.
- `node --version`, `node -v`: asks on anything else.
- Writes inside the worktree or the run's scratch directory, the kind the Edit and Write tools make: `git add` (`-A`, `-u`, `-N`, `-n`, `-v` and paths), `git commit` with `-m`, `-qm`, `-am` or `-F <file>` (and `-q`, `-a`, paths; no `--amend`, `--no-verify`, `--author` or `-F -`), `git restore` (`--staged`, `--worktree`, paths), `git checkout -- <path>`, `git stash` (alone, with `push` or `list`; `-u`, `-k`, `-q`, `-m <message>`, paths; `pop`, `apply`, `show` and `drop` ask, since every worktree of the repository, so every agent of the project, shares one stash list), `sed -i` with a script of plain `s`, `d` and `p` commands (no `e`, `w` or `r`) on files, `mkdir -p`, `biome format|check|lint --write` and `cat > file <<'EOF'` or `cat >> file <<'EOF'`. `git push`, `remote`, `config`, `fetch` and `pull`, and every other `git checkout` form, still ask. A pathspec starting with `:` asks. Every path such a command names must be in the worktree or the scratch directory (not the plugin cache or the store), and a path with a secret name, `.git` or `.claude` in it asks, so `.git/config` and `.git/hooks/…` do. A file that doesn't exist yet is judged on its nearest parent that does, so a link on the way that leads out asks, and so does a dangling link.
- `cd <dir>`: one directory and no options; asks on a bare `cd`, `cd -`, zsh's `cd +1` and two-argument `cd old new`, and on a `cd` inside a pipeline. A later command that runs only after the `cd` succeeds (after `&&`) has its paths checked against `<dir>`; any other later command is checked against both `<dir>` and the directory before it, since a failed `cd` leaves the shell where it was: `cd src && cat ../package.json` runs, `cd src; cat ../package.json` asks.

Only on the right of a `|`, filtering what the command before printed:

- `cut`, `tr`, `nl`, `column`: nothing more. `tr` takes no files, so its arguments aren't checked as paths.
- `sort`: asks on `-o`, `-T` (also inside a bundle) and any long option outside the plain ordering and key ones, so `--output`, `--compress-program`, `--temporary-directory`, `--files0-from` and `--random-source` ask.
- `uniq`: asks on a second file operand, which `uniq` writes to, and on options other than `-c`, `-d`, `-D`, `-u`, `-i`, `-z`, `-f`/`-s`/`-w N` and their long forms.
- `jq`: asks on `-f`/`--from-file`, `--rawfile`, `--slurpfile`, `--argfile`, `-L` and any option outside the plain output ones, and on a filter using `env`, `$ENV`, `import`, `include` or `modulemeta`. The filter isn't checked as a path; file operands are.
- `awk`: asks on any option but `-F` and `-v`, so `-f`, `-e`, `-d` and the gawk file options ask, and on a program holding `system`, `getline`, `ARGV`, `ARGC`, `ENVIRON`, `PROCINFO`, `SYMTAB`, `FUNCTAB`, `>`, `|` or `@`. The program isn't checked as a path; file operands are.
- `sed`: already on the list above; after a `|` it reads stdin, so `| sed -n 1,5p` needs no file.

These are built in with the defaults, so `defaults: false` drops them, `cd` included.

Checks on every command:

- Syntax: a lone `&`, `|&`, `<`, `(`, `)`, `*`, `?`, `[`, `]` or `#` outside quotes asks (background, stderr pipes, input redirects and here-docs, subshells and process substitution, globs, comments), and so do newlines, unbalanced quotes, a word starting with `~` other than `~` or `~/…` (`~user`, `~+`; see Paths for `~/…`) and a word starting with an unquoted `=` (zsh expands `=ls` to a program's path). `$`, backticks, `\` and `!` ask outside single quotes; inside single quotes they are plain text for `grep`, `rg`, `sed`, `echo` and the pipe-only filters above (`awk '{print $1}'`, `grep 'foo$'`), and ask for every other program, since pnpm script arguments or `make 'X=$(shell …)'` would expand them. Inside double quotes, those same programs also accept a backslash followed by any other character, as bash keeps it literally (`grep "a\|b"` passes `a\|b`); `$`, backticks and `!` still ask there, as do `\$`, `\"`, `\\`, `\!` and a backslash before a backtick, an unquoted `\`, and any backslash in double quotes for other programs. The first word of each command must be a program name, not a variable assignment, a path or an option.
- Redirects: only `2>&1`, `2>/dev/null` and `>/dev/null` (with or without a space before `/dev/null`); any other `>`, `>>`, `>|`, `&>` or `>&` asks, except the one write form `cat > file <<'EOF'` (or `>>`), which must close the command line, have a delimiter in single quotes (so the body is plain text and isn't read) and end with a line of just the delimiter.
- Variables: `$?` is allowed in an `echo` (`pnpm test; echo exit=$?`). A command that only sets a variable to a plain value (`S=/tmp/x`: letters, digits and `_./@%+,:=-`, no space, quote, glob, `~` or `$`) lets a later word that starts with it, `$S/a.md`, `"$S/a.md"` or `${S}/a.md`, be checked as if written out. The assignment must run whatever came before it (not after `&&` or `||`, not in a pipeline), a variable the command didn't set asks, and so do names the shell or the toolchain read (`PATH`, `HOME`, `IFS`, `GIT_*`, `NODE*`, `LD_*`, …) and names the shell sets itself or ignores an assignment to (`_`, `FUNCNAME`, `RANDOM`, `SECONDS`, `UID`, `REPLY`, zsh's `status`, `argv`, `funcstack`, …). An unbraced variable followed by `:` or `[` asks, since zsh reads `$S:h` as a modifier and `$S[1,0]` as a subscript, in double quotes too; `${S}:x` doesn't. Any other `$` asks.
- Braces: `{a,b}` in an argument is expanded as the shell would and each resulting word is checked, so `wc -l {a,b}.ts` runs and `cat {a,.env}` asks. Sequences (`{1..3}`), nested groups, quotes inside a group, a group with no comma, an expansion past 64 words, braces in the program's place and an expanded word that is empty or starts with `~` or `=` ask.
- Paths: every argument, both sides of an `=` or `:` in it, and a value glued to a short option (`-o/etc/x`) is resolved against the shell's current directory, which an earlier `cd` may have moved. A word's leading `~/` (or a bare `~`) is expanded to the session's `$HOME`, the home its commands see, as the shell does; `~user`, a `~` after `=` or `:` and a quoted path starting `~/` are not, and ask; a lone quoted `~` is text (`rg -n '~' src`). The run's scratch directory (named by the runner, never the shell's own directory) is read and written like the worktree. Besides the worktree, read-only commands may name two places below that home: `.claude/plugins/cache/` (the plugin cache; nothing else under `~/.claude`, where the login, settings and account files live) and the store checkout (briefs, plans, audit logs), the directory the environment's base profile names in its store layout (`.sky-store` unless the layout's `home` says otherwise; the runner learns it from `SKY_STORE_HOME`, which the API sets with the profile's store). With no base profile store there is no store place, only the plugin cache. A write, such as `cat x > ~/.sky-store/y`, still asks. Those two places are read by naming paths into them, never by moving there: the shell itself must be in the worktree, and a `cd` out of it, into the store included, asks. With the default commands on (`defaults` isn't `false`), the Read, Grep and Glob tools read the same two places without asking, whether or not the environment's policy holds `Read`: the call runs on a copy staged into the run's scratch directory, as other reads outside the worktree do, and only a `Read(...)` rule naming a path in either place holds it. A Grep or Glob of a directory there searches a copy that leaves out the `.git` directories inside it and the entries whose path below the place has a secret name (the list below), so a search never sees what a read by name would ask about; a search whose own path is a `.git` directory (`~/.sky-store/.git`) reads all of it but its `config`, as `cat ~/.sky-store/.git/HEAD` does. A path with a secret name, a link that leads out of the place and a search of `~/.claude` or the home (a Glob of `~/.claude/**`, say) are not in either place, and with `defaults: false` neither place counts: such a read is judged like any other outside the worktree, waiting for a person only if the policy holds that tool or a `Read(...)` rule names the path, except that a path in or holding `~/.claude`, the plugin cache included, always waits. It asks when a path lands outside the worktree and those two places, or when any path segment is `.claude`, `.config`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker` or `environ`, starts with `.env`, `.claude.json` (the account and MCP settings file), `.dev.vars`, `.npmrc`, `.yarnrc`, `.netrc`, `.pgpass`, `.pypirc`, `.htpasswd` or `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, ends in `.pem`, `.key`, `.p12` or `.pfx`, or contains `credentials`, `token`, `secret` or `.tfstate` (any case), or when the path reaches `.git/config`. Segments are matched anywhere, so `cat .claude/CLAUDE.md` inside the worktree asks, and so does a search for `token` (`rg token src`). The one exception is the worktree's `.claude/skills/`, `.claude/agents/` and `.claude/commands/`, which read without asking; the rest of its `.claude`, `settings.json` and `settings.local.json` included, asks. For a path named by absolute path or `~/…`, segments are checked against what follows the root it is in, so `.claude` in the plugin cache's own path doesn't count; a relative path into the plugin cache or the store is checked whole.
- Symlinks: each path that exists is followed to its real location and checked again, so a link inside the worktree, the plugin cache or the store that leads outside the place it is in (another of the places included), or onto a secret, asks. The check runs for every command: a plugin cache or store that is itself a link to the home or a directory holding it, to `~/.claude` (where it really is, when it is a link itself) or a directory holding it, to anywhere in it outside `plugins/cache`, or to a path with a secret name in it (`~/.config/gh`) stops being a place at all, so reads there ask. A path that doesn't exist is judged by its text, except a `cd` target, which asks because bash would then move by the physical path; one that can't be resolved for another reason asks.

`pnpm test`, `pnpm typecheck` and `pnpm lint` are built in, with `-r` and `--filter <pkg>` allowed before the script. They run whatever the repo's `package.json` and test files say, so approving them approves code the agent can edit; an environment that doesn't accept that sets `defaults: false` and lists the commands it does. They ask on script arguments starting with `-` other than `--`, `--run`, `--silent`, `--bail` and `--passWithNoTests`.

A held tool call's `toolSummary` is cut at 2,000 characters (it goes out in webhooks and `sky wait`'s text). The request also keeps the call's whole input as JSON text, cut at 64 KiB after secrets are redacted: `pendingRequest.toolInput` on `GET /v1/agents/:id/runs/:runId` (and the run list), and in `sky wait --json` and `sky inbox --json`. Events and webhooks never carry it.

`autoApprove.commands` adds entries and `defaults: false` replaces the built-ins; `defaults: false` with no `commands` turns auto-approval off. An entry is a prefix: `make check` approves `make check` followed by any plain arguments, so `git` alone approves `git push` and `git reset --hard`, and `pnpm exec` approves `pnpm exec rm build`. Added commands get the same syntax, path and per-program checks, and an entry those checks would always refuse is rejected when you apply the environment.

## Pull requests

An agent's sandbox holds no GitHub token, so `git push` and `gh` don't work there. Agents publish through a Sprites connector to GitHub instead:

1. In the Sprites org whose token Sky runs with (`SPRITES_TOKEN`), connect GitHub and give the connector a policy with `name_prefix: sky-`, so every Sky sandbox can use it. The connector needs the `workflow` scope.
2. Hand its connection id to an environment:

   ```
   sky secret set web GITHUB_CONNECTOR --connector=<connection id>
   ```

Agents in that environment then get `GITHUB_CONNECTOR` and are told to publish with Sky's own command, which sends the branch's commits to GitHub and opens a pull request into the default branch, or updates the one already open. The connector must belong to the same Sprites org as `SPRITES_TOKEN`; another org's connector doesn't recognize Sky's sandboxes.

Commits are published with their `.github/workflows/` files like any other path, which is why the connector needs the `workflow` scope. When GitHub refuses a ref update with a 404 or 403 and the commits sent change workflow files, `publish` fails with `workflow_files_blocked` and names those files, since GitHub's bare `404 Not Found` reads as lost repo access. The fix is to give the connector the `workflow` scope and publish again. Any other refusal, and any rate limit, is reported as GitHub sent it. A gateway call that answers 500, 502, 503 or 504, or whose connection is reset or closed by the other side, is retried with growing pauses (`TRANSIENT_BACKOFF_MS` in `packages/runner/src/publish.ts`). A forced update of a rewritten branch is never resent blind: after each pause the branch is read again, and the update goes again only while the branch is still where this publish found it.

Earlier versions of `publish` held workflow changes back, sending the default branch's workflow files in their place and leaving a patch to apply by hand. If a pull request published that way never had its patch applied, `publish` refuses to update it, because GitHub's head isn't a commit the agent made. Fix it once: apply the patch to the pull request's branch from outside the sandbox, or publish to a new branch with `--branch`; after that `publish` works as normal.

A merge commit is published with all its parents, so after an agent merges the default branch into its own, GitHub sees the pull request as up to date and CI runs. Every parent other than the first must already be on GitHub, as the default branch's head is. A merge of a branch that exists only in the sandbox is refused and nothing is sent; merge only branches GitHub has, or rebase instead. When the default branch has moved on GitHub since the merge, `publish` rebases a branch the agent started onto it first, which drops a merge of the default branch and replays only the branch's own commits; a branch the agent continues from an existing pull request is never rebased, and is published with its merge as it is.

### How the sandbox pulls the repo

A **public** repo is pulled over git with no credential: provisioning clones it with its full history, and each run's refresh of the default branch (and the first fetch of a `--branch` start) is a `git fetch`. Those cost no GitHub REST calls; keeping an agent's own branch in step on later runs still makes a few connector calls. A **private** repo goes through the connector, which shares one hourly GitHub quota with everything else using that account. Sky reads the branch's commit and tree (a few calls) and takes the files from a single archive download, so a pull costs about five calls however many files the repo has; a file the archive doesn't carry byte-for-byte as git stores it is fetched on its own. Sky never calls the API to ask which kind a repo is, it tries git first. When the anonymous fetch fails (a private repo, no network) Sky logs one line saying why and uses the connector. The attempt has a time limit and can't prompt for a login or use a stored credential. Set the environment secret `SKY_ANON_GIT` to `0` (`sky secret set <env> SKY_ANON_GIT`) to skip it for a repo known to be private. Every connector call reads GitHub's rate-limit headers: with fewer than 500 calls left each call waits a second first, and when the quota runs out a call waits for GitHub's reset if it is within five minutes and otherwise fails with `github_rate_limited: GitHub's hourly API limit is used up until <UTC time>`. The API also lets only two environments pull through the connector at once, so rebuilding several together can't spend the hour's quota in parallel; the rest wait their turn. The store repo (`storeRepo`) always syncs through the connector.

Follow-up, not built: a GitHub App that mints a short-lived read token per clone would let private repos use git too.

Some repos reject commits by unverified authors, or commits with a `Co-authored-by` trailer. For those:

- **Author.** Set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` as secrets of the environment (`sky secret set web GIT_AUTHOR_EMAIL`, and the same for the name). The agent's commits and the commits `publish` sends to GitHub then carry that author and committer, including commits the agent made before the variables were set; commits an earlier `publish` already sent to the branch stay on GitHub as they were sent. `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` set a different committer. Unless both author variables are set, commits are by `Claude <noreply@anthropic.com>`; setting only one of them falls back to Claude for both.
- **Trailers.** Claude Code's own commit and pull request attribution is turned off for the agent's session, though not for the `claude -p` runs it starts, and `publish` strips every `Co-authored-by` trailer, and the "Generated with Claude Code" footer, from commit messages and pull request bodies.
- **Branch.** `publish --branch <name>` sends the commits to the GitHub branch `<name>` and opens the pull request from it, while the agent's worktree stays on `claude/<agent id>`. Set the secret `SKY_PUBLISH_BRANCH` to make it the default. The order is the flag, then the branch the agent was started on with `sky agent start --branch` (see [Fetching from GitHub](#fetching-from-github)), then the secret. That secret is shared by every agent in the environment, and two agents publishing to one branch collide, so with several agents pass `--branch` per agent. Use a new branch name: a branch that already holds commits this agent never made is not overwritten. The name must be a valid branch name and not the base or default branch. The `compareUrl` an agent reports still names `claude/<agent id>`, unless it was started on a branch, whose name it uses.

### Fetching from GitHub

Sandboxes hold no GitHub credential, so `git push` and any fetch of a private repo fail there. The runner fetches at the start of every run: over git for a public repo, through the connector for a private one. Only `origin/<default>` moves, never the local default branch, and the run's instructions name the tip it reached with its short sha and UTC time. A run that wants a default branch that moved while it worked, or commits someone pushed to its own branch, runs `node /opt/sky/runner.mjs sync`. It does two things under the repo lock. First it moves `origin/<default>` to GitHub's tip again through the connector and prints the new tip and how many commits GitHub's branch gained or dropped (a branch rewritten on GitHub shows both), or says it was already current; it stops, leaving `origin/<default>` where it was, if GitHub is more than 100 commits ahead, and that refresh changes no local branch. Then it brings the worktree onto the GitHub branch `publish` sends to (`--branch <name>` on `sync` names it, else the branch the agent continues, else `SKY_PUBLISH_BRANCH`, else the worktree's own): commits pushed there are fast-forwarded in when the worktree has no unpublished commits, and unpublished commits are rebased onto them when it has some. Afterwards every published commit in the local branch carries GitHub's sha, so `git log` and GitHub agree. Once it has brought in commits someone else pushed, the branch is treated like one the agent continues: `publish` only fast-forwards it, and never rebases those commits onto the base or force-updates them. It refuses for a worktree with uncommitted changes, unpublished commits that include a merge (a rebase would flatten it), a rebase that conflicts, a git operation stopped mid-way (a rebase, merge, cherry-pick, revert, `git am` or bisect), a branch too far ahead to fetch, or a branch none of whose recent commits matches the worktree. A refusal leaves the worktree and local branch as they were, though GitHub's copy of the branch may already have been fetched into `origin/<branch>`. A branch never published is left alone, with a line saying so. A run is told to `sync` when the user says they pushed to its branch, or when `publish` refuses because GitHub's branch moved. It costs no more connector calls than a run's start does for the same work, except that each further published commit whose sha differs from GitHub's (as `publish` leaves them) costs one commit and one tree read to be replaced by GitHub's. Agents run `runner.mjs` only for `publish` and `sync`; the API alone starts a run, and a `runner.mjs` run any other way refuses. Without a connector in the environment nothing is fetched and the sandbox keeps the commit it was provisioned with.

- **Default branch.** Every run refreshes `origin/<default branch>` first, so a new worktree starts from GitHub's current code. A clean worktree from an earlier run is rebased onto it. A worktree with uncommitted changes, one whose rebase conflicts, and one already published (rewriting it would break its pull request) are left alone, and the agent's prompt says how many commits it is behind. A default branch more than 100 commits ahead is not fetched; the prompt says so.
- **Start from a branch.** `sky agent start <env> --branch=<name>` (REST: `branch` on `POST /v1/agents`; MCP: the `branch` parameter) starts the agent from an existing branch on GitHub, such as an open pull request's. The agent works on a local `claude/<agentId>` branch, and `publish` updates `<name>` and its open pull request, without rebasing it onto the default branch. The start fails with `404 branch_not_found` if the branch doesn't exist, `422 branch_is_default` for the default branch, and `422 branch_needs_connector` when the environment has no connector.
- **Shared branch.** Two agents may target the same branch, and `publish` refuses to overwrite commits the branch never had.
- **Commits pushed from outside.** Follow-up runs fetch the agent's GitHub branch first. A clean worktree takes the commits pushed there by someone else (fast-forward, or a cherry-pick when `publish` gave its commits new shas). Diverged histories change nothing; the agent's prompt says what is on GitHub and `publish` refuses to overwrite it. Mid-run, `runner.mjs sync` (above) brings such commits in, rebasing the agent's unpublished commits onto them.

## Previews

Check an agent's work by using it. A preview serves the app's production build, so it shows what will ship:

```
sky agent preview <agent> --port=5173 [--build=<cmd|none>] [--start=<cmd>] [--ttl=24h] [--no-wait]
sky agent preview <agent> --stop
sky agent preview <agent>
```

The first builds the app once in the agent's worktree on the environment's sprite, then serves it, and prints a link. `--build` and `--start` default from the worktree's lockfile (`pnpm build` and `pnpm start` for `pnpm-lock.yaml`, `yarn build` and `yarn start`, `bun run build` and `bun run start`, or `npm run build` and `npm start`), so most repos need no flags; with no lockfile and no flags the start is refused (`400 preview_commands_needed`). `--build=none` skips the build. The build is a one-off command, not part of the app's service: it runs once, with the environment's secrets, its base profile's `sessionEnv`, `PORT` and `NODE_ENV=production`, its output logged, and is stopped after 15 minutes. The app's service then runs only the start command (with the same environment), so a sprite that wakes restarts the server in seconds without building again. Neither gets a Claude credential or a Sky token. The app should listen on `--port` on all interfaces.

The API answers at once (`202`), as soon as the link works, and the build goes on. Opening the link in any browser, with no Sky or Fly login, shows a small "Building preview…" page that refreshes itself until the app is up, then the app at its root path, so root-relative assets and client-side routing work. The preview's `state` is `building`, then `starting`, then `ready` once the app listens on its port (it has two minutes to), or `failed`. `sky agent preview` prints the link, then waits, printing each state as it changes, and exits 0 once `ready` or 1 on `failed`, with the tail of the failed build's or start's output (secrets redacted); `--no-wait` returns at once. Over REST, `GET` reports the state with `200`; a failed preview carries its redacted `detail` and a `failure` of `command` when the build or start command failed, or `sprite` when the sprite did. The proxy in front of the app rewrites `Host` to `localhost:<port>`, so the app's allowed-hosts check doesn't turn the sprite's address away. It sets `X-Forwarded-Host` to the preview's host and `X-Forwarded-Proto: https`. A request carrying the preview's own `Origin` reaches the app with `Origin` as `http://localhost:<port>` and `X-Forwarded-Host` as `localhost:<port>`, and a same-origin `Referer` is rewritten the same way, so the origin check on a form post passes in React Router under `@react-router/serve`, Next.js Server Actions and SvelteKit under `vite preview`. SvelteKit's adapter-node needs `ORIGIN=http://localhost:<port>` set. An app that builds its origin from `X-Forwarded-Proto`, such as Rails, still sees `https` and refuses the rewritten `http` `Origin`. A `Location` back to `http://` or `https://localhost:<port>` is pointed at the preview. Another site's `Origin` reaches the app unchanged.

**A new commit needs a new preview.** A production server serves the build it started with and doesn't pick up worktree edits, including a follow-up run's. Run `sky agent preview` again on the same agent: it rebuilds from the worktree and replaces the running preview, with a new link.

**Memory.** A production build is a heavy job on the sprite's memory, and the preview then keeps the app and its proxy running. Start a preview while no other heavy job runs on the environment.

- **One per environment.** A sprite has one HTTP port, so an environment has one preview. Starting one on another agent replaces the running one; the answer (`replaced`, and a note on stderr) names the agent it replaced. Starting again on the same agent rebuilds and replaces it, with a new link; starting while a build is still running stops that build. A `runs` key can replace only previews on agents it started: while another key's preview runs in the environment, the start is refused with `409 preview_busy`, which doesn't name that agent. The admin key replaces any.
- **Private to whoever holds the link.** The sprite's URL is public only while a preview runs, and everything it serves goes through a small proxy (from the runner bundle) on the sprite's HTTP port, 8080. The proxy answers 404, with a page that names nothing, to any browser without the preview's cookie. The link is the sprite's URL plus `/__sky/preview?t=<token>`: the token is 32 random bytes, Sky and the proxy keep only its hash, and a valid token sets an HttpOnly, Secure, SameSite=Lax cookie that lasts as long as the preview, then redirects to `/`. The link is shown once, when the preview starts; `sky agent preview <agent>` without flags reports its state, port, expiry and how the app and proxy are doing. Anyone who has the link can use the app until the preview ends, so share it like a password. A browser with the cookie sees the "Building preview…" page while nothing listens yet; any other gets the plain 404. If something already listens on 8080 or on `--port` on the sprite, the start is refused (`port_busy`) and nothing on the sprite is touched. Stopping when nothing runs succeeds (`200`, `preview: null`; `sky agent preview <agent> --stop` exits 0), so a retried stop or a cleanup trap doesn't fail.
- **How it ends.** At `--ttl` (24 hours by default, 7 days at most), on `--stop`, when the agent is archived and when the environment is deleted. Each removes both sprite services, sets the sprite's URL back to private and invalidates the token. Anything else leaves it running: the agent's runs ending, or a follow-up starting, do not touch it, and the follow-up's edits don't reach it until a new preview is started. The proxy and the app are sprite services, so they restart when a sleeping sprite wakes. A failed preview stays readable for ten minutes, then goes.

Over REST it is `POST`, `GET` and `DELETE /v1/agents/:id/preview` (`{ "port", "build"?, "start"?, "ttlSeconds"? }` to start), and over MCP the `preview` tool. A `runs` key can preview only the agents it started.

## REST API

All routes live under `/v1`. Ids are prefixed: `env_…`, `agent_…`, `run_…`.

**Launch an agent** in a ready environment:

```
POST /v1/agents
{ "envId": "env_abc", "prompt": "Fix the flaky login test" }
```

`202 Accepted`, with `Location: /v1/agents/<agentId>/runs/<runId>` and a body of `{ "agent": …, "run": … }`.

Add `"branch": "<name>"` to start from an existing GitHub branch ([Fetching from GitHub](#fetching-from-github)). The agent's `remoteBranch` then names it; without `branch` it is `null`.

| route                                                                   | what it does                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v1/environments` · `GET`, `PATCH`, `DELETE /v1/environments/:id` | environments; create returns `202` while provisioning  |
| `PUT`, `GET`, `DELETE /v1/environments/:id/secrets[/:name]`             | environment secrets                                    |
| `GET /v1/agents`                                                        | list your agents with their latest run                 |
| `POST /v1/agents/:id/runs`                                              | follow-up run, resuming the agent's session            |
| `GET /v1/agents/:id/runs/:runId` · `…/stream`                           | a run's result, or its events as SSE                   |
| `POST /v1/agents/:id/answers` · `…/approvals`                           | answer a waiting question; approve or deny a tool call |
| `POST /v1/agents/:id/stop` · `…/archive`                                | stop the current run; archive the agent                |
| `POST`, `GET`, `DELETE /v1/agents/:id/preview`                          | start, read and stop the agent's [preview](#previews)  |
| `POST`, `GET /v1/webhooks` · `GET`, `DELETE /v1/webhooks/:id`           | subscribe an https URL to events; list, read, remove   |
| `GET /v1/webhooks/:id/deliveries`                                       | a webhook's recent deliveries and their results        |
| `POST`, `GET /v1/keys` · `DELETE /v1/keys/:id`                          | admin only: mint, list and revoke `runs` keys          |
| `GET /v1/claude-credentials`                                            | admin only: the Claude credentials, by name            |
| `POST`, `GET`, `DELETE /v1/admin/drain`                                 | admin only: [drain](#draining-before-a-restart)        |

### Listing agents

```
GET /v1/agents?env=web&status=running,waiting_answer&archived=false&limit=50&cursor=…
```

Newest activity first, where an agent's activity is the last event of its latest run (its creation, before a first run). Every query parameter is optional:

| parameter  | meaning                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `env`      | environment ids or names; repeat the parameter or use a comma list                                              |
| `status`   | the latest run's state (below); repeat or comma list. An agent with no run matches none                         |
| `archived` | `false` (default) live agents, `true` only archived ones, `all` both                                            |
| `limit`    | rows per page, 1 to 200 (default 50)                                                                            |
| `cursor`   | the `nextCursor` of the previous page, with the same filters; a cursor Sky didn't issue is `400 invalid_cursor` |

```json
{
  "data": [
    {
      "id": "agt_…",
      "envId": "env_…",
      "envName": "web",
      "branch": "claude/agt_…",
      "remoteBranch": "feature/login",
      "createdAt": "2026-11-17T09:00:00.000Z",
      "archivedAt": null,
      "run": {
        "id": "run_…",
        "status": "waiting",
        "state": "waiting_answer",
        "createdAt": "2026-11-17T09:00:01.000Z",
        "lastEventAt": "2026-11-17T09:12:30.000Z",
        "endedAt": null,
        "openRequests": 1
      }
    }
  ],
  "nextCursor": "…"
}
```

`run` is `null` for an agent that hasn't started one, and `nextCursor` is present only when more agents match. `lastEventAt` is the run's latest event, or the run's creation before its first; `endedAt` is when a finished, failed or stopped run ended, else `null`. `openRequests` counts the questions and tool-call requests a `waiting` run has open, and is `0` for a run in any other state. `remoteBranch` is the GitHub branch the agent was started on, `null` otherwise.

`state` is the run's `status`, except that a `waiting` run is split by what it waits on: `waiting_approval` for a tool call to approve or deny, `waiting_answer` for a question. So the states are `queued`, `starting`, `running`, `waiting_approval`, `waiting_answer`, `finished`, `failed` and `stopped`. `queued` is a launch held while the API drains ([below](#draining-before-a-restart)); a client that doesn't know the state can treat it as `starting`, a run that hasn't begun.

A `runs` key lists only the agents it started, and `env` names it may not use match nothing; the admin key lists every agent.

Errors come back as `{ "error": { "code": …, "message": … } }`. The ones you'll meet:

| code                | means                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| `concurrency_cap`   | the environment already runs its max agents; wait for one to end or stop one       |
| `run_active`        | a run is in progress; wait for it or stop it                                       |
| `env_not_ready`     | the environment isn't ready to launch agents yet                                   |
| `provisioning`      | the environment is still provisioning; wait for it to finish                       |
| `agents_exist`      | repo or setup can't change while unarchived agents exist                           |
| `already_decided`   | the request was already decided differently; that decision stands                  |
| `request_closed`    | the request's run ended with the request still open; nothing was applied           |
| `request_withdrawn` | the run stopped waiting on the request before it was answered; nothing was applied |
| `webhooks_filter`   | webhooks filter on the environment; delete them first (ids in `webhookIds`)        |

### Draining before a restart

Restarting the API loses what a working run keeps in memory (a pending usage-limit retry, its waits), so a deploy should wait until nothing is starting or running. A drain does the waiting for you. With the admin key:

```
POST /v1/admin/drain     { "timeoutSeconds": 1800 }   # optional; default 1800, at most 7200
GET /v1/admin/drain
DELETE /v1/admin/drain
```

While a drain is on, runs already `starting` or `running` carry on, and every new launch (an agent start, a follow-up, a retry after a usage limit) is **held, not refused**: the caller gets its usual `202` and a run whose `status` is `queued` (an agent's list `state` too). The run counts toward its environment's `concurrency` and its agent's one active run, and `POST /v1/agents/:id/stop` ends it like any other. When the drain ends, held launches become `starting` and launch as they would have, oldest first. A drain ends when you `DELETE` it, when its deadline passes (so a forgotten drain never blocks work), or when the API restarts. Held launches are stored sealed in the database, prompt included, so the API that boots after a deploy starts them. A run's launch deadline counts from its release, not from the hold.

`GET` and the other two answer:

```json
{
  "draining": true,
  "since": "2026-11-22T10:00:00.000Z",
  "deadline": "2026-11-22T10:30:00.000Z",
  "active": ["run_…"],
  "held": 2,
  "ready": false
}
```

`active` lists the runs still `starting` or `running`; a run waiting on an approval or an answer is quiet and not listed, and neither is a queued one. `ready` is `true` when `active` is empty: it is safe to restart. `since` and `deadline` are `null` when no drain is on.

```
sky admin drain --wait             # start (--timeout=<seconds>), then poll until ready
sky admin drain --status
sky admin drain --cancel
```

`--wait` exits 0 once `ready`. At the deadline it exits 4 and prints the run ids still active, leaving the drain on for the caller to `--cancel`; an API it can't reach exits 1. The [Image workflow](CONTRIBUTING.md#deploy) runs it before each deploy.

### Run errors

A run the API fails ends with `run.failed`, and its `error` is one of:

| error                       | means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch_failed`             | the runner couldn't be started on the sprite; the detail follows the colon                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `launch_timeout`            | the runner never reported in within `LAUNCH_DEADLINE_MINUTES` (default 15) of the run's creation; a `runner.warning` or heartbeat doesn't count as reporting in. A run queued for the repo lock fails sooner, from the runner: see **Launch** below                                                                                                                                                                                                                                             |
| `claude_limited`            | the launch was refused: the environment's subscription is at its usage limit and the API key can't stand in (none is set, or the environment's `claudeFallback` is `none`); the error names the reset time in UTC                                                                                                                                                                                                                                                                               |
| `claude_credential_missing` | the environment is assigned a credential this server no longer holds, or the API key it is assigned isn't set                                                                                                                                                                                                                                                                                                                                                                                   |
| `settings_redirect`         | the runner refused to start Claude: a settings file sets a key that would redirect its credential, see [What Sky refuses in Claude settings](#what-sky-refuses-in-claude-settings); the error names the file and key. Not retried                                                                                                                                                                                                                                                               |
| `credential_exposed`        | the runner refused to start Claude, or stopped it, because the repo's commands could read the run's Claude credential, see [What a repo's hooks, MCP servers and commands can see](#what-a-repos-hooks-mcp-servers-and-commands-can-see). Not retried                                                                                                                                                                                                                                           |
| `upstream_blocked`          | Claude's login met Cloudflare's challenge (a 403 "Attention Required!") from Anthropic's API a second time in one chain of retries. Not retried; launch again later                                                                                                                                                                                                                                                                                                                             |
| `sprite_low_memory`         | the launch was refused: the sprite had less memory available than `SPRITE_MIN_FREE_MB` (default 1024); the error says how much was free. Wait for a run on the sprite to end, or lower `concurrency`                                                                                                                                                                                                                                                                                            |
| `runner_lost`               | the run went quiet, the API woke its sprite, and the runner was no longer running there; the error names the sprite                                                                                                                                                                                                                                                                                                                                                                             |
| `runner_killed`             | as `runner_lost`, and the sprite killed the runner, likely out of memory: the kernel logged a kill after the run was created, or the sprite had less than `SPRITE_MIN_FREE_MB` available; the error names the sprite and the memory it had                                                                                                                                                                                                                                                      |
| `sandbox_restarted`         | as `runner_lost`, but the sprite restarted while the runner was up: the machine rebooted, or it stayed up and its processes restarted (its pid 1 started again). The usual cause is memory use past the machine's limit. The error names the sprite and gives the time of the restart, the 5-minute load and the run's last Bash command, redacted and cut to 300 characters. Commit work before a heavy test step, and bound or split such steps (a full browser suite, a wide parallel build) |
| `runner_timeout`            | no event for `RUN_TIMEOUT_MINUTES` (default 30), though the runner was still running (or its sprite couldn't be reached to tell); names the tool call when one was running                                                                                                                                                                                                                                                                                                                      |
| `waiting_timeout`           | the run waited on an answer or approval past its limit and its runner is gone                                                                                                                                                                                                                                                                                                                                                                                                                   |

**The probe.** A sprite can go to sleep under a run and lose its runner. Once a `running` run has had no event for `RUN_PROBE_MINUTES` (default 5, and always below `RUN_TIMEOUT_MINUTES`; when the timeout is under 10 minutes the default is half of it), the API wakes its sprite and looks for the run's runner:

- **Heartbeats arriving:** while a tool call runs, the runner posts `runner.heartbeat` about every 60 seconds with the tool's name and how long it has run. A heartbeating run is alive, so it isn't probed, however long the call takes. A heartbeat isn't progress: a tool call still running past `RUN_TIMEOUT_MINUTES` fails with `runner_timeout: <tool> was still running after <time> with no result, past the <limit> limit`, or with `runner_timeout: the runner went quiet during <tool> after it had run <time>` when the heartbeats stopped. A `runner.warning` isn't progress either.
- **Runner alive:** the API records a `run.probed` event and the run carries on. A probe is not runner activity, so a runner that is alive but wedged still fails with `runner_timeout`.
- **Runner gone:** the API first collects the sprite's diagnostics (`free -m`, uptime and load, how long ago pid 1 started, the top processes by memory with their command lines, and the kernel's out-of-memory and kill lines where `dmesg` is readable), logs them, and stores a bounded, redacted copy on the run as a `runner.warning` event just before `run.failed`. Then the run fails at once, instead of waiting out `runner_timeout`: with `sandbox_restarted` when the sprite booted, or its pid 1 started, more than 30 seconds after the run's `run.started` and more than 30 seconds before the probe's first exec on the sprite set out (it wins over the next two, as a restart ends every process; a boot from the launch's wake of a cold sprite, or from the probe's own wake of a sprite that slept under the run, is not a restart); else with `runner_killed` when the kernel log has a kill line stamped after the run was created or less than `SPRITE_MIN_FREE_MB` available (dmesg is often closed to the sprite user, so memory is the fallback), else `runner_lost`. A kill line from before the run does not count. The agent is free for a follow-up, which resumes the session and worktree as any follow-up does.
- **Sprite can't answer:** the API logs it and leaves the run alone; `runner_timeout` is the backstop. If the sprite no longer exists, the run fails at once with `runner_lost`.
- **An exec exits 137:** a command the API ran on a sprite (a wake, a check, a setup step) ended with SIGKILL, so something there is being killed. The API doesn't wait for the window: it probes every `running` run on that sprite at once. A runner found alive is left alone and nothing is recorded.

A run is probed at most once per window, and a slow sprite never holds up the API's sweep. Only `running` runs are probed; a run waiting on a request has its own deadline.

**Launch.** A sprite that pauses before the runner holds it freezes the runner, and the run sits in `starting` until `launch_timeout`. Two things guard against it. The API takes the run's keep-awake task on the sprite just before it starts the runner (a 2-minute task the runner's own hold then refreshes; if the runner never comes up it lapses by itself, and a failure of this step is logged and never fails the launch). And a run still `starting` 90 seconds after its runner started, with no event but a `runner.warning` or heartbeat, gets one wake: the API looks for its runner on the sprite, which unfreezes it. A runner found alive is left alone; one that is missing waits for `launch_timeout`.

Runs on one sprite share its repo, so a run's worktree setup takes the repo lock (`/workspace/repo/.git/sky-repo.lock`) and a second run launched meanwhile queues for it. The API gives the runner what is left of `LAUNCH_DEADLINE_MINUTES` when it starts it, and the runner gives up the queue inside that, a little before the deadline: the run fails with `run.failed` and the error `worktree setup failed: can't take the repo lock /workspace/repo/.git/sky-repo.lock within <N>s: another run's setup or a worktree removal held it all that time and may be stuck`, the runner's own error rather than one from the table above. Launch again once that setup has finished or failed.

**The run log.** On the sprite, `/workspace/runs/<runId>.log` is written only by the run's own runner, which holds `<runId>.lock` while it runs. The runner starts only when the API launches it with the run's id as its argument. Started any other way, by hand or from an agent's shell (which inherits the log's location), it refuses with one line on stderr and never touches the log. An agent's own commands are `node /opt/sky/runner.mjs publish` and `node /opt/sky/runner.mjs sync`.

## MCP

`POST /mcp` (streamable HTTP, same bearer keys) exposes `create_env`, `launch`, `followup`, `status`, `list_agents`, `answer`, `approve`, `stop`, `archive`, `preview` and `wait_for_events`, so a chat bot can dispatch, follow and answer agents. Every tool call runs with the caller's own key, so a `runs` key gets the same limits as over REST.

`list_agents` is `GET /v1/agents` ([Listing agents](#listing-agents)): it takes `env` (ids or names) and `status` (states) as arrays, `archived` (`false`, `true` or `all`), `limit` and `cursor`, and returns the page the API sends, with `nextCursor` when more agents match. Use it to find an agent whose id you lost, or to see which are running or waiting on you.

`wait_for_events` waits up to 30 seconds and returns as soon as something happens, with a `cursor` to pass back as `after` on the next call. Call it in a loop to follow every agent live without a public URL. On your first call, use `status` to find agents already waiting.

## Events

What an agent does arrives as events, each with `agentId`, `environmentId` (the environment the agent belongs to) and `runId`:

| event                                                                  | when                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `run.started`, `run.finished`, `run.failed`, `run.stopped`             | the run's lifecycle                                                                                                             |
| `run.waiting`                                                          | the agent needs an `answer` or an approval                                                                                      |
| `run.resumed`                                                          | a question was answered or a tool call approved or denied                                                                       |
| `run.withdrawn`                                                        | a request was withdrawn unanswered (`requestId`, `reason`); the run is `running` again, or `finished` on `run_finished`         |
| `run.probed`                                                           | a silent run's runner was checked on its sprite and found alive                                                                 |
| `runner.warning`                                                       | the runner hit a problem that didn't end the run, with its message                                                              |
| `runner.heartbeat`                                                     | a tool call is still running: its name and how long, about every 60 s                                                           |
| `claude.Message`                                                       | Claude, or a subagent (with `parentToolUseId`), wrote a message                                                                 |
| `claude.PreToolUse`, `claude.PostToolUse`, `claude.PostToolUseFailure` | a tool call starts, finishes or fails, with its input and output                                                                |
| `claude.SubagentStart`, `claude.SubagentStop`                          | a subagent starts or finishes                                                                                                   |
| `claude.TaskCreated`, `claude.TaskCompleted`                           | a todo item is added or finished                                                                                                |
| `claude.TaskNotification`                                              | a background task (a shell, monitor or subagent) ended: its `taskId`, `taskType` when known, `status` and `summary`             |
| `claude.BackgroundTasksChanged`                                        | the set of background tasks changed: each one's `taskId`, `taskType` and whether it is `ambient` (a watcher that wakes no turn) |
| `claude.Notification`, `claude.PreCompact`, `claude.FileChanged`       | Claude Code's notifications, context compaction, watched-file changes                                                           |

A run that goes quiet while background tasks run is explained by `claude.BackgroundTasksChanged` (what was running) and `claude.TaskNotification` (what each task's end notice said; recording a notice doesn't change how long the run waits for its tasks). The `claude.*` names are Claude Code's own hook names, except those two and `claude.Message`, which come from Claude's message stream. Each text field is redacted (registered secrets and tokens) and then cut to 4,096 characters (`runner.warning` included). `claude.*` and `runner.heartbeat` events are kept for 7 days; `run.*` and `runner.warning` events are kept.

A `run.waiting` ends in `run.resumed` (someone answered), `run.withdrawn` (the runner stopped waiting first, or the run finished while waiting), or the run's own end. A request the runner withdraws is closed and the run goes back to `running`, so it can still finish. A run that finishes while waiting has its request withdrawn by the API: subscribers see `run.withdrawn`, then `run.finished`, and the run never shows `running` again. A `sky stop`, a wait that times out or a failure ends a waiting run at once: subscribers see `run.waiting`, then `run.stopped` or `run.failed`. The `reason` is one of: `hook_cancelled` (the wait was cancelled and the session goes on), `session_ending` (the session was ending), `run_stopping` (the runner was stopped inside the sprite), `run_ending` (the runner withdrew before posting its ending) and `run_finished` (the API withdrew it when the run finished while waiting). Answering a withdrawn request is refused with `409 request_withdrawn`. Answering a request left open by a stop, a timed-out wait or a failure is refused with `409 request_closed`. Both apply from the API, MCP and `sky approve`, `sky deny` and `sky answer` alike.

Three ways to receive them:

- **MCP:** `wait_for_events`, above.
- **Stream:** `GET /v1/stream`, one SSE connection across every agent. Filter with `?types=claude.PostToolUse,run.waiting` and `?agentId=`. After a drop, reconnect with `Last-Event-ID` to receive what you missed. A `: ping` arrives every 15 seconds. When the server restarts, the stream ends with an `event: server.shutdown` frame whose `id` is your resume point and whose `retry: 2000` asks you to reconnect in 2 seconds; `EventSource` does this on its own. `GET /v1/events?after=&wait=` is the same feed as a long poll.
- **Webhooks:** `POST /v1/webhooks` (or `sky webhook add`) with an `https` URL and the `eventTypes` you want. A failed delivery is retried with backoff, up to 30 attempts (a refused one, below, is not retried), and a `429` holds the webhook until its `Retry-After`. Two optional fields:
  - `format`: `"sky"` (the default), `"standard"` or `"openbot"`, below.
  - `environmentIds`: a non-empty array of environment ids. The webhook then receives only events from agents in those environments; an id that doesn't exist is `400 invalid_body`. Left out, it receives every environment's events. An environment a webhook filters on can't be deleted until that webhook is (`409 webhooks_filter`).

  `GET /v1/webhooks` returns each webhook's `format` and `environmentIds` when set. A secret is never returned. Once a webhook has had a delivery attempt it also carries, so a receiver that answers 401 on every try shows up here and not only in the server logs:
  - `lastAttempt`: `at` (when it ran), `status` (the HTTP status, or `null` when the receiver never answered), `error` (why there was no response: `timeout`, `connection_refused`, `connection_reset`, `dns`, `tls`, `blocked_address` or `url_not_allowed` (a refused URL or private address, which fails at once without retries), or `other`; `null` when there was one) and `attempt` (the attempt number within its delivery, from 1).
  - `failedStreak`: how many deliveries in a row, since the last delivered one, ended failed or are still retrying after a failed attempt.
  - `failing`: `true` once a delivery gave up, after its 30th attempt or at once when refused, until the webhook's next delivered one clears it. Absent otherwise.

  `lastAttempt` and `failedStreak` are absent until the webhook has an attempt on record, and `failing` is absent unless set; all three are optional, so older clients ignore them. `sky webhook list` prints them after the webhook, such as `| FAILING, last 401 at 2026-11-21T09:30:00.000Z (attempt 30), 13 failed in a row`.

  `GET /v1/webhooks/:id/deliveries` (or `sky webhook deliveries <id>`) lists the webhook's deliveries, newest first, 20 by default and at most 100 (`?limit=`, or `--limit`). When older ones remain the page carries a `nextCursor`; pass it back as `?cursor=` (or `--cursor`). Each delivery has `id`, `eventType`, `runId`, `status` (`pending`, `delivered` or `failed`), `attempts`, `lastStatus`, `lastError` (redacted) with its `lastErrorKind`, and `createdAt`, `lastAttemptAt` and `nextAttemptAt` (only while pending). The request body, headers, signature and secret are never included. A `runs` key reads the deliveries of its own webhooks only; another's is `404 not_found`.

  When a delivery's give-up makes the webhook `failing`, the run it was for also gets a `runner.warning` event naming the webhook id, the event and the last status or error kind, never its URL or secret. That is once per stretch of failing: later give-ups post nothing until a delivered attempt clears `failing`, and the next give-up after that warns again. A webhook subscribed to `runner.warning` whose own warning delivery gives up is flagged but not warned about again.

  **Refused URLs.** A webhook URL must be `https` on the default port (443), must not carry a username or password, and must name a public host. `POST /v1/webhooks` answers `400 url_not_allowed` for `localhost` and names under it, names ending in `.internal`, `.flycast`, `.local` or `.home.arpa`, single-label names, and addresses in private, loopback, link-local, unique-local (including Fly's private `fdaa::/16`), shared, multicast and reserved ranges. The IPv6 forms refused are IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible (`::/96`) addresses, 6to4 (`2002::/16`), Teredo (`2001::/32`), discard (`100::/64`), benchmarking (`2001:2::/48`), documentation (`2001:db8::/32`) and local-use NAT64 (`64:ff9b:1::/48`) addresses, and NAT64 `64:ff9b::/96` addresses whose embedded IPv4 address is in a refused range. A URL whose host carries a zone id (`https://[fe80::1%25eth0]/hook`) does not parse, so `POST /v1/webhooks` answers `400 invalid_body` for it. Sky also resolves the host when it connects and refuses the delivery if any resolved address is in one of those ranges or carries a zone id, so a public name that points at a private address is refused too. A refused delivery is marked `failed` at once and is not retried. Its error is `blocked_address` when the host or its address is refused, and `url_not_allowed` when a stored URL fails for its scheme, port or credentials. Addresses and ports never appear in a delivery's error text; they are replaced with `<addr>`.

  A webhook created before these rules, whose host now fails them, is not deleted and still shows in `sky webhook list`, but each of its deliveries is refused. Delete it and add it again with a public URL.

**`sky` format.** The body is the event itself. Each delivery carries `Sky-Event-Type`, `Sky-Event-Id`, and

```
Sky-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
```

keyed with your `WEBHOOK_SIGNING_KEY`.

**`standard` format** follows [Standard Webhooks](https://www.standardwebhooks.com), for receivers such as OpenBot routines. Create it with a `secret` of the form `whsec_<base64>`, where the base64 decodes to a 24-64 byte key; a missing or malformed one is `400 invalid_body`. Sky stores it encrypted, like environment secrets. `sky webhook add --format=standard` reads it with `--secret=@file` or `--secret=-` (stdin), never from an argument.

```json
POST /hook
Content-Type: application/json
webhook-id: evt_1042
webhook-timestamp: 1794070000
webhook-signature: v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>">

{
  "type": "run.waiting",
  "timestamp": "2026-11-07T17:26:40.123Z",
  "data": {
    "id": "evt_1042",
    "agentId": "agt_…",
    "environmentId": "env_…",
    "runId": "run_…",
    "ts": "2026-11-07T17:26:40.123Z",
    "type": "run.waiting",
    "payload": { "request": { "kind": "approval", "requestId": "req_…", "toolName": "Bash", "toolSummary": "…" } }
  }
}
```

`webhook-id` is the same on every retry of a delivery, so a receiver can drop duplicates by it; `webhook-timestamp` and so the signature are fresh on each attempt. `data` is the same event the stream and `GET /v1/events` return, and a receiver can filter on JSON Pointers into it, such as `/environmentId`.

To verify, recompute the signature over the exact bytes received and reject a timestamp too far from your clock:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody, now = Date.now() / 1000) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();
  // the header may hold several space-separated "v1,<base64>" signatures
  return headers["webhook-signature"].split(" ").some((s) => {
    const [version, sig] = s.split(",");
    const got = Buffer.from(sig ?? "", "base64");
    return (
      version === "v1" &&
      got.length === expected.length &&
      timingSafeEqual(got, expected)
    );
  });
}
```

**`openbot` format** signs the way OpenBot webhook routines verify, so a routine's own signing secret works as is. Create it with the `secret` exactly as the routine shows it, up to 256 characters (`whsec_` prefix included if it has one; it is not base64-decoded). A missing or empty secret, a longer one, or one with whitespace at either end is `400 invalid_body`; Sky never trims it, because the trimmed string would be a different key. Sky stores it encrypted and never logs it. `sky webhook add --format=openbot` reads it with `--secret=@file` or `--secret=-` (stdin), never from an argument, and drops only the one newline that ends the file or the input.

```json
POST /hook
Content-Type: application/json
x-openbot-timestamp: 1794070000
x-openbot-delivery-id: evt_1042_whk_…
x-openbot-signature: sha256=<hex HMAC-SHA256 of "<x-openbot-timestamp>.<x-openbot-delivery-id>.<body>">

{ "type": "run.waiting", "data": { "id": "evt_1042", "environmentId": "env_…", "…": "the event, as in standard" } }
```

The HMAC key is the secret's raw UTF-8 bytes. `x-openbot-delivery-id` is `<event id>_<webhook id>`, so each webhook gets its own, and it is the same on every retry of that delivery; `x-openbot-timestamp` and so the signature are fresh on each attempt. `type` is the event type and `data` the same event `standard` carries, so a routine can filter on JSON Pointers into it, such as `/environmentId`.

## License

[MIT](LICENSE)
