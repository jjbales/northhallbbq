const { db } = require('./db');

// pieces: { [protein_id]: how many going on the pit }
// A brisket doesn't eat the same wrap as a butt, so usage is looked up per
// protein and added together.
function projectedUse(pieces) {
  const counts = pieces || {};
  const rates = db.prepare('SELECT * FROM supply_rates').all();
  const rateFor = (supplyId, proteinId) => {
    const r = rates.find((x) => x.supply_id === supplyId && x.protein_id === Number(proteinId));
    return r ? r.per_piece : 0;
  };

  return db.prepare('SELECT * FROM supplies WHERE active = 1 ORDER BY sort_order, id')
    .all()
    .map((s) => {
      let qty = s.per_cook || 0;                       // flat, however much goes on
      const breakdown = [];
      for (const [pid, n] of Object.entries(counts)) {
        const rate = rateFor(s.id, pid);
        if (!(rate > 0) || !(n > 0)) continue;
        qty += rate * n;
        breakdown.push({ protein_id: Number(pid), qty: Math.round(rate * n * 1000) / 1000 });
      }
      qty = Math.round(qty * 1000) / 1000;
      return {
        supply_id: s.id,
        label: s.name,
        unit: s.unit,
        qty,
        breakdown,
        unit_cost_cents: s.unit_cost_cents,
        total_cents: Math.round(qty * s.unit_cost_cents),
        on_hand: s.on_hand,
        short_by: Math.max(0, Math.round((qty - s.on_hand) * 1000) / 1000),
      };
    })
    .filter((x) => x.qty > 0);
}

// What a cook is putting on, as { protein_id: qty }.
function piecesForCook(cookId) {
  const out = {};
  for (const r of db.prepare('SELECT protein_id, qty_total FROM cook_proteins WHERE cook_date_id = ?').all(cookId)) {
    if (r.qty_total > 0) out[r.protein_id] = r.qty_total;
  }
  return out;
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

  const lines = projectedUse(piecesForCook(cookId));
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
function suppliesForCook(cookId) {
  const snap = db.prepare('SELECT * FROM cook_supplies WHERE cook_date_id = ? ORDER BY id').all(cookId);
  if (snap.length) return { lines: snap, total_cents: snap.reduce((a, b) => a + b.total_cents, 0), settled: true };
  const est = projectedUse(piecesForCook(cookId));
  return { lines: est, total_cents: est.reduce((a, b) => a + b.total_cents, 0), settled: false };
}

// Split a cook's supply bill across what's on the pit. Per-piece usage is
// attributed to the protein that used it; flat per-cook costs (fuel) are shared
// out by headcount. Answers the question the totals can't: am I actually making
// money on chicken?
function costByProtein(cookId, otherCents) {
  const mix = piecesForCook(cookId);
  const ids = Object.keys(mix).map(Number);
  const heads = ids.reduce((a, id) => a + mix[id], 0);
  const out = {};
  for (const id of ids) out[id] = { supplies_cents: 0, other_cents: 0 };
  if (!heads) return out;

  const snap = db.prepare('SELECT * FROM cook_supplies WHERE cook_date_id = ?').all(cookId);
  const lines = snap.length ? null : projectedUse(mix);
  const rates = db.prepare('SELECT * FROM supply_rates').all();

  const attribute = (supplyId, qty, unitCost) => {
    // how much of this supply each protein is responsible for
    let perPieceTotal = 0;
    const share = {};
    for (const id of ids) {
      const r = rates.find((x) => x.supply_id === supplyId && x.protein_id === id);
      const q = (r ? r.per_piece : 0) * mix[id];
      share[id] = q;
      perPieceTotal += q;
    }
    const flat = Math.max(0, qty - perPieceTotal);   // the per-cook part
    for (const id of ids) {
      const q = share[id] + flat * (mix[id] / heads);
      out[id].supplies_cents += q * unitCost;
    }
  };

  if (snap.length) for (const l of snap) attribute(l.supply_id, l.qty, l.unit_cost_cents);
  else for (const l of lines) attribute(l.supply_id, l.qty, l.unit_cost_cents);

  for (const id of ids) {
    out[id].other_cents = (otherCents || 0) * (mix[id] / heads);
    out[id].supplies_cents = Math.round(out[id].supplies_cents);
    out[id].other_cents = Math.round(out[id].other_cents);
  }
  return out;
}

// The pantry with its per-protein usage rates folded in.
function shelf() {
  const rates = db.prepare('SELECT * FROM supply_rates').all();
  return db.prepare('SELECT * FROM supplies ORDER BY sort_order, id').all().map((s) => {
    const per = {};
    for (const r of rates) if (r.supply_id === s.id) per[r.protein_id] = r.per_piece;
    return {
      ...s,
      per_piece: per,
      low: s.active === 1 && s.low_at > 0 && s.on_hand <= s.low_at,
      value_cents: Math.round(s.on_hand * s.unit_cost_cents),
    };
  });
}

// Replace one supply's usage rates. Anything not mentioned is left alone.
const setRates = db.transaction((supplyId, perPiece) => {
  const up = db.prepare(
    `INSERT INTO supply_rates (supply_id, protein_id, per_piece) VALUES (?,?,?)
     ON CONFLICT(supply_id, protein_id) DO UPDATE SET per_piece = excluded.per_piece`
  );
  for (const [pid, v] of Object.entries(perPiece || {})) {
    const n = Number(v);
    up.run(supplyId, Number(pid), Number.isFinite(n) && n > 0 ? n : 0);
  }
});

module.exports = {
  projectedUse, piecesForCook, recordPurchase, consumeForCook, releaseForCook,
  suppliesForCook, shelf, setRates, costByProtein,
};
