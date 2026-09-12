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

## Where to run it — the actual recommendation

**Render.** Not because it's cheaper (it isn't), but because of what it costs
you in attention.

Real prices, from their own pricing pages:

| | Render | Fly.io |
|---|---|---|
| Smallest paid instance | $7.00/mo (512MB) | $3.19/mo (512MB shared-cpu-1x) |
| 1GB persistent disk | $0.25/mo | $0.15/mo |
| **Monthly total** | **~$7.25** | **~$3.35** |
| How you deploy | Connect the GitHub repo, it reads `render.yaml`, done | `flyctl` from your terminal, or wire up a GitHub Action |
| Volumes while idle | Always on | Charged even when the machine is stopped |

Fly is roughly half the price. That's about **$47 a year** — one butt. Against
$50-a-butt unit economics, the cheaper host saves you less than a single
order, and costs you an evening the first time `flyctl` does something
surprising on a Friday night before a cook.

Render also already has `render.yaml` in this repo, so the setup is: connect
the repo, set two environment variables, deploy.

**Pick Fly instead if** you're comfortable in a terminal and would rather pay
$3 than $7 on principle. It's a good platform — this is a convenience call,
not a quality one.

**Whichever you pick, do not use a free tier.** Render's free plan has no
persistent disk: the site will deploy, take orders all week, then lose every
one of them the next time it restarts. That's the single most expensive
mistake available here.

### One thing to expect on either

A service with an attached disk can't do a zero-downtime rolling deploy — the
disk belongs to one machine at a time, so pushing an update takes the site
down for a few seconds. Irrelevant for a BBQ order page. Just don't deploy
while someone's mid-checkout on a Friday night.

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

The site runs on **northhallbbq.com**, registered at Cloudflare:

    northhallbbq.com   ->  CNAME  ->  north-hall-bbq.onrender.com

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
