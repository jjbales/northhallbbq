// Drops in two sample cook dates so you can click around. Safe to re-run.
const { db } = require('./lib/db');

const day = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function addCook(date, butts, costCents, note) {
  if (db.prepare('SELECT 1 FROM cook_dates WHERE cook_date = ?').get(date)) return;
  const info = db.prepare(
    `INSERT INTO cook_dates (cook_date, butts_total, butt_cost_cents, other_cost_cents, note)
     VALUES (?,?,?,?,?)`
  ).run(date, butts, costCents, 3500, note);
  const slots = [
    ['11:00 AM – 12:00 PM', '11:00', '12:00', 6],
    ['12:00 PM – 1:00 PM', '12:00', '13:00', 6],
    ['1:00 PM – 2:00 PM', '13:00', '14:00', 4],
  ];
  slots.forEach((s, i) =>
    db.prepare('INSERT INTO pickup_slots (cook_date_id, label, start_time, end_time, capacity, sort_order) VALUES (?,?,?,?,?,?)')
      .run(info.lastInsertRowid, s[0], s[1], s[2], s[3], i));
  console.log(`seeded cook ${date} (${butts} butts)`);
}

addCook(day(7), 8, 1840, 'Pickup at the house. Text me if you need a different time.');
addCook(day(21), 12, 1795, 'Big cook — order early, these go fast.');
