const { db } = require('./db');

// What a cook of this size would consume, at today's costs.
// Nothing is deducted here -- this is the estimate you see while planning.
function projectedUse(butts) {
  return db.prepare('SELECT * FROM supplies WHERE active = 1 ORDER BY sort_order, id')
    .all()
    .map((s) => {
      const qty = Math.round(((s.per_butt || 0) * butts + (s.per_cook || 0)) * 1000) / 1000;
      return {
        supply_id: s.id,
        label: s.name,
        unit: s.unit,
        qty,
        unit_cost_cents: s.unit_cost_cents,
        total_cents: Math.round(qty * s.unit_cost_cents),
        on_hand: s.on_hand,
        short_by: Math.max(0, Math.round((qty - s.on_hand) * 1000) / 1000),
      };
    })
    .filter((x) => x.qty > 0);
}

// Buying more. Recomputes the running average so cook costs reflect what you
// actually paid across restocks, not just the newest receipt.
const recordPurchase = db.transaction((supplyId, qty, totalCents, note) => {
  const s = db.prepare('SELECT * FROM supplies WHERE id = ?').get(supplyId);
  if (!s) throw new Error('No such supply.');
  if (!(qty > 0)) throw new Error('Quantity has to be more than zero.');

  const oldValue = s.on_hand * s.unit_cost_cents;
  const newOnHand = s.on_hand + qty;
  // kept fractional on purpose -- rounding to whole cents per foot of wrap or
  // ounce of rub throws the cook cost off by a few percent
  const newUnitCost = newOnHand > 0 ? (oldValue + totalCents) / newOnHand : 0;

  db.prepare('INSERT INTO supply_purchases (supply_id, qty, total_cents, note) VALUES (?,?,?,?)')
    .run(supplyId, qty, Math.round(totalCents), note || '');
  db.prepare('UPDATE supplies SET on_hand = ?, unit_cost_cents = ? WHERE id = ?')
    .run(newOnHand, newUnitCost, supplyId);
  return db.prepare('SELECT * FROM supplies WHERE id = ?').get(supplyId);
});

// Close out a cook: snapshot what it used, and take it out of stock. Writing
// the prices down here means an old cook keeps its real numbers when costs
// move later. Runs once -- a second call is a no-op.
const consumeForCook = db.transaction((cookId) => {
  const already = db.prepare('SELECT COUNT(*) c FROM cook_supplies WHERE cook_date_id = ?').get(cookId).c;
  if (already > 0) return { already: true };

  const cook = db.prepare('SELECT * FROM cook_dates WHERE id = ?').get(cookId);
  if (!cook) throw new Error('No such cook date.');

  const lines = projectedUse(cook.butts_total);
  const ins = db.prepare(
    `INSERT INTO cook_supplies (cook_date_id, supply_id, label, qty, unit, unit_cost_cents, total_cents)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const l of lines) {
    ins.run(cookId, l.supply_id, l.label, l.qty, l.unit, l.unit_cost_cents, l.total_cents);
    // stock can go negative -- that's information, not an error: it means you
    // cooked on supplies you hadn't logged buying yet
    db.prepare('UPDATE supplies SET on_hand = on_hand - ? WHERE id = ?').run(l.qty, l.supply_id);
  }
  return { already: false, lines };
});

// Put it back if a cook is reopened.
const releaseForCook = db.transaction((cookId) => {
  const lines = db.prepare('SELECT * FROM cook_supplies WHERE cook_date_id = ?').all(cookId);
  for (const l of lines) {
    if (l.supply_id) db.prepare('UPDATE supplies SET on_hand = on_hand + ? WHERE id = ?').run(l.qty, l.supply_id);
  }
  db.prepare('DELETE FROM cook_supplies WHERE cook_date_id = ?').run(cookId);
  return lines.length;
});

// What a cook cost in supplies: the snapshot if it's closed out, the estimate
// if it hasn't happened yet.
function suppliesForCook(cookId, butts) {
  const snap = db.prepare('SELECT * FROM cook_supplies WHERE cook_date_id = ? ORDER BY id').all(cookId);
  if (snap.length) return { lines: snap, total_cents: snap.reduce((a, b) => a + b.total_cents, 0), settled: true };
  const est = projectedUse(butts);
  return { lines: est, total_cents: est.reduce((a, b) => a + b.total_cents, 0), settled: false };
}

module.exports = { projectedUse, recordPurchase, consumeForCook, releaseForCook, suppliesForCook };
