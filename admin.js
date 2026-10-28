// Command-line tools for reviewing reports and removing abusive accounts. Run on the server:
//   npm run admin                     list open reports
//   npm run admin -- all              list every report, including resolved ones
//   npm run admin -- resolve <id>     mark a report as dealt with
//   npm run admin -- delete <phone>   permanently delete an account and everything linked to it
const { db } = require('./db');

const [command, arg] = process.argv.slice(2);

function list(all) {
  const rows = db
    .prepare(
      `SELECT r.*, u.phone AS reporter_phone, COALESCE(w.name, e.name) AS reporter_name,
         (SELECT COUNT(*) FROM reports r2 WHERE r2.reported_phone = r.reported_phone) AS times_reported
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
       LEFT JOIN workers w ON w.user_id = r.reporter_id LEFT JOIN employers e ON e.user_id = r.reporter_id
       ${all ? '' : "WHERE r.status = 'open'"} ORDER BY r.id`
    )
    .all();
  if (!rows.length) return console.log(all ? 'No reports.' : 'No open reports.');
  for (const r of rows) {
    console.log(`#${r.id}  ${r.created_at}  [${r.status}]  ${r.reason}`);
    console.log(`  Reported: ${r.reported_name} (${r.reported_phone})${r.reported_id ? '' : ' (account deleted)'}, reported ${r.times_reported} time(s) in total`);
    console.log(`  By:       ${r.reporter_name ?? '(account deleted)'}${r.reporter_phone ? ` (${r.reporter_phone})` : ''}`);
    if (r.details) console.log(`  Details:  ${r.details}`);
    console.log('');
  }
}

if (!command || command === 'all') {
  list(command === 'all');
} else if (command === 'resolve' && arg) {
  const { changes } = db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(Number(arg));
  console.log(changes ? `Report #${arg} resolved.` : `No report #${arg}.`);
} else if (command === 'delete' && arg) {
  const { changes } = db.prepare('DELETE FROM users WHERE phone = ?').run(arg.replace(/[\s()-]/g, ''));
  console.log(changes ? `Account ${arg} deleted.` : `No account with phone ${arg}.`);
} else {
  console.log('Usage: npm run admin [-- all | resolve <id> | delete <phone>]');
  process.exitCode = 1;
}
