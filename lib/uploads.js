const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { db } = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 12 * 1024 * 1024;      // what we'll accept off the wire
const BIG = 1600;                         // what we keep
const THUMB = 640;
// What a customer may send. Checked against the file's actual bytes, not its
// name or its declared content type -- both are trivially lied about.
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'heif', 'avif', 'gif']);

const dir = () => UPLOAD_DIR;
const pathFor = (name) => path.join(UPLOAD_DIR, path.basename(name));

// Re-encode rather than store what arrived. That's what strips the GPS a phone
// puts in every photo, and it means a file dressed up as an image but carrying
// something else never survives the round trip.
async function accept(buffer, { feedbackId, credit }) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('No photo came through.'), { code: 400 });
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('That photo is too big — 12 MB is the limit.'), { code: 413 });
  }

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50e6 }).metadata();
  } catch (e) {
    throw Object.assign(new Error("That doesn't look like a photo."), { code: 400 });
  }
  if (!meta.format || !ALLOWED.has(meta.format)) {
    throw Object.assign(new Error("That file isn't an image I can use."), { code: 400 });
  }
  if (!meta.width || !meta.height) {
    throw Object.assign(new Error("That doesn't look like a photo."), { code: 400 });
  }

  const id = crypto.randomBytes(9).toString('hex');
  const big = `${id}.jpg`, small = `${id}-thumb.jpg`;

  // rotate() applies the orientation tag and then drops it, so a phone photo
  // comes out the way it looked on the phone
  const base = sharp(buffer, { limitInputPixels: 50e6 }).rotate();
  const out = await base.clone().resize(BIG, BIG, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, progressive: true, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const thumb = await base.clone().resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: true, mozjpeg: true }).toBuffer();

  fs.writeFileSync(pathFor(big), out.data);
  fs.writeFileSync(pathFor(small), thumb);

  const info = db.prepare(
    `INSERT INTO photos (file, thumb, caption, source, feedback_id, stored, credit,
                         width, height, active, sort_order)
     VALUES (?,?,?, 'customer', ?,?,?,?,?, 0, ?)`
  ).run(`/u/${big}`, `/u/${small}`, '', feedbackId || null, big,
        String(credit || '').slice(0, 80), out.info.width, out.info.height,
        (db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM photos').get().m || 0) + 1);

  return db.prepare('SELECT * FROM photos WHERE id = ?').get(info.lastInsertRowid);
}

// Serving. A customer photo is only readable once it's been approved; before
// that the same URL is a plain 404, so there's nothing to guess at.
function readable(name, { admin } = {}) {
  const base = path.basename(String(name || ''));
  if (!/^[a-f0-9]{18}(-thumb)?\.jpg$/.test(base)) return null;
  const stored = base.replace('-thumb', '');
  const row = db.prepare('SELECT * FROM photos WHERE stored = ?').get(stored);
  if (!row) return null;
  if (!admin && row.active !== 1) return null;
  const p = pathFor(base);
  return fs.existsSync(p) ? p : null;
}

// Taking one out of the album takes the files with it.
function remove(row) {
  if (row.source !== 'customer' || !row.stored) return;
  for (const f of [row.stored, row.stored.replace('.jpg', '-thumb.jpg')]) {
    try { fs.unlinkSync(pathFor(f)); } catch (e) { /* already gone */ }
  }
}

module.exports = { accept, readable, remove, dir, MAX_BYTES };
