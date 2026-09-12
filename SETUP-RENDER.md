# Going live: northhallbbq.com on Render

Domain is registered (Cloudflare, 12 Sept 2026) and already on Cloudflare's
nameservers, which makes the DNS part easy.

Work through this in order. Budget 20 minutes.

---

## 1. Push the repo (if you haven't)

See `PUSH.md`. Render deploys from GitHub, so the code has to be there first.

## 2. Create the service

1. <https://dashboard.render.com> → **New** → **Blueprint**
2. Connect the `jjbales/northhallbbq` repo
3. Render reads `render.yaml` and proposes: a Docker web service on the
   **Starter** plan with a **1 GB disk mounted at `/data`**. That disk is the
   whole ballgame — it's where orders live. Confirm it's there before you
   click create.
4. It will ask for `ADMIN_PASSWORD` because the blueprint deliberately doesn't
   contain one. **Pick something real.** This password is the only thing
   between the internet and your customer list.

First build takes ~5 minutes (it compiles the SQLite native module).

You'll get a URL like `north-hall-bbq.onrender.com`. Load it and click
through an order before touching DNS — easier to debug on the Render URL than
through Cloudflare.

## 3. Point the domain

**In Render:** service → **Settings** → **Custom Domains** → add
`northhallbbq.com`. Render automatically adds `www.northhallbbq.com` and
redirects between them. It'll show you the DNS target.

**In Cloudflare:** DNS → Records → add:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` | `north-hall-bbq.onrender.com` | **DNS only (grey cloud)** |
| CNAME | `www` | `north-hall-bbq.onrender.com` | **DNS only (grey cloud)** |

Cloudflare flattens a CNAME at the root automatically, so `@` works — you
don't need an A record.

**Grey cloud, not orange.** Two reasons, and both bite people:

- Render can't verify the domain or issue its TLS certificate while Cloudflare
  is proxying and answering for it.
- If you proxy with Cloudflare's SSL mode set to **Flexible**, you get an
  infinite redirect loop — Cloudflare talks HTTP to Render, Render redirects
  to HTTPS, forever. The page just never loads.

If you later want Cloudflare's proxy (caching, DDoS), turn the cloud orange
only *after* Render shows the certificate as issued, and set SSL/TLS mode to
**Full (strict)** in the same visit. For a site this size you don't need it.

Back in Render, click **Verify**. Certificate issues in a few minutes.

## 4. Optional: keep the old address working

If you've handed anyone `bbq.jasonbales.com`, add the same CNAME on
jasonbales.com and add that hostname in Render's Custom Domains too. Costs
nothing and means no one hits a dead link.

## 5. Before you take money

- [ ] `ADMIN_PASSWORD` is not `smoke`
- [ ] `https://northhallbbq.com` loads with a padlock
- [ ] Place a test order end to end, then cancel it in the admin
- [ ] Settings → paste your **Cheddar Up collection link** (still outstanding)
- [ ] Set pickup windows on your first real cook date
- [ ] Download the orders CSV once so you know where the button is

## 6. Back up the database

Render's disk is persistent, not backed up. One command from your Mac, once a
month or after a big cook:

```bash
# Render dashboard -> your service -> Shell
cat /data/bbq.db > /tmp/backup.db
```

Or simpler: hit the **Download all orders (CSV)** button in Settings and keep
the file. It's not a full backup, but if the worst happened you'd still have
every name, phone number and order.

---

## What it costs

| | |
|---|---|
| Render Starter | $7.00/mo |
| 1 GB disk | $0.25/mo |
| Domain | ~$10/yr |
| **Year one** | **~$97** |

Two butts.
