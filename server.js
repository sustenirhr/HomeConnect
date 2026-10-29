const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { db, hashPasswordAsync, saveProfile, createUser } = require('./db');
const { sendSms, checkSmsAccount } = require('./sms');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 3 * 1024 * 1024;
const MAX_IMAGE = 900_000; // characters of base64 data URL
const SESSION_DAYS = 30;
// In production the site must be served over HTTPS: cookies get the Secure flag and browsers are told to always use HTTPS.
const PRODUCTION = process.env.NODE_ENV === 'production';
// Set TRUST_PROXY=1 only when the app sits behind a reverse proxy (nginx, Caddy, a load balancer) that sets X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  ...(PRODUCTION ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};
const COOKIE_FLAGS = `HttpOnly; SameSite=Lax; Path=/${PRODUCTION ? '; Secure' : ''}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const WORK_TYPES = ['fulltime', 'parttime', 'either'];
const MARITAL = ['Single', 'Married', 'Divorced', 'Separated', 'Widowed'];
const EDUCATION = ['No formal education', 'Primary', 'Secondary', 'Certificate / Vocational', 'Diploma', 'Degree'];
const HOUSE_SIZES = ['Bedsitter / Studio', '1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5+ bedrooms'];
const REPORT_REASONS = ['Harassment or abuse', 'Scam or asking for money', 'Inappropriate messages', 'Fake profile', 'Other'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- validation ----------

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) ? n : NaN;
};
const need = (ok, message) => {
  if (!ok) throw new HttpError(400, message);
};
const between = (n, min, max) => n >= min && n <= max;

function image(v, label, required) {
  if (v == null || v === '') {
    need(!required, `${label} is required`);
    return null;
  }
  need(
    typeof v === 'string' && v.length <= MAX_IMAGE && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v),
    `${label} must be a JPEG, PNG or WebP image`
  );
  return v;
}

function phoneNumber(v) {
  const phone = str(v, 30).replace(/[\s()-]/g, '');
  need(/^\+?\d{7,15}$/.test(phone), 'Enter a valid phone number');
  return phone;
}

function validateWorker(p) {
  const v = {
    name: str(p.name, 80),
    id_number: str(p.id_number, 30),
    photo: image(p.photo, 'Photo', true),
    marital_status: p.marital_status,
    age: num(p.age),
    location: str(p.location, 80),
    has_kids: p.has_kids ? 1 : 0,
    religion: str(p.religion, 40),
    education: p.education,
    education_details: str(p.education_details, 300),
    good_conduct: p.good_conduct ? 1 : 0,
    allergies: str(p.allergies, 300),
    work_type: p.work_type,
  };
  v.num_kids = v.has_kids ? num(p.num_kids) : 0;
  v.good_conduct_doc = v.good_conduct ? image(p.good_conduct_doc, 'Certificate of good conduct', false) : null;

  need(v.name, 'Name is required');
  need(v.id_number, 'ID number is required');
  need(MARITAL.includes(v.marital_status), 'Select a marital status');
  need(between(v.age, 18, 80), 'Workers must be between 18 and 80 years old');
  need(v.location, 'Location is required');
  need(!v.has_kids || between(v.num_kids, 1, 20), 'Enter how many kids you have');
  need(v.religion, 'Religion is required');
  need(EDUCATION.includes(v.education), 'Select an education level');
  need(WORK_TYPES.includes(v.work_type), 'Select full-time, part-time or either');

  need(Array.isArray(p.work_history) && p.work_history.length <= 10, 'Invalid work history');
  v.work_history = JSON.stringify(
    p.work_history.map((job) => {
      const entry = {
        place: str(job?.place, 100),
        employer_name: str(job?.employer_name, 80),
        employer_phone: phoneNumber(job?.employer_phone),
        people_cared_for: num(job?.people_cared_for),
      };
      need(entry.place && entry.employer_name, 'Each previous job needs a workplace and employer name');
      need(between(entry.people_cared_for, 1, 50), 'Enter how many people you took care of in each previous job');
      return entry;
    })
  );
  return v;
}

function validateEmployer(p) {
  const v = {
    name: str(p.name, 80),
    location: str(p.location, 80),
    age: num(p.age),
    id_number: str(p.id_number, 30),
    num_kids: num(p.num_kids),
    house_size: p.house_size,
    religion: str(p.religion, 40),
  };
  need(v.name, 'Name is required');
  need(v.location, 'Location is required');
  need(between(v.age, 18, 100), 'Employers must be at least 18 years old');
  need(v.id_number, 'ID number is required');
  need(between(v.num_kids, 0, 20), 'Enter the number of kids (0 if none)');
  need(HOUSE_SIZES.includes(v.house_size), 'Select the size of your house');
  need(v.religion, 'Religion is required');
  return v;
}

function validateJob(p) {
  const v = {
    title: str(p.title, 80),
    location: str(p.location, 80),
    work_type: p.work_type,
    salary: str(p.salary, 60),
    start_date: str(p.start_date, 10),
    duties: str(p.duties, 1500),
    requirements: str(p.requirements, 1000),
  };
  need(v.title, 'Give the vacancy a title');
  need(v.location, 'Location is required');
  need(WORK_TYPES.includes(v.work_type), 'Select full-time, part-time or either');
  need(!v.start_date || /^\d{4}-\d{2}-\d{2}$/.test(v.start_date), 'Enter a valid start date');
  need(v.duties, 'Describe the duties');
  return v;
}

const validateProfile = (role, p) => {
  need(p && typeof p === 'object', 'Profile is required');
  return role === 'worker' ? validateWorker(p) : validateEmployer(p);
};

// ---------- what each side is allowed to see ----------

// Photos and certificates are not sent inside lists: each is its own URL that the browser fetches and caches.
// These columns replace the images with a short fingerprint (length plus a slice of the data) used to bust the cache.
// The slice skips the last bytes because image files end with the same fixed marker.
const fingerprint = (column) => `length(${column}) || '-' || substr(${column}, -48, 16)`;
const WORKER_FIELDS = `w.user_id, w.name, w.id_number, w.marital_status, w.age, w.location, w.has_kids, w.num_kids,
  w.religion, w.work_history, w.education, w.education_details, w.good_conduct, w.allergies, w.work_type,
  ${fingerprint('w.photo')} AS photo_v, ${fingerprint('w.good_conduct_doc')} AS doc_v`;

const imageUrl = (workerId, kind, version) => version && `/api/workers/${workerId}/${kind}?v=${encodeURIComponent(version)}`;

// ID numbers are never shared. Phone numbers, referee phone numbers and the
// good-conduct document are only shared once both sides have accepted.
function workerView(row, matched) {
  const history = JSON.parse(row.work_history);
  return {
    id: row.user_id,
    name: row.name,
    photo: imageUrl(row.user_id, 'photo', row.photo_v),
    marital_status: row.marital_status,
    age: row.age,
    location: row.location,
    has_kids: !!row.has_kids,
    num_kids: row.num_kids,
    religion: row.religion,
    education: row.education,
    education_details: row.education_details,
    good_conduct: !!row.good_conduct,
    allergies: row.allergies,
    work_type: row.work_type,
    work_history: matched ? history : history.map(({ employer_phone, ...rest }) => rest),
    ...(matched ? { phone: row.phone, good_conduct_doc: imageUrl(row.user_id, 'good-conduct', row.doc_v) } : {}),
  };
}

function employerView(row, matched) {
  return {
    id: row.user_id,
    name: row.name,
    location: row.location,
    age: row.age,
    num_kids: row.num_kids,
    house_size: row.house_size,
    religion: row.religion,
    ...(matched ? { phone: row.phone } : {}),
  };
}

function ownProfile(user) {
  if (user.role === 'worker') {
    const { photo_v, doc_v, ...row } = db.prepare(`SELECT ${WORKER_FIELDS} FROM workers w WHERE w.user_id = ?`).get(user.id);
    return {
      ...row,
      photo: imageUrl(user.id, 'photo', photo_v),
      good_conduct_doc: imageUrl(user.id, 'good-conduct', doc_v),
      has_kids: !!row.has_kids,
      good_conduct: !!row.good_conduct,
      work_history: JSON.parse(row.work_history),
    };
  }
  return db.prepare('SELECT * FROM employers WHERE user_id = ?').get(user.id);
}

// ---------- http helpers ----------

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

// Hosts such as Render sit behind Cloudflare, which sets these headers to the visitor's address and overwrites
// any value a visitor sends. Without them, the proxy's own entry (the last one in X-Forwarded-For) is used.
const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'true-client-ip'];
let loggedIpHeaders = false;

function clientIp(req) {
  if (!TRUST_PROXY) return req.socket.remoteAddress || 'unknown';
  // Logged once per start so you can confirm in the host's logs that real visitor addresses come through.
  if (!loggedIpHeaders) {
    loggedIpHeaders = true;
    const seen = ['x-forwarded-for', ...CLIENT_IP_HEADERS].map((h) => `${h}=${req.headers[h] ?? '(none)'}`).join(' ');
    console.log(`[client-ip check] ${seen}`);
  }
  const direct = CLIENT_IP_HEADERS.map((h) => req.headers[h]).find((v) => typeof v === 'string' && v.trim());
  const forwarded = req.headers['x-forwarded-for']?.split(',').pop().trim();
  return direct?.trim() || forwarded || req.socket.remoteAddress || 'unknown';
}

// Fixed-window counters kept in memory. This works for a single server process;
// if you ever run several copies of the app, move these counts to a shared store such as Redis.
const hits = new Map();
function rateLimit(key, limit, windowMinutes, message = 'Too many attempts. Please wait a few minutes and try again.') {
  const now = Date.now();
  let entry = hits.get(key);
  if (!entry || entry.reset <= now) hits.set(key, (entry = { count: 0, reset: now + windowMinutes * 60_000 }));
  if (++entry.count > limit) throw new HttpError(429, message);
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
}, 60_000).unref();

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Requiring JSON also keeps cross-site form posts from reaching the API.
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Expected JSON'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Upload is too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        need(body && typeof body === 'object', 'Invalid request');
        resolve(body);
      } catch (err) {
        reject(err instanceof HttpError ? err : new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sessionToken(req) {
  return /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}

// Only a hash of each session token is stored, so a leaked database copy cannot be used to log in as anyone.
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return undefined;
  return db
    .prepare(
      `SELECT u.id, u.role, u.phone FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', ?)`
    )
    .get(tokenHash(token), `-${SESSION_DAYS} days`);
}

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(tokenHash(token), userId);
  return { 'Set-Cookie': `sid=${token}; ${COOKIE_FLAGS}; Max-Age=${SESSION_DAYS * 86400}` };
}

