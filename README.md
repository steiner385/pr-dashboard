# pr-dashboard

Locally-hosted dashboard for every open PR across one or more GitHub orgs/users:
CI/CD lifecycle stage, percent complete, and ETA — all in a single browser tab.

![Dashboard overview: status strip and per-repo metro rows](.github/images/dashboard.png)

## UI

The dashboard opens with a **status strip** — five colour-coded tiles (Running, Queued, Deploying, Failed, Idle) that show live PR counts; clicking any tile filters the PR list to that state, and clicking again clears the filter. Below the strip, each open PR is rendered as a **metro-map row**: a horizontal track of nodes (CI → merge queue → QA deploy → prod) with the active node pulsing, done segments filled green, and a small elapsed/ETA annotation under the active node. Clicking a row expands a **check Gantt panel**: one row per CI job, grouped by workflow — the rollup workflow (e.g. `CI`) is shown first with required checks before advisory; other workflows (e.g. `Auto-merge PRs`) appear in a separate labeled section below. Each row has a proportional progress bar, elapsed time, and an ETA-accuracy footer line (`typically ±Xm, n=N`). At the very top, when any PRs are in the merge queue, a **queue-train strip** shows the current build batch(es) as blue bordered "cars" with progress bars, followed by dashed "next batch" and "then" cars listing the waiting PRs — clicking any PR anchor in a car smoothly scrolls the page to that PR's row (respecting `prefers-reduced-motion`). Queued PRs show two labeled sections in their expanded panel: the **merge group build** (driving the stage ETA) and **PR checks (head commit)**.

## Features

![Expanded PR row: per-check Gantt with running progress bars, elapsed time, and ETAs](.github/images/expanded.png)

![Status-strip filter: clicking the Running tile narrows the list to PRs with CI in flight](.github/images/running-filter.png)

*Screenshots show public repos (`facebook/*`), captured from a demo instance.*

- **Pipeline stages** per PR: CI → merge queue → QA deploy → awaiting prod
  (deploy stages only for repos with configured environments), plus
  parked substates (draft, conflicting, CI failed, queue group failed…).
- **Live updates over SSE** with frame dedup — unchanged snapshots aren't
  re-sent. A server keepalive forces a frame at least every 60s so the
  header's `live · updated HH:MM` stamp stays fresh.
- **Connection badge**: the header shows `live · updated HH:MM` while the
  SSE stream is connected and a red `disconnected — retrying…` badge when it
  drops (plus `stale since HH:MM` when GitHub fetches are failing).
- **Queue position**: queued PRs show `behind N` (entries ahead of it in the
  merge queue).
- **ETAs from observed history**: per-check p50/p90 durations, observed
  whole-group merge-queue runs, and merged→QA-live deploy gaps.
- **Conditional-remaining estimator**: when ≥5 historical samples exist for a
  running check, the remaining time is re-anchored on the samples that exceed
  the current elapsed time (handles bimodal cold/warm caches); if elapsed
  exceeds every sample the check is flagged overdue.
- **ETA accuracy footer**: the expanded check panel shows
  `ETA accuracy (ci): typically ±2m (n=14)` — the median absolute error of
  first-ETA predictions vs actual stage durations (seconds shown below one
  minute, e.g. `±45s`).
- **Runner visibility**: queued jobs are split into **waiting-for-runner**
  (every `needs:` dependency completed OK — the job is eligible and just needs
  a machine: `⧗ waiting for runner · 3m (typical ~1m)`, amber when waiting
  exceeds 2× typical) vs **blocked** on a named upstream job
  (`⊘ blocked on static-checks`). Pickup waits are learned per
  `(repo, check, event)` — `wait = startedAt − max(needs' completedAt)`, no
  extra API calls — and the medians feed stage ETAs for still-queued jobs.
  The `needs:` graph derived from `ci.yml` is **phase-aware**: a dependency
  whose job provably never runs for the check's event (e.g. a
  `merge_group`-only job seen from a PR-phase check) is satisfied by absence
  instead of being reported as blocking forever.
