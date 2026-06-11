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
- Set `ANTHROPIC_API_KEY` in the Render Environment tab to enable AI-assisted invoice matching (proposed code matching, exception reasoning).