const purgeSessions = () => db.prepare("DELETE FROM sessions WHERE created_at <= datetime('now', ?)").run(`-${SESSION_DAYS} days`);
purgeSessions();
setInterval(purgeSessions, 60 * 60_000).unref();

function requireRole(req, role) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please log in');
  if (role && user.role !== role) throw new HttpError(403, 'Not allowed');
  return user;
}

const me = (user) => ({ role: user.role, phone: user.phone, profile: ownProfile(user) });

const MATCHED = "decision = 'accept' AND worker_response = 'accept'";

// Chat is only open between an employer and worker who have both accepted each other.
function chatPair(user, otherId) {
  const [employerId, workerId] = user.role === 'employer' ? [user.id, otherId] : [otherId, user.id];
  if (isBlocked(employerId, workerId)) throw new HttpError(403, 'This chat is no longer available');
  if (!db.prepare(`SELECT 1 FROM decisions WHERE employer_id = ? AND worker_id = ? AND ${MATCHED}`).get(employerId, workerId)) {
    throw new HttpError(403, 'You can only chat once you have both accepted each other');
  }
  return { employerId, workerId };
}

const messageView = (row, userId) => ({ id: row.id, mine: row.sender_id === userId, body: row.body, created_at: row.created_at });

// ---------- passwords and SMS codes ----------

