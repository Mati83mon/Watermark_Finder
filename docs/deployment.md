# Deployment

Three deployments, all on free tiers: the Space (analysis), the Worker (API), the
Pages project (frontend). Deploy in that order — the Worker needs the Space URL,
and the frontend needs the Worker URL.

Total cost: nothing. No payment method is required for any of the three.

---

## 1. Analysis Space (Hugging Face)

### Create it

1. <https://huggingface.co/new-space>
2. Name: `text-provenance-lab` · SDK: **Docker** · Hardware: **CPU basic (free)**
   · Visibility: your choice.

### Configure

Settings → Variables and secrets:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TPL_API_TOKEN` | `openssl rand -base64 32` — keep it; the Worker needs the same value |
| Variable | `TPL_CORS_ORIGINS` | Your Pages domain, or leave unset while testing |

Optional: `TPL_ENABLE_PERPLEXITY=1` also requires uncommenting `torch` and
`transformers` in `analysis-space/requirements.txt`. It adds ~700 MB to the image
and noticeably slows cold starts; leave it off unless you want that signal.

### Publish

Automatic, via `.github/workflows/deploy-space.yml`. Set in the GitHub repo:

- Secret `HF_TOKEN` — a Hugging Face **write** token
- Variable `HF_SPACE_ID` — e.g. `your-username/text-provenance-lab`
- Variable `SPACE_URL` — e.g. `https://your-username-text-provenance-lab.hf.space`

Or manually:

```bash
pip install "huggingface_hub[cli]"
huggingface-cli login
huggingface-cli upload your-username/text-provenance-lab analysis-space . \
  --repo-type space --delete "*"
```

### Verify

```bash
curl https://your-username-text-provenance-lab.hf.space/health
# {"status":"ok","version":"1.0.0","schema_version":"1.0"}
```

The first build takes several minutes. A free Space sleeps after ~48 h idle and
takes 30–60 s to wake; the Worker retries with backoff and the UI says so.

---

## 2. Worker API (Cloudflare)

### Create the resources

```bash
npm install
cd worker
npx wrangler login

npx wrangler d1 create watermark-finder
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create watermark-finder
```

Each command prints an id. Put them in `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID`, and set
`ANALYSIS_SPACE_URL` to your Space URL (no trailing slash).

Repeat with `-preview` names for `[env.preview]` if you want an isolated preview
environment.

### Secrets

```bash
npx wrangler secret put ANALYSIS_SPACE_TOKEN   # the TPL_API_TOKEN from step 1
npx wrangler secret put SESSION_SECRET         # openssl rand -base64 32
```

`SESSION_SECRET` signs workspace tokens. Without it the Worker falls back to a
known development key and `/api/health` reports the degraded state in `warnings`.
Rotating it invalidates every existing workspace token; browsers recover by
minting a new workspace, but their history becomes unreachable.

### Migrate and deploy

```bash
npx wrangler d1 migrations apply watermark-finder --remote
npx wrangler deploy
```

### Verify

```bash
curl https://watermark-finder-api.<subdomain>.workers.dev/api/health
```

`"status":"ok"` means the Worker reached both D1 and the Space. `"degraded"` with
`"engine":"unreachable"` usually means the Space is asleep — call it once
directly and try again.

### Set CORS

Set `ALLOWED_ORIGINS` in `wrangler.toml` to your Pages domain once step 3 gives
you one, then redeploy. Leaving it as `*` lets any site call your Worker and
spend your free-tier budget.

---

## 3. Frontend (Cloudflare Pages)

### Via the dashboard

Workers & Pages → Create → Pages → Connect to Git:

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build --workspace @wf/web` |
| Build output directory | `web/out` |
| Root directory | *(repository root)* |
| Environment variable | `NEXT_PUBLIC_API_BASE_URL` = your Worker URL |

`NEXT_PUBLIC_API_BASE_URL` is baked in at build time; changing it needs a
rebuild. The Settings page can override it per browser, which is handy for
pointing a production build at a local Worker.

### Via GitHub Actions

`.github/workflows/deploy-worker-pages.yml` deploys both. Set:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Token with Workers Scripts, D1, KV, R2 and Pages edit permissions |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | From the Cloudflare dashboard sidebar |
| Variable | `API_BASE_URL` | Deployed Worker URL |
| Variable | `PAGES_PROJECT` | Pages project name |

The workflow applies D1 migrations, deploys the Worker, smoke-tests
`/api/health`, then builds and uploads the site.

---

## Local development

```bash
# Terminal 1 - engine
cd analysis-space
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app:app --reload --port 7860

# Terminal 2 - Worker
cd worker
npx wrangler d1 migrations apply watermark-finder --local
npx wrangler dev            # http://127.0.0.1:8787

# Terminal 3 - frontend
cd web
npm run dev                 # http://localhost:3000
```

`worker/.dev.vars` (git-ignored) supplies local secrets:

```
ANALYSIS_SPACE_URL = "http://127.0.0.1:7860"
ANALYSIS_SPACE_TOKEN = "local-dev-token"
SESSION_SECRET = "local-dev-session-secret"
```

`wrangler dev` uses local D1, KV and R2 by default — nothing touches production.

---

## Post-deploy checklist

- [ ] `GET /api/health` returns `"status":"ok"`
- [ ] `warnings` is empty (a non-empty one means `SESSION_SECRET` is unset)
- [ ] `ALLOWED_ORIGINS` names your Pages domain, not `*`
- [ ] An analysis of pasted text completes and shows a result
- [ ] A document with a planted payload is flagged — paste text containing tag
      characters and confirm `payload_recovered`
- [ ] `DAILY_ANALYSIS_LIMIT` is set to something you are willing to spend
- [ ] The cron trigger appears under the Worker's Triggers tab

## Rollback

```bash
# Worker: redeploy a previous commit
git checkout <sha> -- worker/ shared/ && npx wrangler deploy

# Pages: use "Rollback to this deployment" in the dashboard

# Space: revert the commit and let the workflow redeploy, or
huggingface-cli upload <space-id> analysis-space . --repo-type space --revision <sha>
```

Migrations are additive; rolling code back does not roll the schema back. If a
migration must be undone, write a new migration that reverses it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `engine_unavailable` on every analysis | Space asleep or `ANALYSIS_SPACE_URL` wrong | `curl <space>/health`; check for a trailing slash |
| `401` from the engine | Token mismatch | `ANALYSIS_SPACE_TOKEN` must equal `TPL_API_TOKEN` |
| Analyses stay `pending` | Cron trigger missing | Confirm `[triggers]` in `wrangler.toml` and redeploy |
| Browser CORS errors | Origin not allow-listed | Add the Pages domain to `ALLOWED_ORIGINS` |
| `429` immediately | Limits too tight for your use | Raise `RATE_LIMIT_REQUESTS` / `DAILY_ANALYSIS_LIMIT` |
| Frontend calls `127.0.0.1` in production | `NEXT_PUBLIC_API_BASE_URL` unset at build time | Set it and rebuild |
