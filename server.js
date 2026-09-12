require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, getSetting, setSetting, allSettings } = require('./lib/db');
const { availability, priceCart, releaseExpiredHolds, ordersCloseAt, committedButts } = require('./lib/inventory');

const app = express();
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
app.use((req, res, next) =>
  req.originalUrl === '/api/stripe/webhook' ? next() : express.json()(req, res, next)
);
app.use(express.static(path.join(__dirname, 'public')));

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
  });
});

app.get('/api/products', (req, res) => {
  res.json(
    db.prepare('SELECT slug, name, description, unit, price_cents, butt_equiv FROM products WHERE active = 1 ORDER BY sort_order, id').all()
  );
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
  if (cart.butt_equiv > avail.butts_remaining + 1e-9) {
    throw Object.assign(
      new Error(`Only ${avail.whole_butts_available} whole butt(s) / ${avail.lbs_available} lbs left for that date.`),
      { code: 409 }
    );
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
      customer.notes || '', cart.butt_equiv, cart.total_cents, mode, status, hold,
      pref, optin
    );

  const insItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, name, unit, qty, price_cents, butt_equiv)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const l of cart.lines) {
    insItem.run(info.lastInsertRowid, l.product_id, l.name, l.unit, l.qty, l.price_cents, l.butt_equiv);
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
    if (cart.butt_equiv <= 0) return res.status(400).json({ error: 'Your order is empty.' });

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
  // Keep the per-pound product in step with the yield figure.
  const y = Number(getSetting('yield_lbs_per_butt'));
  if (y > 0) db.prepare("UPDATE products SET butt_equiv = ? WHERE unit = 'lb'").run(1 / y);
  res.json(allSettings());
});

app.get('/api/admin/products', requireAdmin, (req, res) =>
  res.json(db.prepare('SELECT * FROM products ORDER BY sort_order, id').all())
);
app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { id, slug, name, description, unit, price_cents, butt_equiv, active, sort_order } = req.body || {};
  if (id) {
    db.prepare(
      `UPDATE products SET name=?, description=?, unit=?, price_cents=?, butt_equiv=?, active=?, sort_order=? WHERE id=?`
    ).run(name, description || '', unit, Math.round(price_cents), butt_equiv, active ? 1 : 0, sort_order || 0, id);
  } else {
    db.prepare(
      `INSERT INTO products (slug, name, description, unit, price_cents, butt_equiv, active, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(slug, name, description || '', unit, Math.round(price_cents), butt_equiv, active ? 1 : 0, sort_order || 0);
  }
  res.json(db.prepare('SELECT * FROM products ORDER BY sort_order, id').all());
});

app.post('/api/admin/cooks', requireAdmin, (req, res) => {
  try {
    const { id, cook_date, butts_total, butt_cost_cents, other_cost_cents,
            status, note, orders_close_at, slots } = req.body || {};

    // --- validate, so a slip of the keyboard can't write a broken cook -------
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cook_date || ''))) {
      return res.status(400).json({ error: 'Pick a cook date.' });
    }
    const total = Number(butts_total);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: 'How many butts? Must be more than zero.' });
    }

    // a different cook already owns this date?
    const clash = db.prepare('SELECT id FROM cook_dates WHERE cook_date = ?').get(cook_date);
    if (clash && (!id || Number(id) !== clash.id)) {
      return res.status(409).json({
        error: `There's already a cook on ${cook_date}. Edit that one instead of adding a second.`,
      });
    }

    let cookId = id ? Number(id) : null;
    if (cookId) {
      // don't let the total drop below what people have already bought
      const committed = committedButts(cookId);
      if (total < committed - 1e-9) {
        return res.status(409).json({
          error: `You've already got ${committed} butt(s) spoken for on that date, so the total can't go below that. Cancel an order first if you need to shrink the cook.`,
        });
      }
      db.prepare(
        `UPDATE cook_dates SET cook_date=?, butts_total=?, butt_cost_cents=?, other_cost_cents=?,
                status=?, note=?, orders_close_at=? WHERE id=?`
      ).run(cook_date, total, Math.round(butt_cost_cents || 0), Math.round(other_cost_cents || 0),
            status || 'open', note || '', orders_close_at || null, cookId);
    } else {
      const info = db.prepare(
        `INSERT INTO cook_dates (cook_date, butts_total, butt_cost_cents, other_cost_cents, status, note, orders_close_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(cook_date, total, Math.round(butt_cost_cents || 0), Math.round(other_cost_cents || 0),
            status || 'open', note || '', orders_close_at || null);
      cookId = info.lastInsertRowid;
    }

    // --- slots: update in place, never orphan an order's pickup window ------
    if (Array.isArray(slots)) {
      const existing = db.prepare('SELECT * FROM pickup_slots WHERE cook_date_id = ?').all(cookId);
      const wanted = slots.filter((x) => x && x.label);
      const keep = new Set();

      wanted.forEach((w, i) => {
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

    res.json(availability(cookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/cooks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM cook_dates WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
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
    const pork = Math.round(c.butt_cost_cents * c.butts_total);
    const costs = pork + c.other_cost_cents;

    return {
      ...c,
      availability: avail,
      orders,
      money: {
        revenue_cents: revenue,
        collected_cents: collected,
        outstanding_cents: revenue - collected,
        pork_cost_cents: pork,
        other_cost_cents: c.other_cost_cents,
        total_cost_cents: costs,
        profit_cents: revenue - costs,
        margin_pct: revenue > 0 ? Math.round(((revenue - costs) / revenue) * 100) : 0,
        breakeven_butts: c.butt_cost_cents > 0 || c.other_cost_cents > 0
          ? Math.ceil(costs / Math.max(1, (db.prepare("SELECT price_cents FROM products WHERE slug='whole-butt'").get() || {}).price_cents || 5000))
          : 0,
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
    .replace(/{address}/g, getSetting('pickup_address') || '');
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
           s.label AS slot, o.status, o.total_cents, o.butt_equiv, o.created_at, o.notes,
           o.contact_pref, o.reminder_optin
      FROM orders o JOIN cook_dates c ON c.id = o.cook_date_id
      LEFT JOIN pickup_slots s ON s.id = o.slot_id
     WHERE o.status != 'cancelled' ORDER BY c.cook_date DESC, o.created_at`).all();
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = 'Cook Date,Order,Name,Phone,Email,Pickup,Status,Total,Butt Equivalent,Placed,Notes,Contact Preference,Wants Reminder';
  const body = rows.map((r) =>
    [r.cook_date, r.public_id, r.customer_name, r.phone, r.email, r.slot, r.status,
     money(r.total_cents), r.butt_equiv, r.created_at, r.notes,
     r.contact_pref, r.reminder_optin ? 'yes' : 'no'].map(esc).join(',')
  );
  res.type('text/csv').attachment('bbq-orders.csv').send([head, ...body].join('\n'));
});

app.listen(PORT, () => {
  console.log(`\n  ${getSetting('business_name')} running at ${BASE_URL}`);
});
