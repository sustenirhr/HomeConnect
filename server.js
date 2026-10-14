const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword, saveProfile, createUser } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 3 * 1024 * 1024;
const MAX_IMAGE = 900_000; // characters of base64 data URL
const SESSION_DAYS = 30;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const WORK_TYPES = ['fulltime', 'parttime', 'either'];
const MARITAL = ['Single', 'Married', 'Divorced', 'Separated', 'Widowed'];
const EDUCATION = ['No formal education', 'Primary', 'Secondary', 'Certificate / Vocational', 'Diploma', 'Degree'];
const HOUSE_SIZES = ['Bedsitter / Studio', '1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5+ bedrooms'];

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

// ID numbers are never shared. Phone numbers, referee phone numbers and the
// good-conduct document are only shared once both sides have accepted.
function workerView(row, matched) {
  const history = JSON.parse(row.work_history);
  return {
    id: row.user_id,
    name: row.name,
    photo: row.photo,
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
    ...(matched ? { phone: row.phone, good_conduct_doc: row.good_conduct_doc } : {}),
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
    const row = db.prepare('SELECT * FROM workers WHERE user_id = ?').get(user.id);
    return { ...row, has_kids: !!row.has_kids, good_conduct: !!row.good_conduct, work_history: JSON.parse(row.work_history) };
  }
  return db.prepare('SELECT * FROM employers WHERE user_id = ?').get(user.id);
}

// ---------- http helpers ----------

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

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

function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return undefined;
  return db
    .prepare(
      `SELECT u.id, u.role, u.phone FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', ?)`
    )
    .get(token, `-${SESSION_DAYS} days`);
}

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` };
}

function requireRole(req, role) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please log in');
  if (role && user.role !== role) throw new HttpError(403, 'Not allowed');
  return user;
}

const me = (user) => ({ role: user.role, phone: user.phone, profile: ownProfile(user) });

// ---------- api ----------

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  let m;

  if (route === 'POST /api/register') {
    const body = await readJson(req);
    need(body.role === 'employer' || body.role === 'worker', 'Choose employer or worker');
    const phone = phoneNumber(body.phone);
    need(
      typeof body.password === 'string' && between(body.password.length, 8, 200) && /[A-Za-z]/.test(body.password) && /\d/.test(body.password),
      'Password must be at least 8 characters and include both letters and numbers'
    );
    const profile = validateProfile(body.role, body.profile);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'That phone number is already registered. Try logging in.');
    }
    const id = createUser(body.role, phone, body.password, profile);
    return send(res, 201, me({ id, role: body.role, phone }), startSession(id));
  }

  if (route === 'POST /api/login') {
    const body = await readJson(req);
    const phone = str(body.phone, 30).replace(/[\s()-]/g, '');
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    // Hash even when the phone is unknown so response time does not reveal which numbers are registered.
    const { hash } = hashPassword(String(body.password ?? ''), user?.salt ?? '0'.repeat(32));
    const ok = user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
    if (!ok) throw new HttpError(401, 'Wrong phone number or password');
    return send(res, 200, me(user), startSession(user.id));
  }

  if (route === 'POST /api/logout') {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return send(res, 200, {}, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (route === 'GET /api/me') return send(res, 200, me(requireRole(req)));

  if (route === 'PUT /api/profile') {
    const user = requireRole(req);
    saveProfile(user.role, user.id, validateProfile(user.role, await readJson(req)));
    return send(res, 200, me(user));
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
    // The education filter is a minimum: "Secondary" also returns Diploma, Degree and so on.
    const levels = EDUCATION.slice(Math.max(0, EDUCATION.indexOf(url.searchParams.get('education'))));
    const rows = db
      .prepare(
        `SELECT w.* FROM workers w
         WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.employer_id = ? AND d.worker_id = w.user_id)
           AND w.location LIKE ? ESCAPE '\\'
           AND (? = '' OR w.work_type = ? OR w.work_type = 'either')
           AND w.age BETWEEN ? AND ?
           AND (? = '' OR w.religion = ?)
           AND w.education IN (${levels.map(() => '?').join(', ')})
         ORDER BY w.user_id DESC LIMIT 30`
      )
      .all(
        user.id, `%${location}%`, type, type,
        Number.isNaN(minAge) ? 0 : minAge, Number.isNaN(maxAge) ? 999 : maxAge,
        religion, religion, ...levels
      );
    return send(res, 200, rows.map((row) => workerView(row, false)));
  }

  if (route === 'POST /api/decisions') {
    const user = requireRole(req, 'employer');
    const body = await readJson(req);
    need(body.decision === 'accept' || body.decision === 'reject', 'Invalid decision');
    const workerId = num(body.worker_id);
    need(db.prepare('SELECT 1 FROM workers WHERE user_id = ?').get(workerId || 0), 'Worker not found');
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
        `SELECT w.*, u.phone, d.worker_response FROM decisions d
         JOIN workers w ON w.user_id = d.worker_id JOIN users u ON u.id = d.worker_id
         WHERE d.employer_id = ? AND d.decision = 'accept' ORDER BY d.created_at DESC`
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
        `SELECT w.*, u.phone, a.status AS application, a.message FROM applications a
         JOIN workers w ON w.user_id = a.worker_id JOIN users u ON u.id = a.worker_id
         WHERE a.job_id = ? ORDER BY a.status = 'decline', a.created_at DESC`
      )
      .all(job.id);
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
         ORDER BY a.worker_id IS NULL, j.created_at DESC, j.id DESC LIMIT 100`
      )
      .all(user.id, `%${location}%`);
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
    const job = db.prepare("SELECT id FROM jobs WHERE id = ? AND status = 'open'").get(Number(m[1]));
    if (!job) throw new HttpError(404, 'This vacancy is no longer open');
    db.prepare('INSERT OR IGNORE INTO applications (job_id, worker_id, message) VALUES (?, ?, ?)').run(job.id, user.id, str(body.message, 600));
    return send(res, 200, {});
  }

  if ((m = /^DELETE \/api\/jobs\/(\d+)\/apply$/.exec(route))) {
    const user = requireRole(req, 'worker');
    db.prepare("DELETE FROM applications WHERE job_id = ? AND worker_id = ? AND status = 'pending'").run(Number(m[1]), user.id);
    return send(res, 200, {});
  }

  // ----- worker side -----

  if (route === 'GET /api/requests') {
    const user = requireRole(req, 'worker');
    const rows = db
      .prepare(
        `SELECT e.*, u.phone, d.worker_response FROM decisions d
         JOIN employers e ON e.user_id = d.employer_id JOIN users u ON u.id = d.employer_id
         WHERE d.worker_id = ? AND d.decision = 'accept' AND d.worker_response IS NOT 'decline'
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

function serveStatic(req, res, url) {
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET') serveStatic(req, res, url);
      else res.writeHead(405).end();
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  })
  .listen(PORT, () => console.log(`HomeConnect running at http://localhost:${PORT}`));
