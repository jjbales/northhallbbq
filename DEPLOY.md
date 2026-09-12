# Putting North Hall BBQ on the internet

## The thing to know first

**GitHub Pages cannot run this site.** Pages only serves static files — plain
HTML, CSS and images. This is a Node server with a database: it takes orders,
holds inventory, and writes to SQLite. It needs somewhere that runs Node and
keeps a disk.

GitHub is still the right place for the *code*. It just isn't the host.

## Where the orders live

Everything is one SQLite file at `data/bbq.db`. That matters when picking a
host: several of them wipe the filesystem on every deploy and every restart.
If you deploy to one of those, your orders disappear the next time you push a
change — not a hypothetical, it's the normal behaviour of free tiers.

So the requirement is: **a host with a persistent disk**, mounted at the path
in `DATA_DIR`. `render.yaml` in this repo already asks for one.

## Options, cheapest first

| Host | Cost | Persistent disk | Notes |
|---|---|---|---|
| **Render** | ~$7/mo | Yes, on paid plans | `render.yaml` is here, so it's close to one click. Free tier has no disk — don't use it for this. |
| **Fly.io** | ~$3-5/mo | Yes, volumes | Cheapest that's still easy. Uses the `Dockerfile`. |
| **Railway** | usage-based | Yes, volumes | Simple, but the bill moves around. |
| **A $5 VPS** | $5/mo | It's a real disk | Most control, most babysitting. You patch it. |

All four take the `Dockerfile` in this repo.

## Domain

You already own **jasonbales.com**, so the free option is a subdomain:

    bbq.jasonbales.com   ->  CNAME  ->  your-app.onrender.com

That costs nothing, works today, and looks fine on a flyer.

A separate name like `northhallbbq.com` runs about $10-12/year. Buy it from a
registrar that sells at cost and doesn't play renewal games — Cloudflare
Registrar is the usual recommendation; Porkbun and Namecheap are fine too.
Avoid the $0.99 first-year offers, the renewal is where they get you.

Either way: put the domain's DNS on Cloudflare (free), point the record at
your host, and let Cloudflare handle HTTPS.

## Before you take real money

- [ ] `ADMIN_PASSWORD` set to something that isn't `smoke`
- [ ] `BASE_URL` set to the real https:// address
- [ ] HTTPS working (automatic on all four hosts above)
- [ ] A backup of `bbq.db` somewhere that isn't the server
