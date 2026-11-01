<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/sky-header-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/sky-header-light.svg">
  <img alt="sky" src="brand/sky-header-light.svg">
</picture>

Your Claude Code crew, in the cloud.

Sky runs Claude Code agents on your own servers while you're away. Point it at a GitHub repo, hand an agent a prompt, and it works in its own session and branch, asks you when it needs an answer or an approval, and tells you when it's done. You drive it from a REST API, a CLI, an MCP server (so a chat bot can dispatch work), and signed webhooks.

Sky is not affiliated with or endorsed by Anthropic.

## Where to use it

Sky is self-hosted: there is no shared instance. Deploy your own with [CONTRIBUTING.md](CONTRIBUTING.md#deploy); every example below uses `https://<your-app>.fly.dev`.

## Auth

Every call carries the API key you set at deploy time:

```
Authorization: Bearer <SKY_API_KEY>
```

A missing or wrong key returns `401`.

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
```

`setup` runs in the clone with bash, with pnpm and yarn on `PATH` and `SKY_CLAUDE` set to the `claude` binary agents run. After it, Sky installs the plugins the repo's `.claude/settings.json` enables in `enabledPlugins`, from the marketplaces its `extraKnownMarketplaces` declares. If a plugin comes from a marketplace that isn't declared there, add the marketplace in `setup`:

```yaml
setup: |
  pnpm install
  "$SKY_CLAUDE" plugin marketplace add owner/marketplace-repo
```

Provisioning fails at the setup step, naming the plugin and its marketplace, if a plugin's marketplace is neither declared nor added.

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
```

`<env>` is an environment's name or id.

```
sky agent start web --prompt=@task.md
sky wait <agent>      # until it needs an answer or approval, or ends
sky inbox <agent>     # the pending question or approval
sky approve <agent> <requestId>   # or deny --reason=…, or answer -- <text>
sky status <agent>    # status, summary, error and compare link
```

[Driving agents](docs/driving-agents.md) walks a bot through an agent end to end: start, wait, answer or approve, follow up, read the result, archive.

### Base profiles

A base profile is what every sprite gets before its own `setup`, defined once on the server so no client's tooling lives in Sky's code. The API reads them from `SKY_BASE_PROFILES`, a JSON object of profiles by name, empty by default; an environment picks one with `base: <name>`. A `base` the server doesn't have is rejected, and changing `base` rebuilds the sprite like changing `setup` (so it is refused with `agents_exist` while unarchived agents exist). With no `base`, an environment gets no plugins or MCP servers beyond its repo's, no store sync and no check instructions.

A profile holds:

- `marketplaces`: sources for `claude plugin marketplace add`. None may start with `-`.
- `plugins`: `name@marketplace`, installed at user scope, starting with a letter or digit. Provisioning installs and updates them after adding the marketplaces.
- `mcpServers`: user-scope MCP servers by name (letters, digits, `_` and `-`, starting with a letter or digit), each `command` (with `args`, `env`) or `url` (with `headers`). Credentials are never inline: an `env` or `headers` value is the **name** of an env secret (`sky secret set`), which the session expands from its own env. Sky writes it into the sprite's config as `${NAME}`, so no secret value reaches the checkpoint. A header can only name a secret, so that secret holds the entire header value: for `Authorization`, store `Bearer <token>`, not the token alone.
- `storeRepo`: a GitHub `owner/name` synced through the env's `GITHUB_CONNECTOR`, as the next section describes. `storeLayout` says where the checkout lives under `$HOME` (`home`), which paths stay local (`exclude`), which are append-only line files to merge (`lineFiles`) and an optional merge script (`mergeScript`); it requires a `storeRepo`. `home` must be a directory below `$HOME`, neither `$HOME` itself nor anything under `.claude`. `exclude` and `lineFiles` patterns contain no whitespace. `mergeScript` is a path under `$HOME` of letters, digits and `.` `_` `/` `-`.
- `sessionEnv`: non-secret variables set in every session, such as a plugin's own switch. Never put a secret here. A name the runner sets or reads itself is rejected: `PATH`, `HOME`, `NODE_OPTIONS`, `AGENT_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the runner's own variables (the `SKY_` ones among them), and anything starting `GIT_`.
- `checks`: lines the runner tells the agent to follow before it finishes, each an instruction or a command on a single line, run in order from the repo root. A command that calls `claude -p` runs as a nested headless session the runner has logged in; an API key stays out of it.

Provisioning applies the profile after the clone and before `setup`, so `setup` can use what it installs; the env's own plugins from `.claude/settings.json` follow `setup`. Plugins are updated on each provision; a run does not update them again. Reprovision to refresh.

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

### Approvals

`approvalPolicy` holds the listed tool calls until you approve or deny them. A Bash command on the auto-approve list skips a bare `Bash` entry and runs at once, so `git status` or `grep` doesn't cost an approval. A `Bash(git diff:*)` entry still holds what it names, and `Read`, `Glob` and `Grep` are unaffected.

A command skips approval only when it is one simple command of plain words that starts with a list entry, and none of the checks below asks. Anything else waits for you, and so does a command the runner can't evaluate.

Built-in list (`defaults: true`), with what each asks on besides the checks on every command:

- `ls`, `cat`, `head`, `pwd`, `which`: nothing more.
- `wc`: asks on `--files0-from` and any `--f…`.
- `echo`: the syntax check only; it prints its arguments, so they aren't checked as paths.
- `grep`: asks on `-r`, `-R`, `-d` (also inside a bundle such as `-rn`), and any long option outside the plain matching and output ones.
- `rg`: asks on `--pre`, `--pre-glob`, `--hidden`, `--follow`, `--no-ignore*`, `--ignore-file`, `--glob`, `--iglob`, `--type-add`, `--unrestricted`, `--search-zip`, `--hostname-bin`, `--trace`, `--debug`, and short options holding `z`, `u`, `L`, `g` or `.`.
- `sed`: asks on anything but `sed -n 'N,Mp' file…` or `sed -n 'Np' file…`.
- `tail`: asks on following, `-f`/`-F` in any bundle and any `--f…`.
- `find`: asks on `-L`, `-follow`, `-files0-from`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`.
- `git status`, `git log`, `git diff`, `git show`, `git rev-parse`: asks on `-c`, `-O…`, `--output…`, `--ext-diff`, `--textconv`, `--no-index`, `--open-files-in-pager…`, `--exec-path…`, `--git-dir…`, `--work-tree…`.
- `git branch`: asks on the git options above, any flag but `-l`/`--list`, `-a`/`--all`, `-r`/`--remotes`, `-v`/`-vv`/`--verbose`, `--show-current`, `--color`/`--no-color`, and a name without `--list` or `-l`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`: see below.
- `node --version`, `node -v`: asks on anything else.

Checks on every command:

- Syntax: unquoted `;` `&` `|` `<` `>` `(` `)` `*` `?` `[` `]` `{` `}` `#` ask (chaining, pipes, redirects, subshells, globs, braces, comments), and so do `$`, backticks, `\`, `!`, newlines, unbalanced quotes, a word starting with `~` (even quoted) and a word starting with an unquoted `=` (zsh expands `=ls` to a program's path). The first word must be a program name, not a variable assignment, a path or an option.
- Paths: every argument, both sides of an `=` or `:` in it, and a value glued to a short option (`-o/etc/x`) is resolved against the shell's current directory, which an earlier `cd` may have moved. It asks when that lands outside the agent's worktree, when the shell itself is outside it, or when any path segment is `.claude`, `.config`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker` or `environ`, starts with `.env`, `.dev.vars`, `.npmrc`, `.yarnrc`, `.netrc`, `.pgpass`, `.pypirc`, `.htpasswd` or `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, ends in `.pem`, `.key`, `.p12` or `.pfx`, or contains `credentials`, `token`, `secret` or `.tfstate` (any case), or when the path reaches `.git/config`. Segments are matched anywhere, so `cat .claude/CLAUDE.md` inside the worktree asks, and so does a search for `token` (`rg token src`).
- Symlinks: each path that exists is followed to its real location and checked again, so a link inside the worktree that leads outside it, or onto a secret, asks. A path that doesn't exist is judged by its text; one that can't be resolved for another reason asks.

`pnpm test`, `pnpm typecheck` and `pnpm lint` are built in, with `-r` and `--filter <pkg>` allowed before the script. They run whatever the repo's `package.json` and test files say, so approving them approves code the agent can edit; an environment that doesn't accept that sets `defaults: false` and lists the commands it does. They ask on script arguments starting with `-` other than `--`, `--run`, `--silent`, `--bail` and `--passWithNoTests`.

`autoApprove.commands` adds entries and `defaults: false` replaces the built-ins; `defaults: false` with no `commands` turns auto-approval off. An entry is a prefix: `make check` approves `make check` followed by any plain arguments, so `git` alone approves `git push` and `git reset --hard`, and `pnpm exec` approves `pnpm exec rm build`. Added commands get the same syntax, path and per-program checks, and an entry those checks would always refuse is rejected when you apply the environment.

## Pull requests

An agent's sandbox holds no GitHub token, so `git push` and `gh` don't work there. Agents publish through a Sprites connector to GitHub instead:

1. In the Sprites org whose token Sky runs with (`SPRITES_TOKEN`), connect GitHub and give the connector a policy with `name_prefix: sky-`, so every Sky sandbox can use it.
2. Hand its connection id to an environment:

   ```
   sky secret set web GITHUB_CONNECTOR --connector=<connection id>
   ```

Agents in that environment then get `GITHUB_CONNECTOR` and are told to publish with Sky's own command, which sends the branch's commits to GitHub and opens a pull request into the default branch, or updates the one already open. The connector must belong to the same Sprites org as `SPRITES_TOKEN`; another org's connector doesn't recognize Sky's sandboxes.

## REST API

All routes live under `/v1`. Ids are prefixed: `env_…`, `agent_…`, `run_…`.

**Launch an agent** in a ready environment:

```
POST /v1/agents
{ "envId": "env_abc", "prompt": "Fix the flaky login test" }
```

`202 Accepted`, with `Location: /v1/agents/<agentId>/runs/<runId>` and a body of `{ "agent": …, "run": … }`.

| route                                                                   | what it does                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v1/environments` · `GET`, `PATCH`, `DELETE /v1/environments/:id` | environments; create returns `202` while provisioning  |
| `PUT`, `GET`, `DELETE /v1/environments/:id/secrets[/:name]`             | environment secrets                                    |
| `POST /v1/agents/:id/runs`                                              | follow-up run, resuming the agent's session            |
| `GET /v1/agents/:id/runs/:runId` · `…/stream`                           | a run's result, or its events as SSE                   |
| `POST /v1/agents/:id/answers` · `…/approvals`                           | answer a waiting question; approve or deny a tool call |
| `POST /v1/agents/:id/stop` · `…/archive`                                | stop the current run; archive the agent                |
| `POST /v1/webhooks`                                                     | subscribe an https URL to events                       |

Errors come back as `{ "error": { "code": …, "message": … } }`. The ones you'll meet:

| code              | means                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `concurrency_cap` | the environment already runs its max agents; wait for one to end or stop one |
| `run_active`      | a run is in progress; wait for it or stop it                                 |
| `env_not_ready`   | the environment isn't ready to launch agents yet                             |
| `provisioning`    | the environment is still provisioning; wait for it to finish                 |
| `agents_exist`    | repo or setup can't change while unarchived agents exist                     |
| `already_decided` | the request was already decided differently; that decision stands            |

## MCP

`POST /mcp` (streamable HTTP, same bearer key) exposes `create_env`, `launch`, `followup`, `status`, `answer`, `approve`, `stop`, `archive` and `wait_for_events`, so a chat bot can dispatch, follow and answer agents.

`wait_for_events` waits up to 30 seconds and returns as soon as something happens, with a `cursor` to pass back as `after` on the next call. Call it in a loop to follow every agent live without a public URL. On your first call, use `status` to find agents already waiting.

## Events

What an agent does arrives as events, each with `agentId` and `runId`:

| event                                                                  | when                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `run.started`, `run.finished`, `run.failed`, `run.stopped`             | the run's lifecycle                                                   |
| `run.waiting`                                                          | the agent needs an `answer` or an approval                            |
| `run.resumed`                                                          | a question was answered or a tool call approved or denied             |
| `claude.Message`                                                       | Claude, or a subagent (with `parentToolUseId`), wrote a message       |
| `claude.PreToolUse`, `claude.PostToolUse`, `claude.PostToolUseFailure` | a tool call starts, finishes or fails, with its input and output      |
| `claude.SubagentStart`, `claude.SubagentStop`                          | a subagent starts or finishes                                         |
| `claude.TaskCreated`, `claude.TaskCompleted`                           | a todo item is added or finished                                      |
| `claude.Notification`, `claude.PreCompact`, `claude.FileChanged`       | Claude Code's notifications, context compaction, watched-file changes |

The `claude.*` names are Claude Code's own hook names. Each text field is redacted (registered secrets and tokens) and then cut to 4,096 characters. `claude.*` events are kept for 7 days; `run.*` events are kept.

Three ways to receive them:

- **MCP:** `wait_for_events`, above.
- **Stream:** `GET /v1/stream`, one SSE connection across every agent. Filter with `?types=claude.PostToolUse,run.waiting` and `?agentId=`. After a drop, reconnect with `Last-Event-ID` to receive what you missed. A `: ping` arrives every 15 seconds. When the server restarts, the stream ends with an `event: server.shutdown` frame whose `id` is your resume point and whose `retry: 2000` asks you to reconnect in 2 seconds; `EventSource` does this on its own. `GET /v1/events?after=&wait=` is the same feed as a long poll.
- **Webhooks:** `POST /v1/webhooks` with an `https` URL and the `eventTypes` you want. Each delivery carries `Sky-Event-Type`, `Sky-Event-Id`, and

```
Sky-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
```

keyed with your `WEBHOOK_SIGNING_KEY`. A failed delivery is retried with backoff, up to 30 attempts.

## License

[MIT](LICENSE)
