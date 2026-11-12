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

**The environment is the boundary inside the sprite.** These limits hold at the API. Every agent of an environment runs on its one sprite as the same user, so an agent a `runs` key starts can read what that sprite holds: the environment's secrets, the Claude login, and the files, variables and agent tokens of other agents running there. A prompt asking for them is enough. Put an environment on a key's list only when you'd hand that system the environment's secrets; for a system you trust less, give it an environment of its own.

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
claudeCredential: personal # optional: which Claude credential runs use (see Claude credentials); omit for the default token
claudeFallback: api-key # api-key (default) or none: what a run does while its subscription is at its limit
```

`setup` runs in the clone with bash, with pnpm and yarn on `PATH` and `SKY_CLAUDE` set to the `claude` binary agents run. After it, Sky installs the plugins the repo's `.claude/settings.json` enables in `enabledPlugins`, from the marketplaces its `extraKnownMarketplaces` declares. If a plugin comes from a marketplace that isn't declared there, add the marketplace in `setup`:

```yaml
setup: |
  pnpm install
  "$SKY_CLAUDE" plugin marketplace add owner/marketplace-repo
```

Provisioning fails at the setup step, naming the plugin and its marketplace, if a plugin's marketplace is neither declared nor added.

**Memory and `concurrency`.** Every agent of an environment runs on its one sprite, and a sprite has a fixed amount of memory and no swap. A large monorepo (thousands of files, with a typecheck or test run per agent) can use several GB at a time, so set `concurrency` to 1-2 there; the default of 3 suits small repos. When a sprite runs out of memory the kernel kills processes, often the runner, and the run is lost with the work since its last commit. Sky guards against this two ways. Before it starts a run, it reads the sprite's available memory (`free -m`) and, below `SPRITE_MIN_FREE_MB` (an environment variable of the API; default `1024`, `0` turns the check off), refuses the launch with `sprite_low_memory`. And when a run ends, the runner ends every process the run's session started (dev servers, watchers, test workers, a nested `claude -p`), so they don't hold memory for the next run; other runs' processes on the sprite are left alone.

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
sky webhook list                # id, format, url, event types and environments; secrets are never printed
sky webhook delete whk_…
sky key create <name> --role=runs --env=web,api   # admin only: a key limited to those environments; prints the secret once
sky key list
sky key revoke key_…
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

### Claude credentials

Runs authenticate to Claude with a credential the server holds as a secret. Each credential has a name, and no value is ever returned, printed or logged: everything below refers to them by name.

| secret                      | credential                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE_CODE_OAUTH_TOKEN`   | `default`, a subscription token from `claude setup-token`; required, and what an environment uses until it is assigned another |
| `CLAUDE_OAUTH_TOKEN_<NAME>` | another subscription, named by `<NAME>` in lowercase: `CLAUDE_OAUTH_TOKEN_PERSONAL` is `personal` (letters, digits and `_`)    |
| `SKY_ANTHROPIC_API_KEY`     | `api-key`, a pay-per-use Anthropic API key                                                                                     |

**Each environment has one credential.** Assign it with `sky env set-claude <env> <name|api-key|pool|default>`, the `claudeCredential` field of `env.yaml`, or `PATCH /v1/environments/:id`; only the admin key can. Unset (or `default`) is the default token. A run records the name of the credential it used: `sky status` prints it and a run's `claudeCredential` carries it. `GET /v1/claude-credentials` (admin only) and `sky claude-credentials` list each credential with its kind (`subscription` or `api-key`), the environments assigned it, when its limit lifts if it is limited, and how many runs started on it since midnight UTC, its last-seen 5-hour and 7-day usage, and the pool environments that may use it.

