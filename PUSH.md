# Getting this into GitHub (jjbales)

The project is already a git repository with its history committed — you're
not starting from an empty folder. Two steps.

## 1. Make an empty repo on GitHub

Go to <https://github.com/new>

- **Owner:** jjbales
- **Repository name:** `north-hall-bbq`
- **Private** (recommended — nothing secret is in the code, but there's no
  reason for your customer list logic to be public either)
- **Do NOT** tick "Add a README", "Add .gitignore" or "Choose a license".
  Leave it completely empty, or the first push will be rejected for having
  unrelated history.

## 2. Push from your Mac

Unzip this project somewhere sensible (`~/Projects/north-hall-bbq` is fine),
open Terminal in that folder, and run:

```bash
git remote add origin https://github.com/jjbales/north-hall-bbq.git
git branch -M main
git push -u origin main
```

If it asks for a password, don't type your GitHub account password — GitHub
stopped accepting those. Either install the GitHub CLI and run `gh auth login`
once, or create a personal access token at
<https://github.com/settings/tokens> and paste that as the password.

## What's in the repo, and what deliberately isn't

**In:** all the app code, the brand artwork and the script that generates it,
the Dockerfile and render.yaml for deploying, and the docs.

**Out, on purpose:**

- `data/` — the SQLite database with real customer orders. Never commit that.
- `.env` — your admin password and any Stripe keys. Never commit that either.
- `node_modules/` — rebuilt by `npm install`.

`.gitignore` already enforces all three, so you can't fat-finger it later.

## After it's pushed

Connect the repo to Fly or Render and every `git push` redeploys the site.
`DEPLOY.md` has the rest.
