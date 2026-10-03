// Creates (or promotes) the first admin so someone can sign in and manage the app.
//   npm run bootstrap-admin -- you@company.com First Last
// Reads VOLCANO_API_URL / VOLCANO_SERVICE_KEY / VOLCANO_DATABASE from the environment
// (the npm script loads volcano/volcano.env).
import { normalizeEmail } from '../src/lib/employee-import';
import { rows } from '../src/server/db';
import { serviceClient } from '../src/server/volcano';

async function main() {
  const [rawEmail, first, last] = process.argv.slice(2);
  if (!rawEmail || !first || !last) {
    console.error('Usage: npm run bootstrap-admin -- <email> <first name> <last name>');
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);
  const db = serviceClient();
  const [existing] = await rows<{ id: string }>(db.from('employees').select('id').eq('email', email));
  if (existing) {
    await rows(db.update('employees', { role: 'admin', status: 'active', termination_date: null }).eq('id', existing.id));
    console.log(`${email} is now an admin.`);
  } else {
    await rows(db.insert('employees', { email, first_name: first, last_name: last, role: 'admin', hire_date: new Date().toISOString().slice(0, 10) }));
    console.log(`Created admin ${email}.`);
  }
  console.log('Next: open the app, choose "Create your account" with this email, and sign in.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
