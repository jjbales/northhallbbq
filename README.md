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

Three things go on the pit, and each counts down on its own:

| | one piece | also sold by the pound |
|---|---|---|
| **Pork** | a Boston butt | yes, at the yield in Settings |
| **Brisket** | a whole packer | yes |
| **Chicken** | a spatchcocked bird | no — whole birds only |

Every menu item belongs to one of them and eats a **portion of one piece**: a
whole butt is 1.0, a pound of pulled pork is 1/yield. Sell 4 lbs of pulled pork
off a 4.5 lb yield and 0.89 of a butt is gone. That's what makes the numbers on
the page move.

Because the pools are separate, selling out of brisket doesn't touch the pork.
The shop groups the menu by protein and shows each one's count above its items;
a group that's gone greys out and its inputs go dead, while everything else
keeps taking orders. The whole cook only reads "sold out" when there's nothing
left of anything.

Nothing can be oversold. The check runs protein by protein at the API, inside
the same transaction that writes the order, so a mixed order that's short on
just one thing is refused whole — the pork isn't quietly taken while the brisket
fails.

Brisket and chicken ship **switched off with no price**. Set your own prices
under Menu & prices and flip them Active; an item priced at $0 stays off the
shop no matter what Active says.

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
- **Schedule a cook** — date, how many of each protein and what you paid per
  piece, other costs, pickup windows and how many handoffs fit in each. Leave a
  count at zero and it stays off that cook.
- **Supplies** — the pantry: wrap, pans, rub, fuel. You buy in bulk for the
  business, not per cook, so this tracks what's on the shelf and what it cost.
  See below.
- **Menu & prices** — edit prices, add items (sauce, sides), set what each item
  comes off and what portion of one it eats.
- **Settings** — business name, pickup address, payment mode, yield, hold time.
  CSV export of every order lives at the bottom.

## Supplies

Wrap, pans, rub and fuel get bought in bulk and drawn down a cook at a time, so
they live in their own pantry rather than being typed in per cook.

Each item carries a unit (foot, pan, ounce, bag), how much is on hand, what it
costs per unit, and how fast it goes. Usage is set **per protein** — a brisket
takes more wrap than a butt and a chicken takes none — plus a **per cook**
figure for anything flat, like a bag of charcoal. Leave a column at zero if a
supply doesn't apply to that protein. Set *low at* and the tab tells you when
you're getting close.

**Logging a purchase** adds to stock and rolls into a running average cost. Buy
150 ft of wrap for $18.99 and a second roll later for $24.99, and wrap costs
$0.1466 a foot from then on — so a cook's numbers follow what you actually
spent, not just the newest receipt.

Costs per unit are kept fractional on purpose. Rounding a foot of wrap or an
ounce of rub up to the nearest cent throws a cook off by a few percent.

Each cook also shows what each protein costs you **all in** — its own meat, its
share of the supplies it used, and a slice of the flat costs. That's the number
that answers whether the chicken is worth cooking.

**Nothing comes off the shelf until you mark a cook cooked.** Up to that point
every cook shows an estimate, so you can change what's going on the pit freely. Hitting
*Mark cooked* takes the supplies out of stock and writes the prices down with
that cook, so an old cook keeps its real numbers when costs move later.
*Reopen* puts it all back.

### Changing prices after the fact

Meat cost lives on the cook, not the protein, so you can correct what you paid
per butt, brisket or bird right up until you settle up. Supply costs are live on
the Supplies tab, and every cook that hasn't been marked done re-prices itself
the moment you change one.

Marking a cook **done** is the one lock: that's when prices are written down
with the cook so old cooks keep their real numbers. If a receipt turns up after
that, hit **Reopen**, fix the price, and mark it done again — stock nets out to
zero and the cook re-snapshots at the corrected cost.

Stock is allowed to go negative. That isn't an error — it means you cooked on
supplies you hadn't logged buying yet, and logging the receipt squares it up.

## Putting it on northhallbbq.com

It's a normal Node app, so anywhere that runs Node works. Cheapest paths:

1. **Mac mini at home** — run it with `pm2` or a launchd plist so it restarts
   on reboot, then point a Cloudflare Tunnel at it. Free, no ports opened on
   your router, and `northhallbbq.com` resolves straight to the mini.
2. **A $5/mo VPS or Render/Railway/Fly** — push the folder, set the env vars,
   point a CNAME at it. No hardware to babysit.

Either way put it behind HTTPS before you take real card payments, and change
`ADMIN_PASSWORD` to something that isn't "smoke".
