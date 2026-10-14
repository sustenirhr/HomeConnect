const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'homeconnect.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('employer', 'worker')),
    phone      TEXT NOT NULL UNIQUE,
    pass_hash  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workers (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    id_number         TEXT NOT NULL,
    photo             TEXT,
    marital_status    TEXT NOT NULL,
    age               INTEGER NOT NULL,
    location          TEXT NOT NULL,
    has_kids          INTEGER NOT NULL,
    num_kids          INTEGER NOT NULL,
    religion          TEXT NOT NULL,
    work_history      TEXT NOT NULL,
    education         TEXT NOT NULL,
    education_details TEXT NOT NULL,
    good_conduct      INTEGER NOT NULL,
    good_conduct_doc  TEXT,
    allergies         TEXT NOT NULL,
    work_type         TEXT NOT NULL CHECK (work_type IN ('fulltime', 'parttime', 'either'))
  );

  CREATE TABLE IF NOT EXISTS employers (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL,
    age        INTEGER NOT NULL,
    id_number  TEXT NOT NULL,
    num_kids   INTEGER NOT NULL,
    house_size TEXT NOT NULL,
    religion   TEXT NOT NULL
  );

  -- One row per employer/worker pair once the employer accepts or rejects.
  -- worker_response stays NULL until the worker answers an accepted request.
  CREATE TABLE IF NOT EXISTS decisions (
    employer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    worker_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    decision        TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
    worker_response TEXT CHECK (worker_response IN ('accept', 'decline')),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (employer_id, worker_id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY,
    employer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    location     TEXT NOT NULL,
    work_type    TEXT NOT NULL CHECK (work_type IN ('fulltime', 'parttime', 'either')),
    salary       TEXT NOT NULL,
    start_date   TEXT NOT NULL,
    duties       TEXT NOT NULL,
    requirements TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- A worker applies once per vacancy; the employer then accepts or declines.
  CREATE TABLE IF NOT EXISTS applications (
    job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accept', 'decline')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, worker_id)
  );

  -- Chat between a matched employer and worker. read_at is set when the recipient opens the chat.
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    employer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    worker_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_by_pair ON messages (employer_id, worker_id, id);
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

const WORKER_COLUMNS = [
  'name', 'id_number', 'photo', 'marital_status', 'age', 'location', 'has_kids', 'num_kids', 'religion',
  'work_history', 'education', 'education_details', 'good_conduct', 'good_conduct_doc', 'allergies', 'work_type',
];
const EMPLOYER_COLUMNS = ['name', 'location', 'age', 'id_number', 'num_kids', 'house_size', 'religion'];

function saveProfile(role, userId, profile) {
  const table = role === 'worker' ? 'workers' : 'employers';
  const columns = role === 'worker' ? WORKER_COLUMNS : EMPLOYER_COLUMNS;
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (user_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`
  ).run(userId, ...columns.map((c) => profile[c] ?? null));
}

function createUser(role, phone, password, profile) {
  const { salt, hash } = hashPassword(password);
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (role, phone, pass_hash, salt) VALUES (?, ?, ?, ?)')
      .run(role, phone, hash, salt);
    saveProfile(role, Number(lastInsertRowid), profile);
    db.exec('COMMIT');
    return Number(lastInsertRowid);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, hashPassword, saveProfile, createUser };
