'use client';
import { VolcanoAuth } from '@volcano.dev/sdk';

let client: VolcanoAuth | null = null;

/** Browser client: acts as the signed-in user, so RLS applies to every query. */
export function getVolcano(): VolcanoAuth {
  if (!client) {
    client = new VolcanoAuth({
      apiUrl: process.env.NEXT_PUBLIC_VOLCANO_API_URL!,
      anonKey: process.env.NEXT_PUBLIC_VOLCANO_ANON_KEY!,
    });
    client.database(process.env.NEXT_PUBLIC_VOLCANO_DATABASE || 'payroll');
  }
  return client;
}
