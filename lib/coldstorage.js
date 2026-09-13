const { db } = require('./db');

// What's in the freezer. Meat is bought in bulk and held, so each protein
// carries a piece count and a running average of what a piece cost you.
function freezer() {
  return db.prepare('SELECT * FROM proteins WHERE active = 1 ORDER BY sort_order, id')
    .all()
    .map((p) => ({
      ...p,
      low: p.low_at > 0 && p.on_hand <= p.low_at,
      value_cents: Math.round(p.on_hand * p.unit_cost_cents),
      lb_cost_cents: p.avg_lbs > 0 ? p.unit_cost_cents / p.avg_lbs : 0,
    }));
}

// A meat run. You shop by the pound and cook by the piece, so a receipt is
// both: 8 butts, 62 lbs, $119.66 -> $14.96 a butt and $1.93 a pound. Both
// averages are weighted, so restocking at a new price moves them honestly.
const recordPurchase = db.transaction((proteinId, qty, lbs, totalCents, note) => {
  const p = db.prepare('SELECT * FROM proteins WHERE id = ?').get(proteinId);
  if (!p) throw new Error('No such protein.');
  if (!(qty > 0)) throw new Error('How many did you buy?');

  const newOnHand = p.on_hand + qty;
  const newCost = newOnHand > 0
    ? (p.on_hand * p.unit_cost_cents + totalCents) / newOnHand
    : 0;
  // only blend weight in if this receipt actually carried one
  const newAvgLbs = lbs > 0 && newOnHand > 0
    ? (p.on_hand * p.avg_lbs + lbs) / newOnHand
    : p.avg_lbs;

  db.prepare(
    'INSERT INTO protein_purchases (protein_id, qty, lbs, total_cents, note) VALUES (?,?,?,?,?)'
  ).run(proteinId, qty, lbs || 0, Math.round(totalCents), note || '');
  db.prepare('UPDATE proteins SET on_hand = ?, unit_cost_cents = ?, avg_lbs = ? WHERE id = ?')
    .run(newOnHand, newCost, newAvgLbs, proteinId);
  return db.prepare('SELECT * FROM proteins WHERE id = ?').get(proteinId);
});

// Marking a cook done takes its meat out of the freezer. The cook already
// carries what each piece cost, so nothing needs re-pricing here.
// Runs once per cook -- a second call is a no-op.
const consumeForCook = db.transaction((cookId) => {
  const rows = db.prepare(
    'SELECT * FROM cook_proteins WHERE cook_date_id = ? AND consumed = 0 AND qty_total > 0'
  ).all(cookId);
  for (const r of rows) {
    // stock can go negative -- it means you cooked meat you hadn't logged buying
    db.prepare('UPDATE proteins SET on_hand = on_hand - ? WHERE id = ?').run(r.qty_total, r.protein_id);
    db.prepare('UPDATE cook_proteins SET consumed = 1 WHERE id = ?').run(r.id);
  }
  return rows.length;
});

// Reopening a cook puts the meat back.
const releaseForCook = db.transaction((cookId) => {
  const rows = db.prepare(
    'SELECT * FROM cook_proteins WHERE cook_date_id = ? AND consumed = 1'
  ).all(cookId);
  for (const r of rows) {
    db.prepare('UPDATE proteins SET on_hand = on_hand + ? WHERE id = ?').run(r.qty_total, r.protein_id);
    db.prepare('UPDATE cook_proteins SET consumed = 0 WHERE id = ?').run(r.id);
  }
  return rows.length;
});

// Everything already promised to a cook that hasn't happened yet. A butt can
// only be sold once, so the freezer count on its own overstates what's free.
function spokenFor() {
  const rows = db.prepare(
    `SELECT cp.protein_id AS pid, COALESCE(SUM(cp.qty_total), 0) AS n
       FROM cook_proteins cp
       JOIN cook_dates c ON c.id = cp.cook_date_id
      WHERE cp.consumed = 0 AND c.status != 'done'
      GROUP BY cp.protein_id`
  ).all();
  const map = {};
  for (const r of rows) map[r.pid] = Number(r.n) || 0;
  return map;
}

// The freezer with commitments netted off -- what you could still schedule.
function freezerWithCommitments() {
  const held = spokenFor();
  return freezer().map((p) => {
    const committed = held[p.id] || 0;
    return {
      ...p,
      committed,
      uncommitted: Math.round((p.on_hand - committed) * 100) / 100,
    };
  });
}

module.exports = { freezer, freezerWithCommitments, spokenFor, recordPurchase, consumeForCook, releaseForCook };
