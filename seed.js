// Fills the database with demo accounts so the app can be tried out straight away.
// Run with: npm run seed
// All demo accounts share DEMO_PASSWORD. Do not run this against a production database.
const { db, hashPassword, createUser } = require('./db');

const DEMO_PASSWORD = 'demo1234';
const DEMO_EMPLOYER_PHONE = '0700000100';

const job = (place, employer_name, employer_phone, people_cared_for) => ({ place, employer_name, employer_phone, people_cared_for });

const worker = (name, age, location, marital_status, num_kids, religion, education, work_type, good_conduct, allergies, work_history, education_details = '') => ({
  name, age, location, marital_status, num_kids, has_kids: num_kids ? 1 : 0, religion, education, education_details, work_type,
  good_conduct: good_conduct ? 1 : 0, good_conduct_doc: null, allergies, photo: null,
  work_history: JSON.stringify(work_history),
});

const workers = [
  worker('Mary Wanjiku', 34, 'Kawangware, Nairobi', 'Married', 2, 'Christian', 'Secondary', 'fulltime', true, '',
    [job('Family home in Lavington', 'Mrs. Achieng Odhiambo', '0700000201', 5), job('Family home in Kileleshwa', 'Mr. Peter Kamau', '0700000202', 3)]),
  worker('Fatuma Hassan', 28, 'Eastleigh, Nairobi', 'Single', 0, 'Muslim', 'Certificate / Vocational', 'either', true, 'Does not handle pork',
    [job('Family home in South C', 'Mrs. Amina Yusuf', '0700000203', 4)], 'Certificate in childcare, Nairobi Technical Training Institute'),
  worker('Grace Atieno', 41, 'Kibera, Nairobi', 'Widowed', 3, 'Christian', 'Primary', 'fulltime', false, 'Allergic to dust',
    [job('Family home in Karen', 'Mrs. Susan Mwangi', '0700000204', 6), job('Guest house in Langata', 'Mr. John Otieno', '0700000205', 8)]),
  worker('Esther Chebet', 23, 'Rongai, Kajiado', 'Single', 0, 'Christian', 'Secondary', 'parttime', true, '', []),
  worker('Josephine Mutua', 37, 'Githurai, Kiambu', 'Separated', 1, 'Christian', 'Diploma', 'either', true, 'Vegetarian',
    [job('Family home in Runda', 'Dr. Lucy Njoroge', '0700000206', 4)], 'Diploma in early childhood development'),
  worker('Zainabu Ali', 31, 'Nyali, Mombasa', 'Married', 2, 'Muslim', 'Secondary', 'fulltime', false, '',
    [job('Family home in Bamburi', 'Mrs. Halima Said', '0700000207', 5)]),
];

const insert = db.prepare('SELECT 1 FROM users WHERE phone = ?');
let created = 0;

workers.forEach((profile, i) => {
  const phone = `07000000${String(i + 1).padStart(2, '0')}`;
  if (insert.get(phone)) return;
  createUser('worker', phone, hashPassword(DEMO_PASSWORD), { ...profile, id_number: `DEMO${1000 + i}` });
  created++;
});

if (!insert.get(DEMO_EMPLOYER_PHONE)) {
  createUser('employer', DEMO_EMPLOYER_PHONE, hashPassword(DEMO_PASSWORD), {
    name: 'Demo Employer', location: 'Kilimani, Nairobi', age: 38, id_number: 'DEMO2000', num_kids: 2, house_size: '3 bedrooms', religion: 'Christian',
  });
  created++;
}

const employerId = db.prepare('SELECT id FROM users WHERE phone = ?').get(DEMO_EMPLOYER_PHONE).id;
if (!db.prepare('SELECT 1 FROM jobs WHERE employer_id = ?').get(employerId)) {
  const addJob = db.prepare(
    `INSERT INTO jobs (employer_id, title, location, work_type, salary, start_date, duties, requirements) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  addJob.run(employerId, 'Live-in nanny for two kids', 'Kilimani, Nairobi', 'fulltime', 'KES 18,000 / month', '',
    'Caring for a 3-year-old and a 7-year-old, school runs, preparing meals for the kids and light housework.',
    'Experience with young children. Certificate of good conduct.');
  addJob.run(employerId, 'Weekend house help', 'Kilimani, Nairobi', 'parttime', 'KES 1,200 / day', '',
    'Cleaning, laundry and ironing on Saturdays and Sundays.', '');
  created += 2;
}

console.log(`Seeded ${created} demo account(s) / vacancies.`);
console.log(`Demo employer login: ${DEMO_EMPLOYER_PHONE} — worker logins: 0700000001 to 070000000${workers.length} — password is DEMO_PASSWORD in seed.js`);