**Only a `pool` environment moves work between subscriptions, and pools are off by default.** An environment assigned a subscription, `api-key` or the default token uses that credential alone: Sky does not balance its runs across tokens, and a run that fails on its subscription is never retried on another. Its only fallback is the API key. Moving between subscriptions is something you opt an environment into, with `claudeCredential: pool` ([below](#opt-in-subscription-pool)).

**When a subscription reaches its usage limit** (the 5-hour or the weekly one), Sky marks it limited until the reset time Claude reports, kept across restarts, and:

- a run that fails with the limit is retried once, as a new run on the same agent (its `retryOf` names the failed one), resuming the same session so its worktree isn't lost, on `SKY_ANTHROPIC_API_KEY`;
- a launch while the subscription is limited goes straight to the API key, until the reset time passes;
- with no API key set, the launch fails at once with `claude_limited`, naming the reset time in UTC, instead of starting a run that would die.

If the message gives no reset time Sky can read, it holds the limit for 15 minutes. Set `claudeFallback: none` on an environment to turn the fallback off: its limited launches fail with the same error and the reset time, and no API money is spent. A run is retried from the server's memory of its launch, so a restart between a run's launch and its limit failure loses that one retry, not the limited state.

**The API key stays out of the project's way.** Claude Code prefers `ANTHROPIC_API_KEY` over a subscription token, and an environment may hold its own `ANTHROPIC_API_KEY` secret for its commands. The runner gives the Claude session exactly the run's credential. On a subscription run no API key of any kind reaches it; the project's key still works for the commands the session runs. On an API-key run Sky's key is used for the session alone: the commands never see it, and they keep the project's own key, or have none. A nested `claude -p` (such as a Kru check) is logged in with the sandbox's subscription, so on an API-key run it isn't logged in and the agent is told to report such a check as not run.

#### Opt-in subscription pool

`claudeCredential: pool` lets one environment spread its runs over several subscriptions. It is the only assignment that does, and nothing is a pool until you set it. `claudePool: [work, personal]` (`sky env set-claude <env> pool --pool=work,personal`) lists the subscriptions it may use, in failover order; without a list the pool is every subscription the server holds, the default included. `pool` is not a valid `<NAME>` for a token.

- **Usage.** For each subscription Sky keeps its last-seen 5-hour and 7-day usage and their reset times, read from the `anthropic-ratelimit-unified-*` headers of a one-token probe (`POST /v1/messages` on the cheapest model, with the Claude Code system prompt and the OAuth beta header). A pool launch probes the subscriptions whose reading is older than 5 minutes, one probe at a time per subscription and never more often than that, and stores the readings, so a restart keeps them. A probe that fails is logged by name and never fails the launch. A subscription the probe finds full is marked limited until that window resets. One the probe gets a `429` for with no window full is marked limited until the earliest reset the answer gives. Either is held 15 minutes when the answer gives no reset. A subscription whose token is refused (`401` or `403`) is logged by name, nothing is stored for it, and pool launches leave it out for 5 minutes. No reset is held further than 7 days ahead, from a probe or a limit message.
- **Pick.** A pool launch runs on the subscription in the pool that isn't limited and has the most headroom: the lowest of the larger of its 5-hour and 7-day use, a window already past its reset counting as unused. Ties go to the earlier in the list, and a subscription that was never probed ranks after those that were.
- **Failover.** A pool run that fails with a usage limit, 5-hour or weekly, marks that subscription limited until its reset and is retried once on the next subscription in the pool's order that isn't limited, resuming the same session. A chain tries each subscription at most once. After the list it goes to the API key on the terms above, or, when the server has no key or `claudeFallback` is `none`, stays failed with a `runner.warning` naming the earliest reset in UTC. A pool launch with every subscription limited, or refused by the probe, goes straight to the key, or fails with `claude_limited` naming the earliest reset.

`sky claude-credentials` shows each subscription's usage and which pool environments use it. The API key rules above are unchanged for pools: the key reaches only the Claude session of a run that is on it.

### Base profiles

A base profile is what every sprite gets before its own `setup`, defined once on the server so no client's tooling lives in Sky's code. The API reads them from `SKY_BASE_PROFILES`, a JSON object of profiles by name, empty by default; an environment picks one with `base: <name>`. A `base` the server doesn't have is rejected, and changing `base` rebuilds the sprite like changing `setup` (so it is refused with `agents_exist` while unarchived agents exist). With no `base`, an environment gets no plugins or MCP servers beyond its repo's, no store sync and no check instructions.

A profile holds:

- `marketplaces`: sources for `claude plugin marketplace add`. None may start with `-`.
- `plugins`: `name@marketplace`, installed at user scope, starting with a letter or digit. Provisioning installs and updates them after adding the marketplaces.
- `mcpServers`: user-scope MCP servers by name (letters, digits, `_` and `-`, starting with a letter or digit), each `command` (with `args`, `env`) or `url` (with `headers`). Credentials are never inline: an `env` or `headers` value is the **name** of an env secret (`sky secret set`). Each run resolves the names from its env and hands the session the servers directly. Sky also writes them into the sprite's config as `${NAME}`, so no secret value reaches the checkpoint. A header can only name a secret, so that secret holds the entire header value: for `Authorization`, store `Bearer <token>`, not the token alone.
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

A command skips approval only when every simple command in it would skip approval on its own: each is plain words starting with a list entry, and none of the checks below asks. Simple commands may be joined by `;`, `&&`, `||` and `|`, so `git status -sb | head -3`, `ls a; cat b` and `cd packages/x && grep -n foo bar.ts` run at once, while `git status && git push` asks. Anything else waits for you, and so does a command the runner can't evaluate.

Built-in list (`defaults: true`), with what each asks on besides the checks on every command:

- `ls`, `cat`, `head`, `pwd`, `which`: nothing more.
- `wc`: asks on `--files0-from` and any `--f…`.
- `echo`: the syntax check only; it prints its arguments, so they aren't checked as paths.
- `grep`: asks on `-r`, `-R`, `-d` (also inside a bundle such as `-rn`), and any long option outside the plain matching and output ones.
- `rg`: asks on `--pre`, `--pre-glob`, `--hidden`, `--follow`, `--no-ignore*`, `--ignore-file`, `--glob`, `--iglob`, `--type-add`, `--unrestricted`, `--search-zip`, `--hostname-bin`, `--trace`, `--debug`, and short options holding `z`, `u`, `L`, `g` or `.`.
- `sed`: asks on anything but `sed -n 'N,Mp' file…` or `sed -n 'Np' file…`.
- `tail`: asks on following, `-f`/`-F` in any bundle and any `--f…`.
- `find`: asks on `-L`, `-follow`, `-files0-from`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`.
- `git status`, `git log`, `git diff`, `git show`, `git rev-parse`: asks on `-c`, `--config-env…`, `-O…`, `--output…`, `--ext-diff`, `--textconv`, `--no-index`, `--open-files-in-pager…`, `--exec-path…`, `--git-dir…`, `--work-tree…`.
- `git branch`: asks on the git options above, any flag but `-l`/`--list`, `-a`/`--all`, `-r`/`--remotes`, `-v`/`-vv`/`--verbose`, `--show-current`, `--color`/`--no-color`, and a name without `--list` or `-l`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`: see below.
- `node --version`, `node -v`: asks on anything else.
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

- Syntax: a lone `&`, `|&`, `<`, `(`, `)`, `*`, `?`, `[`, `]` or `#` outside quotes asks (background, stderr pipes, input redirects and here-docs, subshells and process substitution, globs, comments), and so do newlines, unbalanced quotes, a word starting with `~` (even quoted) and a word starting with an unquoted `=` (zsh expands `=ls` to a program's path). `$`, backticks, `\` and `!` ask outside single quotes; inside single quotes they are plain text for `grep`, `rg`, `sed`, `echo` and the pipe-only filters above (`awk '{print $1}'`, `grep 'foo$'`), and ask for every other program, since pnpm script arguments or `make 'X=$(shell …)'` would expand them. The first word of each command must be a program name, not a variable assignment, a path or an option.
- Redirects: only `2>&1`, `2>/dev/null` and `>/dev/null` (with or without a space before `/dev/null`); any other `>`, `>>`, `>|`, `&>` or `>&` asks.
- Braces: `{a,b}` in an argument is expanded as the shell would and each resulting word is checked, so `wc -l {a,b}.ts` runs and `cat {a,.env}` asks. Sequences (`{1..3}`), nested groups, quotes inside a group, a group with no comma, an expansion past 64 words, braces in the program's place and an expanded word that is empty or starts with `~` or `=` ask.
- Paths: every argument, both sides of an `=` or `:` in it, and a value glued to a short option (`-o/etc/x`) is resolved against the shell's current directory, which an earlier `cd` may have moved. It asks when that lands outside the agent's worktree, when the shell itself is outside it, or when any path segment is `.claude`, `.config`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker` or `environ`, starts with `.env`, `.dev.vars`, `.npmrc`, `.yarnrc`, `.netrc`, `.pgpass`, `.pypirc`, `.htpasswd` or `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, ends in `.pem`, `.key`, `.p12` or `.pfx`, or contains `credentials`, `token`, `secret` or `.tfstate` (any case), or when the path reaches `.git/config`. Segments are matched anywhere, so `cat .claude/CLAUDE.md` inside the worktree asks, and so does a search for `token` (`rg token src`).
- Symlinks: each path that exists is followed to its real location and checked again, so a link inside the worktree that leads outside it, or onto a secret, asks. A path that doesn't exist is judged by its text, except a `cd` target, which asks because bash would then move by the physical path; one that can't be resolved for another reason asks.

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

A merge commit is published with all its parents, so after an agent merges the default branch into its own, GitHub sees the pull request as up to date and CI runs. Every parent other than the first must already be on GitHub, as the default branch's head is. A merge of a branch that exists only in the sandbox is refused and nothing is sent; merge only branches GitHub has, or rebase instead. When the default branch has moved on GitHub since the merge, `publish` rebases a branch the agent started onto it first, which drops a merge of the default branch and replays only the branch's own commits; a branch the agent continues from an existing pull request is never rebased, and is published with its merge as it is. Because the connector can't write under `.github/workflows/`, a merge that brings in workflow changes the branch doesn't have on GitHub (as when the default branch changed a workflow after the branch was first published) is refused and nothing is sent, since the pull request would otherwise show those changes as undone. Have someone merge the default branch into the pull request's branch from outside the sandbox and publish again, or, on a branch the agent started, rebase instead of merging.

### How the sandbox pulls the repo

A **public** repo is pulled over git with no credential: provisioning clones it with its full history, and each run's refresh of the default branch (and the first fetch of a `--branch` start) is a `git fetch`. Those cost no GitHub REST calls; keeping an agent's own branch in step on later runs still makes a few connector calls. A **private** repo goes through the connector, one REST call per file, which spends the connector's shared hourly quota; Sky never calls the API to ask which kind a repo is, it tries git first. When the anonymous fetch fails (a private repo, no network) Sky logs one line saying why and uses the connector. The attempt has a time limit and can't prompt for a login or use a stored credential. Set the environment secret `SKY_ANON_GIT` to `0` (`sky secret set <env> SKY_ANON_GIT`) to skip it for a repo known to be private. When the connector's quota runs out, a call waits for GitHub's reset if it is within five minutes and otherwise fails naming the reset time. The store repo (`storeRepo`) always syncs through the connector.

Follow-up, not built: a GitHub App that mints a short-lived read token per clone would let private repos use git too.

Some repos reject commits by unverified authors, or commits with a `Co-authored-by` trailer. For those:

- **Author.** Set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` as secrets of the environment (`sky secret set web GIT_AUTHOR_EMAIL`, and the same for the name). The agent's commits and the commits `publish` sends to GitHub then carry that author and committer, including commits the agent made before the variables were set; commits an earlier `publish` already sent to the branch stay on GitHub as they were sent. `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` set a different committer. Unless both author variables are set, commits are by `Claude <noreply@anthropic.com>`; setting only one of them falls back to Claude for both.
- **Trailers.** Claude Code's own commit and pull request attribution is turned off for the agent's session, though not for the `claude -p` runs it starts, and `publish` strips every `Co-authored-by` trailer, and the "Generated with Claude Code" footer, from commit messages and pull request bodies.
- **Branch.** `publish --branch <name>` sends the commits to the GitHub branch `<name>` and opens the pull request from it, while the agent's worktree stays on `claude/<agent id>`. Set the secret `SKY_PUBLISH_BRANCH` to make it the default. The order is the flag, then the branch the agent was started on with `sky agent start --branch` (see [Fetching from GitHub](#fetching-from-github)), then the secret. That secret is shared by every agent in the environment, and two agents publishing to one branch collide, so with several agents pass `--branch` per agent. Use a new branch name: a branch that already holds commits this agent never made is not overwritten. The name must be a valid branch name and not the base or default branch. The `compareUrl` an agent reports still names `claude/<agent id>`, unless it was started on a branch, whose name it uses.

### Fetching from GitHub

Sandboxes hold no GitHub credential, so `git push` and any fetch of a private repo fail there. The runner fetches at the start of every run: over git for a public repo, through the connector for a private one. Agents run `runner.mjs` only for `publish`; the API alone starts a run, and a `runner.mjs` run any other way refuses. Without a connector in the environment nothing is fetched and the sandbox keeps the commit it was provisioned with.

- **Default branch.** Every run refreshes `origin/<default branch>` first, so a new worktree starts from GitHub's current code. A clean worktree from an earlier run is rebased onto it. A worktree with uncommitted changes, one whose rebase conflicts, and one already published (rewriting it would break its pull request) are left alone, and the agent's prompt says how many commits it is behind. A default branch more than 100 commits ahead is not fetched; the prompt says so.
- **Start from a branch.** `sky agent start <env> --branch=<name>` (REST: `branch` on `POST /v1/agents`; MCP: the `branch` parameter) starts the agent from an existing branch on GitHub, such as an open pull request's. The agent works on a local `claude/<agentId>` branch, and `publish` updates `<name>` and its open pull request, without rebasing it onto the default branch. The start fails with `404 branch_not_found` if the branch doesn't exist, `422 branch_is_default` for the default branch, and `422 branch_needs_connector` when the environment has no connector.
- **Shared branch.** Two agents may target the same branch, and `publish` refuses to overwrite commits the branch never had.
- **Commits pushed from outside.** Follow-up runs fetch the agent's GitHub branch first. A clean worktree takes the commits pushed there by someone else (fast-forward, or a cherry-pick when `publish` gave its commits new shas). Diverged histories change nothing; the agent's prompt says what is on GitHub and `publish` refuses to overwrite it.

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
| `POST /v1/agents/:id/runs`                                              | follow-up run, resuming the agent's session            |
| `GET /v1/agents/:id/runs/:runId` · `…/stream`                           | a run's result, or its events as SSE                   |
| `POST /v1/agents/:id/answers` · `…/approvals`                           | answer a waiting question; approve or deny a tool call |
| `POST /v1/agents/:id/stop` · `…/archive`                                | stop the current run; archive the agent                |
| `POST`, `GET /v1/webhooks` · `GET`, `DELETE /v1/webhooks/:id`           | subscribe an https URL to events; list, read, remove   |
| `POST`, `GET /v1/keys` · `DELETE /v1/keys/:id`                          | admin only: mint, list and revoke `runs` keys          |
| `GET /v1/claude-credentials`                                            | admin only: the Claude credentials, by name            |

Errors come back as `{ "error": { "code": …, "message": … } }`. The ones you'll meet:

| code              | means                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `concurrency_cap` | the environment already runs its max agents; wait for one to end or stop one |
| `run_active`      | a run is in progress; wait for it or stop it                                 |
| `env_not_ready`   | the environment isn't ready to launch agents yet                             |
| `provisioning`    | the environment is still provisioning; wait for it to finish                 |
| `agents_exist`    | repo or setup can't change while unarchived agents exist                     |
| `already_decided` | the request was already decided differently; that decision stands            |
| `webhooks_filter` | webhooks filter on the environment; delete them first (ids in `webhookIds`)  |

### Run errors

A run the API fails ends with `run.failed`, and its `error` is one of:

| error                       | means                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launch_failed`             | the runner couldn't be started on the sprite; the detail follows the colon                                                                                                                                                                 |
| `launch_timeout`            | the runner never reported in within `LAUNCH_DEADLINE_MINUTES` (default 15); a `runner.warning` or heartbeat doesn't count as reporting in                                                                                                  |
| `claude_limited`            | the launch was refused: the environment's subscription is at its usage limit and the API key can't stand in (none is set, or the environment's `claudeFallback` is `none`); the error names the reset time in UTC                          |
| `claude_credential_missing` | the environment is assigned a credential this server no longer holds, or the API key it is assigned isn't set                                                                                                                              |
| `sprite_low_memory`         | the launch was refused: the sprite had less memory available than `SPRITE_MIN_FREE_MB` (default 1024); the error says how much was free. Wait for a run on the sprite to end, or lower `concurrency`                                       |
| `runner_lost`               | the run went quiet, the API woke its sprite, and the runner was no longer running there; the error names the sprite                                                                                                                        |
| `runner_killed`             | as `runner_lost`, and the sprite killed the runner, likely out of memory: the kernel logged a kill after the run was created, or the sprite had less than `SPRITE_MIN_FREE_MB` available; the error names the sprite and the memory it had |
| `runner_timeout`            | no event for `RUN_TIMEOUT_MINUTES` (default 30), though the runner was still running (or its sprite couldn't be reached to tell); names the tool call when one was running                                                                 |
| `waiting_timeout`           | the run waited on an answer or approval past its limit and its runner is gone                                                                                                                                                              |

**The probe.** A sprite can go to sleep under a run and lose its runner. Once a `running` run has had no event for `RUN_PROBE_MINUTES` (default 5, and always below `RUN_TIMEOUT_MINUTES`; when the timeout is under 10 minutes the default is half of it), the API wakes its sprite and looks for the run's runner:

- **Heartbeats arriving:** while a tool call runs, the runner posts `runner.heartbeat` about every 60 seconds with the tool's name and how long it has run. A heartbeating run is alive, so it isn't probed, however long the call takes. A heartbeat isn't progress: a tool call still running past `RUN_TIMEOUT_MINUTES` fails with `runner_timeout: <tool> was still running after <time> with no result, past the <limit> limit`, or with `runner_timeout: the runner went quiet during <tool> after it had run <time>` when the heartbeats stopped. A `runner.warning` isn't progress either.
- **Runner alive:** the API records a `run.probed` event and the run carries on. A probe is not runner activity, so a runner that is alive but wedged still fails with `runner_timeout`.
- **Runner gone:** the API first collects the sprite's diagnostics (`free -m`, uptime, the top processes by memory with their command lines, and the kernel's out-of-memory and kill lines where `dmesg` is readable), logs them, and stores a bounded, redacted copy on the run as a `runner.warning` event just before `run.failed`. Then the run fails at once, instead of waiting out `runner_timeout`: with `runner_killed` when the kernel log has a kill line stamped after the run was created or less than `SPRITE_MIN_FREE_MB` available (dmesg is often closed to the sprite user, so memory is the fallback), else `runner_lost`. A kill line from before the run does not count. The agent is free for a follow-up, which resumes the session and worktree as any follow-up does.
- **Sprite can't answer:** the API logs it and leaves the run alone; `runner_timeout` is the backstop. If the sprite no longer exists, the run fails at once with `runner_lost`.
- **An exec exits 137:** a command the API ran on a sprite (a wake, a check, a setup step) ended with SIGKILL, so something there is being killed. The API doesn't wait for the window: it probes every `running` run on that sprite at once. A runner found alive is left alone and nothing is recorded.

A run is probed at most once per window, and a slow sprite never holds up the API's sweep. Only `running` runs are probed; a run waiting on a request has its own deadline.

**Launch.** A sprite that pauses before the runner holds it freezes the runner, and the run sits in `starting` until `launch_timeout`. Two things guard against it. The API takes the run's keep-awake task on the sprite just before it starts the runner (a 2-minute task the runner's own hold then refreshes; if the runner never comes up it lapses by itself, and a failure of this step is logged and never fails the launch). And a run still `starting` 90 seconds after its runner started, with no event but a `runner.warning` or heartbeat, gets one wake: the API looks for its runner on the sprite, which unfreezes it. A runner found alive is left alone; one that is missing waits for `launch_timeout`.

**The run log.** On the sprite, `/workspace/runs/<runId>.log` is written only by the run's own runner, which holds `<runId>.lock` while it runs. The runner starts only when the API launches it with the run's id as its argument. Started any other way, by hand or from an agent's shell (which inherits the log's location), it refuses with one line on stderr and never touches the log. An agent's own command is `node /opt/sky/runner.mjs publish`.

## MCP

`POST /mcp` (streamable HTTP, same bearer keys) exposes `create_env`, `launch`, `followup`, `status`, `answer`, `approve`, `stop`, `archive` and `wait_for_events`, so a chat bot can dispatch, follow and answer agents. Every tool call runs with the caller's own key, so a `runs` key gets the same limits as over REST.

`wait_for_events` waits up to 30 seconds and returns as soon as something happens, with a `cursor` to pass back as `after` on the next call. Call it in a loop to follow every agent live without a public URL. On your first call, use `status` to find agents already waiting.

## Events

What an agent does arrives as events, each with `agentId`, `environmentId` (the environment the agent belongs to) and `runId`:

| event                                                                  | when                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `run.started`, `run.finished`, `run.failed`, `run.stopped`             | the run's lifecycle                                                   |
| `run.waiting`                                                          | the agent needs an `answer` or an approval                            |
| `run.resumed`                                                          | a question was answered or a tool call approved or denied             |
| `run.probed`                                                           | a silent run's runner was checked on its sprite and found alive       |
| `runner.warning`                                                       | the runner hit a problem that didn't end the run, with its message    |
| `runner.heartbeat`                                                     | a tool call is still running: its name and how long, about every 60 s |
| `claude.Message`                                                       | Claude, or a subagent (with `parentToolUseId`), wrote a message       |
| `claude.PreToolUse`, `claude.PostToolUse`, `claude.PostToolUseFailure` | a tool call starts, finishes or fails, with its input and output      |
| `claude.SubagentStart`, `claude.SubagentStop`                          | a subagent starts or finishes                                         |
| `claude.TaskCreated`, `claude.TaskCompleted`                           | a todo item is added or finished                                      |
| `claude.Notification`, `claude.PreCompact`, `claude.FileChanged`       | Claude Code's notifications, context compaction, watched-file changes |

The `claude.*` names are Claude Code's own hook names. Each text field is redacted (registered secrets and tokens) and then cut to 4,096 characters (`runner.warning` included). `claude.*` and `runner.heartbeat` events are kept for 7 days; `run.*` and `runner.warning` events are kept.

Three ways to receive them:

- **MCP:** `wait_for_events`, above.
- **Stream:** `GET /v1/stream`, one SSE connection across every agent. Filter with `?types=claude.PostToolUse,run.waiting` and `?agentId=`. After a drop, reconnect with `Last-Event-ID` to receive what you missed. A `: ping` arrives every 15 seconds. When the server restarts, the stream ends with an `event: server.shutdown` frame whose `id` is your resume point and whose `retry: 2000` asks you to reconnect in 2 seconds; `EventSource` does this on its own. `GET /v1/events?after=&wait=` is the same feed as a long poll.
- **Webhooks:** `POST /v1/webhooks` (or `sky webhook add`) with an `https` URL and the `eventTypes` you want. A failed delivery is retried with backoff, up to 30 attempts, and a `429` holds the webhook until its `Retry-After`. Two optional fields:
  - `format`: `"sky"` (the default) or `"standard"`, below.
  - `environmentIds`: a non-empty array of environment ids. The webhook then receives only events from agents in those environments; an id that doesn't exist is `400 invalid_body`. Left out, it receives every environment's events. An environment a webhook filters on can't be deleted until that webhook is (`409 webhooks_filter`).

  `GET /v1/webhooks` returns each webhook's `format` and `environmentIds` when set. A secret is never returned.

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

## License

[MIT](LICENSE)
