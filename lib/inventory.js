const { db, getSetting } = require('./db');

// Statuses that hold a butt off the board.
// 'pending' only counts while its hold is still good.
const HOLDING = `(
  o.status IN ('reserved','paid','picked_up')
  OR (o.status = 'pending' AND o.hold_expires_at > datetime('now'))
)`;

function releaseExpiredHolds() {
  db.prepare(
    `UPDATE orders SET status = 'cancelled'
      WHERE status = 'pending' AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= datetime('now')`
  ).run();
}

function committedButts(cookDateId) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(o.butt_equiv), 0) AS total
                FROM orders o
               WHERE o.cook_date_id = ? AND ${HOLDING}`)
    .get(cookDateId);
  return Number(row.total) || 0;
}

function slotTaken(cookDateId) {
  const rows = db
    .prepare(`SELECT o.slot_id AS slot_id, COUNT(*) AS n
                FROM orders o
               WHERE o.cook_date_id = ? AND o.slot_id IS NOT NULL AND ${HOLDING}
               GROUP BY o.slot_id`)
    .all(cookDateId);
  const map = {};
  for (const r of rows) map[r.slot_id] = r.n;
  return map;
}

function ordersCloseAt(cook) {
  if (cook.orders_close_at) return cook.orders_close_at;
  return `${cook.cook_date} 06:00:00`; // default: orders shut at 6am the day of
}

function availability(cookDateId) {
  releaseExpiredHolds();
  const cook = db.prepare('SELECT * FROM cook_dates WHERE id = ?').get(cookDateId);
  if (!cook) return null;

  const yieldLbs = Number(getSetting('yield_lbs_per_butt')) || 5;
  const committed = committedButts(cook.id);
  const remaining = Math.max(0, cook.butts_total - committed);
  const closeAt = ordersCloseAt(cook);
  const closed =
    cook.status !== 'open' ||
    remaining <= 0.0001 ||
    new Date(closeAt.replace(' ', 'T')) <= new Date();

  const taken = slotTaken(cook.id);
  const slots = db
    .prepare('SELECT * FROM pickup_slots WHERE cook_date_id = ? ORDER BY sort_order, start_time')
    .all(cook.id)
    .map((s) => ({
      id: s.id,
      label: s.label,
      start_time: s.start_time,
      end_time: s.end_time,
      capacity: s.capacity,
      taken: taken[s.id] || 0,
      remaining: Math.max(0, s.capacity - (taken[s.id] || 0)),
    }));

  return {
    cook_date_id: cook.id,
    cook_date: cook.cook_date,
    note: cook.note || '',
    status: cook.status,
    butts_total: cook.butts_total,
    butts_committed: Math.round(committed * 100) / 100,
    butts_remaining: Math.round(remaining * 100) / 100,
    whole_butts_available: Math.floor(remaining + 1e-9),
    lbs_available: Math.round(remaining * yieldLbs * 10) / 10,
    percent_sold: cook.butts_total > 0 ? Math.min(100, Math.round((committed / cook.butts_total) * 100)) : 0,
    orders_close_at: closeAt,
    sold_out: remaining <= 0.0001,
    closed,
    slots,
  };
}

// Price a cart, and work out how much inventory it eats. Prices come from the
// DB, never from the browser.
function priceCart(items) {
  const out = { lines: [], total_cents: 0, butt_equiv: 0 };
  for (const item of items || []) {
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const p = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(item.slug);
    if (!p) throw new Error(`Unknown product: ${item.slug}`);
    if (p.unit === 'each' && !Number.isInteger(qty)) throw new Error(`${p.name} must be a whole number`);
    const line = {
      product_id: p.id,
      slug: p.slug,
      name: p.name,
      unit: p.unit,
      qty,
      price_cents: p.price_cents,
      subtotal_cents: Math.round(p.price_cents * qty),
      butt_equiv: p.butt_equiv * qty,
    };
    out.lines.push(line);
    out.total_cents += line.subtotal_cents;
    out.butt_equiv += line.butt_equiv;
  }
  out.butt_equiv = Math.round(out.butt_equiv * 10000) / 10000;
  return out;
}

module.exports = { availability, priceCart, committedButts, releaseExpiredHolds, ordersCloseAt };
