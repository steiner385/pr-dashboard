# Embedding pr-dashboard in the KinDash admin SPA — host integration guide

> ## ⚠️ ARCHITECTURE SUPERSEDED — read this first
> The **"separate service + proxy"** model described below is **obsolete**. The
> corrected architecture (per the project owner): pr-dashboard is **source-only**
> and the host hosts **both tiers in-process** — there is **no separate
> pr-dashboard service and no cross-service proxy**.
> - **Backend:** mount `createPrDashboardBackend()` from **`pr-dashboard/server`** in
>   your own Express server (`app.use('/bff/ops/prdash', requireAdminSession, router)`)
>   and run `startPoller()` in-process. Your auth gates it (`trustHostAuth` default true,
>   no shared secret). SQLite lives on your `dataDir` volume (single instance).
> - **Frontend:** mount `<PrDashboard apiBase="/bff/ops/prdash/api" .../>` from `pr-dashboard/embed`.
>
> See the **README "Embedding pr-dashboard in a host app"** section and the
> coordination channel (`/home/tony/.config/kindash/coordination/pr-dashboard-integration.md`,
> DECISIONS D1–D4) for the current contract. The frontend/routing/styling/SSR notes
> below remain valid; **ignore every "proxy", "separate service", "allowedOriginHosts",
> and "bindHosts" instruction** — those are the old model. (Full rewrite of this file is a follow-up.)

---

This is the handoff for the host (`admin.kindash.com`) team consuming the
`pr-dashboard/embed` component. It covers the package API, the routing
integration (read the **Routing** section carefully — it has a real nested-router
gotcha), the backend/proxy contract you must provision, styling, and the
host-vs-embed ownership split.

pr-dashboard stays a **separate, independently-deployed service**. You embed only
its UI; its backend is reached through a proxy you control.

---

## 1. Install & consume

The package is `private`, built on install via a `prepare` script, so a git
dependency works:

```jsonc
// host package.json
"dependencies": {
  "pr-dashboard": "github:steiner385/pr-dashboard#<commit-sha>"
}
```

- **React 19 is a peer dependency.** The host provides the single React instance.
  Ensure your bundler **dedupes React** — a second React copy makes the embed's
  contexts resolve to the wrong instance (symptoms: a blank panel, or
  `useSectionRoute must be used within a RouterProvider` thrown at runtime).
- `prepare` runs `vite build` on install to produce `dist/embed/*`; your CI needs
  the dev toolchain available at install time (standard for git deps).

```tsx
import { PrDashboard } from 'pr-dashboard/embed';
import 'pr-dashboard/embed/style.css';
```

---

## 2. Component API

```ts
interface PrDashboardProps {
  apiBase?: string;        // default '/api' — your proxy root for ALL data + SSE
  basename?: string;       // default ''    — URL prefix the embed lives under
  routerMode?: 'path' | 'hash';  // default 'path'
  focusedRepo?: string;    // optional controlled repo; omit for the in-content switcher
  onFocusChange?: (repo: string) => void;
  className?: string;      // appended to the .prdash-root wrapper
  withCredentials?: boolean; // default false — SSE cookie mode only (see §5)
}
```

Minimal mount:

```tsx
<PrDashboard apiBase="/api/ci" basename="/console/ci" />
```

The five sections (URL segment after `basename`): `health` (default),
`pipeline`, `diagnose`, `model-edit`, `insights`. Retired aliases still resolve:
`metrics`/`tune` → `insights`; `model`/`optimize`/`build` → `model-edit`.

---

## 3. What the embed renders vs. what the host owns

The embed is **content-only**. It renders:
- A compact in-content **StatusStrip**: pipeline (repo) switcher, the
  live/stale/reconnecting indicator, an ingestion self-health dot, and a `?` that
  opens the Legend (the glyph/color decoder).
- The active **section view**.

