import { VolcanoAuth } from '@volcano.dev/sdk';

function env(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing environment variable ${names[0]}`);
}

const apiUrl = () => env('VOLCANO_API_URL', 'NEXT_PUBLIC_VOLCANO_API_URL');

// PAYROLL_DATABASE first: the local stack has one project shared by every local repo, so a
// project variable as generic as VOLCANO_DATABASE can be set by another app.
export const databaseName = (): string =>
  process.env.PAYROLL_DATABASE || process.env.VOLCANO_DATABASE || process.env.NEXT_PUBLIC_VOLCANO_DATABASE || 'payroll';

/** Acts as the signed-in user; RLS applies. */
export function userClient(accessToken: string): VolcanoAuth {
  const v = new VolcanoAuth({ apiUrl: apiUrl(), anonKey: env('VOLCANO_ANON_KEY', 'NEXT_PUBLIC_VOLCANO_ANON_KEY'), accessToken });
  v.database(databaseName());
  return v;
}

/** Bypasses RLS. Server-only: functions, Next.js route handlers, scripts. */
export function serviceClient(): VolcanoAuth {
  const key = env('VOLCANO_SERVICE_KEY');
  const v = new VolcanoAuth({ apiUrl: apiUrl(), anonKey: key, accessToken: key });
  v.database(databaseName());
  return v;
}