- **Workflow-scoped required population**: checks are attributed to the workflow
  that emitted them; prefix matching for required checks is scoped to the rollup
  workflow so helper workflows (e.g. `Auto-merge PRs`) can never pollute the
  required set.
- **Settings panel**: a gear button (⚙) in the header opens a slide-over panel
  for editing the safe subset of instance config live — see
  [Settings panel](#settings-panel) below.

---

## Setup (new user quickstart)

### 1. Clone and install

```bash
git clone https://github.com/your-fork/pr-dashboard.git
cd pr-dashboard
pnpm install
```

### 2. Authenticate with GitHub

The default token source is the `gh` CLI keyring:

```bash
gh auth login    # once — follow the prompts
```

Alternatively, set `tokenSource: "env"` in your config and export `GITHUB_TOKEN`,
or register a dedicated GitHub App with `pnpm app:setup` — see
[GitHub App mode](#github-app-mode-pnpm-appsetup) below.

### 3. Configure (optional but recommended)

Create `config.json` in the repo root **or** `~/.config/pr-dashboard/config.json`
(XDG; useful when you want one config for multiple checkouts). The first existing
file wins; `PRDASH_CONFIG` env var overrides both. See `config.example.json` for a
complete annotated example.

Minimal config to watch one org:

```json
{ "owners": ["your-org"] }
```

Without a config file the app auto-derives the owner from the GitHub token (`viewer.login`).

### 4. Build and run

```bash
pnpm build    # compiles frontend → dist/public; only needed once and after updates
pnpm start    # http://127.0.0.1:4400
```

Dev mode with hot-module reload:

```bash
pnpm dev      # Vite on :5173 proxying /api to :4400
```

First launch backfills ~50 commits of check-run history per repo so ETAs work
immediately. History lives in `data/history.db`. Deploy ancestry ("is this
merge commit live on QA/prod yet?") is answered through the GitHub compare API
by default — no git binary, no local clones. Only with `ancestrySource:
"clone"` do bare clones get created in `data/clones/`.

### 5. Install as a systemd user service

```bash
pnpm service:install    # renders deploy/pr-dashboard.service.template → ~/.config/systemd/user/ and daemon-reloads

systemctl --user enable --now pr-dashboard
loginctl enable-linger $USER    # keep running after logout

# Inspect
systemctl --user status pr-dashboard
journalctl --user -u pr-dashboard -f
```

To restart after a config change or update:

```bash
systemctl --user restart pr-dashboard
```

---

## Config field reference

All fields are optional; the table shows default values.

| Field | Default | Description |
|---|---|---|
| `owners` | `[]` | GitHub org/user logins whose PRs are shown. Empty → auto-derived: App mode uses the installation account logins; `gh`/`env` use the token's `viewer.login`. |
| `exclude` | `[]` | Repo full names (`"org/repo"`) to skip entirely. |
| `port` | `4400` | HTTP port. Bound to `127.0.0.1` only (loopback-only by design — see Security). |
| `retentionDays` | `7` | How many days of check-run history to keep in `data/history.db`. |
| `batchSize` | `6` | Default merge-queue batch size used in queue-position arithmetic. |
| `tokenSource` | `"gh"` | Where the GitHub token comes from. `"gh"` reads the `gh` CLI keyring (strips `GITHUB_TOKEN`). `"env"` reads `GITHUB_TOKEN`. `"app"` mints GitHub App installation tokens (see [GitHub App mode](#github-app-mode-pnpm-appsetup)). |
| `app.appId` | — | **Required when `tokenSource` is `"app"`.** Numeric GitHub App id. File-only (never PUT-writable). |
| `app.privateKeyPath` | — | **Required when `tokenSource` is `"app"`.** Path to the App's RSA private key PEM. File-only. |
| `app.installationId` | all installations | Optional restriction: pin the dashboard to a single installation. Omit to watch repos across every account the App is installed on (see [Multi-installation](#multi-installation)). File-only. |
| `webhooks.enabled` | `false` | Opt-in signed webhook receiver (see [Webhooks](#webhooks-optional)). File-only. |
| `webhooks.secretPath` | — | **Required when webhooks are enabled.** Path to the shared webhook secret file (written by `pnpm app:setup`). File-only. |
| `webhooks.path` | `"/api/webhooks/github"` | Route the receiver listens on. File-only. |
| `deployUrlAllowlist` | unset | Optional hostname allowlist for **in-repo** (`.pr-dashboard.yml`-sourced) deploy `healthUrl`/`cloneUrl` (`cloneUrl` is only checked with `ancestrySource: "clone"` — it is never touched otherwise). Unset → in-repo URLs honored as-is. File-only. |
| `ancestrySource` | `"api"` | How deploy ancestry is answered. `"api"` = GitHub compare API (no git binary, no local clones; a pre-existing clone serves as a transport-error fallback only). `"clone"` = local bare clones in `data/clones/` (the previous mechanism — useful if you prefer local checks or are rate-limit constrained). File-only. |
| `apiUrl` | `"https://api.github.com/graphql"` | GraphQL endpoint. Override for GitHub Enterprise (e.g. `"https://github.example.com/api/graphql"`). |
| `rateLimitFloor` | `1000` | Remaining rate-limit budget below which polling degrades to slow intervals. |
| `intervals.sweepMs` | `60000` | Full-sweep poll interval (ms). |
| `intervals.hotMs` | `15000` | Fast-poll interval when active PRs are in flight (ms). |
| `intervals.deployMs` | `30000` | Deploy-health-check interval (ms). |
| `deploy.<repo>` | `{}` | Deploy-tracking config keyed by `"owner/repo"`. Omit the key to disable deploy stages for that repo. |
| `deploy.<repo>.cloneUrl` | `"https://github.com/<repo>.git"` | Git URL for the bare clone used for ancestry checks. **Only used (and only needed) when `ancestrySource` is `"clone"`.** |
| `deploy.<repo>.defaultBranch` | `"main"` | Branch that merges land on (used to anchor ancestry walks). |
| `deploy.<repo>.environments[]` | — | Array of deployment environments (at most one `qa` and one `prod`). |
| `deploy.<repo>.environments[].name` | — | **Required.** `"qa"` or `"prod"`. |
| `deploy.<repo>.environments[].healthUrl` | — | **Required.** URL polled for the deployed SHA (expects a JSON body). |
| `deploy.<repo>.environments[].auto` | `true` for `qa`, `false` for `prod` | Whether deploys to this env trigger automatically (affects stage transitions). |
| `deploy.<repo>.environments[].shaKey` | `"commitSha"` | JSON key in the health response that contains the deployed commit SHA. |
| `repos.<repo>` | `{}` | Per-repo behaviour overrides keyed by `"owner/repo"`. |
| `repos.<repo>.requiredCheckPrefixes` | derived from `ci.yml` | Check name prefixes that force a check to be treated as required mid-run, before GitHub marks it `isRequired`. Explicit `[]` disables prefix matching entirely for this repo. |
| `repos.<repo>.rollupJobId` | `"ci"` | The rollup job in `ci.yml` whose `needs:` closure defines required checks. Also used to scope prefix matching to the right workflow. |
| `repos.<repo>.workflowPath` | `".github/workflows/ci.yml"` | Repo-relative path to the workflow YAML read for `needs:` derivation. |
| `repos.<repo>.batchSize` | global `batchSize` | Merge-queue batch size for this repo. Overrides the global value. |

---

## Settings panel

The gear button (⚙) in the header opens a slide-over settings panel backed by
`GET/PUT /api/config`. Changes are written back to the loaded config file
(read-modify-write — hand-written fields outside the editable subset are
preserved verbatim) and **hot-applied** without a restart: the poller swaps its
config, re-arms its timers with the new intervals, and triggers an immediate
sweep.

**Editable in the panel** (the safe subset):

| Section | Fields |
|---|---|
| Watched repos | `owners`, `exclude` |
| Tuning | `retentionDays`, `batchSize`, `intervals` (sweep / hot / deploy) |

**File-only (shown read-only in the panel):**

- `tokenSource`, `apiUrl`, `port` — anything the UI can write, anything running
  on localhost can write via `PUT /api/config`. These three are the credential
  and network surface: a writable `tokenSource`/`apiUrl` would let a local
  process redirect your GitHub token to an attacker-controlled endpoint, and a
  writable `port` could re-bind the service. The server rejects any attempt to
  PUT them with `400 { offendingKeys }` — the UI's read-only rendering is a
  convenience, not the security boundary.
- `deploy.<repo>` and `repos.<repo>` blocks — edit them in `config.json`
  directly, or set them per-repo via an in-repo `.pr-dashboard.yml`
  (next section). The panel shows each repo's *effective* settings with a
  per-field source tag (`override` / `in-repo` / `derived` / `default`).

The panel also has a **Restart** button (`POST /api/admin/restart`, with inline
confirmation): the server responds `202` and exits non-zero shortly after, so
systemd (`Restart=on-failure`) revives it; no shell execution is involved. The
UI rides out the bounce on the existing SSE auto-reconnect.

---

## Notifications

The poller already detects every alert-worthy transition; the notifier layer
(issue #19) turns them into desktop notifications. Six event types:

| Type | Fires when | Default |
|---|---|---|
| `ci-failed` | a PR enters `parked/ci-failed` (a required check failed) | on |
| `group-failed` | a queued PR's merge-group build fails | on |
| `queue-blocked` | a queue entry goes UNMERGEABLE (genuine conflict or cascade victim — the detail names the conflicting culprit PR) | on |
| `ready` | a PR's checks go green (`ci` -> `ready/armed` or `ready/idle`) | off |
| `overdue` | a stage's ETA is exceeded (`overdue` flips true) | off |
| `prod-live` | a merged PR's commit becomes prod ancestry ("shipped") | on |

**Debounce:** one notification per (PR, event type) while the condition holds;
if the condition clears (e.g. the failing check is retried green) and later
re-enters, it fires again. `prod-live` fires once per PR per process lifetime.

### Sink A — host command (`notifications` in config.json, file-only)

```json
"notifications": {
  "enabled": true,
  "command": ["notify-send", "{title}", "{body}"],
  "events": { "ci-failed": true, "group-failed": true, "queue-blocked": true,
              "ready": false, "overdue": false, "prod-live": true }
}
```

- `command` is an **argv array**, run via `execFile` — never a shell, so a
  hostile PR title can't inject. `{title}`/`{body}` are substituted in any
  argument (never in `command[0]`, the executable).
- The whole block is **file-only**: `PUT /api/config` rejects it (the command
  executes on the host, so it must never be writable from the browser).
- Command failures are logged once and never crash a poll cycle.
- A type set `false` in `events` fires neither sink.

### Sink B — browser notifications (the header bell)

Notification events also ride the SSE stream as named `notification` frames.
The bell button in the header toggles browser Web Notifications: turning it on
requests `Notification` permission and persists the choice in localStorage.
Works regardless of `notifications.enabled` (that flag gates only the host
command); the per-type `events` toggles apply to both sinks.

**Caveat:** there is no service worker — the dashboard tab must be open
(backgrounded is fine) to receive browser notifications. For tab-independent
delivery, use the command sink.

## Kiosk mode (wall displays)

Append `?kiosk=1` to the dashboard URL for a read-only, at-a-distance view
intended for wall-mounted displays (e.g. a Raspberry Pi running Chromium in
kiosk mode):

```
http://127.0.0.1:4400/?kiosk=1            # 30s per view (default)
http://127.0.0.1:4400/?kiosk=1&cycle=20   # 20s per view (minimum 10)
```

- **Read-only chrome** — the settings gear, legend, and notification bell are
  hidden, the Pipeline/Metrics tab bar is gone, status tiles are plain
  (non-filtering) summaries, and PR rows don't expand on click. The status
  strip stays: it's the glanceable summary.
- **Larger type** for readability across the room.
- **Auto-cycling** — the view rotates every `cycle` seconds: each repo section
  is scrolled to the top of the viewport in turn, then the Metrics trends view
  shows, then the cycle wraps. Cycling pauses while the tab is hidden and
  honors `prefers-reduced-motion` (instant jumps instead of smooth scrolling).
- **Live updates unchanged** — the same SSE stream (keepalive + auto-reconnect)
  feeds the kiosk view, so it never needs a manual refresh.

Params are read once at page load; change the URL and reload to adjust.

## In-repo `.pr-dashboard.yml`

Any watched repo can carry its own dashboard settings in a `.pr-dashboard.yml`
at the repo root of its default branch. The file is read over the GraphQL API
(blob read — no clone needed) at startup and refreshed on the same 24h cycle as
`ci.yml` prefix derivation. This is the "repo layer" of the config model — the
repo's maintainers describe how their CI/deploys work, and any dashboard
instance watching the repo picks it up automatically.

### Schema

All fields optional; unknown keys are ignored with a logged warning, and an
invalid field is dropped individually (one bad field never takes the rest of
the file with it).

```yaml
rollupJobId: ci                      # rollup job in the workflow below (default: ci)
workflowPath: .github/workflows/ci.yml
requiredCheckPrefixes: []            # replaces ci.yml derivation when set ([] disables prefix matching)
batchSize: 6                         # merge-queue batch size
deploy:                              # enables deploy stages for this repo
  cloneUrl: https://github.com/owner/repo.git   # default: GitHub URL of the repo (clone mode only)
  defaultBranch: main
  environments:                      # at most one qa and one prod
    - name: qa                       # qa | prod
      healthUrl: https://qa.example.com/health  # required per environment
      auto: true                     # default: true for qa, false for prod
      shaKey: commitSha              # JSON key holding the deployed SHA
```

Validation and defaulting are identical to the same fields in `config.json`
(env names lowercased, `qa`/`prod` only, `healthUrl` required, `shaKey`
defaults to `commitSha`).

### Precedence

Per-repo settings resolve field-by-field, highest first:

1. **Instance override** — `repos.<repo>` / `deploy.<repo>` in your
   `config.json` always wins (your instance, your last word).
2. **In-repo** — the repo's `.pr-dashboard.yml`.
3. **Derived** — prefixes derived from the repo's `ci.yml`
   (`requiredCheckPrefixes` only).
4. **Defaults**.

The settings panel's per-repo section shows which layer each effective value
came from (`override` / `in-repo` / `derived` / `default`).

### Trust note

By default, **in-repo deploy URLs are honored as-is**: a `.pr-dashboard.yml`
lets that repo's maintainers point `healthUrl` (which the dashboard polls) and
— in clone mode — `cloneUrl` (which it clones) anywhere. That is acceptable for
the single-user self-hosted deployment — you control the repos you watch. If
you watch repos you don't fully control, set `deployUrlAllowlist` in
`config.json`: when set, in-repo deploy entries whose `healthUrl` host (plus
the `cloneUrl` host when `ancestrySource` is `"clone"` — the only mode that
touches it) is not on the list are dropped with a logged warning.
Instance-override deploy config (`deploy.<repo>` in your own `config.json`) is
exempt — the operator wrote it.

---

## Path anchoring

All runtime paths (data directory, config file, static files) are resolved
relative to the **package root** — the directory containing `package.json`.
The server does not rely on `process.cwd()`, so it works when started from
any directory (including via systemd).

Environment overrides:
- `PRDASH_DATA_DIR` — override the data directory (default: `<root>/data`)
- `PRDASH_CONFIG` — override the config file path (default: `<root>/config.json`)

---

## Required-check prefixes (derived from ci.yml)

Repos that gate merges on a single rollup job (e.g. a `ci` rollup) don't mark
checks `isRequired` until late in the run. To classify required checks mid-run
the poller uses name prefixes, resolved in this order:

1. **Config**: `repos["<owner>/<repo>"].requiredCheckPrefixes` in `config.json`
   — always wins. An explicit empty array (`[]`) disables prefix matching
   entirely for that repo.
2. **Derived**: the poller reads the repo's workflow file (default
   `.github/workflows/ci.yml`) at startup (and re-derives every 24h) and walks
   the rollup job's `needs:` graph; each job in the closure contributes
   its display name as a prefix (reusable-workflow jobs get a ` /` suffix).
   With `ancestrySource: "api"` (the default) the file is read over the
   GraphQL blob API — no clone needed — for every deploy repo **and** every
   repo that opts in via a `repos.<repo>` entry or an in-repo
   `.pr-dashboard.yml`. With `ancestrySource: "clone"` derivation reads the
   bare clone and is limited to deploy repos (as before).
   A successful derivation is logged:
   `[poller] derived required-check prefixes for <repo>: …`.
   Unparseable YAML leaves the previous prefixes in place; valid YAML with no
   rollup job degrades to `['ci']`.
3. **Fallback**: `['ci']` — used only until derivation succeeds.

Prefix matching is scoped to the rollup workflow: a check whose name starts with
a required prefix only counts as required when it was emitted by the same workflow
that owns the rollup job. Checks from helper workflows (e.g. an auto-merge
orchestrator) are excluded from the required population regardless of their names.

---

## GitHub App mode (`pnpm app:setup`)

Instead of a personal token, the dashboard can authenticate as a **GitHub App
you register yourself** — read-only permissions (`checks`, `pull_requests`,
`actions`, `contents`, `metadata`), private to your account, no PAT to rotate.
Registration is one command via GitHub's app-manifest flow:

```bash
pnpm app:setup    # optional: pnpm app:setup my-dashboard-app
```

The script starts a one-shot localhost listener and prints a URL. Open it: it
forwards you to GitHub's pre-filled "Create GitHub App" page (the name is
editable there). After you confirm, GitHub redirects back to the local listener
and setup completes automatically:

- the App's private key is written to
  `~/.config/pr-dashboard/<slug>.private-key.pem` (mode 0600), and the
  generated webhook secret to `<slug>.webhook-secret` alongside it;
- your active config file is patched (read-modify-write — other fields are
  preserved) to `tokenSource: "app"` with `app: { appId, privateKeyPath }`;
- the **install URL** (`https://github.com/apps/<slug>/installations/new`) is
  printed — install the App on the account/repos the dashboard should watch,
  then restart the dashboard.

At runtime the server mints short-lived installation tokens itself (App JWT →
installation access token, cached and refreshed before expiry, built on
`node:crypto` only). At startup it lists the App's installations and builds a
per-owner client map; the list is refreshed every 24 hours, so new
installations are picked up without a restart.

### Multi-installation

**One instance watches repos across all of the App's installations.** Install
the App on each account whose repos the dashboard should watch (the install
URL again: `https://github.com/apps/<slug>/installations/new`). Every GitHub
request is routed to the installation that covers the repo's owner — each
installation gets its own token and its own rate-limit budget. An owner in
your `owners` list that no installation covers is skipped with a one-time
`owner '<owner>' has no installation — skipped` warning (it's a config
mismatch, not an outage — the repo's data is never marked stale for it).

With `tokenSource: "app"` and no `owners` configured, the owners list defaults
to the installation account logins — installing the App on an account is
enough to start watching it.

`app.installationId` is an **optional restriction**: when set, the registry is
pinned to that single installation and only its account's repos are visible.
Use it when one App serves several dashboard instances and each should only
see its own account.

**Alternative pattern — one instance per account.** Instead of one instance
spanning installations, you can still run a separate instance per account:
distinct `PRDASH_CONFIG` / `PRDASH_DATA_DIR` / port, with `app.installationId`
pinned to that account's installation. Useful when you want per-account
isolation (separate ports, data dirs, lifecycles) rather than a single
combined dashboard.

---

## Webhooks (optional)

Polling is the primary update mechanism and works with zero ingress. If you
want lower-latency updates, the server ships an **opt-in, signature-verified
webhook receiver**:

```json
{
  "webhooks": {
    "enabled": true,
    "secretPath": "~/.config/pr-dashboard/<slug>.webhook-secret"
  }
}
```

- Every delivery must carry a valid `X-Hub-Signature-256` HMAC (verified with
  a timing-safe compare against the shared secret in `secretPath` — written for
  you by `pnpm app:setup`). Bad/missing signature → 401; receiver disabled →
  404.
- Events nudge the poller out-of-band: `pull_request`/`check_run`/`check_suite`
  trigger a targeted PR refresh, `merge_group` a queue refresh, `workflow_run`
  a sweep. Webhooks are a *hint*, not the source of truth — polling still
  reconciles everything.
- When webhooks are enabled the hot-poll interval automatically relaxes ×4
  (an explicit `intervals.hotMs` in your config still wins).
- The server stays loopback-only, so GitHub needs a tunnel to reach it. Point
  the tunnel at the receiver path on loopback:

  ```bash
  # cloudflared
  cloudflared tunnel --url http://127.0.0.1:4400
  # then set the App's webhook URL to https://<tunnel-host>/api/webhooks/github

  # or smee.io (dev-grade)
  smee --url https://smee.io/<channel> --target http://127.0.0.1:4400/api/webhooks/github
  ```

  Enable the webhook in your App's settings (URL + the same secret) after the
  tunnel is up. Without ingress, simply leave `webhooks.enabled` false —
  everything works on polling alone.

---

## Security model

- **Loopback-only by design.** The server binds to `127.0.0.1` only and there is
  no configuration option to expose it publicly. Do not reverse-proxy it without
  adding authentication.
- **Same-origin guard on mutations.** Mutating endpoints (`PUT /api/config`,
  `POST /api/admin/restart`) reject cross-site requests with 403: a present
  `Sec-Fetch-Site` header must be `same-origin`/`none`, and a present `Origin`
  must be a localhost origin on the configured port. This blocks
  browser-mediated CSRF from random websites against the loopback service. The
  webhook path is exempt — it is authenticated by its HMAC signature instead.
- **Credential/network config is file-only.** `tokenSource`, `apiUrl`, `port`,
  `app`, `webhooks`, `ancestrySource`, and `deployUrlAllowlist` can never be
  written through
  `PUT /api/config` (the server rejects them with `400 { offendingKeys }`).
  Anything that could redirect your token or re-bind the service requires
  editing the config file on disk.
- **In-repo deploy URLs and `deployUrlAllowlist`.** Watched repos can carry a
  `.pr-dashboard.yml` that points `healthUrl` (and, in clone mode, `cloneUrl`)
  anywhere. If you don't
  fully control every watched repo, set `deployUrlAllowlist` to the hostnames
  you trust; non-matching in-repo deploy entries are dropped with a warning
  (instance-override config is exempt).
- **Bare clones in `data/clones/` contain full repository history — clone mode
  only.** With the default `ancestrySource: "api"` no clones are ever created
  (ancestry runs over the compare API) and this concern does not apply. With
  `ancestrySource: "clone"`, any repo configured under `deploy.<repo>` will
  have its full git history cloned locally — on private repos this means all
  commits, messages, and tree objects are stored on disk in `data/clones/`.
  Protect this directory accordingly; it is excluded from source control via
  `.gitignore`.
- **Token source.** The default `tokenSource: "gh"` reads the token from the `gh`
  CLI keyring and deliberately strips the `GITHUB_TOKEN` environment variable so
  a stale env var cannot shadow the fresh keyring credential. `tokenSource: "env"`
  reads `GITHUB_TOKEN` directly — ensure the environment is clean when using this
  mode (e.g. avoid exporting a stale token from a shell profile). `tokenSource:
  "app"` reads the App's PEM from `app.privateKeyPath`; installation tokens are
  cached in memory only and never logged or returned by any endpoint.

---

## License

[MIT](LICENSE) © 2026 Tony Stein.