It deliberately does **not** render — **the host must own these**:
- The page **chrome**: outer header, the page `h1`, and the **`<main>` landmark**.
  The embed emits **no** `banner`/`navigation`/`main` landmark and its section
  headings start at `<h2>` — so your page should provide the `h1` and the `<main>`
  wrapper for a correct accessibility tree.
- **Section navigation** (see §4) — there is no nav rail.
- **Auth** (see §5).
- **Settings** and the **⌘K command palette** are intentionally absent when
  embedded (no global keybinding to collide with your command bar). If operators
  need pr-dashboard settings, use the standalone app for that, or expose it
  through your own admin surface.

---

## 4. Routing integration — READ THIS (nested-router gotcha)

In `routerMode="path"` (the default), the embed derives the active section from
`location.pathname` (the first segment after `basename`) and:
- updates on the browser **`popstate`** event (back/forward), and
- on **in-content navigation** (e.g. a Health-lane chip) it calls
  `history.pushState` to `${basename}/${section}` and updates itself.

**The catch:** `history.pushState` does **not** fire `popstate`. So if your host
router navigates with `pushState` (every SPA router does), the embed will **not**
observe it, and vice-versa. Two History routers on the same path space don't see
each other's pushes. This is the classic nested-router problem, not a bug in the
embed.

**Recommended integration patterns (pick one):**

1. **Host drives sections, with a popstate bridge (recommended).**
   Let your nav update the URL to `${basename}/${section}`, then tell the embed to
   re-read it:
   ```ts
   function goToCiSection(section: string) {
     history.pushState({}, '', `/console/ci/${section}`);     // or your router's navigate()
     window.dispatchEvent(new PopStateEvent('popstate'));      // <-- wakes the embed
   }
   ```
   The synthetic `popstate` makes the embed re-derive `active` from the new path.
   (It also notifies your own router if it listens to popstate.)

2. **Give pr-dashboard a dedicated subtree and don't mirror its section in host
   state.** Mount it at `basename="/console/ci"`, route your shell to that page,
   and let the user switch sections via your nav using pattern (1). Don't try to
   keep a separate host-side "current CI section" — read it from the URL when you
   need it.

3. **If you need tight, bidirectional router integration** (host breadcrumbs that
   reflect in-content navigation, etc.), request the follow-up enhancement below.

**Follow-up enhancement worth requesting if (1)/(2) aren't enough:** a controlled
`section` prop + `onSectionChange` callback on `<PrDashboard>` (currently a
deliberate non-goal). That would let your router fully own section state and the
embed become a controlled component. It's a small addition to the existing
`RouterProvider`; ask the pr-dashboard team if your UX needs it.

`routerMode="hash"` is also available (the embed reads/writes `location.hash`),
which **won't collide** with a host *path* router — but it will collide with a
host *hash* router. Path mode is the default for exactly this reason.

---

## 5. Auth, proxy, and the backend contract (operational — required)

**Auth is the host's job.** The embed never shows a login UI; it just calls
`apiBase`. Point `apiBase` at a proxy you control that injects credentials when
forwarding to the pr-dashboard backend.

The pr-dashboard backend was built for a loopback/Tailscale trust model, so the
embedded topology requires **backend config + a proxy contract** (no backend code
change). You must provision:

1. **Origin allow-listing.** The backend's `originGuard` 403s any mutating request
   whose `Origin` host isn't trusted. The embed *does* issue mutations
   (mark-ready-to-merge, draft-PR levers). So either:
   - add your host origin to the backend's `allowedOriginHosts`
     (e.g. `allowedOriginHosts: ['admin.kindash.com']`), **or**
   - strip the `Origin` header at the proxy (a header-less request is allowed).
2. **Reachable bind.** The backend defaults to `bindHosts: ['127.0.0.1']`
   (loopback only). Co-locate the proxy or add a private/Tailscale bind address it
   can reach. Any non-loopback bind you add is automatically trusted by
   `originGuard`.
