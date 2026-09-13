require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, getSetting, setSetting, allSettings } = require('./lib/db');
const { availability, priceCart, releaseExpiredHolds, ordersCloseAt,
        committedByProtein, activeProteins } = require('./lib/inventory');
const { projectedUse, piecesForCook, recordPurchase, consumeForCook, releaseForCook,
        suppliesForCook, shelf, setRates, costByProtein } = require('./lib/supplies');
const cold = require('./lib/coldstorage');
const fb = require('./lib/feedback');
const uploads = require('./lib/uploads');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'smoke';
const ADMIN_COOKIE = 'bbq_admin';
const adminToken = crypto.createHash('sha256').update(ADMIN_PASSWORD + '::bbq').digest('hex');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(cookieParser());
// Stripe webhook needs the raw body, everything else gets JSON.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  // photo uploads arrive as the raw image bytes, not as JSON or multipart
  if (req.method === 'POST' && /^\/api\/feedback\/[^/]+\/photo$/.test(req.path)) {
    return express.raw({ type: () => true, limit: uploads.MAX_BYTES })(req, res, next);
  }
  return express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// Customer photos live off the persistent disk, not in public/, so one that
// hasn't been approved is a 404 rather than a URL somebody could stumble on.
app.get('/u/:name', (req, res) => {
  const p = uploads.readable(req.params.name);
  if (!p) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(p);
});

// The same files, for you, before you've decided.
app.get('/api/admin/u/:name', requireAdmin, (req, res) => {
  const p = uploads.readable(req.params.name, { admin: true });
  if (!p) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(p);
});

const money = (c) => (c / 100).toFixed(2);
const publicId = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function paymentMode() {
  const mode = getSetting('payment_mode');
  if (mode === 'stripe' && !stripe) return 'offline'; // no keys yet -> don't pretend
  return mode;
}

// ---------------------------------------------------------------- public API
app.get('/api/config', (req, res) => {
  const s = allSettings();
  res.json({
    business_name: s.business_name,
    tagline: s.tagline,
    contact_phone: s.contact_phone,
    contact_email: s.contact_email,
    payment_mode: paymentMode(),
    cheddarup_url: s.cheddarup_url,
    fundraiser_headline: s.fundraiser_headline,
    fundraiser_blurb: s.fundraiser_blurb,
    fundraiser_cta: s.fundraiser_cta,
    yield_lbs_per_butt: Number(s.yield_lbs_per_butt),
    hold_minutes: Number(s.hold_minutes),
    gallery_headline: s.gallery_headline,
    gallery_blurb: s.gallery_blurb,
    feedback_headline: s.feedback_headline,
    feedback_blurb: s.feedback_blurb,
    show_feedback: s.show_feedback === '1',
  });
});

app.get('/api/products', (req, res) => {
  res.json(
    db.prepare(
      `SELECT pr.slug, pr.name, pr.description, pr.unit, pr.price_cents, pr.piece_equiv,
              pr.protein_id, pr.image_url, x.slug AS protein_slug, x.name AS protein_name,
              x.piece, x.pieces, x.yield_lbs, x.art
         FROM products pr JOIN proteins x ON x.id = pr.protein_id
        WHERE pr.active = 1 AND x.active = 1 AND pr.price_cents > 0
        ORDER BY x.sort_order, x.id, pr.sort_order, pr.id`
    ).all()
  );
});

// What's on the pit, with what's in the freezer behind it -- the cook form
// uses both, so it can pre-fill the cost and warn you when you're short.
app.get('/api/admin/proteins', requireAdmin, (req, res) =>
  res.json(cold.freezerWithCommitments()));

// The album. Web-sized copies, captions in the order you set.
app.get('/api/photos', (req, res) => {
  res.json(
    db.prepare(
      `SELECT p.id, p.file, p.thumb, p.caption, p.featured, p.source, p.credit,
              x.name AS protein_name
         FROM photos p LEFT JOIN proteins x ON x.id = p.protein_id
        WHERE p.active = 1 ORDER BY p.sort_order, p.id`
    ).all()
  );
});

// What customers said -- approved only, contact details never leave the admin.
app.get('/api/feedback', (req, res) => {
  if (getSetting('show_feedback') !== '1') return res.json({ items: [], summary: null });
  res.json({ items: fb.approved(req.query.limit), summary: fb.summary() });
});

