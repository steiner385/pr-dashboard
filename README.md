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
immediately. History lives in `data/history.db`; bare clones for deploy ancestry
checks live in `data/clones/`.

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
| `owners` | `[]` | GitHub org/user logins whose PRs are shown. Empty → auto-derived from the token's `viewer.login`. |
| `exclude` | `[]` | Repo full names (`"org/repo"`) to skip entirely. |
| `port` | `4400` | HTTP port. Bound to `127.0.0.1` only (loopback-only by design — see Security). |
| `retentionDays` | `7` | How many days of check-run history to keep in `data/history.db`. |
| `batchSize` | `6` | Default merge-queue batch size used in queue-position arithmetic. |
| `tokenSource` | `"gh"` | Where the GitHub token comes from. `"gh"` reads the `gh` CLI keyring (strips `GITHUB_TOKEN`). `"env"` reads `GITHUB_TOKEN`. `"app"` mints GitHub App installation tokens (see [GitHub App mode](#github-app-mode-pnpm-appsetup)). |
| `app.appId` | — | **Required when `tokenSource` is `"app"`.** Numeric GitHub App id. File-only (never PUT-writable). |
| `app.privateKeyPath` | — | **Required when `tokenSource` is `"app"`.** Path to the App's RSA private key PEM. File-only. |
| `app.installationId` | auto-discovered | Installation to mint tokens for. Omit when the App has exactly one installation. File-only. |
| `webhooks.enabled` | `false` | Opt-in signed webhook receiver (see [Webhooks](#webhooks-optional)). File-only. |
| `webhooks.secretPath` | — | **Required when webhooks are enabled.** Path to the shared webhook secret file (written by `pnpm app:setup`). File-only. |
| `webhooks.path` | `"/api/webhooks/github"` | Route the receiver listens on. File-only. |
| `deployUrlAllowlist` | unset | Optional hostname allowlist for **in-repo** (`.pr-dashboard.yml`-sourced) deploy `healthUrl`/`cloneUrl`. Unset → in-repo URLs honored as-is. File-only. |
| `apiUrl` | `"https://api.github.com/graphql"` | GraphQL endpoint. Override for GitHub Enterprise (e.g. `"https://github.example.com/api/graphql"`). |
| `rateLimitFloor` | `1000` | Remaining rate-limit budget below which polling degrades to slow intervals. |
| `intervals.sweepMs` | `60000` | Full-sweep poll interval (ms). |
| `intervals.hotMs` | `15000` | Fast-poll interval when active PRs are in flight (ms). |
| `intervals.deployMs` | `30000` | Deploy-health-check interval (ms). |
| `deploy.<repo>` | `{}` | Deploy-tracking config keyed by `"owner/repo"`. Omit the key to disable deploy stages for that repo. |
| `deploy.<repo>.cloneUrl` | `"https://github.com/<repo>.git"` | Git URL for the bare clone used for ancestry checks. |
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
  cloneUrl: https://github.com/owner/repo.git   # default: GitHub URL of the repo
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
`cloneUrl` (which it clones) anywhere. That is acceptable for the single-user
self-hosted deployment — you control the repos you watch. If you watch repos
you don't fully control, set `deployUrlAllowlist` in `config.json`: when set,
in-repo deploy entries whose `healthUrl`/`cloneUrl` host is not on the list are
dropped with a logged warning. Instance-override deploy config (`deploy.<repo>`
in your own `config.json`) is exempt — the operator wrote it.

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
2. **Derived**: for repos with a deploy clone, the poller reads
   `.github/workflows/ci.yml` at startup (and re-derives every 24h) and walks
   the rollup job's `needs:` graph; each job in the closure contributes
   its display name as a prefix (reusable-workflow jobs get a ` /` suffix).
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
`node:crypto` only). When the App has exactly one installation the
`installationId` is auto-discovered; with multiple installations, startup fails
with a list of ids to pin via `app.installationId`.

### Limitations

**One installation per instance.** An installation token only sees the repos
of the account it is installed on — repos under any other owner in your
`owners` list are invisible to it: their sweep searches return nothing and
detail/blob fetches resolve to `repository: null` (the server keeps
last-known-good config for such repos and logs
`owner '<owner>' appears inaccessible to the current token` when an owner is
fully invisible). If you watch repos across multiple accounts, run **one
instance per account** — distinct `PRDASH_CONFIG` / `PRDASH_DATA_DIR` / port,
with the App installed on (and `app.installationId` pinned to) that account —
until multi-installation support lands
([#10](https://github.com/steiner385/pr-dashboard/issues/10)).

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
  `app`, `webhooks`, and `deployUrlAllowlist` can never be written through
  `PUT /api/config` (the server rejects them with `400 { offendingKeys }`).
  Anything that could redirect your token or re-bind the service requires
  editing the config file on disk.
- **In-repo deploy URLs and `deployUrlAllowlist`.** Watched repos can carry a
  `.pr-dashboard.yml` that points `healthUrl`/`cloneUrl` anywhere. If you don't
  fully control every watched repo, set `deployUrlAllowlist` to the hostnames
  you trust; non-matching in-repo deploy entries are dropped with a warning
  (instance-override config is exempt).
- **Bare clones in `data/clones/` contain full repository history.** Any repo
  configured under `deploy.<repo>` will have its full git history cloned locally.
  On private repos this means all commits, messages, and tree objects are stored on
  disk in `data/clones/`. Protect this directory accordingly; it is excluded from
  source control via `.gitignore`.
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