3. **Path allow-list — deny `/admin/*`.** `apiBase` proxies the whole `/api`
   namespace. `POST /api/.../admin/restart` calls `process.exit(1)` (it's how the
   standalone forces a systemd restart). **Do not expose `/admin/*` through the
   host proxy.** Also decide deliberately whether `GET /api/.../config` (returns
   the resolved config, incl. owners/bind hosts) and the write levers should be
   reachable by host-authed users.
4. **SSE through the proxy.** `GET /api/.../events` is a long-lived
   `text/event-stream`. The backend already sends `X-Accel-Buffering: no`, but
   confirm the proxy **does not buffer** and its read timeout exceeds the 25 s
   server keep-alive ping.

**Credentials on the SSE.** Native `EventSource` cannot set headers. So:
- Preferred: the proxy injects credentials **server-side** when it forwards the
  SSE — then leave `withCredentials={false}`.
- Cookie fallback: set `withCredentials` to send cookies on the SSE, **same-origin
  proxy required**. ⚠️ **`withCredentials` is SSE-only** — it does **not** make the
  embed's `fetch` mutations send cookies. Fetch-path auth must come from the proxy
  (same-origin or server-side injection), not browser cookies.

**Example nginx (illustrative):**
```nginx
# Embed calls apiBase="/api/ci"; rewrite to the backend's /api/* .
location /api/ci/admin/ { return 403; }          # never expose admin
location /api/ci/ {
    auth_request /your-auth;                      # host injects/validates creds here
    proxy_pass http://pr-dashboard-backend/api/;  # strip the /ci prefix
    # proxy_set_header Origin "";                 # OR add admin.kindash.com to allowedOriginHosts
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;                          # SSE must not buffer
    proxy_read_timeout 1h;                        # outlast the 25s SSE ping
}
```
The embed is **fail-closed by default**: until you allow-list the origin, all
mutations 403 — only GETs work. That's deliberate.

---

## 6. Styling & theming

- Import `pr-dashboard/embed/style.css` once. Every rule is scoped under
  `.prdash-root` (the embed's wrapper div), so **nothing leaks** into your page and
  the embed sets **no** `body`/`html` styles.
- The embed's design tokens are CSS custom properties defined on `.prdash-root`
  (remapped from `:root` at build time, including the dark-mode block). To theme,
  override those variables on `.prdash-root` (or a wrapping selector). The embed
  inherits your page **font** by default (it sets no `font-family` on the body).
- Pass `className` to add your own wrapper class for layout (sizing/positioning the
  embed within your page).

---

## 7. React / SSR / multi-instance constraints

- **Client-only.** The providers read `window`/`location` at init. If your shell
  SSRs, render `<PrDashboard>` **client-side only** (e.g. dynamic import with SSR
  disabled).
- **Single React 19 instance**, deduped (see §1).
- **Multi-instance / multi-tenant:** one `<PrDashboard apiBase=...>` maps to one
  backend. If you need to show CI for multiple tenants, run one pr-dashboard
  backend per tenant and mount one embed each with its own `apiBase`. The backend
  is single-tenant (one owners list, one SQLite).

---

## 8. Quick checklist for the host team

- [ ] Add pr-dashboard as a git dep; confirm React is deduped to a single v19.
- [ ] Mount `<PrDashboard apiBase="/api/ci" basename="/console/ci" />`,
      client-side only, inside your `<main>` with your own `h1`.
- [ ] Provide section nav using the **popstate bridge** (§4 pattern 1).
- [ ] Stand up the proxy: origin allow-list (or strip Origin), reachable bind,
      **deny `/api/.../admin/*`**, SSE no-buffering + long read timeout,
      credential injection.
- [ ] Decide the SSE credential model (server-side inject vs. `withCredentials`).
- [ ] (Optional) Request a controlled `section`/`onSectionChange` prop if you need
      bidirectional router integration.
