// The integration tests wipe the local database, including the admin you sign in with.
// After the run, put that admin back with `npm run bootstrap-admin`, reading
// LOCAL_ADMIN_EMAIL / LOCAL_ADMIN_FIRST_NAME / LOCAL_ADMIN_LAST_NAME from volcano/volcano.env.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const ENV_FILE = 'volcano/volcano.env';

function restoreAdmin(): void {
  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
  const { LOCAL_ADMIN_EMAIL: email, LOCAL_ADMIN_FIRST_NAME: first, LOCAL_ADMIN_LAST_NAME: last } = env;
  if (!email || !first || !last) {
    console.warn(`\nThe local admin was wiped. Set LOCAL_ADMIN_EMAIL, LOCAL_ADMIN_FIRST_NAME and LOCAL_ADMIN_LAST_NAME in ${ENV_FILE} to restore it after each run.`);
    return;
  }
  execFileSync('npm', ['run', '--silent', 'bootstrap-admin', '--', email, first, last], { stdio: 'inherit' });
}

export default function setup(): () => void {
  return restoreAdmin;
}
