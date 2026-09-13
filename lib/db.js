const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'bbq.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Things you sell. butt_equiv = how much of one whole butt a single unit consumes.
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  unit        TEXT NOT NULL DEFAULT 'each',      -- 'each' | 'lb'
  price_cents INTEGER NOT NULL,
  butt_equiv  REAL NOT NULL DEFAULT 0,           -- 1.0 for a whole butt, ~0.2 for a lb of pulled
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

-- One cook. This is the thing with a countdown.
CREATE TABLE IF NOT EXISTS cook_dates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cook_date         TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD (pickup day)
  butts_total       REAL NOT NULL,               -- how many butts you're putting on
  butt_cost_cents   INTEGER NOT NULL DEFAULT 0,  -- what you paid per shoulder, this cook
  other_cost_cents  INTEGER NOT NULL DEFAULT 0,  -- wood, rub, foil, pans -- whole cook
  status            TEXT NOT NULL DEFAULT 'open',-- open | closed | done
  note              TEXT DEFAULT '',
  orders_close_at   TEXT,                        -- ISO datetime; null = closes at cook date 6am
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supplies you buy for the business in bulk -- wrap, pans, rub, fuel. Stock is
-- held here; a cook draws down what it uses and is costed at what you paid.
CREATE TABLE IF NOT EXISTS supplies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'unit',   -- roll, pan, lb, tank...
  on_hand         REAL NOT NULL DEFAULT 0,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,     -- weighted average of what you've paid
  per_butt        REAL NOT NULL DEFAULT 0,        -- units consumed per butt
  per_cook        REAL NOT NULL DEFAULT 0,        -- units consumed once per cook
  low_at          REAL NOT NULL DEFAULT 0,        -- warn when on_hand drops below this
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

-- Every time you buy more. Keeps the running average cost honest.
CREATE TABLE IF NOT EXISTS supply_purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_id    INTEGER NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
  qty          REAL NOT NULL,
  total_cents  INTEGER NOT NULL,
  note         TEXT DEFAULT '',
  purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What a finished cook actually consumed, priced at the time. A snapshot, so
-- old cooks keep their real numbers when prices move later.
CREATE TABLE IF NOT EXISTS cook_supplies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cook_date_id    INTEGER NOT NULL REFERENCES cook_dates(id) ON DELETE CASCADE,
  supply_id       INTEGER REFERENCES supplies(id) ON DELETE SET NULL,
  label           TEXT NOT NULL,
  qty             REAL NOT NULL DEFAULT 0,
  unit            TEXT NOT NULL DEFAULT 'unit',
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pickup_slots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cook_date_id  INTEGER NOT NULL REFERENCES cook_dates(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                   -- "11:00 AM - 12:00 PM"
  start_time    TEXT NOT NULL,                   -- "11:00"
  end_time      TEXT NOT NULL,                   -- "12:00"
  capacity      INTEGER NOT NULL DEFAULT 6,      -- how many orders you can hand off in that window
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT UNIQUE NOT NULL,
  cook_date_id    INTEGER NOT NULL REFERENCES cook_dates(id) ON DELETE CASCADE,
  slot_id         INTEGER REFERENCES pickup_slots(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  butt_equiv      REAL NOT NULL DEFAULT 0,       -- inventory this order consumes
  total_cents     INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'offline',
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | reserved | paid | picked_up | cancelled
  stripe_session  TEXT,
  hold_expires_at TEXT,                          -- pending orders stop holding inventory after this
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at         TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  name         TEXT NOT NULL,
  unit         TEXT NOT NULL,
  qty          REAL NOT NULL,
  price_cents  INTEGER NOT NULL,
  butt_equiv   REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_cook ON orders(cook_date_id, status);

-- What goes on the pit. Each one counts down on its own: selling out of
-- brisket doesn't touch the pork.
CREATE TABLE IF NOT EXISTS proteins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,              -- pork | brisket | chicken
  name        TEXT NOT NULL,                     -- "Pork"
  piece       TEXT NOT NULL,                     -- "butt"  (one piece of it)
  pieces      TEXT NOT NULL,                     -- "butts"
  yield_lbs   REAL NOT NULL DEFAULT 0,           -- finished pounds off one piece; 0 = whole only
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

-- How many of each protein this cook is putting on, and what they cost that
-- week. Meat prices move, so the cost lives on the cook, not the protein.
CREATE TABLE IF NOT EXISTS cook_proteins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cook_date_id    INTEGER NOT NULL REFERENCES cook_dates(id) ON DELETE CASCADE,
  protein_id      INTEGER NOT NULL REFERENCES proteins(id) ON DELETE CASCADE,
  qty_total       REAL NOT NULL DEFAULT 0,
  unit_cost_cents REAL NOT NULL DEFAULT 0,       -- what you paid per piece, this cook
  UNIQUE (cook_date_id, protein_id)
);

-- A brisket doesn't eat the same wrap as a butt, and a chicken barely eats any.
CREATE TABLE IF NOT EXISTS supply_rates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_id  INTEGER NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
  protein_id INTEGER NOT NULL REFERENCES proteins(id) ON DELETE CASCADE,
  per_piece  REAL NOT NULL DEFAULT 0,
  UNIQUE (supply_id, protein_id)
);

