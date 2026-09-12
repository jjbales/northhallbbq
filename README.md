# North Hall BBQ — cook-date ordering site

A small self-contained web app: you schedule a cook (a date + how many butts
you're putting on), customers order against it, and the public page counts
down in real time as they sell. Nothing oversells, even if two people are
checking out at the same second.

## Look and feel

Colors come straight from North Hall High School's published identity page:
Forest Green `#2d5035`, white, rich black, athletic gray `#a9a8a9`. The school
does not publish an official typeface, so headings use **Oswald** (condensed,
athletic) and body copy uses **Source Sans 3** — both pulled from Google Fonts
in the page `<head>`. If the machine running this has no internet, the site
falls back to system fonts and still looks fine; to make it fully offline,
drop the .woff2 files in `public/fonts/` and swap the `<link>` for an
`@font-face` block.

Note: this uses the school's *colors*, not its logo or wordmark, and the site
does not claim any affiliation with or endorsement by the school.

## Running it

```bash
npm install
cp .env.example .env      # edit ADMIN_PASSWORD
node seed.js              # optional: two sample cook dates to click around
npm start
```

Then:

- Shop: <http://localhost:4000>
- Admin ("Pit Boss"): <http://localhost:4000/admin.html>

The password is whatever you put in `.env` as `ADMIN_PASSWORD`
(default `smoke` if you skip it). All data lives in `data/bbq.db` — one
SQLite file. Back that file up and you've backed up the business.

## How the countdown works

Everything is measured in **butt equivalents**:

| Item | Butt equivalent |
|---|---|
| Whole Boston Butt | 1.0 |
| Pulled pork, per lb | 1 ÷ (lbs per butt) — 0.2 at the default 5 lbs |
| Sauce, sides, anything off-pig | 0 |

So if you put 8 butts on and someone buys 2 whole plus 3 lbs pulled, that's
2.6 butts gone and 5.4 left. The public page shows whole butts available and
approximate pounds. Change "pounds of pulled pork per butt" in Settings if
your yield runs different and the math follows.

A cook stops taking orders when it sells out, when you close it, or at the
"orders close" time you set (default 6:00 AM the morning of).

## Holds

When payment mode is Stripe, an unpaid cart holds its butts for 20 minutes
(Settings → "minutes to hold an unpaid cart"), then quietly releases them.
No ghost inventory sitting on the board because somebody wandered off.

## Payments

Set this in Settings. Three modes:

- **Cheddar Up** — the site takes the order and holds the butt, then sends the
  customer to your Cheddar Up collection link to pay. Paste that link into
  Settings. You mark the order paid in the admin. Fees are 3.95% + $0.95 on
  the free plan, and Cheddar Up passes those to the payer by default, so you
  net the full $50.
- **Stripe** — real card checkout on your own site, 2.9% + $0.30. Put
  `STRIPE_SECRET_KEY` in `.env` and restart. Orders flip to paid
  automatically. For production also set `STRIPE_WEBHOOK_SECRET` and point a
  webhook at `/api/stripe/webhook` for `checkout.session.completed`.
- **Pay at pickup** — no money online at all.

If you pick Stripe but there's no key in `.env`, the site quietly falls back
to pay-at-pickup rather than showing customers a broken checkout.

## Confirmations and reminders

At checkout the customer picks **text**, **email**, or **both**, and can tick
"remind me the day before pickup" (on by default). If they choose email, the
email field becomes required — no more orders you can't actually reach.

The admin's **Confirmations & reminders** tab writes each message for you from
a template and gives you a Text button (`sms:` link), an Email button
(`mailto:` link) and Copy. Open it on your phone, tap Text, your own messages
app opens with the message already typed, you hit send, then tap Mark sent so
it drops off the list. Reminders appear based on the lead time you set
(default 1 day).

**Nothing sends automatically.** That's deliberate: automatic SMS needs a paid
service (Twilio and similar) plus a registered sender, and automatic email
needs a mail service or your messages land in spam. This way it costs nothing
and works today. When volume makes the tapping annoying, the message text and
the send queue are already built — wiring in a real sender is a small change,
not a rewrite.

Templates use `{name}` `{date}` `{slot}` `{items}` `{total}` `{order}` and are
editable under "Message wording".

## Admin

- **Cooks & orders** — every cook with butts left, money booked, money
  collected, your cost, and profit. Mark orders paid / picked up / cancelled.
  Cancelling puts the butt back on the board. There's also a "add an order by
  hand" drawer for the folks who just text you.
- **Schedule a cook** — date, how many butts, what you paid per shoulder,
  other costs for the cook, pickup windows and how many handoffs fit in each.
- **Menu & prices** — edit prices, add items (sauce, sides), set butt
  equivalents.
- **Settings** — business name, pickup address, payment mode, yield, hold time.
  CSV export of every order lives at the bottom.

## Putting it on northhallbbq.com

It's a normal Node app, so anywhere that runs Node works. Cheapest paths:

1. **Mac mini at home** — run it with `pm2` or a launchd plist so it restarts
   on reboot, then point a Cloudflare Tunnel at it. Free, no ports opened on
   your router, and `northhallbbq.com` resolves straight to the mini.
2. **A $5/mo VPS or Render/Railway/Fly** — push the folder, set the env vars,
   point a CNAME at it. No hardware to babysit.

Either way put it behind HTTPS before you take real card payments, and change
`ADMIN_PASSWORD` to something that isn't "smoke".