function newPassword(password) {
  need(
    typeof password === 'string' && between(password.length, 8, 200) && /[A-Za-z]/.test(password) && /\d/.test(password),
    'Password must be at least 8 characters and include both letters and numbers'
  );
}

async function passwordMatches(user, password) {
  // Hash even when the user is unknown so response time does not reveal which numbers are registered.
  const { hash } = await hashPasswordAsync(String(password ?? '').slice(0, 200), user?.salt ?? '0'.repeat(32));
  return !!user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
}

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const codeHash = (phone, purpose, code) => crypto.createHash('sha256').update(`${phone}:${purpose}:${code}`).digest('hex');

async function sendCode(phone, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(
    `INSERT INTO otps (phone, purpose, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))
     ON CONFLICT (phone, purpose) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at`
  ).run(phone, purpose, codeHash(phone, purpose, code), `+${CODE_MINUTES} minutes`);
  const what = purpose === 'register' ? 'confirm your phone number' : 'reset your password';
  try {
    await sendSms(phone, `Your Kazinyumbani code is ${code}. Use it to ${what}. It expires in ${CODE_MINUTES} minutes. Never share this code.`);
  } catch (err) {
    console.error(err);
    throw new HttpError(502, 'We could not send the text message. Please try again in a moment.');
  }
}

// Checks a code and uses it up. After CODE_ATTEMPTS wrong guesses the code stops working and a new one is needed.
function useCode(phone, purpose, code) {
  const row = db.prepare("SELECT * FROM otps WHERE phone = ? AND purpose = ? AND expires_at > datetime('now')").get(phone, purpose);
  const given = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  need(row && row.attempts < CODE_ATTEMPTS, 'That code has expired. Ask for a new one.');
  if (!crypto.timingSafeEqual(Buffer.from(codeHash(phone, purpose, given), 'hex'), Buffer.from(row.code_hash, 'hex'))) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ? AND purpose = ?').run(phone, purpose);
    throw new HttpError(400, 'That code is wrong. Check the text message and try again.');
  }
  db.prepare('DELETE FROM otps WHERE phone = ? AND purpose = ?').run(phone, purpose);
}

setInterval(() => db.prepare("DELETE FROM otps WHERE expires_at <= datetime('now')").run(), 60 * 60_000).unref();

// ---------- blocking ----------