CREATE INDEX IF NOT EXISTS idx_cook_proteins ON cook_proteins(cook_date_id);
`);

// ---- migrations ------------------------------------------------------------
// Adds columns to existing databases without clobbering anyone's orders.
function addColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
addColumn('orders', 'contact_pref', "TEXT NOT NULL DEFAULT 'text'");   // text | email | both
addColumn('orders', 'reminder_optin', 'INTEGER NOT NULL DEFAULT 1');
addColumn('orders', 'reminder_sent_at', 'TEXT');
addColumn('orders', 'confirm_sent_at', 'TEXT');

// Multi-protein: a product now belongs to one protein, and piece_equiv is how
// much of a single piece of it one unit eats (1 whole brisket = 1, a pound of
// chopped = 1/yield). butt_equiv is the old single-pool name, kept so existing
// rows still add up while the data moves across.
addColumn('products', 'protein_id', 'INTEGER REFERENCES proteins(id)');
addColumn('products', 'piece_equiv', 'REAL NOT NULL DEFAULT 0');
addColumn('order_items', 'protein_id', 'INTEGER');
addColumn('order_items', 'piece_equiv', 'REAL NOT NULL DEFAULT 0');

// ---- defaults -------------------------------------------------------------
const DEFAULT_SETTINGS = {
  business_name: 'North Hall BBQ',
  tagline: 'Since 2014 — one butt or a thousand, same flavor every time.',
  pickup_address: '5330 Lawson Road, Gainesville, GA',
  contact_phone: '770.689.8110',
  contact_email: 'jason@northhallbbq.com',
  // Payment mode: 'offline' | 'stripe' | 'cheddarup'
  payment_mode: 'cheddarup',
  cheddarup_url: '',
  // How many pounds of finished pulled pork you get off one butt.
  yield_lbs_per_butt: '4.5',
  // How long a customer's cart holds a butt before it goes back on the board.
  hold_minutes: '20',
  currency: 'usd',

  // Reminder message templates. {name} {date} {slot} {items} {total} {order} get swapped in.
  reminder_lead_days: '1',
  msg_confirm: "Hey {name}, you're down for {items} on {date}, {slot}. Total {total}. Pickup: {address}. Order #{order}. — North Hall BBQ",
  msg_reminder: "Reminder: your BBQ pickup is tomorrow, {date} at {slot}. {items}, {total}. See you then! — North Hall BBQ",
  // Fundraiser callout on the public page. Blank the headline to hide the section.
  fundraiser_headline: 'Fundraisers',
  fundraiser_blurb: "The cook dates above are small batches for neighbors. The big ones are fundraisers -- churches, schools, ball teams, non-profits. I handle the whole cook, you keep the margin, and it tastes exactly like what you'd get on a Saturday in the driveway. One butt or a thousand, same pits, same rub.",
  fundraiser_cta: 'Call or email me and we\'ll size it up.',
};

const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
};
const setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const allSettings = () => {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
};

function seed() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k)) setSetting.run(k, v);
  }

  // ---- what goes on the pit ------------------------------------------------
  if (db.prepare('SELECT COUNT(*) c FROM proteins').get().c === 0) {
    const p = db.prepare(
      'INSERT INTO proteins (slug, name, piece, pieces, yield_lbs, sort_order) VALUES (?,?,?,?,?,?)'
    );
    const yieldLbs = Number(getSetting('yield_lbs_per_butt')) || 4.5;
    p.run('pork',    'Pork',    'butt',    'butts',    yieldLbs, 1);
    p.run('brisket', 'Brisket', 'brisket', 'briskets', 7,        2);
    p.run('chicken', 'Chicken', 'bird',    'birds',    0,        3);  // sold whole only
  }
  const protein = (slug) => db.prepare('SELECT * FROM proteins WHERE slug = ?').get(slug);
  const pork = protein('pork'), brisket = protein('brisket'), chicken = protein('chicken');

  // ---- the menu ------------------------------------------------------------
  const haveProduct = (slug) => db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug);
  const addProduct = db.prepare(
    `INSERT INTO products (slug, name, description, unit, price_cents, butt_equiv,
                           protein_id, piece_equiv, sort_order, active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  if (!haveProduct('whole-butt')) {
    addProduct.run('whole-butt', 'Whole Boston Butt',
      'One whole smoked pork shoulder, pulled or left whole, your call.',
      'each', 5000, 1, pork.id, 1, 1, 1);
  }
  if (!haveProduct('pulled-lb')) {
    addProduct.run('pulled-lb', 'Pulled Pork (by the pound)', 'Smoked and pulled, sold by the pound.',
      'lb', 1500, 1 / pork.yield_lbs, pork.id, 1 / pork.yield_lbs, 2, 1);
  }
  // Brisket and chicken arrive switched OFF with a placeholder price. Nobody
  // can order one until you set your own price and flip it on -- guessing what
  // you charge for a packer is not my call to make.
  if (!haveProduct('whole-brisket')) {
    addProduct.run('whole-brisket', 'Whole Brisket',
      'A whole packer, smoked overnight. Sliced or left whole, your call.',
      'each', 0, 0, brisket.id, 1, 3, 0);
  }
  if (!haveProduct('brisket-lb')) {
    addProduct.run('brisket-lb', 'Brisket (by the pound)', 'Smoked and sliced, sold by the pound.',
      'lb', 0, 0, brisket.id, 1 / brisket.yield_lbs, 4, 0);
  }
  if (!haveProduct('whole-chicken')) {
    addProduct.run('whole-chicken', 'Spatchcocked Chicken',
      'A whole bird, butterflied so it cooks flat and even. Sold whole.',
      'each', 0, 0, chicken.id, 1, 5, 0);
  }

  // ---- the pantry ----------------------------------------------------------
  if (db.prepare('SELECT COUNT(*) c FROM supplies').get().c === 0) {
    const sup = db.prepare(
      `INSERT INTO supplies (name, unit, on_hand, unit_cost_cents, per_butt, per_cook, low_at, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    // quantities and costs start at zero -- fill them in from a real receipt
    sup.run('Wrap', 'ft',   0, 0, 6, 0, 50, 1);
    sup.run('Pans', 'pan',  0, 0, 1, 0, 10, 2);
    sup.run('Rub',  'oz',   0, 0, 2, 0, 16, 3);
    sup.run('Fuel', 'bag',  0, 0, 0, 1,  2, 4);
  }

  // ---- carry the old single-pool data across --------------------------------
  // Everything used to be pork, so that's where it all lands. Runs once; after
  // that these queries find nothing.
  const migrate = db.transaction(() => {
    // products that predate proteins
    db.prepare('UPDATE products SET protein_id = ?, piece_equiv = butt_equiv WHERE protein_id IS NULL')
      .run(pork.id);

    // each existing cook's butt count and cost become its pork line
    const cooks = db.prepare(
      `SELECT c.* FROM cook_dates c
        WHERE NOT EXISTS (SELECT 1 FROM cook_proteins cp WHERE cp.cook_date_id = c.id)`
    ).all();
    const insCP = db.prepare(
      'INSERT INTO cook_proteins (cook_date_id, protein_id, qty_total, unit_cost_cents) VALUES (?,?,?,?)'
    );
    for (const c of cooks) insCP.run(c.id, pork.id, c.butts_total, c.butt_cost_cents);

    // order lines predating proteins were all pork
    db.prepare(
      `UPDATE order_items SET protein_id = ?, piece_equiv = butt_equiv WHERE protein_id IS NULL`
    ).run(pork.id);

    // a supply's old per-butt rate becomes its pork rate. Brisket and chicken
    // start at zero -- set them on the Supplies tab, they're genuinely different.
    const needRates = db.prepare(
      `SELECT s.id, s.per_butt FROM supplies s
        WHERE NOT EXISTS (SELECT 1 FROM supply_rates r WHERE r.supply_id = s.id)`
    ).all();
    const insRate = db.prepare(
      'INSERT INTO supply_rates (supply_id, protein_id, per_piece) VALUES (?,?,?)'
    );
    for (const s2 of needRates) {
      insRate.run(s2.id, pork.id, s2.per_butt || 0);
      insRate.run(s2.id, brisket.id, 0);
      insRate.run(s2.id, chicken.id, 0);
    }
  });
  migrate();
}
seed();

module.exports = { db, getSetting, setSetting, allSettings, DEFAULT_SETTINGS };
