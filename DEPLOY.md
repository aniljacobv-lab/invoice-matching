# Deploying Invoice Matching

This deploys as a single always-on web service on Render. The API serves both the React UI and the `/api/*` endpoints in one process — one URL, no separate frontend host.

## One-time setup

1. **Create the GitHub repo.** Go to https://github.com/new, name it `invoice-matching`, leave it empty (no README/license/.gitignore), create.

2. **Push this folder.** Open Command Prompt in `C:\Users\anilj\invoice-matching` and run:

       setup-git.bat https://github.com/<your-username>/invoice-matching.git

3. **Connect Render.** Go to https://dashboard.render.com/blueprints, pick the `invoice-matching` repo, click Apply. Render reads `render.yaml` and provisions the Web Service automatically. First build takes ~5 minutes.

## Daily use

       push.bat "what you changed"

Render auto-redeploys in 2–3 minutes.

## Notes

- Free tier sleeps after ~15 min of no traffic; first hit cold-starts in ~30s.
- Data is in-memory (seeds from `api/data/*.json` on every restart). For persistence, swap the memory store for Postgres + the schema in `api/db/schema.sql`.

## AI features

Set `ANTHROPIC_API_KEY` in the Render Environment tab (or a local `.env` — the server
hot-reloads it, no restart needed) to enable four AI capabilities:

| Capability | Endpoint | What it does |
|---|---|---|
| Fuzzy matching | `POST /api/ai/fuzzy-match/:invoiceNum` | Proposes an ASN/PO for an invoice exact-key matching missed, with confidence and reasoning |
| Exception triage | `POST /api/ai/triage` | Ranks the queue by recoverable dollars, names root causes and systemic themes |
| Natural-language query | `POST /api/ai/query` | "PepsiCo invoices over $2k with no ASN" → structured filter → real rows |
| Line alignment | `POST /api/ai/align/:invoiceNum` | Aligns invoice lines to shipped lines when UPCs don't join, enabling line-level variance |

Supporting endpoints: `GET /api/ai/status` (availability, model, token usage, cache
stats) and `GET /api/ai/candidates/:invoiceNum` (the deterministic prescreen on its
own — no model call, no key required).

Tunables live in `api/config/app.config.json` under `ai`, overridable with the
`ANTHROPIC_MODEL`, `AI_ENABLED` and `AI_ROUTES` env vars.

### Multiple AI platforms

Six platforms are supported behind one interface. Set credentials for whichever
you use — anything unconfigured is skipped, so the same image runs everywhere.

| Platform | Credentials | Extra package |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | none (built in) |
| `bedrock` | AWS credential chain + `AWS_REGION` | `npm run add:bedrock` |
| `vertex` | `GOOGLE_CLOUD_PROJECT` + ADC | `npm run add:vertex` |
| `openai` | `OPENAI_API_KEY` | `npm run add:openai` |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `_ENDPOINT`, `_DEPLOYMENT` | `npm run add:openai` |
| `google` | `GOOGLE_API_KEY` | `npm run add:google` |

Bedrock and Vertex serve Claude inside your own AWS or GCP tenancy, which is
usually what enterprise data-residency and procurement review actually require.
They need no prompt or schema changes.

The extra packages are deliberately **not** in `dependencies` — an
Anthropic-only deployment installs nothing additional and the Docker image stays
small. A missing package is reported as "not installed" with the install command,
never as a crash.

### Routing and failover

Each capability routes independently, with an ordered fallback chain:

```json
"routes": {
  "fuzzy-match": ["anthropic:claude-opus-5", "anthropic:claude-sonnet-5"],
  "triage":      ["anthropic:claude-sonnet-5", "openai:gpt-5-mini"],
  "nl-query":    ["anthropic:claude-haiku-4-5", "anthropic:claude-sonnet-5"],
  "line-align":  ["anthropic:claude-sonnet-5", "openai:gpt-5-mini"]
}
```

The economics differ per capability, which is why they are separated. `fuzzy-match`
is low-volume and high-stakes — a wrong match is a duplicate payment — so it gets
the strongest model. `triage` runs across ~1,300 exceptions and is where cost
actually accumulates, and a human reads every line before acting, so a cheaper
model is defensible. `nl-query` is interactive and only emits a small filter object
that ordinary code then executes.

Override without rebuilding via `AI_ROUTES`:

```
AI_ROUTES={"triage":["openai:gpt-5-mini","google:gemini-2.5-flash"]}
```

Failover triggers on transport errors only — rate limits, timeouts, 5xx. A schema
violation does **not** fail over, because the same request will fail identically
elsewhere and retrying would burn money hiding a prompt bug. `GET /api/ai/status`
reports per-platform availability, per-capability routing, and a failover count.

### Guarantees

- **AI never posts money.** Every model output is a proposal carrying a confidence and
  a stated reason. Closing an exception still goes through
  `POST /match/v1/exceptions/:id/close` with a named human resolver.
- **Without a key the app degrades, it does not break.** AI endpoints return
  `{ available: false, reason }`, the UI hides the panels, and deterministic matching
  is completely unaffected — it never calls a model on any code path.
- **Deterministic first, AI on the remainder.** Every feature runs a cheap indexed
  pass before spending a token: the fuzzy matcher shortlists ~12 candidates out of
  1,862, and line alignment only sends the model lines that failed the UPC join.
- **Model output is validated.** Replies come back through a forced tool call against
  a JSON schema, and any document id the model returns is checked against the ids it
  was actually given, so a hallucinated reference is dropped rather than shown to AP.

### Cost control

Responses are cached in-process by content signature for `ai.cacheTtlMinutes`
(default 60). `GET /api/ai/status` reports cumulative token usage and cache hits;
`POST /api/ai/cache/clear` empties it.
