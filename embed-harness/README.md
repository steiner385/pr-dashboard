# Embed harness (dev-only)

A minimal **host page** that mounts the real shipped `<PrDashboard>` embed
(`dist/embed/index.js` + the `.prdash-root`-scoped `dist/embed/style.css`) so you can
comb the embeddable build the way a consuming app (e.g. `admin.kindash.com`) sees it —
CSS scoping/isolation, `@container` breakpoints, the `apiBase`/`routerMode` wiring.

Not shipped (excluded from the package `files`). Run it against a live backend:

```bash
pnpm embed:harness          # builds the embed, then serves the harness on :4500
# point apiBase at a running daemon — vite proxies /api → http://localhost:4400
```

The host page has deliberately opinionated Georgia/magenta styles: the embed must
render correctly inside `.prdash-root` while leaving the host chrome untouched (and the
embed's design tokens must not leak onto the host `:root`). The CI "embed CSS is scoped"
gate enforces the same invariants headlessly on every build.
