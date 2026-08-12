# Cloudflare Pages configuration

The frontend is a **static export** (`output: 'export'` in `web/next.config.mjs`),
so Pages serves plain files. There is no `@cloudflare/next-on-pages` adapter and
no edge runtime to configure.

## Build settings

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm ci && npm run build --workspace @wf/web` |
| Build output directory | `web/out` |
| Root directory | *(repository root)* |
| Node version | 20 |

## Environment variables

| Name | Scope | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Production | Your Worker URL, no trailing slash |
| `NEXT_PUBLIC_API_BASE_URL` | Preview | Your preview Worker URL |

This is inlined at build time. Changing it requires a rebuild — the Settings page
can override it per browser, which is enough for local testing against a
production build.

## Routing

`trailingSlash: true` is set, so every route is a directory with an `index.html`
and Pages serves it without any redirect rules. The analysis result page is
`/analysis/result/?id=<id>` — a query parameter rather than a dynamic segment,
because a static export cannot pre-render an unbounded set of ids.

## Headers

Optional `web/public/_headers`, applied by Pages automatically:

```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
```

A `Content-Security-Policy` is deliberately not set here: the page must be able
to `connect-src` to whichever Worker URL is configured, including one entered at
runtime on the Settings page, so a static policy would either be too loose to
help or would break that feature.

## Custom domain

Add it under the Pages project, then add the same origin to `ALLOWED_ORIGINS` in
`worker/wrangler.toml` and redeploy the Worker — otherwise the browser's
preflight fails.