// SQL condition that is true when neither user has blocked the other. Pass the two column names or `?` placeholders.
const notBlocked = (a, b) =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ${a} AND bl.blocked_id = ${b}) OR (bl.blocker_id = ${b} AND bl.blocked_id = ${a}))`;

const isBlocked = (a, b) => !!db.prepare(`SELECT 1 WHERE NOT ${notBlocked('?', '?')}`).get(a, b, b, a);

// ---------- api ----------

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  let m;

  // Texts a 6-digit code: to confirm the number before sign-up, or to reset a forgotten password.
  if (route === 'POST /api/otp') {
    const body = await readJson(req);
    need(body.purpose === 'register' || body.purpose === 'reset', 'Invalid request');
    const phone = phoneNumber(body.phone);
    // Every text costs money, so sending is limited per number and per address.
    rateLimit(`otp-phone:${phone}`, 3, 15, 'Too many codes requested for this number. Please wait 15 minutes.');
    rateLimit(`otp-ip:${clientIp(req)}`, 30, 60, 'Too many codes requested. Please wait a while and try again.');
    const registered = !!db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone);
    if (body.purpose === 'register' && registered) throw new HttpError(409, 'That phone number is already registered. Try logging in.');
    // For resets, answer the same way whether or not the number has an account; only real accounts get a text.
    if (body.purpose === 'register' || registered) await sendCode(phone, body.purpose);
    return send(res, 200, {});
  }

  if (route === 'POST /api/register') {
    // Generous per address: mobile networks put many phones behind one IP.
    rateLimit(`register:${clientIp(req)}`, 30, 60);
    const body = await readJson(req);
    need(body.role === 'employer' || body.role === 'worker', 'Choose employer or worker');
    const phone = phoneNumber(body.phone);
    newPassword(body.password);
    const profile = validateProfile(body.role, body.profile);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'That phone number is already registered. Try logging in.');
    }
    useCode(phone, 'register', body.code);
    const id = createUser(body.role, phone, await hashPasswordAsync(body.password), profile);
    return send(res, 201, me({ id, role: body.role, phone }), startSession(id));
  }

  if (route === 'POST /api/login') {
    const body = await readJson(req);
    const phone = str(body.phone, 30).replace(/[\s()-]/g, '');
    // Per number stops password guessing on one account; per address stops one attacker trying many numbers.
    rateLimit(`login-phone:${phone}`, 10, 15);
    rateLimit(`login-ip:${clientIp(req)}`, 100, 15);
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!(await passwordMatches(user, body.password))) throw new HttpError(401, 'Wrong phone number or password');
    return send(res, 200, me(user), startSession(user.id));
  }

  if (route === 'POST /api/password-reset') {
    const body = await readJson(req);
    const phone = phoneNumber(body.phone);
    newPassword(body.password);
    useCode(phone, 'reset', body.code);
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) throw new HttpError(400, 'That code is wrong or has expired');
    const { salt, hash } = await hashPasswordAsync(body.password);
    db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
    // Log out every device, in case someone else had access to the account.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return send(res, 200, me(user), startSession(user.id));
  }

  // Permanently erases the account. Everything linked to it (profile, photos, matches, jobs, chats) goes with it.
  if (route === 'DELETE /api/account') {
    const user = requireRole(req);
    const body = await readJson(req);
    rateLimit(`login-phone:${user.phone}`, 10, 15);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!(await passwordMatches(row, body.password))) throw new HttpError(401, 'Wrong password');
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return send(res, 200, {}, { 'Set-Cookie': `sid=; ${COOKIE_FLAGS}; Max-Age=0` });
  }

  if (route === 'POST /api/logout') {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
    return send(res, 200, {}, { 'Set-Cookie': `sid=; ${COOKIE_FLAGS}; Max-Age=0` });
  }

  if (route === 'GET /api/me') return send(res, 200, me(requireRole(req)));

  if (route === 'PUT /api/profile') {
    const user = requireRole(req);
    const body = await readJson(req);
    // The profile form sends back the image URLs it was given when the images were not changed: keep the stored ones.
    if (user.role === 'worker' && body && typeof body === 'object') {
      const stored = db.prepare('SELECT photo, good_conduct_doc FROM workers WHERE user_id = ?').get(user.id);
      if (typeof body.photo === 'string' && body.photo.startsWith('/api/')) body.photo = stored.photo;
      if (typeof body.good_conduct_doc === 'string' && body.good_conduct_doc.startsWith('/api/')) body.good_conduct_doc = stored.good_conduct_doc;
    }
    saveProfile(user.role, user.id, validateProfile(user.role, body));
    return send(res, 200, me(user));
  }

  // Images are only served to people who can already see them in the app.
  if ((m = /^GET \/api\/workers\/(\d+)\/(photo|good-conduct)$/.exec(route))) {
    const user = requireRole(req);
    const workerId = Number(m[1]);
    const isDoc = m[2] === 'good-conduct';
    const own = user.id === workerId;
    // Any employer can see a worker's photo while browsing; the certificate needs a match or an accepted application.
    const allowed =
      own ||
      (user.role === 'employer' &&
        !isBlocked(user.id, workerId) &&
        (!isDoc ||
          db.prepare(`SELECT 1 FROM decisions WHERE employer_id = ? AND worker_id = ? AND ${MATCHED}`).get(user.id, workerId) ||
          db
            .prepare(
              `SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id
               WHERE j.employer_id = ? AND a.worker_id = ? AND a.status = 'accept'`
            )
            .get(user.id, workerId)));
    if (!allowed) throw new HttpError(404, 'Not found');
    const row = db.prepare(`SELECT ${isDoc ? 'good_conduct_doc' : 'photo'} AS img FROM workers WHERE user_id = ?`).get(workerId);
    const parts = row?.img && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(row.img);
    if (!parts) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': parts[1],
      // The URL carries a fingerprint of the image, so the browser may keep it until the image changes.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    return res.end(Buffer.from(parts[2], 'base64'));
  }

  // ----- employer side -----

  if (route === 'GET /api/workers') {
    const user = requireRole(req, 'employer');
    const location = str(url.searchParams.get('location') ?? '', 80).replace(/[\\%_]/g, '\\$&');
    const workType = url.searchParams.get('work_type');
    const type = WORK_TYPES.includes(workType) && workType !== 'either' ? workType : '';
    const minAge = num(url.searchParams.get('min_age') ?? '');
    const maxAge = num(url.searchParams.get('max_age') ?? '');
    const religion = str(url.searchParams.get('religion') ?? '', 40);
    const conduct = { yes: 1, no: 0 }[url.searchParams.get('good_conduct')] ?? -1; // -1 = either
    // The education filter is a minimum: "Secondary" also returns Diploma, Degree and so on.
    const levels = EDUCATION.slice(Math.max(0, EDUCATION.indexOf(url.searchParams.get('education'))));
    const rows = db
      .prepare(
        `SELECT ${WORKER_FIELDS} FROM workers w
         WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.employer_id = ? AND d.worker_id = w.user_id)
           AND ${notBlocked('?', 'w.user_id')}
           AND w.location LIKE ? ESCAPE '\\'
           AND (? = '' OR w.work_type = ? OR w.work_type = 'either')
           AND w.age BETWEEN ? AND ?
           AND (? = '' OR w.religion = ?)
           AND (? = -1 OR w.good_conduct = ?)
           AND w.education IN (${levels.map(() => '?').join(', ')})
         ORDER BY w.user_id DESC LIMIT 30`
      )
      .all(
        user.id, user.id, user.id, `%${location}%`, type, type,
        Number.isNaN(minAge) ? 0 : minAge, Number.isNaN(maxAge) ? 999 : maxAge,
        religion, religion, conduct, conduct, ...levels
      );
    return send(res, 200, rows.map((row) => workerView(row, false)));
  }

  if (route === 'POST /api/decisions') {
    const user = requireRole(req, 'employer');
    const body = await readJson(req);
    need(body.decision === 'accept' || body.decision === 'reject', 'Invalid decision');
    const workerId = num(body.worker_id);
    need(db.prepare('SELECT 1 FROM workers WHERE user_id = ?').get(workerId || 0) && !isBlocked(user.id, workerId), 'Worker not found');
    db.prepare(
      `INSERT INTO decisions (employer_id, worker_id, decision) VALUES (?, ?, ?)
       ON CONFLICT (employer_id, worker_id) DO UPDATE SET decision = excluded.decision, worker_response = NULL`
    ).run(user.id, workerId, body.decision);
    return send(res, 200, {});
  }

  if (route === 'GET /api/shortlist') {
    const user = requireRole(req, 'employer');
    const rows = db
      .prepare(
        `SELECT ${WORKER_FIELDS}, u.phone, d.worker_response FROM decisions d
         JOIN workers w ON w.user_id = d.worker_id JOIN users u ON u.id = d.worker_id
         WHERE d.employer_id = ? AND d.decision = 'accept' AND ${notBlocked('d.employer_id', 'd.worker_id')}
         ORDER BY d.created_at DESC`
      )
      .all(user.id);
    return send(
      res,
      200,
      rows.map((row) => ({ ...workerView(row, row.worker_response === 'accept'), status: row.worker_response ?? 'pending' }))
    );
  }

  // Removing a decision puts the worker back in the employer's browse deck.
  if ((m = /^DELETE \/api\/decisions\/(\d+)$/.exec(route))) {
    const user = requireRole(req, 'employer');
    db.prepare('DELETE FROM decisions WHERE employer_id = ? AND worker_id = ?').run(user.id, Number(m[1]));
    return send(res, 200, {});
  }

  if (route === 'DELETE /api/rejections') {
    const user = requireRole(req, 'employer');
    const { changes } = db.prepare("DELETE FROM decisions WHERE employer_id = ? AND decision = 'reject'").run(user.id);
    return send(res, 200, { restored: Number(changes) });
  }

  // ----- job vacancies: employer side -----

  if (route === 'POST /api/jobs') {
    const user = requireRole(req, 'employer');
    const job = validateJob(await readJson(req));
    db.prepare(
      `INSERT INTO jobs (employer_id, title, location, work_type, salary, start_date, duties, requirements)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(user.id, job.title, job.location, job.work_type, job.salary, job.start_date, job.duties, job.requirements);
    return send(res, 201, {});
  }

  if (route === 'GET /api/jobs/mine') {
    const user = requireRole(req, 'employer');
    const rows = db
      .prepare(
        `SELECT j.*,
           (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applicants,
           (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'pending') AS pending
         FROM jobs j WHERE j.employer_id = ? ORDER BY j.status = 'closed', j.created_at DESC, j.id DESC`
      )
      .all(user.id);
    return send(res, 200, rows);
  }

  if ((m = /^PUT \/api\/jobs\/(\d+)\/status$/.exec(route))) {
    const user = requireRole(req, 'employer');
    const { status } = await readJson(req);
    need(status === 'open' || status === 'closed', 'Invalid status');
    const { changes } = db.prepare('UPDATE jobs SET status = ? WHERE id = ? AND employer_id = ?').run(status, Number(m[1]), user.id);
    if (!changes) throw new HttpError(404, 'Vacancy not found');
    return send(res, 200, {});
  }

  if ((m = /^GET \/api\/jobs\/(\d+)\/applicants$/.exec(route))) {
    const user = requireRole(req, 'employer');
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND employer_id = ?').get(Number(m[1]), user.id);
    if (!job) throw new HttpError(404, 'Vacancy not found');
    const rows = db
      .prepare(
        `SELECT ${WORKER_FIELDS}, u.phone, a.status AS application, a.message FROM applications a
         JOIN workers w ON w.user_id = a.worker_id JOIN users u ON u.id = a.worker_id
         WHERE a.job_id = ? AND ${notBlocked('?', 'a.worker_id')} ORDER BY a.status = 'decline', a.created_at DESC`
      )
      .all(job.id, user.id, user.id);
    const applicants = rows.map((row) => ({
      ...workerView(row, row.application === 'accept'),
      application: row.application,
      message: row.message,
    }));
    return send(res, 200, { job, applicants });
  }

  if ((m = /^POST \/api\/jobs\/(\d+)\/applicants\/(\d+)$/.exec(route))) {
    const user = requireRole(req, 'employer');
    const { decision } = await readJson(req);
    need(decision === 'accept' || decision === 'decline', 'Invalid decision');
    const { changes } = db
      .prepare(
        `UPDATE applications SET status = ? WHERE job_id = ? AND worker_id = ?
           AND job_id IN (SELECT id FROM jobs WHERE employer_id = ?)`
      )
      .run(decision, Number(m[1]), Number(m[2]), user.id);
    if (!changes) throw new HttpError(404, 'Application not found');
    return send(res, 200, {});
  }

  // ----- job vacancies: worker side -----

  // Open vacancies, plus closed ones this worker already applied to so they can follow up.
  if (route === 'GET /api/jobs') {
    const user = requireRole(req, 'worker');
    const location = str(url.searchParams.get('location') ?? '', 80).replace(/[\\%_]/g, '\\$&');
    const rows = db
      .prepare(
        `SELECT j.*, a.status AS application, e.name AS e_name, e.location AS e_location, e.age AS e_age,
           e.num_kids AS e_num_kids, e.house_size AS e_house_size, e.religion AS e_religion, u.phone AS e_phone
         FROM jobs j
         JOIN employers e ON e.user_id = j.employer_id JOIN users u ON u.id = j.employer_id
         LEFT JOIN applications a ON a.job_id = j.id AND a.worker_id = ?
         WHERE (j.status = 'open' OR a.worker_id IS NOT NULL) AND j.location LIKE ? ESCAPE '\\'
           AND ${notBlocked('?', 'j.employer_id')}
         ORDER BY a.worker_id IS NULL, j.created_at DESC, j.id DESC LIMIT 100`
      )
      .all(user.id, `%${location}%`, user.id, user.id);
    const jobs = rows.map((row) => ({
      id: row.id,
      title: row.title,
      location: row.location,
      work_type: row.work_type,
      salary: row.salary,
      start_date: row.start_date,
      duties: row.duties,
      requirements: row.requirements,
      status: row.status,
      created_at: row.created_at,
      application: row.application ?? null,
      employer: employerView(
        {
          user_id: row.employer_id, name: row.e_name, location: row.e_location, age: row.e_age,
          num_kids: row.e_num_kids, house_size: row.e_house_size, religion: row.e_religion, phone: row.e_phone,
        },
        row.application === 'accept'
      ),
    }));
    return send(res, 200, jobs);
  }

  if ((m = /^POST \/api\/jobs\/(\d+)\/apply$/.exec(route))) {
    const user = requireRole(req, 'worker');
    const body = await readJson(req);
    const job = db.prepare("SELECT id, employer_id FROM jobs WHERE id = ? AND status = 'open'").get(Number(m[1]));
    if (!job || isBlocked(user.id, job.employer_id)) throw new HttpError(404, 'This vacancy is no longer open');
    db.prepare('INSERT OR IGNORE INTO applications (job_id, worker_id, message) VALUES (?, ?, ?)').run(job.id, user.id, str(body.message, 600));
    return send(res, 200, {});
  }

  if ((m = /^DELETE \/api\/jobs\/(\d+)\/apply$/.exec(route))) {
    const user = requireRole(req, 'worker');
    db.prepare("DELETE FROM applications WHERE job_id = ? AND worker_id = ? AND status = 'pending'").run(Number(m[1]), user.id);
    return send(res, 200, {});
  }

  // ----- chat between matched employers and workers -----

  if (route === 'GET /api/chats/unread') {
    const user = requireRole(req);
    const rows = db
      .prepare(
        `SELECT CASE WHEN m.employer_id = ? THEN m.worker_id ELSE m.employer_id END AS other, COUNT(*) AS n
         FROM messages m JOIN decisions d ON d.employer_id = m.employer_id AND d.worker_id = m.worker_id
         WHERE (m.employer_id = ? OR m.worker_id = ?) AND m.sender_id != ? AND m.read_at IS NULL
           AND d.decision = 'accept' AND d.worker_response = 'accept' AND ${notBlocked('m.employer_id', 'm.worker_id')}
         GROUP BY other`
      )
      .all(user.id, user.id, user.id, user.id);
    const by = Object.fromEntries(rows.map((r) => [r.other, r.n]));
    return send(res, 200, { total: rows.reduce((sum, r) => sum + r.n, 0), by });
  }

  if ((m = /^GET \/api\/chats\/(\d+)$/.exec(route))) {
    const user = requireRole(req);
    const otherId = Number(m[1]);
    const { employerId, workerId } = chatPair(user, otherId);
    const after = num(url.searchParams.get('after') ?? '');
    const firstLoad = Number.isNaN(after);
    // The first load gets the latest 200 messages; polls get anything newer than what the chat already shows.
    const messages = firstLoad
      ? db
          .prepare('SELECT * FROM (SELECT * FROM messages WHERE employer_id = ? AND worker_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id')
          .all(employerId, workerId)
      : db
          .prepare('SELECT * FROM messages WHERE employer_id = ? AND worker_id = ? AND id > ? ORDER BY id LIMIT 500')
          .all(employerId, workerId, after);
    // Polls run every few seconds, so only write when there is actually something new to mark as read.
    if (firstLoad || messages.some((row) => row.sender_id !== user.id)) {
      db.prepare(
        'UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE employer_id = ? AND worker_id = ? AND sender_id != ? AND read_at IS NULL'
      ).run(employerId, workerId, user.id);
    }
    const result = { messages: messages.map((row) => messageView(row, user.id)) };
    if (firstLoad) {
      const other =
        user.role === 'employer'
          ? db
              .prepare(`SELECT ${fingerprint('w.photo')} AS photo_v, w.name, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?`)
              .get(otherId)
          : db.prepare('SELECT e.name, u.phone FROM employers e JOIN users u ON u.id = e.user_id WHERE e.user_id = ?').get(otherId);
      const { photo_v, ...rest } = other;
      result.other = { id: otherId, ...rest, photo: imageUrl(otherId, 'photo', photo_v) };
    }
    return send(res, 200, result);
  }

  if ((m = /^POST \/api\/chats\/(\d+)$/.exec(route))) {
    const user = requireRole(req);
    rateLimit(`chat:${user.id}`, 30, 1, 'You are sending messages too quickly. Please slow down.');
    const { employerId, workerId } = chatPair(user, Number(m[1]));
    const body = str((await readJson(req)).body, 1000);
    need(body, 'Write a message first');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO messages (employer_id, worker_id, sender_id, body) VALUES (?, ?, ?, ?)')
      .run(employerId, workerId, user.id, body);
    return send(res, 201, messageView(db.prepare('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid), user.id));
  }

  // ----- blocking and reporting -----

  if (route === 'GET /api/blocks') {
    const user = requireRole(req);
    const rows = db
      .prepare(
        `SELECT b.blocked_id AS id, COALESCE(w.name, e.name) AS name FROM blocks b
         LEFT JOIN workers w ON w.user_id = b.blocked_id LEFT JOIN employers e ON e.user_id = b.blocked_id
         WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
      )
      .all(user.id);
    return send(res, 200, rows);
  }

  if ((m = /^POST \/api\/blocks\/(\d+)$/.exec(route))) {
    const user = requireRole(req);
    const otherId = Number(m[1]);
    need(otherId !== user.id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(otherId), 'User not found');
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(user.id, otherId);
    return send(res, 200, {});
  }

  if ((m = /^DELETE \/api\/blocks\/(\d+)$/.exec(route))) {
    const user = requireRole(req);
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.id, Number(m[1]));
    return send(res, 200, {});
  }

  if (route === 'POST /api/reports') {
    const user = requireRole(req);
    rateLimit(`report:${user.id}`, 10, 60, 'You have sent a lot of reports. Please wait a while before sending more.');
    const body = await readJson(req);
    const reportedId = num(body.user_id);
    need(REPORT_REASONS.includes(body.reason), 'Choose a reason');
    const reported = db
      .prepare(
        `SELECT u.id, u.phone, COALESCE(w.name, e.name) AS name FROM users u
         LEFT JOIN workers w ON w.user_id = u.id LEFT JOIN employers e ON e.user_id = u.id WHERE u.id = ?`
      )
      .get(reportedId || 0);
    need(reported && reported.id !== user.id, 'User not found');
    db.prepare(
      'INSERT INTO reports (reporter_id, reported_id, reported_phone, reported_name, reason, details) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, reported.id, reported.phone, reported.name ?? '', body.reason, str(body.details, 1000));
    if (body.block) db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(user.id, reported.id);
    return send(res, 201, {});
  }

  // ----- worker side -----

  if (route === 'GET /api/requests') {
    const user = requireRole(req, 'worker');
    const rows = db
      .prepare(
        `SELECT e.*, u.phone, d.worker_response FROM decisions d
         JOIN employers e ON e.user_id = d.employer_id JOIN users u ON u.id = d.employer_id
         WHERE d.worker_id = ? AND d.decision = 'accept' AND d.worker_response IS NOT 'decline'
           AND ${notBlocked('d.employer_id', 'd.worker_id')}
         ORDER BY d.created_at DESC`
      )
      .all(user.id);
    return send(
      res,
      200,
      rows.map((row) => ({ ...employerView(row, row.worker_response === 'accept'), status: row.worker_response ?? 'pending' }))
    );
  }

  if ((m = /^POST \/api\/requests\/(\d+)$/.exec(route))) {
    const user = requireRole(req, 'worker');
    const body = await readJson(req);
    need(body.response === 'accept' || body.response === 'decline', 'Invalid response');
    const { changes } = db
      .prepare("UPDATE decisions SET worker_response = ? WHERE employer_id = ? AND worker_id = ? AND decision = 'accept'")
      .run(body.response, Number(m[1]), user.id);
    if (!changes) throw new HttpError(404, 'Request not found');
    return send(res, 200, {});
  }

  throw new HttpError(404, 'Not found');
}

// Static files are kept in memory (plain and gzipped) and re-read only when they change on disk.
// Browsers revalidate with the ETag and get a tiny 304 response when nothing changed.
const staticCache = new Map();

function loadStatic(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const cached = staticCache.get(file);
  if (cached && cached.mtime === stat.mtimeMs) return cached;
  const data = fs.readFileSync(file);
  const type = MIME[path.extname(file)];
  const entry = {
    mtime: stat.mtimeMs,
    type,
    data,
    gzip: /^text|json|svg/.test(type) ? zlib.gzipSync(data) : null,
    etag: `"${crypto.createHash('sha1').update(data).digest('base64url')}"`,
  };
  staticCache.set(file, entry);
  return entry;
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return res.writeHead(400).end('Bad request');
  }
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const entry = file.startsWith(PUBLIC_DIR + path.sep) && MIME[path.extname(file)] && loadStatic(file);
  if (!entry) return res.writeHead(404).end('Not found');
  const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', ETag: entry.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === entry.etag) return res.writeHead(304, headers).end();
  const gzip = entry.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { ...headers, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gzip ? entry.gzip : entry.data);
}

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    const url = new URL(req.url, 'http://localhost');
    // For uptime monitors and load balancers: checks the database answers too.
    if (url.pathname === '/healthz') {
      db.prepare('SELECT 1').get();
      return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else res.writeHead(405).end();
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
  }
});

// Drop clients that are too slow to send their request, so they cannot tie up connections.
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
// Longer than a typical load balancer's idle timeout (60s), so the proxy closes idle connections first.
server.keepAliveTimeout = 65_000;

server.listen(PORT, () => {
  console.log(`Kazinyumbani running at http://localhost:${PORT}`);
  checkSmsAccount();
});

// Hosting platforms send SIGTERM on deploys and restarts: finish in-flight requests, then close the database cleanly.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
