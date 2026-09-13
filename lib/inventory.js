const { db } = require('./db');

// Statuses that hold meat off the board.
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

const activeProteins = () =>
  db.prepare('SELECT * FROM proteins WHERE active = 1 ORDER BY sort_order, id').all();

// How much of each protein is spoken for on a given cook. Pork selling out
// has nothing to do with brisket, so this is per protein all the way down.
function committedByProtein(cookDateId) {
  const rows = db.prepare(
    `SELECT i.protein_id AS pid, COALESCE(SUM(i.piece_equiv * i.qty), 0) AS total
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE o.cook_date_id = ? AND ${HOLDING}
      GROUP BY i.protein_id`
  ).all(cookDateId);
  const map = {};
  for (const r of rows) map[r.pid] = Number(r.total) || 0;
  return map;
}

// What this cook is putting on, per protein, with what it cost.
function cookProteins(cookDateId) {
  return db.prepare(
    `SELECT cp.*, p.slug, p.name, p.piece, p.pieces, p.yield_lbs, p.sort_order
       FROM cook_proteins cp
       JOIN proteins p ON p.id = cp.protein_id
      WHERE cp.cook_date_id = ? AND cp.qty_total > 0
      ORDER BY p.sort_order, p.id`
  ).all(cookDateId);
}

// Kept for the cook-edit guard: you can't shrink a protein below what's sold.
function committedButts(cookDateId) {
  const pork = db.prepare("SELECT id FROM proteins WHERE slug = 'pork'").get();
  return pork ? committedByProtein(cookDateId)[pork.id] || 0 : 0;
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

  const committed = committedByProtein(cook.id);
  const lines = cookProteins(cook.id).map((cp) => {
    const sold = committed[cp.protein_id] || 0;
    const left = Math.max(0, cp.qty_total - sold);
    return {
      protein_id: cp.protein_id,
      slug: cp.slug,
      name: cp.name,
      piece: cp.piece,
      pieces: cp.pieces,
      yield_lbs: cp.yield_lbs,
      unit_cost_cents: cp.unit_cost_cents,
      total: cp.qty_total,
      committed: Math.round(sold * 100) / 100,
      remaining: Math.round(left * 100) / 100,
      whole_available: Math.floor(left + 1e-9),
      lbs_available: cp.yield_lbs > 0 ? Math.round(left * cp.yield_lbs * 10) / 10 : 0,
      percent_sold: cp.qty_total > 0 ? Math.min(100, Math.round((sold / cp.qty_total) * 100)) : 0,
      sold_out: left <= 0.0001,
    };
  });

  const totalPieces = lines.reduce((a, l) => a + l.total, 0);
  const totalSold = lines.reduce((a, l) => a + l.committed, 0);
  // The whole cook is only sold out when there's nothing left of anything.
  const soldOut = lines.length > 0 && lines.every((l) => l.sold_out);
  const closeAt = ordersCloseAt(cook);
  const closed =
    cook.status !== 'open' ||
    lines.length === 0 ||
    soldOut ||
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

  const porkLine = lines.find((l) => l.slug === 'pork');

  return {
    cook_date_id: cook.id,
    cook_date: cook.cook_date,
    note: cook.note || '',
    status: cook.status,
    proteins: lines,
    pieces_total: totalPieces,
    pieces_committed: Math.round(totalSold * 100) / 100,
    percent_sold: totalPieces > 0 ? Math.min(100, Math.round((totalSold / totalPieces) * 100)) : 0,
    orders_close_at: closeAt,
    sold_out: soldOut,
    closed,
    slots,
    // the old single-pool fields, still used by the confirmation page
    butts_total: porkLine ? porkLine.total : 0,
    butts_committed: porkLine ? porkLine.committed : 0,
    butts_remaining: porkLine ? porkLine.remaining : 0,
    whole_butts_available: porkLine ? porkLine.whole_available : 0,
    lbs_available: porkLine ? porkLine.lbs_available : 0,
  };
}

// Price a cart and work out what it eats, protein by protein. Prices come from
// the database, never from the browser.
function priceCart(items) {
  const out = { lines: [], total_cents: 0, by_protein: {}, butt_equiv: 0 };
  for (const item of items || []) {
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const p = db.prepare(
      `SELECT pr.*, x.slug AS protein_slug, x.name AS protein_name, x.piece, x.pieces
         FROM products pr LEFT JOIN proteins x ON x.id = pr.protein_id
        WHERE pr.slug = ? AND pr.active = 1`
    ).get(item.slug);
    if (!p) throw new Error(`Unknown product: ${item.slug}`);
    if (p.unit === 'each' && !Number.isInteger(qty)) throw new Error(`${p.name} must be a whole number`);
    if (!p.protein_id) throw new Error(`${p.name} isn't linked to anything on the pit yet.`);
    if (!(p.price_cents > 0)) throw new Error(`${p.name} isn't priced yet.`);

    const line = {
      product_id: p.id,
      slug: p.slug,
      name: p.name,
      unit: p.unit,
      qty,
      price_cents: p.price_cents,
      subtotal_cents: Math.round(p.price_cents * qty),
      protein_id: p.protein_id,
      protein_slug: p.protein_slug,
      piece_equiv: p.piece_equiv,
      pieces: Math.round(p.piece_equiv * qty * 10000) / 10000,
    };
    out.lines.push(line);
    out.total_cents += line.subtotal_cents;
    out.by_protein[p.protein_id] = Math.round(
      ((out.by_protein[p.protein_id] || 0) + line.pieces) * 10000
    ) / 10000;
  }
  return out;
}

module.exports = {
  availability, priceCart, committedButts, committedByProtein, cookProteins,
  activeProteins, releaseExpiredHolds, ordersCloseAt,
};
