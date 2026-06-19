# Releasing `plotroom`

Releases publish to npm **automatically** from GitHub Actions via **npm Trusted
Publishing (OIDC)** — no tokens, no secrets. Every published version carries a
[SLSA provenance](https://slsa.dev/) attestation linking it to the exact source
commit + workflow run.

Workflow: [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## Cut a release

1. **Bump the version** in `package.json` (semver) on a branch, and merge to `main`:
   ```bash
   git checkout -b chore/vX.Y.Z
   npm version X.Y.Z --no-git-tag-version   # edits package.json only
   git commit -am "chore: bump version to X.Y.Z"
   # open a PR, let CI pass, merge to main
   ```

2. **Cut a GitHub Release** whose tag matches that version (the workflow enforces
   `tag == package.json version`):
   ```bash
   gh release create vX.Y.Z --title vX.Y.Z --generate-notes --target main
   ```

3. Publishing the release triggers `publish.yml`, which: installs deps, builds
   both exports via the `prepare` script, verifies the tag matches
   `package.json`, then `npm publish --provenance --access public` over OIDC.

4. **Verify:**
   ```bash
   npm view plotroom version              # → X.Y.Z
   npm view plotroom@X.Y.Z dist.attestations   # → provenance present
   ```

## One-time setup (already done — for reference)

- **Trusted publisher** is configured on npmjs.com → `plotroom` → Settings →
  Trusted Publisher → GitHub Actions: org `steiner385`, repo `plotroom`, workflow
  `publish.yml` (no environment). This is what lets npm accept the OIDC publish.
- The **first version (`0.1.0`) was a one-time manual token publish** — npm OIDC
  cannot bootstrap a package name that doesn't exist yet
  ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). Every version since
  publishes tokenless.

## Re-running / manual publish

`publish.yml` also accepts a **manual `workflow_dispatch`** (Actions tab → Publish
to npm → Run workflow), which publishes whatever version is on `main`. Use it to
re-run after a transient failure — e.g. re-run the release's workflow once the
trusted publisher is armed, without cutting a new release.

## Troubleshooting

- **`E404 ... 'plotroom@X.Y.Z' ... you do not have permission`** at the publish
  step (provenance signing succeeded just before it): npm has no publish grant —
  the **trusted publisher isn't configured or doesn't match**. Confirm the
  org/repo/workflow-filename on npmjs.com exactly match this repo + `publish.yml`.
- **Tag/version mismatch**: the workflow fails fast if the release tag isn't
  `v<package.json version>`. Fix the tag or the version and re-release.
