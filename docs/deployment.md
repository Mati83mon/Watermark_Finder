# Deployment

Three deployments: the Space (analysis), the Worker (API), the Pages project
(frontend). Deploy in that order — the Worker needs the Space URL, and the
frontend needs the Worker URL.

Everything on Cloudflare stays inside free allowances and needs no payment
method. The Space is the one component with a plan rule attached; ["Hardware and
the free tier"](#hardware-and-the-free-tier) below states it exactly, along with
the options — including a browser-only deployment that removes the server from
the picture entirely.

## Live environment

| Component | URL | State |
| --- | --- | --- |
| Frontend (Pages) | https://watermark-finder.pages.dev | deployed |
| API (Worker) | https://watermark-finder-api.pennypicher-api.workers.dev | deployed, cron `*/5 * * * *` active |
| Engine (Space) | https://mati83moni-text-provenance-lab.hf.space | deployed, running |

All three are live and `/api/health` reports `"status": "ok"`. Verified end to
end in production: a document carrying a `wm:PROD-TEST-2026` payload in Unicode
tag characters came back as `payload_recovered` with the message decoded intact,
and the source text round-tripped through R2 byte for byte.

### Hardware and the free tier

Hugging Face states the rule plainly:

> Static Spaces are free for everyone, but hosting Gradio and Docker Spaces on
> free cpu-basic requires a PRO subscription.

The restriction covers **downgrading**, not just creating. The Space settings
page offers `CPU basic · 2 vCPU · 16 GB · FREE` as a selectable option, but the
API rejects it on an account without PRO:

```console
$ curl -X POST -H "authorization: Bearer $HF_TOKEN" \
    -d '{"flavor":"cpu-basic"}' \
    https://huggingface.co/api/spaces/<owner>/<space>/hardware

{"error":"Without a PRO subscription, you can't downgrade this Space to
cpu-basic. Pause it instead to stop hardware charges, or subscribe."}
```

The Space is unaffected by a rejected request - it stays `RUNNING` on its
current hardware - so this is safe to try before committing to a plan.

The deployed engine runs on `cpu-basic`, which carries no hourly cost.

Nothing in this code needs more than that. Measured on the deployed code:

```
RSS after boot              49.3 MB      # 16 GB tier is ~330x this
RSS peak, 52 kB document    52.7 MB
forensic, 1.4 kB             8.2 ms      # uvicorn --workers 1, so 2 vCPU is ample
forensic, 52 kB            321   ms
```

No torch, no transformers - both are commented out in `requirements.txt`, and
`distilgpt2` appears in the Space metadata only because the disabled perplexity
module names it. The runtime is FastAPI plus scikit-learn. `Dockerfile` has
targeted `cpu-basic` from the first commit: anything larger is a consequence of
Hugging Face's plan rules, not of anything this code needs.

The options for your own deployment:

| Option | Cost | Note |
| --- | --- | --- |
| PRO account | monthly fee | Unlocks free `cpu-basic`, which is ample — no hourly charge after that |
| Paid hardware | hourly while awake | Sleep is not billed; a shorter sleep timer cuts idle cost at the price of more cold starts |
| [Browser build](../space-static/) on a static Space | free on any account | No server, so nothing to bill. Loses C2PA and PDF/DOCX extraction — see its README |
| Host the engine elsewhere | free tiers exist | Only `ANALYSIS_SPACE_URL` changes; nothing else moves |

A cold start is not a failure case: the Worker retries a stalled job on a
five-minute cron until `MAX_ATTEMPTS`, and `/api/health` treats a 503 from a
sleeping Space as "dependency asleep" rather than an outage.

The rest of the stack (Pages, Workers, D1, KV, R2) remains entirely within free
allowances.

---

## 1. Analysis Space (Hugging Face)

### Create it

1. <https://huggingface.co/new-space>
2. Owner: `Mati83moni` · Name: `text-provenance-lab` · SDK: **Docker** ·
   Visibility: your choice.

Hardware: see ["Hardware and the free tier"](#hardware-and-the-free-tier) above -
free `cpu-basic` requires PRO for a Docker Space, so the choice is an account
with PRO, paid hardware, or the browser build.

The name matters: the Worker is already configured for
`https://mati83moni-text-provenance-lab.hf.space`, which is the host Hugging Face
derives from `<owner>-<space>`. A different name means updating
`ANALYSIS_SPACE_URL` in `worker/wrangler.toml` and redeploying.

### Configure

Settings → Variables and secrets:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TPL_API_TOKEN` | `openssl rand -base64 32` — keep it; the Worker needs the same value |
| Variable | `TPL_CORS_ORIGINS` | Your Pages domain, or leave unset while testing |

The secret's **name is the environment variable name** the engine reads. A
secret under any other name is invisible to the application, `TPL_API_TOKEN`
stays empty, and the engine serves `/analyze` to anyone who knows the URL.

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
curl https://mati83moni-text-provenance-lab.hf.space/health
# {"status":"ok","version":"1.0.0","schema_version":"1.0"}
```

`README.md` front matter drives the Space configuration, and Hugging Face
rejects a commit whose `short_description` exceeds 60 characters.

The first build takes several minutes. A free Space sleeps after ~48 h idle and
takes 30–60 s to wake; the Worker retries with backoff and the UI says so.

---

## 2. Worker API (Cloudflare)

### Create the resources

**Already provisioned** on the project's Cloudflare account, with their ids
committed in `worker/wrangler.toml`:

| Resource | Name | Id |
| --- | --- | --- |
| D1 | `watermark-finder` | `f18e189b-5f0b-4224-ae12-cc75e3f66217` (WEUR) |
| KV | `watermark-finder-cache` | `9e96038b407648e6be442c34b8c6468f` |
| R2 | `watermark-finder` | *(addressed by name)* |

The `0001_init.sql` migration has been applied to the remote database and
recorded in `d1_migrations`, so `wrangler d1 migrations apply` is a no-op rather
than a re-run.

To provision a fresh set from scratch instead:

```bash
npm install
cd worker
npx wrangler login

npx wrangler d1 create watermark-finder
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create watermark-finder
```

Each command prints an id; paste them into `wrangler.toml`. Repeat with
`-preview` names for `[env.preview]`, which is still unprovisioned.

Either way, set `ANALYSIS_SPACE_URL` to your Space URL (no trailing slash)
before deploying.

### Secrets

Both are **already set** on the deployed Worker. `ANALYSIS_SPACE_TOKEN` was
generated when the Worker was deployed and must be mirrored onto the Space as
`TPL_API_TOKEN`; until the two match, the engine will reject the Worker with 401.

To set or rotate them:

```bash
npx wrangler secret put ANALYSIS_SPACE_TOKEN   # must equal TPL_API_TOKEN on the Space
npx wrangler secret put SESSION_SECRET         # openssl rand -base64 32
```

`SESSION_SECRET` signs workspace tokens. Without it the Worker falls back to a
known development key and `/api/health` reports the degraded state in `warnings`.
Rotating it invalidates every existing workspace token; browsers recover by
minting a new workspace, but their history becomes unreachable.

### Migrate and deploy

```bash
npx wrangler d1 migrations apply watermark-finder --remote   # no-op if already applied
npx wrangler deploy
```

### Verify

```bash
curl https://watermark-finder-api.pennypicher-api.workers.dev/api/health
```

`"status":"ok"` means the Worker reached both D1 and the Space. `"degraded"` with
`"engine":"unreachable"` usually means the Space is asleep — call it once
directly and try again.

### CORS

`ALLOWED_ORIGINS` is set to `https://watermark-finder.pages.dev` and verified: a preflight from that origin
is answered, and a request from any other origin gets no
`access-control-allow-origin` header at all.

Pages preview deployments get random subdomains (`<hash>.watermark-finder.pages.dev`)
which are therefore blocked by design. Add them explicitly if you want previews to
reach the production API.

---

## 3. Frontend (Cloudflare Pages)

### Via the dashboard

Workers & Pages → Create → Pages → Connect to Git:

The project `watermark-finder` already exists (production branch `main`). To
connect it to Git for automatic builds:

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build --workspace @wf/web` |
| Build output directory | `web/out` |
| Root directory | *(repository root)* |
| Environment variable | `NEXT_PUBLIC_API_BASE_URL` = `https://watermark-finder-api.pennypicher-api.workers.dev` |

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

All four are set under **Settings → Secrets and variables → Actions**. If any of
them is missing the workflow skips both deploy jobs and writes the reason into
the run summary instead of failing:

```
### Deployment skipped

This repository is not configured to deploy to Cloudflare. Missing:

- `secret CLOUDFLARE_API_TOKEN`
- `secret CLOUDFLARE_ACCOUNT_ID`
```

That is deliberate. A fork has no Cloudflare account to deploy into, and a red X
on a fork whose code is fine is worse than no signal at all. `deploy-space.yml`
behaves the same way when `HF_TOKEN` or `HF_SPACE_ID` is absent. The `CI`
workflow is unconditional, so tests, typechecks and builds still run on every
push regardless of credentials.

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
