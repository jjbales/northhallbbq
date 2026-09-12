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

## What about Cloudflare?

Split the question in two, because Cloudflare gives a different answer to each.

**As the domain registrar, DNS and HTTPS in front of the site — yes, use it.**
Cloudflare Registrar sells .com at wholesale (around $10-11/yr) with no
first-year bait and no renewal markup, DNS is free, and TLS certificates are
automatic. This is the best part of Cloudflare for you and it works with any
host below.

**As the thing that runs the app — not without rework.** Three products, three
different problems:

| Cloudflare product | Runs this app? | Why |
|---|---|---|
| **Pages** | No | Static files only. Same limitation as GitHub Pages. |
| **Workers** | Only after a rewrite | Workers isn't Node. `better-sqlite3` is a native module and can't load there, and Express needs a shim. You'd swap SQLite for **D1** and Express for Hono. Doable, but it's a real port of the data layer, not a config change. |
| **Containers** | Runs the Dockerfile, but loses your orders | Cloudflare's own docs: "All disk is ephemeral. When a Container instance goes to sleep, the next time it is started, it will have a fresh disk." Every sleep wipes `bbq.db`. Needs Workers Paid ($5/mo) on top. |

So the sensible split is **Cloudflare for the domain and DNS, Fly or Render for
the app.** If you'd rather have everything under one Cloudflare bill later,
the port to Workers + D1 is the way — worth doing once orders are steady, not
before the first cook.

## Domain

You already own **jasonbales.com**, so the free option is a subdomain:

    bbq.jasonbales.com   ->  CNAME  ->  your-app.onrender.com

That costs nothing, works today, and looks fine on a flyer.

A separate name like `northhallbbq.com` runs about $10-12/year at Cloudflare
Registrar, which sells at cost. Porkbun and Namecheap are fine alternatives.
Avoid the $0.99 first-year offers — the renewal is where they get you.

Either way: put the domain's DNS on Cloudflare (free), point the record at
your host, and let Cloudflare handle HTTPS.

## Before you take real money

- [ ] `ADMIN_PASSWORD` set to something that isn't `smoke`
- [ ] `BASE_URL` set to the real https:// address
- [ ] HTTPS working (automatic on all four hosts above)
- [ ] A backup of `bbq.db` somewhere that isn't the server