// A photo attached to a comment. The comment has to exist first, which keeps
// this from being an open file drop.
app.post('/api/feedback/:token/photo', async (req, res) => {
  try {
    if (getSetting('show_feedback') !== '1') return res.status(404).json({ error: 'Not taking these right now.' });
    const row = db.prepare(
      `SELECT * FROM feedback WHERE upload_token = ?
         AND created_at > datetime('now', '-1 hour')`
    ).get(String(req.params.token));
    if (!row) {
      return res.status(404).json({ error: "That comment's gone stale. Send it again with the photo attached." });
    }
    const already = db.prepare('SELECT COUNT(*) c FROM photos WHERE feedback_id = ?').get(row.id).c;
    if (already >= 3) return res.status(429).json({ error: 'Three photos is plenty — thank you.' });

    const photo = await uploads.accept(req.body, { feedbackId: row.id, credit: row.name });
    res.json({ ok: true, id: photo.id });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

app.post('/api/feedback', (req, res) => {
  try {
    const { name, rating, body, email, phone, order, website } = req.body || {};
    const out = fb.submit({
      name, rating, body, email, phone, orderPublicId: order,
      ip: req.ip, trap: website,     // "website" is the honeypot
    });
    // the token lets the browser attach photos to the comment it just left,
    // and nothing else
    res.json({ ok: true, message: getSetting('feedback_thanks'), token: out.token || null });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

// Every open cook, soonest first, with live availability.
app.get('/api/cooks', (req, res) => {
  releaseExpiredHolds();
  const rows = db
    .prepare(`SELECT id FROM cook_dates
               WHERE cook_date >= date('now', '-1 day')
               ORDER BY cook_date ASC`)
    .all();
  res.json(rows.map((r) => availability(r.id)).filter((a) => a && a.status !== 'done'));
});

app.get('/api/cooks/:id', (req, res) => {
  const a = availability(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'No such cook date' });
  res.json(a);
});

app.post('/api/quote', (req, res) => {
  try {
    res.json(priceCart(req.body.items));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ------------------------------------------------------------------- ordering
const createOrder = db.transaction((payload) => {
  const { cookDateId, cart, customer, slotId, mode, holdMinutes } = payload;
  const pref = ['text', 'email', 'both'].includes(customer.contact_pref) ? customer.contact_pref : 'text';
  const optin = customer.reminder_optin ? 1 : 0;

  const avail = availability(cookDateId);
  if (!avail) throw Object.assign(new Error('That cook date is gone.'), { code: 404 });
  if (avail.closed) throw Object.assign(new Error('Orders are closed for that date.'), { code: 409 });
  // Each protein counts down on its own -- running out of brisket must not
  // block a pork order, and vice versa.
  for (const [pidStr, wanted] of Object.entries(cart.by_protein)) {
    const line = avail.proteins.find((p) => p.protein_id === Number(pidStr));
    if (!line) {
      const name = db.prepare('SELECT name FROM proteins WHERE id = ?').get(Number(pidStr));
      throw Object.assign(
        new Error(`${name ? name.name : 'That'} isn't on the pit for that date.`), { code: 409 });
    }
    if (wanted > line.remaining + 1e-9) {
      if (line.sold_out) {
        throw Object.assign(
          new Error(`The ${line.name.toLowerCase()} is sold out for that date. Everything else is still open.`),
          { code: 409 });
      }
      const n = line.whole_available;
      const left = line.yield_lbs > 0
        ? `${n} whole ${n === 1 ? line.piece : line.pieces} / ${line.lbs_available} lbs`
        : `${n} ${n === 1 ? line.piece : line.pieces}`;
      throw Object.assign(
        new Error(`Only ${left} of ${line.name.toLowerCase()} left for that date.`), { code: 409 });
    }
  }
  if (slotId) {
    const slot = avail.slots.find((s) => s.id === slotId);
    if (!slot) throw Object.assign(new Error('Pick a pickup window.'), { code: 400 });
    if (slot.remaining <= 0) throw Object.assign(new Error(`The ${slot.label} window just filled up.`), { code: 409 });
  } else if (avail.slots.length) {
    throw Object.assign(new Error('Pick a pickup window.'), { code: 400 });
  }

  const pid = publicId();
  const status = mode === 'offline' ? 'reserved' : 'pending';
  const hold =
    status === 'pending'
      ? db.prepare(`SELECT datetime('now', '+' || ? || ' minutes') AS t`).get(holdMinutes).t
      : null;

  const info = db
    .prepare(
      `INSERT INTO orders
         (public_id, cook_date_id, slot_id, customer_name, phone, email, notes,
          butt_equiv, total_cents, payment_method, status, hold_expires_at,
          contact_pref, reminder_optin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      pid, cookDateId, slotId || null, customer.name, customer.phone, customer.email || '',
      customer.notes || '', Object.values(cart.by_protein).reduce((a, b) => a + b, 0),
      cart.total_cents, mode, status, hold,
      pref, optin
    );

  const insItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, name, unit, qty, price_cents,
                              butt_equiv, protein_id, piece_equiv)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const l of cart.lines) {
    insItem.run(info.lastInsertRowid, l.product_id, l.name, l.unit, l.qty, l.price_cents,
                l.piece_equiv, l.protein_id, l.piece_equiv);
  }
  return { id: info.lastInsertRowid, public_id: pid, status };
});

app.post('/api/orders', async (req, res) => {
  try {
    const { cook_date_id, items, name, phone, email, notes, slot_id,
            contact_pref, reminder_optin } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Phone number is required.' });
    const pref = ['text', 'email', 'both'].includes(contact_pref) ? contact_pref : 'text';
    if ((pref === 'email' || pref === 'both') && !(email || '').trim()) {
      return res.status(400).json({ error: 'Add an email address, or switch updates to text.' });
    }

    const cart = priceCart(items);
    if (!cart.lines.length) return res.status(400).json({ error: 'Your order is empty.' });

    const mode = paymentMode();
    const order = createOrder({
      cookDateId: Number(cook_date_id),
      cart,
      customer: { name: String(name).trim(), phone: String(phone).trim(), email, notes,
                  contact_pref: pref, reminder_optin: reminder_optin ? 1 : 0 },
      slotId: slot_id ? Number(slot_id) : null,
      mode,
      holdMinutes: Number(getSetting('hold_minutes')) || 20,
    });

    if (mode === 'stripe') {
      const cook = db.prepare('SELECT cook_date FROM cook_dates WHERE id = ?').get(Number(cook_date_id));
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email || undefined,
        line_items: cart.lines.map((l) => ({
          quantity: l.unit === 'lb' ? 1 : l.qty,
          price_data: {
            currency: getSetting('currency') || 'usd',
            unit_amount: l.unit === 'lb' ? l.subtotal_cents : l.price_cents,
            product_data: {
              name: l.unit === 'lb' ? `${l.name} -- ${l.qty} lb` : l.name,
              description: `Pickup ${cook.cook_date}`,
            },
          },
        })),
        success_url: `${BASE_URL}/confirm.html?order=${order.public_id}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/?cancelled=${order.public_id}`,
        metadata: { order_public_id: order.public_id },
      });
      db.prepare('UPDATE orders SET stripe_session = ? WHERE id = ?').run(session.id, order.id);
      return res.json({ ok: true, public_id: order.public_id, mode, checkout_url: session.url });
    }

    if (mode === 'cheddarup') {
      // Order is held; customer pays on your Cheddar Up collection page.
      db.prepare("UPDATE orders SET status = 'reserved' WHERE id = ?").run(order.id);
      return res.json({
        ok: true,
        public_id: order.public_id,
        mode,
        total_cents: cart.total_cents,
        pay_url: getSetting('cheddarup_url') || '',
      });
    }

    return res.json({ ok: true, public_id: order.public_id, mode, total_cents: cart.total_cents });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

app.get('/api/orders/:publicId', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE public_id = ?').get(req.params.publicId);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT name, unit, qty, price_cents FROM order_items WHERE order_id = ?').all(o.id);
  const cook = db.prepare('SELECT cook_date FROM cook_dates WHERE id = ?').get(o.cook_date_id);
  const slot = o.slot_id ? db.prepare('SELECT label FROM pickup_slots WHERE id = ?').get(o.slot_id) : null;
  res.json({
    public_id: o.public_id, name: o.customer_name, status: o.status,
    total_cents: o.total_cents, cook_date: cook ? cook.cook_date : null,
    slot: slot ? slot.label : null, payment_method: o.payment_method, items,
  });
});

// Let a customer call off their own reservation -- but only while it's still
// theirs to call off: not once it's paid, and not after orders close.
app.post('/api/orders/:publicId/cancel', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE public_id = ?').get(req.params.publicId);
  if (!o) return res.status(404).json({ error: 'Order not found.' });

  if (o.status === 'cancelled') return res.json({ ok: true, status: 'cancelled' });
  if (o.status === 'paid' || o.status === 'picked_up') {
    return res.status(409).json({
      error: "That order's already paid, so I'd rather sort it out with you directly. Give me a call and I'll take care of it.",
    });
  }

  const cook = db.prepare('SELECT * FROM cook_dates WHERE id = ?').get(o.cook_date_id);
  const closeAt = ordersCloseAt(cook);
  if (new Date(closeAt.replace(' ', 'T')) <= new Date()) {
    return res.status(409).json({
      error: "Orders for that date are closed and the pork's already bought. Call me and we'll work it out.",
    });
  }

  db.prepare("UPDATE orders SET status='cancelled', hold_expires_at=NULL WHERE id=?").run(o.id);
  res.json({ ok: true, status: 'cancelled' });
});

// Stripe returns the customer here; confirm payment actually happened.
app.get('/api/orders/:publicId/confirm', async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE public_id = ?').get(req.params.publicId);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'paid' || o.status === 'picked_up') return res.json({ ok: true, status: o.status });
  if (stripe && o.stripe_session) {
    const s = await stripe.checkout.sessions.retrieve(o.stripe_session);
    if (s.payment_status === 'paid') {
      db.prepare("UPDATE orders SET status='paid', paid_at=datetime('now'), hold_expires_at=NULL WHERE id=?").run(o.id);
      return res.json({ ok: true, status: 'paid' });
    }
  }
  res.json({ ok: false, status: o.status });
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(400).end();
  let event;
  try {
    event = process.env.STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body.toString());
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const pid = event.data.object.metadata && event.data.object.metadata.order_public_id;
    if (pid) {
      db.prepare("UPDATE orders SET status='paid', paid_at=datetime('now'), hold_expires_at=NULL WHERE public_id=?").run(pid);
    }
  }
  res.json({ received: true });
});

// ------------------------------------------------------------------ admin API
function requireAdmin(req, res, next) {
  if (req.cookies[ADMIN_COOKIE] === adminToken) return next();
  res.status(401).json({ error: 'Not signed in' });
}

app.post('/api/admin/login', (req, res) => {
  if ((req.body || {}).password === ADMIN_PASSWORD) {
    res.cookie(ADMIN_COOKIE, adminToken, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie(ADMIN_COOKIE); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ signed_in: req.cookies[ADMIN_COOKIE] === adminToken }));

app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(allSettings()));
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) setSetting.run(k, String(v));
  // Keep pork's yield and its per-pound product in step with the setting.
  const y = Number(getSetting('yield_lbs_per_butt'));
  if (y > 0) {
    db.prepare("UPDATE proteins SET yield_lbs = ? WHERE slug = 'pork'").run(y);
    db.prepare(
      `UPDATE products SET piece_equiv = ?, butt_equiv = ?
        WHERE unit = 'lb' AND protein_id = (SELECT id FROM proteins WHERE slug = 'pork')`
    ).run(1 / y, 1 / y);
  }
  res.json(allSettings());
});

const productRows = () => db.prepare(
  `SELECT pr.*, x.slug AS protein_slug, x.name AS protein_name, x.piece, x.pieces,
          x.yield_lbs, x.art
     FROM products pr LEFT JOIN proteins x ON x.id = pr.protein_id
    ORDER BY x.sort_order, x.id, pr.sort_order, pr.id`
).all();
app.get('/api/admin/products', requireAdmin, (req, res) => res.json(productRows()));
app.post('/api/admin/products', requireAdmin, (req, res) => {
  try {
    const { id, slug, name, description, unit, price_cents, piece_equiv,
            protein_id, active, sort_order, image_url } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Give it a name.' });
    const pid = Number(protein_id);
    if (!db.prepare('SELECT 1 FROM proteins WHERE id = ?').get(pid)) {
      return res.status(400).json({ error: 'Pick what it comes off -- pork, brisket or chicken.' });
    }
    const eq = Number(piece_equiv);
    if (!Number.isFinite(eq) || eq < 0) return res.status(400).json({ error: 'Bad portion size.' });
    const price = Math.round(Number(price_cents) || 0);
    // price 0 is allowed, but it can't be on sale at that price
    const live = active && price > 0 ? 1 : 0;

    if (id) {
      // leaving sort_order out means "don't move it" -- saving a price should
      // never shuffle the menu
      const cur = db.prepare('SELECT sort_order FROM products WHERE id = ?').get(Number(id));
      const order = Number.isFinite(Number(sort_order)) && sort_order !== null && sort_order !== ''
        ? Number(sort_order) : (cur ? cur.sort_order : 0);
      const img = image_url === undefined ? undefined : String(image_url).trim();
      db.prepare(
        `UPDATE products SET name=?, description=?, unit=?, price_cents=?,
                piece_equiv=?, butt_equiv=?, protein_id=?, active=?, sort_order=?,
                image_url=COALESCE(?, image_url) WHERE id=?`
      ).run(name, description || '', unit, price, eq, eq, pid, live, order,
            img === undefined ? null : img, id);
    } else {
      db.prepare(
        `INSERT INTO products (slug, name, description, unit, price_cents, piece_equiv,
                               butt_equiv, protein_id, active, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(slug, name, description || '', unit, price, eq, eq, pid, live, sort_order || 0);
    }
    res.json(productRows());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ----------------------------------------------------------------- photos
// Photos are dropped into public/photos by hand; this picks them up so you
// don't have to type filenames.
const fsp = require('fs');
app.post('/api/admin/photos/scan', requireAdmin, (req, res) => {
  try {
    const dir = path.join(__dirname, 'public', 'photos');
    if (!fsp.existsSync(dir)) return res.json({ added: 0, photos: [] });
    const files = fsp.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f));
    const ins = db.prepare(
      'INSERT OR IGNORE INTO photos (file, thumb, caption, sort_order) VALUES (?,?,?,?)'
    );
    let added = 0, n = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM photos').get().m;
    for (const f of files) {
      if (/-thumb\./i.test(f)) continue;                 // the small copy isn't its own photo
      const base = f.replace(/\.[^.]+$/, '');
      const ext = f.match(/\.[^.]+$/)[0];
      const thumb = files.includes(`${base}-thumb${ext}`) ? `/photos/${base}-thumb${ext}` : `/photos/${f}`;
      const r = ins.run(`/photos/${f}`, thumb, '', ++n);
      added += r.changes;
    }
    res.json({ added, photos: db.prepare('SELECT * FROM photos ORDER BY sort_order, id').all() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/photos', requireAdmin, (req, res) =>
  res.json(db.prepare(
    `SELECT p.*, x.name AS protein_name,
            f.name AS from_name, f.body AS from_body, f.status AS from_status
       FROM photos p
       LEFT JOIN proteins x ON x.id = p.protein_id
       LEFT JOIN feedback f ON f.id = p.feedback_id
      ORDER BY p.source = 'customer' DESC, p.active ASC, p.sort_order, p.id`
  ).all())
);

app.post('/api/admin/photos', requireAdmin, (req, res) => {
  try {
    const { id, caption, protein_id, featured, active, sort_order, credit } = req.body || {};
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(id));
    if (!p) return res.status(404).json({ error: 'No such photo.' });
    const order = sort_order === undefined || sort_order === null || sort_order === ''
      ? p.sort_order : Number(sort_order);
    db.prepare(
      `UPDATE photos SET caption=?, protein_id=?, featured=?, active=?, sort_order=?,
              credit=COALESCE(?, credit) WHERE id=?`
    ).run(String(caption || '').slice(0, 300), protein_id ? Number(protein_id) : null,
          featured ? 1 : 0, active === 0 || active === false ? 0 : 1, order,
          credit === undefined ? null : String(credit).slice(0, 80), p.id);
    res.json(db.prepare('SELECT * FROM photos ORDER BY sort_order, id').all());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/photos/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
  if (row) {
    // a customer's upload goes for good, files and all; your own stay on disk
    uploads.remove(row);
    db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  }
  res.json({ ok: true });
});

// --------------------------------------------------------------- feedback
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  res.json({
    items: db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 200').all(),
    summary: fb.summary(),
  });
});

app.post('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  try {
    const { status, reply } = req.body || {};
    const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such comment.' });
    const next = ['pending', 'approved', 'hidden'].includes(status) ? status : row.status;
    db.prepare(
      `UPDATE feedback SET status=?, reply=?, reviewed_at=datetime('now') WHERE id=?`
    ).run(next, reply === undefined ? row.reply : String(reply).slice(0, 1000), row.id);
    // hiding what someone wrote should take their pictures down with it;
    // approving the words doesn't publish the pictures -- those are their own call
    if (next !== 'approved') {
      db.prepare("UPDATE photos SET active = 0 WHERE feedback_id = ?").run(row.id);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  for (const p of db.prepare('SELECT * FROM photos WHERE feedback_id = ?').all(id)) {
    uploads.remove(p);
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  }
  db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  res.json({ ok: true });
});

// -------------------------------------------------------------- cold storage
// The freezer. Meat gets bought in bulk and held, so it carries a count the
// same way wrap and pans do.
app.get('/api/admin/coldstorage', requireAdmin, (req, res) => {
  const rows = cold.freezerWithCommitments();
  const purchases = db.prepare(
    `SELECT pp.*, p.name, p.piece, p.pieces FROM protein_purchases pp
       LEFT JOIN proteins p ON p.id = pp.protein_id
      ORDER BY pp.id DESC LIMIT 25`
  ).all();
  res.json({ proteins: rows, purchases, value_cents: rows.reduce((a, b) => a + b.value_cents, 0) });
});

// Logging a meat run. Pieces and pounds both -- you shop by the pound and
// cook by the piece, and the averages should follow what you actually paid.
app.post('/api/admin/coldstorage/:id/purchase', requireAdmin, (req, res) => {
  try {
    const { qty, lbs, total_cents, note } = req.body || {};
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'How many did you buy?' });
    const w = Number(lbs) || 0;
    if (w < 0) return res.status(400).json({ error: 'Weight can\'t be negative.' });
    const t = Number(total_cents);
    if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: 'What did it cost?' });
    res.json(cold.recordPurchase(Number(req.params.id), q, w, t, note));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Correcting a count, a yield, or a low-stock line.
app.post('/api/admin/proteins', requireAdmin, (req, res) => {
  try {
    const { id, name, piece, pieces, yield_lbs, on_hand, unit_cost_cents,
            avg_lbs, low_at, active, sort_order } = req.body || {};
    const p = db.prepare('SELECT * FROM proteins WHERE id = ?').get(Number(id));
    if (!p) return res.status(404).json({ error: 'No such protein.' });
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    db.prepare(
      `UPDATE proteins SET name=?, piece=?, pieces=?, yield_lbs=?, on_hand=?,
              unit_cost_cents=?, avg_lbs=?, low_at=?, active=?, sort_order=? WHERE id=?`
    ).run(
      String(name || p.name).trim(), String(piece || p.piece).trim(), String(pieces || p.pieces).trim(),
      num(yield_lbs, p.yield_lbs), num(on_hand, p.on_hand), num(unit_cost_cents, p.unit_cost_cents),
      num(avg_lbs, p.avg_lbs), num(low_at, p.low_at),
      active === 0 || active === false ? 0 : 1, num(sort_order, p.sort_order), p.id
    );
    res.json(cold.freezerWithCommitments());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --------------------------------------------------------------- row order
// Move a row up or down. Renumbers the whole list so the order sticks even if
// it started out with everything at zero.
const ORDERABLE = { products: 'products', supplies: 'supplies', proteins: 'proteins' };
app.post('/api/admin/reorder/:table', requireAdmin, (req, res) => {
  try {
    const table = ORDERABLE[req.params.table];
    if (!table) return res.status(400).json({ error: 'Nothing to reorder there.' });
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Send the new order.' });

    const up = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
    db.transaction(() => ids.forEach((id, i) => up.run(i + 1, Number(id))))();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ------------------------------------------------------------------ supplies
// The pantry: wrap, pans, rub, fuel. Bought in bulk for the business, drawn
// down a cook at a time.
app.get('/api/admin/supplies', requireAdmin, (req, res) => {
  const rows = shelf();
  const purchases = db.prepare(
    `SELECT p.*, s.name, s.unit FROM supply_purchases p
     LEFT JOIN supplies s ON s.id = p.supply_id
     ORDER BY p.id DESC LIMIT 25`
  ).all();
  res.json({ supplies: rows, purchases, proteins: activeProteins(),
             value_cents: rows.reduce((a, b) => a + b.value_cents, 0) });
});

app.post('/api/admin/supplies', requireAdmin, (req, res) => {
  try {
    const { id, name, unit, per_piece, per_cook, low_at, on_hand, unit_cost_cents,
            active, sort_order } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Give it a name.' });
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    // pork's rate still fills the legacy per_butt column so nothing reads stale
    const porkId = (db.prepare("SELECT id FROM proteins WHERE slug = 'pork'").get() || {}).id;
    const perButt = porkId && per_piece ? num(per_piece[porkId]) : 0;

    let supplyId = id ? Number(id) : null;
    if (supplyId) {
      // on_hand and unit cost are only set here when you're correcting a count;
      // normally they move through purchases and cooks
      const cur = db.prepare('SELECT sort_order FROM supplies WHERE id = ?').get(supplyId);
      const order = sort_order === undefined || sort_order === null || sort_order === ''
        ? (cur ? cur.sort_order : 0) : num(sort_order);
      db.prepare(
        `UPDATE supplies SET name=?, unit=?, per_butt=?, per_cook=?, low_at=?,
                on_hand=?, unit_cost_cents=?, active=?, sort_order=? WHERE id=?`
      ).run(String(name).trim(), String(unit || 'unit').trim(), perButt, num(per_cook),
            num(low_at), num(on_hand), num(unit_cost_cents),
            active === 0 || active === false ? 0 : 1, order, supplyId);
    } else {
      const info = db.prepare(
        `INSERT INTO supplies (name, unit, on_hand, unit_cost_cents, per_butt, per_cook, low_at, active, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(String(name).trim(), String(unit || 'unit').trim(), num(on_hand),
            num(unit_cost_cents), perButt, num(per_cook), num(low_at),
            active === 0 || active === false ? 0 : 1, num(sort_order));
      supplyId = Number(info.lastInsertRowid);
    }
    if (per_piece) setRates(supplyId, per_piece);
    res.json(shelf());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/supplies/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM supplies WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Logging a receipt. Quantity plus what you paid -- the running average cost
// falls out of that, so cook costs follow what you actually spend.
app.post('/api/admin/supplies/:id/purchase', requireAdmin, (req, res) => {
  try {
    const { qty, total_cents, note } = req.body || {};
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'How many did you buy?' });
    const t = Number(total_cents);
    if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: 'What did it cost?' });
    res.json(recordPurchase(Number(req.params.id), q, t, note));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// What a cook this size would eat, and whether you're short.
app.post('/api/admin/supplies/projected', requireAdmin, (req, res) => {
  // { pieces: { <protein_id>: qty } } -- or a cook id to use what's on it
  const { pieces, cook_date_id } = req.body || {};
  const mix = cook_date_id ? piecesForCook(Number(cook_date_id)) : (pieces || {});
  const lines = projectedUse(mix);
  res.json({
    pieces: mix,
    lines,
    total_cents: lines.reduce((a, b) => a + b.total_cents, 0),
    short: lines.filter((l) => l.short_by > 0),
  });
});

app.post('/api/admin/cooks', requireAdmin, (req, res) => {
  try {
    const { id, cook_date, proteins, other_cost_cents,
            status, note, orders_close_at, slots } = req.body || {};

    // --- validate, so a slip of the keyboard can't write a broken cook -------
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cook_date || ''))) {
      return res.status(400).json({ error: 'Pick a cook date.' });
    }
    const known = db.prepare('SELECT * FROM proteins WHERE active = 1').all();
    const wanted = (Array.isArray(proteins) ? proteins : [])
      .map((p) => ({
        protein_id: Number(p.protein_id),
        qty_total: Number(p.qty_total) || 0,
        unit_cost_cents: Number(p.unit_cost_cents) || 0,
      }))
      .filter((p) => known.some((k) => k.id === p.protein_id));
    if (!wanted.some((p) => p.qty_total > 0)) {
      return res.status(400).json({ error: "Put something on the pit -- how many butts, briskets or birds?" });
    }
    if (wanted.some((p) => p.qty_total < 0)) {
      return res.status(400).json({ error: "You can't cook a negative number of anything." });
    }

    // a different cook already owns this date?
    const clash = db.prepare('SELECT id FROM cook_dates WHERE cook_date = ?').get(cook_date);
    if (clash && (!id || Number(id) !== clash.id)) {
      return res.status(409).json({
        error: `There's already a cook on ${cook_date}. Edit that one instead of adding a second.`,
      });
    }

    let cookId = id ? Number(id) : null;
    const prior = cookId ? db.prepare('SELECT status FROM cook_dates WHERE id = ?').get(cookId) : null;
    const nextStatus = status || (prior && prior.status) || 'open';
    const totalPieces = wanted.reduce((a, p) => a + p.qty_total, 0);

    if (cookId) {
      // don't let any protein drop below what people have already bought
      const committed = committedByProtein(cookId);
      for (const p of wanted) {
        const sold = committed[p.protein_id] || 0;
        if (p.qty_total < sold - 1e-9) {
          const k = known.find((x) => x.id === p.protein_id);
          return res.status(409).json({
            error: `You've already got ${sold} ${sold === 1 ? k.piece : k.pieces} of ${k.name.toLowerCase()} spoken for on that date, so it can't go below that. Cancel an order first if you need to cut back.`,
          });
        }
      }
      // and don't let one vanish from the cook entirely if it's sold
      for (const [pidStr, sold] of Object.entries(committed)) {
        if (sold > 1e-9 && !wanted.some((p) => p.protein_id === Number(pidStr) && p.qty_total > 0)) {
          const k = known.find((x) => x.id === Number(pidStr));
          return res.status(409).json({
            error: `There are orders for ${k ? k.name.toLowerCase() : 'something'} on that date, so you can't take it off the cook. Cancel those orders first.`,
          });
        }
      }
      db.prepare(
        `UPDATE cook_dates SET cook_date=?, butts_total=?, other_cost_cents=?,
                status=?, note=?, orders_close_at=? WHERE id=?`
      ).run(cook_date, totalPieces, Math.round(other_cost_cents || 0),
            nextStatus, note || '', orders_close_at || null, cookId);
    } else {
      const info = db.prepare(
        `INSERT INTO cook_dates (cook_date, butts_total, butt_cost_cents, other_cost_cents, status, note, orders_close_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(cook_date, totalPieces, 0, Math.round(other_cost_cents || 0),
            nextStatus, note || '', orders_close_at || null);
      cookId = info.lastInsertRowid;
    }

    // --- what's going on the pit -------------------------------------------
    const upCP = db.prepare(
      `INSERT INTO cook_proteins (cook_date_id, protein_id, qty_total, unit_cost_cents)
       VALUES (?,?,?,?)
       ON CONFLICT(cook_date_id, protein_id)
       DO UPDATE SET qty_total = excluded.qty_total, unit_cost_cents = excluded.unit_cost_cents`
    );
    for (const p of wanted) upCP.run(cookId, p.protein_id, p.qty_total, p.unit_cost_cents);
    // anything dropped to zero and unsold comes off the cook
    for (const p of wanted) {
      if (p.qty_total <= 0) {
        db.prepare('DELETE FROM cook_proteins WHERE cook_date_id = ? AND protein_id = ?')
          .run(cookId, p.protein_id);
      }
    }

    // --- slots: update in place, never orphan an order's pickup window ------
    if (Array.isArray(slots)) {
      const existing = db.prepare('SELECT * FROM pickup_slots WHERE cook_date_id = ?').all(cookId);
      const want = slots.filter((x) => x && x.label);
      const keep = new Set();

      want.forEach((w, i) => {
        const match = existing.find((e) => e.label === w.label);
        if (match) {
          keep.add(match.id);
          db.prepare('UPDATE pickup_slots SET start_time=?, end_time=?, capacity=?, sort_order=? WHERE id=?')
            .run(w.start_time, w.end_time, w.capacity || 6, i, match.id);
        } else {
          const info = db.prepare(
            'INSERT INTO pickup_slots (cook_date_id, label, start_time, end_time, capacity, sort_order) VALUES (?,?,?,?,?,?)'
          ).run(cookId, w.label, w.start_time, w.end_time, w.capacity || 6, i);
          keep.add(Number(info.lastInsertRowid));
        }
      });

      for (const e of existing) {
        if (keep.has(e.id)) continue;
        const used = db.prepare(
          "SELECT COUNT(*) c FROM orders WHERE slot_id = ? AND status != 'cancelled'"
        ).get(e.id).c;
        if (used === 0) db.prepare('DELETE FROM pickup_slots WHERE id = ?').run(e.id);
        // a window with orders in it stays put -- removing it would silently
        // strip the pickup time off someone's confirmed order
      }
    }

    // --- supplies: stock comes out of inventory when the cook is marked done -
    // Before that it's only an estimate, so nothing is deducted and you're free
    // to change what's going on the pit without the wrap and pans going out of step.
    if (nextStatus === 'done') { consumeForCook(cookId); cold.consumeForCook(cookId); }
    else { releaseForCook(cookId); cold.releaseForCook(cookId); }

    res.json(availability(cookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/cooks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM cook_dates WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Open it back up, close orders, or call it done. Marking it done is what
// takes the wrap, pans, rub and fuel out of the pantry.
app.post('/api/admin/cooks/:id/status', requireAdmin, (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['open', 'closed', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Status has to be open, closed or done.' });
    }
    const cookId = Number(req.params.id);
    const cook = db.prepare('SELECT id FROM cook_dates WHERE id = ?').get(cookId);
    if (!cook) return res.status(404).json({ error: 'No such cook date.' });

    db.prepare('UPDATE cook_dates SET status = ? WHERE id = ?').run(status, cookId);
    if (status === 'done') { consumeForCook(cookId); cold.consumeForCook(cookId); }
    else { releaseForCook(cookId); cold.releaseForCook(cookId); }
    res.json({ ok: true, status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Every cook with orders and the money breakdown.
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  releaseExpiredHolds();
  const cooks = db.prepare('SELECT * FROM cook_dates ORDER BY cook_date DESC').all();
  const out = cooks.map((c) => {
    const avail = availability(c.id);
    const orders = db
      .prepare(`SELECT o.*, s.label AS slot_label FROM orders o
                LEFT JOIN pickup_slots s ON s.id = o.slot_id
                WHERE o.cook_date_id = ? AND o.status != 'cancelled'
                ORDER BY o.created_at DESC`)
      .all(c.id)
      .map((o) => ({
        ...o,
        items: db.prepare('SELECT name, unit, qty, price_cents FROM order_items WHERE order_id = ?').all(o.id),
      }));

    const booked = orders.filter((o) => o.status !== 'pending');
    const revenue = booked.reduce((s, o) => s + o.total_cents, 0);
    const collected = booked.filter((o) => o.status === 'paid' || o.status === 'picked_up')
      .reduce((s, o) => s + o.total_cents, 0);
    // Meat cost, protein by protein -- pork and brisket don't cost the same.
    const meat = avail.proteins.map((p) => ({
      protein_id: p.protein_id,
      name: p.name,
      piece: p.piece,
      pieces: p.pieces,
      qty: p.total,
      unit_cost_cents: p.unit_cost_cents,
      total_cents: Math.round(p.unit_cost_cents * p.total),
    }));
    const meatTotal = meat.reduce((a, m) => a + m.total_cents, 0);
    // what each protein costs you all-in, per piece
    const split = costByProtein(c.id, c.other_cost_cents);
    for (const m of meat) {
      const sh = split[m.protein_id] || { supplies_cents: 0, other_cents: 0 };
      m.supplies_cents = sh.supplies_cents;
      m.other_cents = sh.other_cents;
      m.all_in_cents = m.total_cents + sh.supplies_cents + sh.other_cents;
      m.cost_each_cents = m.qty > 0 ? Math.round(m.all_in_cents / m.qty) : 0;
    }

    // snapshot if the cook is closed out, running estimate if it hasn't happened
    const sup = suppliesForCook(c.id);
    const costs = meatTotal + c.other_cost_cents + sup.total_cents;
    const pieces = avail.pieces_total;


    return {
      ...c,
      availability: avail,
      orders,
      meat,
      supplies: sup.lines,
      supplies_settled: sup.settled,
      money: {
        revenue_cents: revenue,
        collected_cents: collected,
        outstanding_cents: revenue - collected,
        meat_cost_cents: meatTotal,
        pork_cost_cents: meatTotal,           // old name, same number
        other_cost_cents: c.other_cost_cents,
        supplies_cents: sup.total_cents,
        cost_per_piece_cents: pieces > 0 ? Math.round(costs / pieces) : 0,
        cost_per_butt_cents: pieces > 0 ? Math.round(costs / pieces) : 0,
        total_cost_cents: costs,
        profit_cents: revenue - costs,
        margin_pct: revenue > 0 ? Math.round(((revenue - costs) / revenue) * 100) : 0,
        breakeven_cents: costs,   // what you have to take in to be square
      },
    };
  });
  res.json({ cooks: out, settings: allSettings() });
});

app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const ok = ['pending', 'reserved', 'paid', 'picked_up', 'cancelled'];
  if (!ok.includes(status)) return res.status(400).json({ error: 'Bad status' });
  const paidAt = status === 'paid' || status === 'picked_up' ? "datetime('now')" : 'paid_at';
  db.prepare(`UPDATE orders SET status=?, hold_expires_at=NULL, paid_at=${paidAt} WHERE id=?`)
    .run(status, Number(req.params.id));
  res.json({ ok: true });
});

// Manual order entry -- for the folks who just text you.
app.post('/api/admin/orders', requireAdmin, (req, res) => {
  try {
    const { cook_date_id, items, name, phone, email, notes, slot_id, status } = req.body || {};
    const cart = priceCart(items);
    const order = createOrder({
      cookDateId: Number(cook_date_id), cart,
      customer: { name, phone: phone || '', email, notes,
                  contact_pref: req.body.contact_pref || 'text',
                  reminder_optin: req.body.reminder_optin === undefined ? 1 : req.body.reminder_optin },
      slotId: slot_id ? Number(slot_id) : null,
      mode: 'offline', holdMinutes: 60,
    });
    if (status && status !== 'reserved') {
      db.prepare("UPDATE orders SET status=?, paid_at=datetime('now') WHERE id=?").run(status, order.id);
    }
    res.json({ ok: true, public_id: order.public_id });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

// Fill a template with an order's details.
function renderMsg(tpl, o) {
  const items = db.prepare('SELECT name, unit, qty FROM order_items WHERE order_id = ?').all(o.id)
    .map((i) => (i.unit === 'lb' ? `${i.qty} lb ${i.name}` : `${i.qty}x ${i.name}`)).join(', ');
  const d = new Date(o.cook_date + 'T12:00:00');
  return String(tpl)
    .replace(/{name}/g, (o.customer_name || '').split(' ')[0])
    .replace(/{date}/g, d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))
    .replace(/{slot}/g, o.slot_label || 'pickup time TBD')
    .replace(/{items}/g, items)
    .replace(/{total}/g, '$' + money(o.total_cents))
    .replace(/{order}/g, o.public_id)
    .replace(/{address}/g, getSetting('pickup_address') || '')
    .replace(/{link}/g, `${BASE_URL}/confirm.html?order=${o.public_id}`);
}

// Who needs a confirmation or a reminder, with the message already written.
app.get('/api/admin/messages', requireAdmin, (req, res) => {
  releaseExpiredHolds();
  const lead = Number(getSetting('reminder_lead_days')) || 1;
  const rows = db.prepare(`
    SELECT o.*, c.cook_date, s.label AS slot_label
      FROM orders o
      JOIN cook_dates c ON c.id = o.cook_date_id
      LEFT JOIN pickup_slots s ON s.id = o.slot_id
     WHERE o.status IN ('reserved','paid')
       AND c.cook_date >= date('now')
     ORDER BY c.cook_date, s.start_time`).all();

  const out = { confirmations: [], reminders: [] };
  for (const o of rows) {
    const base = {
      id: o.id, public_id: o.public_id, name: o.customer_name, phone: o.phone,
      email: o.email || '', contact_pref: o.contact_pref, cook_date: o.cook_date,
      slot: o.slot_label, total_cents: o.total_cents,
    };
    if (!o.confirm_sent_at) {
      out.confirmations.push({ ...base, message: renderMsg(getSetting('msg_confirm'), o) });
    }
    const dueRow = db.prepare(`SELECT date(?, '-' || ? || ' days') <= date('now') AS due`).get(o.cook_date, lead);
    if (o.reminder_optin && !o.reminder_sent_at && dueRow.due) {
      out.reminders.push({ ...base, message: renderMsg(getSetting('msg_reminder'), o) });
    }
  }
  res.json(out);
});

app.post('/api/admin/messages/:id/sent', requireAdmin, (req, res) => {
  const col = req.body.kind === 'reminder' ? 'reminder_sent_at' : 'confirm_sent_at';
  db.prepare(`UPDATE orders SET ${col} = datetime('now') WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.cook_date, o.public_id, o.customer_name, o.phone, o.email,
           s.label AS slot, o.status, o.total_cents, o.created_at, o.notes,
           o.contact_pref, o.reminder_optin, o.id
      FROM orders o JOIN cook_dates c ON c.id = o.cook_date_id
      LEFT JOIN pickup_slots s ON s.id = o.slot_id
     ORDER BY c.cook_date DESC, o.created_at DESC`).all();

  // one column per protein, so a spreadsheet can total the pit at a glance
  const proteins = activeProteins();
  const perOrder = db.prepare(
    `SELECT protein_id, COALESCE(SUM(piece_equiv * qty), 0) AS n
       FROM order_items WHERE order_id = ? GROUP BY protein_id`
  );

  const head = ['Cook date', 'Order', 'Name', 'Phone', 'Email', 'Pickup', 'Status', 'Total',
    ...proteins.map((p) => p.name), 'Items', 'Placed', 'Contact', 'Reminder', 'Notes'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

  const lines = [head.map(esc).join(',')];
  for (const r of rows) {
    const mix = {};
    for (const x of perOrder.all(r.id)) mix[x.protein_id] = Math.round(x.n * 100) / 100;
    const items = db.prepare('SELECT name, unit, qty FROM order_items WHERE order_id = ?').all(r.id)
      .map((i) => (i.unit === 'lb' ? `${i.qty} lb ${i.name}` : `${i.qty}x ${i.name}`)).join('; ');
    lines.push([
      r.cook_date, r.public_id, r.customer_name, r.phone, r.email, r.slot || '', r.status,
      money(r.total_cents), ...proteins.map((p) => mix[p.id] || 0), items,
      r.created_at, r.contact_pref, r.reminder_optin ? 'yes' : 'no', r.notes || '',
    ].map(esc).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="north-hall-bbq-orders.csv"');
  res.send(lines.join('\n'));
});

app.listen(PORT, () => {
  console.log(`\n  ${getSetting('business_name')} running at ${BASE_URL}`);
});
