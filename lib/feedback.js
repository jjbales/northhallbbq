const crypto = require('crypto');
const { db } = require('./db');

const MAX_BODY = 2000;
const MAX_NAME = 80;

// Rate limiting keys off a hash, never the address itself -- there's no reason
// to keep a log of who visited from where.
const hashIp = (ip) =>
  crypto.createHash('sha256').update(String(ip || '') + '::nhbbq').digest('hex').slice(0, 32);

// Three in an hour from one place is plenty for a real customer.
function tooMany(ipHash) {
  const n = db.prepare(
    `SELECT COUNT(*) c FROM feedback
      WHERE ip_hash = ? AND created_at > datetime('now', '-1 hour')`
  ).get(ipHash).c;
  return n >= 3;
}

function submit({ name, rating, body, email, phone, orderPublicId, ip, trap }) {
  // a hidden field a person never sees and a bot fills in
  if (trap) return { ok: true, quiet: true };   // no token, so no upload either

  const n = String(name || '').trim();
  const b = String(body || '').trim();
  if (!n) throw Object.assign(new Error('Put your name on it.'), { code: 400 });
  if (!b) throw Object.assign(new Error('Say something and I\'ll read it.'), { code: 400 });
  if (n.length > MAX_NAME) throw Object.assign(new Error('That name is too long.'), { code: 400 });
  if (b.length > MAX_BODY) {
    throw Object.assign(new Error(`Keep it under ${MAX_BODY} characters.`), { code: 400 });
  }

  let r = rating === '' || rating === null || rating === undefined ? null : Number(rating);
  if (r !== null && (!Number.isInteger(r) || r < 1 || r > 5)) {
    throw Object.assign(new Error('Rating has to be 1 to 5.'), { code: 400 });
  }

  const ipHash = hashIp(ip);
  if (tooMany(ipHash)) {
    throw Object.assign(
      new Error("That's a few in a row from here. Give it an hour, or just call me."),
      { code: 429 }
    );
  }

  // Only accept an order number that actually exists -- otherwise leave it off
  // rather than storing whatever was typed.
  let order = '';
  if (orderPublicId) {
    const o = db.prepare('SELECT public_id FROM orders WHERE public_id = ?')
      .get(String(orderPublicId).toUpperCase());
    if (o) order = o.public_id;
  }

  // A one-shot token so the browser can attach photos to the comment it just
  // left. It's only good for an hour and only for that one row.
  const token = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(
    `INSERT INTO feedback (name, rating, body, email, phone, order_public_id, ip_hash, upload_token)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(n, r, b, String(email || '').trim().slice(0, 160),
        String(phone || '').trim().slice(0, 40), order, ipHash, token);
  return { ok: true, id: info.lastInsertRowid, token };
}

// What the public sees: approved only, and never the contact details.
function approved(limit) {
  return db.prepare(
    `SELECT id, name, rating, body, reply, created_at
       FROM feedback WHERE status = 'approved'
      ORDER BY created_at DESC LIMIT ?`
  ).all(Number(limit) || 24);
}

function summary() {
  const r = db.prepare(
    `SELECT COUNT(*) n, AVG(rating) avg FROM feedback
      WHERE status = 'approved' AND rating IS NOT NULL`
  ).get();
  return {
    count: r.n || 0,
    average: r.n ? Math.round(r.avg * 10) / 10 : null,
    pending: db.prepare("SELECT COUNT(*) c FROM feedback WHERE status = 'pending'").get().c,
  };
}

module.exports = { submit, approved, summary, MAX_BODY };
