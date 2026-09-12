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

// ---- defaults -------------------------------------------------------------
const DEFAULT_SETTINGS = {
  business_name: 'North Hall BBQ',
  tagline: 'Since 2014 — one butt or a thousand, same taste every time.',
  pickup_address: '5330 Lawson Road, Gainesville, GA',
  contact_phone: '770.689.8110',
  contact_email: 'jason@jasonbales.com',
  // Payment mode: 'offline' | 'stripe' | 'cheddarup'
  payment_mode: 'cheddarup',
  cheddarup_url: '',
  // How many pounds of finished pulled pork you get off one butt.
  yield_lbs_per_butt: '5',
  // How long a customer's cart holds a butt before it goes back on the board.
  hold_minutes: '20',
  currency: 'usd',
  // Reminder message templates. {name} {date} {slot} {items} {total} {order} get swapped in.
  reminder_lead_days: '1',
  msg_confirm: "Hey {name}, you're down for {items} on {date}, {slot}. Total {total}. Pickup: {address}. Order #{order}. — North Hall BBQ",
  msg_reminder: "Reminder: your BBQ pickup is tomorrow, {date} at {slot}. {items}, {total}. See you then! — North Hall BBQ",
  // Fundraiser callout on the public page. Blank the headline to hide the section.
  fundraiser_headline: 'Fundraisers',
  fundraiser_blurb: "The cook dates above are small batches for neighbors. The big ones are fundraisers -- churches, schools, ball teams. I handle the whole cook, you keep the margin, and it tastes exactly like what you'd get on a Saturday in the driveway. One butt or a thousand, same pit, same rub.",
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
  const count = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (count === 0) {
    const yieldLbs = Number(getSetting('yield_lbs_per_butt')) || 5;
    const ins = db.prepare(
      `INSERT INTO products (slug, name, description, unit, price_cents, butt_equiv, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run('whole-butt', 'Whole Boston Butt', 'One whole smoked pork shoulder, pulled or left whole, your call.', 'each', 5000, 1, 1);
    ins.run('pulled-lb', 'Pulled Pork (by the pound)', 'Smoked and pulled, sold by the pound.', 'lb', 1500, 1 / yieldLbs, 2);
  }
}
seed();

module.exports = { db, getSetting, setSetting, allSettings, DEFAULT_SETTINGS };
