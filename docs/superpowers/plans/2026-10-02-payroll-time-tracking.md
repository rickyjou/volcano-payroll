# Payroll & Time Tracking on Volcano — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-company time-tracking and gross-pay payroll app on Volcano with an employee portal, manager approvals, an admin area, and provider-neutral exports (file presets, read-only API, signed webhooks).

**Architecture:** Next.js app in `web/` talks to Volcano Postgres directly under row-level security; database triggers enforce the timesheet and payroll-run state machines. Privileged work (pay calculation, finalize, exports, API keys, webhook delivery, account linking, bulk import) runs in Volcano Functions bundled from `src/functions/`. Pure logic (pay calc, exporters, CSV, signing, validation) lives in `src/lib/` and is shared by functions, the web app and the `/api/v1` route.

**Tech Stack:** TypeScript, Volcano (Postgres + RLS, Auth, Functions, Hosting) via `@volcano.dev/sdk`, Next.js 16 (App Router, client components), Vitest, esbuild, tsx.

**Spec:** `docs/superpowers/specs/2026-10-02-payroll-time-tracking-design.md`

## How this plan was validated

Before writing, the code in this plan was prototyped in a scratch directory against the real local Volcano stack (CLI v0.36.0, SDK 1.15.1, Next.js 16.3.8, Node 24):

- All 74 unit tests pass (also under `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles`).
- All 134 generated migrations apply to a fresh database and re-apply cleanly (idempotent).
- The database integration suites (`rls`, `lifecycle`, `webhooks`, `integration-api`; 37 tests) pass against a fresh local database.
- `tsc --noEmit` passes for `src/`, `tests/`, `scripts/` and `web/`; `next build web` succeeds; all six functions bundle with esbuild and export `handler`.
- **Not yet run:** `tests/integration/functions.test.ts` (needs the functions deployed to the local project) and the browser click-through. Tasks 11 and 18 run them.

Facts discovered while prototyping, which the code relies on:

| Fact | Consequence |
|---|---|
| SDK queries need a session; passing the service key as both `anonKey` and `accessToken` works server-side and bypasses RLS. In that context `auth.uid()` is NULL. | `serviceClient()` does exactly this; DB guards treat `auth.uid() IS NULL` as the trusted system. |
| JSON objects/arrays can't be sent as column values ("Query failed"); a JSON **string** into a `JSONB` column works and reads back parsed. | Always write JSONB with `JSON.stringify` (`asJson`). |
| `NUMERIC` columns read back as strings (`"9.00"`); `BIGINT` as numbers. | Convert with `Number()` (`num`). |
| Guard errors arrive as `Query failed: ERROR: CONFLICT:<CODE>: <message> (SQLSTATE P0001)`. | `parseDbError` maps them to 409/403 with the message. |
| A write that RLS filters out returns `data: []` and **no error**. | `mutated()` / `write()` treat zero rows as forbidden. |
| `volcano migrations deploy` runs every file every time, one statement per file, no tracking. | Grouped SQL sources are split into numbered single-statement files by a generator; every statement is idempotent. |
| Volcano returns a session at sign-up **before** the email is confirmed. | `employee-link` refuses unconfirmed emails (local-only opt-out), so nobody can claim a colleague's invited record. |
| Passwords must be at least 15 characters. | Login form says so. |
| The SDK has no bulk insert, transactions, joins, upserts or signed download URLs. | Run lines are written by a trigger from a JSON text column in one insert; exports are stored in the DB. |
| Scheduled function invocations need the SUPERAGENT plan. | Webhooks also dispatch on finalize/void and on an admin button. |
| `npm init` writes `"type": "commonjs"`, which breaks `next build`. | `package.json` is written by hand with no `type` field. |
| Next.js needs `turbopack.root` set to the repo root to import `../src`. | `web/next.config.ts` sets it. |
| The local Volcano stack is one project shared with `../tinyurl` (which uses database `app`). | This app uses database `payroll`. Deleting a local database does not drop its data, so use a new name if you need a clean one. |

## Spec deviations (decided while planning)

1. **Exports are stored in the `exports.content` column, not a Storage bucket.** The SDK has no signed URLs, files are small (under 1 MB for 500 employees), and this keeps one access-control model (RLS).
2. **The integration API is a Next.js route (`web/app/api/v1/[...path]`) calling `src/server/integration-api.ts`**, not a separate `integration-api` function. A function would need the same service key in the Next server anyway; this removes a hop.
3. **Webhook retries don't depend on a scheduler.** Dispatch runs after finalize/void and from **Integrations → Send due deliveries now**; a cron scheduler is optional (SUPERAGENT plan).
4. **Settings use one `ot_multiplier` and one `dt_multiplier`** instead of separate weekly/daily OT multipliers (they are 1.5 in every common rule set).
5. **`payroll_run_lines.pay_period_id`** is copied from the run so employees can group their own lines by month without reading `payroll_runs` (which holds company totals).
6. **Array/JSON columns are `JSONB`** (`skipped_employee_ids`, `warnings`, `events`) and `lines_input` is `TEXT`, because of how the SDK sends values.
7. **Provider presets live in code** (`src/lib/exporters/presets.ts`); only custom mappings are rows in `export_mappings`, addressed as `custom:<uuid>`.
8. **Draft runs can be discarded** (`payroll-run` action `discard`) as well as regenerated.

## Global Constraints

- Node 22+ (functions are bundled for `node22`); Volcano CLI 0.36+; local stack via `volcano start`.
- Database name `payroll` everywhere (`VOLCANO_DATABASE` / `NEXT_PUBLIC_VOLCANO_DATABASE`).
- Every migration file holds exactly one SQL statement and is idempotent. Edit `db/migrations-src/*.sql`, then `npm run db:generate`; never edit `volcano/migrations/NNN_*.sql` by hand.
- Money is integer cents, hours integer hundredths, days integer tenths inside calculations; dates are `YYYY-MM-DD` strings with UTC-only date math.
- JSONB values are written as `JSON.stringify(...)` strings; NUMERIC values read back as strings.
- Functions return `statusCode: 200` on success and `{ error, code, details? }` with 400/401/403/404/409/500 on failure.
- The service key (`VOLCANO_SERVICE_KEY`) never appears in browser code or any `NEXT_PUBLIC_*` variable.
- Root `package.json` has no `"type"` field.
- Integration tests wipe the database they run against and refuse to run against anything but `localhost`.
- No cloud deploy, cloud variable change or cloud migration as part of this plan. Cloud deploy is a separate, explicitly approved step (README runbook).
- Built function bundles in `volcano/functions/*.js` are committed (Volcano deploys what's on disk).

## Review Focus

1. **Someone signs up with a colleague's invited email before confirming it.** Expect `employee-link` to refuse with `EMAIL_NOT_CONFIRMED` unless the local-only flag is set. Pinned by `tests/unit/auth-guards.test.ts` (Task 9).
2. **Data changes after a draft run is generated** (a late approval, a raise, a settings change). Expect finalize to refuse with `RUN_STALE` until the draft is regenerated. Pinned in `tests/integration/lifecycle.test.ts` (Task 8).
3. **Names or IDs containing commas, quotes, newlines or leading `= + - @`** in exported CSVs. Expect RFC 4180 quoting and a `'` prefix on text cells so spreadsheets don't execute them. Pinned in `tests/unit/exporters.test.ts` (Task 4).
4. **Two admins (or a double click) finalizing or generating at once.** Expect one success and one clear failure, never two active runs. Pinned by the unique-index test in `lifecycle.test.ts` (Task 8) and the second-finalize test in `functions.test.ts` (Task 11).
5. **A server or browser in a far-off time zone.** Expect identical dates and pay. Pinned by `npm run test:tz` (Task 3), which runs every unit test under UTC+14 and UTC−7.

Also covered: the last admin can't demote or terminate themselves (`LAST_ADMIN`, Task 8); re-importing the same CSV updates by email instead of duplicating (Task 11).

## File map

```
package.json, tsconfig.json, vitest.config.ts, vitest.integration.config.ts, .gitignore, README.md
db/migrations-src/0[1-6]_*.sql      grouped SQL sources (one -- @file marker per statement)
scripts/migrations.ts               split/validate/generate migrations (unit tested)
scripts/gen-migrations.ts           CLI: db/migrations-src → volcano/migrations
scripts/bootstrap-admin.ts          create/promote the first admin (service key)
src/lib/dates.ts money.ts types.ts  primitives
src/lib/pay-calc/{index,overtime,lines}.ts   gross pay calculation
src/lib/csv.ts                      RFC 4180 writer/parser + formula guard
src/lib/exporters/{index,types,presets}.ts   mapping-driven exports
src/lib/signing.ts random.ts        webhook HMAC, API keys, retry schedule, random tokens
src/lib/db-errors.ts                map guard errors to status/code/message
src/lib/employee-import.ts          CSV import parsing/validation
src/lib/timesheet-grid.ts           grid ↔ entries diffing and cell parsing
src/server/{http,volcano,db,auth}.ts          function/server plumbing
src/server/{payroll-data,runs,mappings,webhooks,integration-api}.ts
src/functions/{employee-link,employee-import,payroll-run,payroll-export,webhook-dispatch,api-key-create}.ts
volcano/functions/*.js              esbuild output (committed)
volcano/migrations/NNN_*.sql        generated (committed)
volcano/volcano-config.yaml, volcano/volcano.env.example
web/next.config.ts tsconfig.json .env.example
web/lib/{volcano,api,format,session,data}.ts(x)
web/components/{ui,AppShell,TimesheetGrid,EmployeeForm,MappingEditor}.tsx
web/app/{layout,page,globals.css}, login, portal(+history,profile), manage,
web/app/admin/{page,employees(+[id],import),periods,runs(+[id]),integrations,settings}
web/app/api/v1/[...path]/route.ts
tests/unit/*.test.ts, tests/unit/fixtures.ts
tests/integration/{helpers,finalized-run}.ts, *.test.ts
```

---
### Task 1: Project scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.integration.config.ts`, `.gitignore`, `web/.env.example`
- Create (via `volcano init`): `volcano/.gitignore`, `volcano/README.md`, `volcano/migrations/README.md`, `volcano/volcano.env`
- Replace: `volcano/volcano.env.example`

**Interfaces:**
- Produces: npm scripts `test`, `test:tz`, `test:integration`, `typecheck`, `build:functions`, `db:generate`, `db:migrate`, `bootstrap-admin`, `dev`, `build`; local database `payroll`.

- [ ] **Step 1: Check the toolchain**

Run: `node --version && volcano --version && volcano status`
Expected: Node ≥ 22, volcano ≥ 0.36, all services `running`. If the stack is down, run `volcano start`. Note the Anon Key and Service Key from `volcano status`.

- [ ] **Step 2: Write `package.json` by hand (no `"type"` field), then install dependencies**

`package.json`:

```json
{
  "name": "payroll",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev web",
    "build": "next build web",
    "start": "next start web",
    "test": "vitest run",
    "test:tz": "TZ=Pacific/Kiritimati vitest run && TZ=America/Los_Angeles vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit && tsc --noEmit -p web",
    "build:functions": "esbuild src/functions/*.ts --bundle --platform=node --target=node22 --format=cjs --outdir=volcano/functions --log-level=warning",
    "db:generate": "tsx scripts/gen-migrations.ts",
    "db:migrate": "npm run db:generate && volcano migrations deploy --all -d payroll",
    "bootstrap-admin": "tsx --env-file=volcano/volcano.env scripts/bootstrap-admin.ts"
  }
}
```

Run:
```sh
npm install @volcano.dev/sdk next react react-dom
npm install -D typescript esbuild vitest tsx @types/node @types/react @types/react-dom
```
Expected: installs succeed; `package.json` now also lists dependencies. Confirm `grep '"type"' package.json` prints nothing.

- [ ] **Step 3: Add TypeScript and Vitest configs**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "vitest*.config.ts"]
}
```
`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
```
`vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Runs against the local Volcano stack (volcano start). Tests share one
// database and reset it, so files run one at a time.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Add `.gitignore`**

`.gitignore`:

```gitignore
node_modules/
.next/
web/.next/
web/next-env.d.ts
web/.env.local
*.tsbuildinfo
.vitest/
.DS_Store
```

- [ ] **Step 5: Scaffold the Volcano directory and env files**

Run: `volcano init`
Expected: creates `volcano/` with `.gitignore` (ignores `volcano.env`), `README.md`, `migrations/README.md`, `volcano.env`, `volcano.env.example`.

Replace `volcano/volcano.env.example` with:

`volcano/volcano.env.example`:

```sh
# Copy to volcano/volcano.env (gitignored). Values from `volcano status` for the local stack.
VOLCANO_API_URL=http://localhost:8000
VOLCANO_ANON_KEY=ak-...
VOLCANO_SERVICE_KEY=sk-...
VOLCANO_DATABASE=payroll

# Local only: the local stack sends no confirmation emails. NEVER set this in the cloud.
PAYROLL_ALLOW_UNCONFIRMED_EMAIL=true
```

Copy it to `volcano/volcano.env` and fill in the real local keys from `volcano status`. Then create `web/.env.example`:

`web/.env.example`:

```sh
# Copy to web/.env.local (gitignored).
NEXT_PUBLIC_VOLCANO_API_URL=http://localhost:8000
NEXT_PUBLIC_VOLCANO_ANON_KEY=ak-...
NEXT_PUBLIC_VOLCANO_DATABASE=payroll

# Server-only (no NEXT_PUBLIC_ prefix): used by /api/v1 for provider integrations.
VOLCANO_SERVICE_KEY=sk-...
```

Copy it to `web/.env.local` with the same local keys.

- [ ] **Step 6: Create the local database**

Run: `volcano databases create payroll`
Expected: `Status: active`. (If `payroll` already exists from earlier experiments, run `volcano databases list`; reuse it only if it holds nothing you need, because integration tests wipe it.)

- [ ] **Step 7: Verify the tooling runs**

Run: `npx vitest run --passWithNoTests`
Expected: exits 0 with "No test files found".

- [ ] **Step 8: Commit**

```sh
git add package.json package-lock.json tsconfig.json vitest.config.ts vitest.integration.config.ts .gitignore volcano/.gitignore volcano/README.md volcano/migrations/README.md volcano/volcano.env.example web/.env.example
git commit -m "chore: scaffold payroll project tooling"
```
Check `git status` first: `volcano/volcano.env` and `web/.env.local` must NOT be staged.

---
### Task 2: Date and money primitives

**Files:**
- Create: `src/lib/dates.ts`, `src/lib/money.ts`
- Test: `tests/unit/dates-money.test.ts`

**Interfaces:**
- Produces (`src/lib/dates.ts`): `type ISODate = string`; `toUtc(d): number`; `fromUtc(t): ISODate`; `addDays(d, n): ISODate`; `dayOfWeek(d): number` (0=Sun); `isWeekday(d): boolean`; `eachDay(start, end): ISODate[]`; `weekStart(d, startsOn): ISODate`; `monthBounds('YYYY-MM'): {start, end}`; `maxDate(a,b)`; `minDate(a,b)`.
- Produces (`src/lib/money.ts`): `divRoundHalfUp(n, d): number`; `toHundredths(x)`; `toTenths(x)`; `toThousandths(x)`; `centsToDollars(cents): string`; `dollarsToCents(input): number` (throws `Invalid amount`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/dates-money.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, eachDay, isWeekday, monthBounds, toUtc, weekStart } from '../../src/lib/dates';
import { centsToDollars, divRoundHalfUp, dollarsToCents } from '../../src/lib/money';

describe('dates', () => {
  it('knows 2026-09-01 is a Tuesday', () => {
    expect(dayOfWeek('2026-09-01')).toBe(2);
  });
  it('rejects impossible dates', () => {
    expect(() => toUtc('2026-02-30')).toThrow('Invalid date');
    expect(() => toUtc('2026-9-1')).toThrow('Invalid date');
  });
  it('adds days across month and year ends', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('lists every day inclusive', () => {
    expect(eachDay('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  it('counts 22 weekdays in September 2026', () => {
    const { start, end } = monthBounds('2026-09');
    expect([start, end]).toEqual(['2026-09-01', '2026-09-30']);
    expect(eachDay(start, end).filter(isWeekday)).toHaveLength(22);
  });
  it('handles February in a leap year', () => {
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
  it('finds the workweek start', () => {
    expect(weekStart('2026-09-01', 0)).toBe('2026-08-30'); // Sunday-start week
    expect(weekStart('2026-09-01', 1)).toBe('2026-08-31'); // Monday-start week
    expect(weekStart('2026-08-30', 0)).toBe('2026-08-30');
  });
});

describe('money', () => {
  it('rounds half up', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 3)).toBe(1);
    expect(divRoundHalfUp(5005, 10)).toBe(501);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
  });
  it('is exact for large values', () => {
    expect(divRoundHalfUp(144_000_000, 264)).toBe(545455);
    expect(divRoundHalfUp(9_007_199_254_740_990, 3)).toBe(3_002_399_751_580_330);
  });
  it('formats and parses dollars', () => {
    expect(centsToDollars(123456)).toBe('1234.56');
    expect(centsToDollars(5)).toBe('0.05');
    expect(centsToDollars(-250)).toBe('-2.50');
    expect(dollarsToCents('$1,234.5')).toBe(123450);
    expect(dollarsToCents('40')).toBe(4000);
    expect(() => dollarsToCents('12.345')).toThrow('Invalid amount');
    expect(() => dollarsToCents('-5')).toThrow('Invalid amount');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/dates-money.test.ts`
Expected: FAIL, cannot resolve `../../src/lib/dates`.

- [ ] **Step 3: Implement**

`src/lib/dates.ts`:

```ts
// Calendar dates are plain 'YYYY-MM-DD' strings. All math is done in UTC so the
// host time zone can never shift a date.
export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toUtc(d: ISODate): number {
  const m = ISO_RE.exec(d);
  if (!m) throw new Error(`Invalid date: ${d}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (fromUtc(t) !== d) throw new Error(`Invalid date: ${d}`);
  return t;
}

export function fromUtc(t: number): ISODate {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(d: ISODate): number {
  return new Date(toUtc(d)).getUTCDay();
}

export function isWeekday(d: ISODate): boolean {
  const w = dayOfWeek(d);
  return w !== 0 && w !== 6;
}

export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let t = toUtc(start), last = toUtc(end); t <= last; t += DAY_MS) out.push(fromUtc(t));
  return out;
}

export function weekStart(d: ISODate, startsOn: number): ISODate {
  return addDays(d, -((dayOfWeek(d) - startsOn + 7) % 7));
}

/** 'YYYY-MM' → first and last day of that month */
export function monthBounds(month: string): { start: ISODate; end: ISODate } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Invalid month: ${month}`);
  return { start: fromUtc(Date.UTC(y, mo - 1, 1)), end: fromUtc(Date.UTC(y, mo, 0)) };
}

export const maxDate = (a: ISODate, b: ISODate): ISODate => (a > b ? a : b);
export const minDate = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b);
```
`src/lib/money.ts`:

```ts
// Money is integer cents; hours are integer hundredths; days are integer tenths.

/** n / d rounded half-up, exact for safe integers. */
export function divRoundHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) {
    throw new Error(`divRoundHalfUp needs safe integers and d > 0 (got ${n}/${d})`);
  }
  if (n < 0) return -divRoundHalfUp(-n, d);
  let q = Math.floor(n / d);
  let r = n - q * d;
  while (r < 0) { q -= 1; r += d; }
  while (r >= d) { q += 1; r -= d; }
  return 2 * r >= d ? q + 1 : q;
}

export const toHundredths = (x: number): number => Math.round(x * 100);
export const toTenths = (x: number): number => Math.round(x * 10);
export const toThousandths = (x: number): number => Math.round(x * 1000);

export function centsToDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** '12.5' / '1,234.56' / '$40' → cents; throws on anything else. */
export function dollarsToCents(input: string): number {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${input}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/dates-money.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```sh
git add src/lib/dates.ts src/lib/money.ts tests/unit/dates-money.test.ts
git commit -m "feat: add UTC date helpers and exact cent arithmetic"
```

---
### Task 3: Gross pay calculation

**Files:**
- Create: `src/lib/types.ts`, `src/lib/pay-calc/overtime.ts`, `src/lib/pay-calc/lines.ts`, `src/lib/pay-calc/index.ts`
- Test: `tests/unit/fixtures.ts`, `tests/unit/pay-calc.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces (`src/lib/types.ts`): `PayType`, `EntryCode` (`REG|PTO|SICK|HOL`), `EarningCode` (adds `OT|DT|SAL`), `ENTRY_CODES`, `EARNING_CODES`, `CalcEmployee`, `CompSegment`, `TimeEntry`, `TimesheetStatus`, `CalcTimesheet`, `OvertimeSettings`, `CalcInput`, `RunLine`, `WarningCode`, `CalcWarning`, `CodeTotal`, `RunTotals`, `CalcResult`.
- Produces (`src/lib/pay-calc`): `calculateRun(input: CalcInput): CalcResult`; `compensationOn(comp, employeeId, day): CompSegment | null`; `employmentDays(emp, period): ISODate[]`; `splitOvertime(current: DayHours[], prior: DayHours[], s): DaySplit[]`.

Rules (from the spec, made precise): salary = annual ÷ 12 × (segment weekdays ÷ period weekdays), one `SAL` line per compensation segment, time off reported with $0; hourly REG split by daily DT/OT tiers then weekly OT (only regular hours count toward the weekly threshold; prior-period approved hours in the first workweek count); time off paid at base rate and never counts toward OT; daily = days × day rate, plus an optional FLSA day-rate OT premium `(mult − 1) × (week pay ÷ week hours) × OT hours`; every line rounds once, half up. Blocking warnings: no approved timesheet, missing compensation on an employed day, more than 24 h on a day. Non-blocking: entries outside employment dates (ignored).

- [ ] **Step 1: Add the shared types**

`src/lib/types.ts`:

```ts
import type { ISODate } from './dates';

export type PayType = 'salary' | 'hourly' | 'daily';
export type EntryCode = 'REG' | 'PTO' | 'SICK' | 'HOL';
export type EarningCode = EntryCode | 'OT' | 'DT' | 'SAL';
export const ENTRY_CODES: EntryCode[] = ['REG', 'PTO', 'SICK', 'HOL'];
export const EARNING_CODES: EarningCode[] = ['SAL', 'REG', 'OT', 'DT', 'PTO', 'SICK', 'HOL'];

export interface CalcEmployee {
  id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  work_state: string | null;
  hire_date: ISODate;
  termination_date: ISODate | null;
}

export interface CompSegment {
  employee_id: string;
  pay_type: PayType;
  /** salary: annual; hourly: per hour; daily: per day — all in cents */
  rate_cents: number;
  effective_from: ISODate;
}

export interface TimeEntry {
  work_date: ISODate;
  earning_code: EntryCode;
  hours: number | null;
  days: number | null;
}

export type TimesheetStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface CalcTimesheet {
  employee_id: string;
  status: TimesheetStatus;
  entries: TimeEntry[];
}

export interface OvertimeSettings {
  ot_weekly_threshold: number | null;
  ot_daily_threshold: number | null;
  dt_daily_threshold: number | null;
  ot_multiplier: number;
  dt_multiplier: number;
  ot_applies_to_daily: boolean;
  /** 0 = Sunday … 6 = Saturday */
  week_starts_on: number;
}

export interface CalcInput {
  period: { start: ISODate; end: ISODate };
  employees: CalcEmployee[];
  compensation: CompSegment[];
  timesheets: CalcTimesheet[];
  /** Approved entries from the previous period that fall in the first (partial) workweek. */
  priorEntries: Record<string, TimeEntry[]>;
  settings: OvertimeSettings;
  skippedEmployeeIds: string[];
}

export interface RunLine {
  employee_id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  pay_type: PayType;
  work_state: string | null;
  earning_code: EarningCode;
  hours: number | null;
  days: number | null;
  rate_cents: number;
  amount_cents: number;
}

export type WarningCode =
  | 'NO_APPROVED_TIMESHEET'
  | 'NO_COMPENSATION'
  | 'HOURS_OVER_24'
  | 'ENTRY_OUTSIDE_EMPLOYMENT';

export interface CalcWarning {
  employee_id: string;
  code: WarningCode;
  blocking: boolean;
  message: string;
}

export interface CodeTotal { hours: number; days: number; amount_cents: number }

export interface RunTotals {
  employee_count: number;
  gross_cents: number;
  by_code: Partial<Record<EarningCode, CodeTotal>>;
}

export interface CalcResult {
  lines: RunLine[];
  warnings: CalcWarning[];
  totals: RunTotals;
}
```

- [ ] **Step 2: Write the test fixtures and failing tests**

`tests/unit/fixtures.ts`:

```ts
import type { CalcEmployee, CalcInput, CompSegment, OvertimeSettings, TimeEntry } from '../../src/lib/types';

export const SEPT = { start: '2026-09-01', end: '2026-09-30' };

export const FEDERAL: OvertimeSettings = {
  ot_weekly_threshold: 40,
  ot_daily_threshold: null,
  dt_daily_threshold: null,
  ot_multiplier: 1.5,
  dt_multiplier: 2,
  ot_applies_to_daily: false,
  week_starts_on: 0,
};

export function emp(id: string, extra: Partial<CalcEmployee> = {}): CalcEmployee {
  return {
    id,
    external_id: `X-${id}`,
    first_name: 'Ada',
    last_name: id.toUpperCase(),
    email: `${id}@example.com`,
    work_state: 'CA',
    hire_date: '2020-01-01',
    termination_date: null,
    ...extra,
  };
}

export const comp = (employee_id: string, pay_type: CompSegment['pay_type'], rate_cents: number, effective_from = '2020-01-01'): CompSegment =>
  ({ employee_id, pay_type, rate_cents, effective_from });

export const reg = (work_date: string, hours: number | null, days: number | null = null): TimeEntry =>
  ({ work_date, earning_code: 'REG', hours, days });

export const off = (code: 'PTO' | 'SICK' | 'HOL', work_date: string, hours: number | null, days: number | null = null): TimeEntry =>
  ({ work_date, earning_code: code, hours, days });

/** Same hours on each listed day. */
export const days = (dates: string[], hours: number): TimeEntry[] => dates.map((d) => reg(d, hours));

export const WEEK_SEP_7 = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

export function input(over: Partial<CalcInput>): CalcInput {
  return {
    period: SEPT,
    employees: [],
    compensation: [],
    timesheets: [],
    priorEntries: {},
    settings: FEDERAL,
    skippedEmployeeIds: [],
    ...over,
  };
}

/** One approved employee with the given compensation and entries. */
export function single(c: CompSegment[], entries: TimeEntry[], over: Partial<CalcInput> = {}, e = emp('a')): CalcInput {
  return input({
    employees: [e],
    compensation: c,
    timesheets: [{ employee_id: e.id, status: 'approved', entries }],
    ...over,
  });
}
```
`tests/unit/pay-calc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { calculateRun, splitOvertime } from '../../src/lib/pay-calc';
import { FEDERAL, WEEK_SEP_7, comp, days, emp, input, off, reg, single } from './fixtures';

const pick = (r: ReturnType<typeof calculateRun>) =>
  r.lines.map((l) => ({ code: l.earning_code, hours: l.hours, days: l.days, rate: l.rate_cents, amount: l.amount_cents }));

describe('salary', () => {
  it('pays annual / 12 for a full month', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], []));
    expect(pick(r)).toEqual([{ code: 'SAL', hours: null, days: 22, rate: 1_000_000, amount: 1_000_000 }]);
  });

  it('prorates a mid-month hire by weekdays', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], [], {}, emp('a', { hire_date: '2026-09-15' })));
    expect(pick(r)).toEqual([{ code: 'SAL', hours: null, days: 12, rate: 1_000_000, amount: 545_455 }]);
  });

  it('prorates a mid-month termination', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], [], {}, emp('a', { termination_date: '2026-09-04' })));
    expect(pick(r)).toEqual([{ code: 'SAL', hours: null, days: 4, rate: 1_000_000, amount: 181_818 }]);
  });

  it('splits a mid-month raise into two lines', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000), comp('a', 'salary', 13_200_000, '2026-09-16')], []));
    expect(pick(r)).toEqual([
      { code: 'SAL', hours: null, days: 11, rate: 1_000_000, amount: 500_000 },
      { code: 'SAL', hours: null, days: 11, rate: 1_100_000, amount: 550_000 },
    ]);
  });

  it('reports time off as unpaid informational lines', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], [off('PTO', '2026-09-03', 8), reg('2026-09-04', 8)]));
    expect(pick(r)).toEqual([
      { code: 'SAL', hours: null, days: 22, rate: 1_000_000, amount: 1_000_000 },
      { code: 'PTO', hours: 8, days: null, rate: 0, amount: 0 },
    ]);
  });
});

describe('hourly', () => {
  it('pays 40 hours straight time', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], days(WEEK_SEP_7, 8)));
    expect(pick(r)).toEqual([{ code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 }]);
  });

  it('moves hours past 40 in a week to overtime', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], days(WEEK_SEP_7, 9)));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 },
      { code: 'OT', hours: 5, days: null, rate: 3750, amount: 18_750 },
    ]);
  });

  it('applies daily OT and DT tiers', () => {
    const ca = { ...FEDERAL, ot_daily_threshold: 8, dt_daily_threshold: 12 };
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [reg('2026-09-07', 13)], { settings: ca }));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 8, days: null, rate: 2500, amount: 20_000 },
      { code: 'OT', hours: 4, days: null, rate: 3750, amount: 15_000 },
      { code: 'DT', hours: 1, days: null, rate: 5000, amount: 5_000 },
    ]);
  });

  it('does not double count daily OT toward the weekly threshold', () => {
    const ca = { ...FEDERAL, ot_daily_threshold: 8 };
    // 5 × 10h = 50h: 10h daily OT, 40h regular → no extra weekly OT
    const r = calculateRun(single([comp('a', 'hourly', 2500)], days(WEEK_SEP_7, 10), { settings: ca }));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 },
      { code: 'OT', hours: 10, days: null, rate: 3750, amount: 37_500 },
    ]);
  });

  it('counts prior-period hours in a workweek that spans the month start', () => {
    const r = calculateRun(single(
      [comp('a', 'hourly', 2500)],
      days(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'], 8),
      { priorEntries: { a: [reg('2026-08-31', 10)] } },
    ));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 30, days: null, rate: 2500, amount: 75_000 },
      { code: 'OT', hours: 2, days: null, rate: 3750, amount: 7_500 },
    ]);
  });

  it('pays time off at base rate and keeps it out of overtime', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [...days(WEEK_SEP_7, 8), off('PTO', '2026-09-12', 8)]));
    expect(pick(r)).toEqual([
      { code: 'PTO', hours: 8, days: null, rate: 2500, amount: 20_000 },
      { code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 },
    ]);
  });

  it('uses the rate in effect on each day', () => {
    const r = calculateRun(single(
      [comp('a', 'hourly', 2500), comp('a', 'hourly', 3000, '2026-09-10')],
      days(WEEK_SEP_7, 8),
    ));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 24, days: null, rate: 2500, amount: 60_000 },
      { code: 'REG', hours: 16, days: null, rate: 3000, amount: 48_000 },
    ]);
  });

  it('rounds half a cent up', () => {
    const r = calculateRun(single([comp('a', 'hourly', 1001)], [reg('2026-09-07', 0.5)]));
    expect(pick(r)).toEqual([{ code: 'REG', hours: 0.5, days: null, rate: 1001, amount: 501 }]);
  });
});

describe('daily', () => {
  it('pays days and half days at the day rate', () => {
    const r = calculateRun(single([comp('a', 'daily', 20_000)], [
      reg('2026-09-01', null, 1), reg('2026-09-02', null, 0.5), off('PTO', '2026-09-03', null, 1),
    ]));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: null, days: 1.5, rate: 20_000, amount: 30_000 },
      { code: 'PTO', hours: null, days: 1, rate: 20_000, amount: 20_000 },
    ]);
  });

  it('adds a day-rate overtime premium only when enabled', () => {
    const entries = WEEK_SEP_7.map((d) => reg(d, 10, 1));
    expect(pick(calculateRun(single([comp('a', 'daily', 20_000)], entries)))).toEqual([
      { code: 'REG', hours: 50, days: 5, rate: 20_000, amount: 100_000 },
    ]);
    const r = calculateRun(single([comp('a', 'daily', 20_000)], entries, { settings: { ...FEDERAL, ot_applies_to_daily: true } }));
    expect(pick(r)).toEqual([
      { code: 'OT', hours: 10, days: null, rate: 2000, amount: 10_000 },
      { code: 'REG', hours: 50, days: 5, rate: 20_000, amount: 100_000 },
    ]);
  });
});

describe('warnings and inclusion', () => {
  it('blocks employees without an approved timesheet', () => {
    const r = calculateRun(input({
      employees: [emp('a')],
      compensation: [comp('a', 'hourly', 2500)],
      timesheets: [{ employee_id: 'a', status: 'submitted', entries: days(WEEK_SEP_7, 8) }],
    }));
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ employee_id: 'a', code: 'NO_APPROVED_TIMESHEET', blocking: true })]);
  });

  it('omits skipped employees without warning', () => {
    const r = calculateRun(input({ employees: [emp('a')], compensation: [comp('a', 'hourly', 2500)], skippedEmployeeIds: ['a'] }));
    expect(r).toMatchObject({ lines: [], warnings: [], totals: { employee_count: 0, gross_cents: 0 } });
  });

  it('ignores employees not employed during the period', () => {
    const r = calculateRun(input({
      employees: [emp('a', { termination_date: '2026-08-31' }), emp('b', { hire_date: '2026-10-01' })],
    }));
    expect(r).toMatchObject({ lines: [], warnings: [] });
  });

  it('blocks when compensation is missing for part of the period', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500, '2026-09-10')], days(WEEK_SEP_7, 8)));
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'NO_COMPENSATION', blocking: true })]);
  });

  it('ignores entries outside employment with a non-blocking warning', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [reg('2026-09-07', 8), reg('2026-09-20', 8)], {}, emp('a', { termination_date: '2026-09-15' })));
    expect(pick(r)).toEqual([{ code: 'REG', hours: 8, days: null, rate: 2500, amount: 20_000 }]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'ENTRY_OUTSIDE_EMPLOYMENT', blocking: false })]);
  });

  it('blocks a day with more than 24 hours', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [reg('2026-09-07', 20), off('PTO', '2026-09-07', 8)]));
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'HOURS_OVER_24', blocking: true })]);
  });
});

describe('totals', () => {
  it('sums by code and overall', () => {
    const r = calculateRun(input({
      employees: [emp('a'), emp('b')],
      compensation: [comp('a', 'hourly', 2500), comp('b', 'salary', 12_000_000)],
      timesheets: [
        { employee_id: 'a', status: 'approved', entries: days(WEEK_SEP_7, 9) },
        { employee_id: 'b', status: 'approved', entries: [] },
      ],
    }));
    expect(r.totals).toEqual({
      employee_count: 2,
      gross_cents: 1_118_750,
      by_code: {
        REG: { hours: 40, days: 0, amount_cents: 100_000 },
        OT: { hours: 5, days: 0, amount_cents: 18_750 },
        SAL: { hours: 0, days: 22, amount_cents: 1_000_000 },
      },
    });
  });
});

describe('splitOvertime', () => {
  it('assigns weekly OT to the latest days of the week', () => {
    const split = splitOvertime(
      [{ day: '2026-09-07', h100: 2000 }, { day: '2026-09-08', h100: 2500 }],
      [],
      { ...FEDERAL, ot_weekly_threshold: 40 },
    );
    expect(split).toEqual([
      { day: '2026-09-07', reg: 2000, ot: 0, dt: 0 },
      { day: '2026-09-08', reg: 2000, ot: 500, dt: 0 },
    ]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/pay-calc.test.ts`
Expected: FAIL, cannot resolve `../../src/lib/pay-calc`.

- [ ] **Step 4: Implement overtime splitting, the line accumulator and the calculator**

`src/lib/pay-calc/overtime.ts`:

```ts
import { weekStart, type ISODate } from '../dates';
import { toHundredths } from '../money';
import type { OvertimeSettings } from '../types';

/** Regular hours worked on one day, in hundredths. */
export interface DayHours { day: ISODate; h100: number }
export interface DaySplit { day: ISODate; reg: number; ot: number; dt: number }

const threshold = (x: number | null): number => (x == null ? Infinity : toHundredths(x));

/**
 * Splits worked hours into regular / overtime / double time.
 * 1. Daily tiers (if configured): above dt_daily_threshold → DT, above ot_daily_threshold → OT.
 * 2. Weekly: regular hours past ot_weekly_threshold within a workweek → OT, in date order.
 *    `prior` days (previous period, same workweek) count toward the weekly threshold
 *    but are not returned.
 */
export function splitOvertime(current: DayHours[], prior: DayHours[], s: OvertimeSettings): DaySplit[] {
  const dtT = threshold(s.dt_daily_threshold);
  const otT = threshold(s.ot_daily_threshold);
  const weeklyT = threshold(s.ot_weekly_threshold);
  const currentDays = new Set(current.map((d) => d.day));

  const all = [...prior, ...current]
    .map(({ day, h100 }) => {
      const dt = Math.max(0, h100 - dtT);
      const rest = h100 - dt;
      const ot = Math.max(0, rest - otT);
      return { day, reg: rest - ot, ot, dt };
    })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const regByWeek = new Map<ISODate, number>();
  for (const d of all) {
    const wk = weekStart(d.day, s.week_starts_on);
    const before = regByWeek.get(wk) ?? 0;
    const moved = Math.max(0, d.reg - Math.max(0, weeklyT - before));
    d.reg -= moved;
    d.ot += moved;
    regByWeek.set(wk, before + d.reg);
  }
  return all.filter((d) => currentDays.has(d.day));
}
```
`src/lib/pay-calc/lines.ts`:

```ts
import { divRoundHalfUp } from '../money';
import type { CalcEmployee, EarningCode, PayType, RunLine } from '../types';

interface Bucket {
  code: EarningCode;
  payType: PayType;
  /** base rate in cents; 0 for informational buckets */
  rate: number;
  /** multiplier × 1000; 0 for informational buckets */
  m1000: number;
  h100: number | null;
  d10: number | null;
}

interface Fixed {
  code: EarningCode;
  payType: PayType;
  rate: number;
  amount: number;
  h100: number | null;
  d10: number | null;
}

const add = (a: number | null, b: number): number => (a ?? 0) + b;

/**
 * Collects quantities per (code, pay type, base rate, multiplier) and turns them
 * into run lines, rounding once per line.
 */
export class LineAccumulator {
  private buckets = new Map<string, Bucket>();
  private fixed: Fixed[] = [];

  constructor(private readonly emp: CalcEmployee) {}

  private bucket(code: EarningCode, payType: PayType, rate: number, m1000: number): Bucket {
    const key = `${code}|${payType}|${rate}|${m1000}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { code, payType, rate, m1000, h100: null, d10: null };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Paid hours: amount = hours × rate × multiplier. */
  addHours(code: EarningCode, payType: PayType, rate: number, m1000: number, h100: number): void {
    if (h100 <= 0) return;
    const b = this.bucket(code, payType, rate, m1000);
    b.h100 = add(b.h100, h100);
  }

  /** Paid days: amount = days × rate. Hours, if entered, are reported but not paid. */
  addDays(code: EarningCode, payType: PayType, rate: number, d10: number, h100 = 0): void {
    if (d10 <= 0) return;
    const b = this.bucket(code, payType, rate, 1000);
    b.d10 = add(b.d10, d10);
    if (h100 > 0) b.h100 = add(b.h100, h100);
  }

  /** Quantity reported with no pay (e.g. PTO hours for a salaried employee). */
  addInfo(code: EarningCode, payType: PayType, h100: number, d10: number): void {
    if (h100 <= 0 && d10 <= 0) return;
    const b = this.bucket(code, payType, 0, 0);
    if (h100 > 0) b.h100 = add(b.h100, h100);
    if (d10 > 0) b.d10 = add(b.d10, d10);
  }

  /** A line whose amount the caller computed (salary segment, day-rate OT premium). */
  addFixed(line: Fixed): void {
    this.fixed.push(line);
  }

  lines(): RunLine[] {
    const base = {
      employee_id: this.emp.id,
      external_id: this.emp.external_id,
      first_name: this.emp.first_name,
      last_name: this.emp.last_name,
      email: this.emp.email,
      work_state: this.emp.work_state,
    };
    const out: RunLine[] = [];
    for (const f of this.fixed) {
      out.push({
        ...base,
        pay_type: f.payType,
        earning_code: f.code,
        hours: f.h100 == null ? null : f.h100 / 100,
        days: f.d10 == null ? null : f.d10 / 10,
        rate_cents: f.rate,
        amount_cents: f.amount,
      });
    }
    for (const b of this.buckets.values()) {
      let amount = 0;
      let rate = 0;
      if (b.m1000 > 0 && b.d10 != null) {
        amount = divRoundHalfUp(b.d10 * b.rate, 10);
        rate = b.rate;
      } else if (b.m1000 > 0 && b.h100 != null) {
        amount = divRoundHalfUp(b.h100 * b.rate * b.m1000, 100_000);
        rate = divRoundHalfUp(b.rate * b.m1000, 1000);
      }
      out.push({
        ...base,
        pay_type: b.payType,
        earning_code: b.code,
        hours: b.h100 == null ? null : b.h100 / 100,
        days: b.d10 == null ? null : b.d10 / 10,
        rate_cents: rate,
        amount_cents: amount,
      });
    }
    return out;
  }
}
```
`src/lib/pay-calc/index.ts`:

```ts
import { eachDay, isWeekday, maxDate, minDate, weekStart, type ISODate } from '../dates';
import { divRoundHalfUp, toHundredths, toTenths, toThousandths } from '../money';
import type {
  CalcEmployee, CalcInput, CalcResult, CalcWarning, CompSegment, EarningCode,
  OvertimeSettings, RunLine, RunTotals, TimeEntry,
} from '../types';
import { LineAccumulator } from './lines';
import { splitOvertime, type DayHours } from './overtime';

export { splitOvertime } from './overtime';

/** The compensation in effect on `day` (latest effective_from ≤ day). */
export function compensationOn(comp: CompSegment[], employeeId: string, day: ISODate): CompSegment | null {
  let best: CompSegment | null = null;
  for (const c of comp) {
    if (c.employee_id !== employeeId || c.effective_from > day) continue;
    if (!best || c.effective_from > best.effective_from) best = c;
  }
  return best;
}

/** Days in the period on which the employee was employed. */
export function employmentDays(emp: CalcEmployee, period: { start: ISODate; end: ISODate }): ISODate[] {
  const start = maxDate(period.start, emp.hire_date);
  const end = emp.termination_date ? minDate(period.end, emp.termination_date) : period.end;
  return start > end ? [] : eachDay(start, end);
}

const name = (e: CalcEmployee) => `${e.first_name} ${e.last_name}`;

export function calculateRun(input: CalcInput): CalcResult {
  const { period, settings } = input;
  const skipped = new Set(input.skippedEmployeeIds);
  const periodWorkdays = eachDay(period.start, period.end).filter(isWeekday).length;
  const lines: RunLine[] = [];
  const warnings: CalcWarning[] = [];
  let employeeCount = 0;

  for (const emp of input.employees) {
    const days = employmentDays(emp, period);
    if (days.length === 0 || skipped.has(emp.id)) continue;

    const warn = (code: CalcWarning['code'], blocking: boolean, message: string) =>
      warnings.push({ employee_id: emp.id, code, blocking, message });

    const ts = input.timesheets.find((t) => t.employee_id === emp.id);
    if (!ts || ts.status !== 'approved') {
      warn('NO_APPROVED_TIMESHEET', true, `${name(emp)} has no approved timesheet`);
      continue;
    }

    const compByDay = new Map<ISODate, CompSegment | null>(
      days.map((d) => [d, compensationOn(input.compensation, emp.id, d)]),
    );
    const missingComp = days.filter((d) => !compByDay.get(d));
    if (missingComp.length > 0) {
      warn('NO_COMPENSATION', true, `${name(emp)} has no compensation on ${missingComp[0]}${missingComp.length > 1 ? ` (+${missingComp.length - 1} more days)` : ''}`);
      continue;
    }

    const entries: TimeEntry[] = [];
    for (const e of ts.entries) {
      if (compByDay.has(e.work_date)) entries.push(e);
      else warn('ENTRY_OUTSIDE_EMPLOYMENT', false, `${name(emp)}: entry on ${e.work_date} is outside employment dates and was ignored`);
    }

    const hoursPerDay = new Map<ISODate, number>();
    for (const e of entries) hoursPerDay.set(e.work_date, (hoursPerDay.get(e.work_date) ?? 0) + toHundredths(e.hours ?? 0));
    const overDays = [...hoursPerDay].filter(([, h]) => h > 2400).map(([d]) => d);
    if (overDays.length > 0) {
      warn('HOURS_OVER_24', true, `${name(emp)} has more than 24 hours on ${overDays.join(', ')}`);
      continue;
    }

    employeeCount += 1;
    const acc = new LineAccumulator(emp);
    addSalary(acc, days, compByDay, periodWorkdays);
    addEntries(acc, entries, compByDay);
    addHourlyOvertime(acc, emp.id, entries, input.priorEntries[emp.id] ?? [], input.compensation, compByDay, settings);
    if (settings.ot_applies_to_daily) {
      addDailyOvertime(acc, emp.id, entries, input.priorEntries[emp.id] ?? [], input.compensation, compByDay, settings);
    }
    lines.push(...acc.lines());
  }

  return { lines, warnings, totals: totalsOf(lines, employeeCount) };
}

/** One SAL line per compensation segment: annual / 12 × segment workdays / period workdays. */
function addSalary(acc: LineAccumulator, days: ISODate[], compByDay: Map<ISODate, CompSegment | null>, periodWorkdays: number) {
  const workdaysByComp = new Map<CompSegment, number>();
  for (const d of days) {
    const c = compByDay.get(d)!;
    if (c.pay_type !== 'salary') continue;
    workdaysByComp.set(c, (workdaysByComp.get(c) ?? 0) + (isWeekday(d) ? 1 : 0));
  }
  for (const [c, workdays] of workdaysByComp) {
    if (workdays === 0) continue;
    acc.addFixed({
      code: 'SAL',
      payType: 'salary',
      rate: divRoundHalfUp(c.rate_cents, 12),
      amount: divRoundHalfUp(c.rate_cents * workdays, 12 * periodWorkdays),
      h100: null,
      d10: workdays * 10,
    });
  }
}

/** Time off for everyone, and day-rate pay for daily employees. Hourly REG is handled with overtime. */
function addEntries(acc: LineAccumulator, entries: TimeEntry[], compByDay: Map<ISODate, CompSegment | null>) {
  for (const e of entries) {
    const c = compByDay.get(e.work_date)!;
    const h100 = toHundredths(e.hours ?? 0);
    const d10 = toTenths(e.days ?? 0);
    if (c.pay_type === 'salary') {
      if (e.earning_code !== 'REG') acc.addInfo(e.earning_code, 'salary', h100, d10);
    } else if (c.pay_type === 'hourly') {
      if (e.earning_code !== 'REG') acc.addHours(e.earning_code, 'hourly', c.rate_cents, 1000, h100);
    } else {
      acc.addDays(e.earning_code, 'daily', c.rate_cents, d10, h100);
    }
  }
}

function regHoursOn(entries: TimeEntry[], payType: 'hourly' | 'daily', comp: (d: ISODate) => CompSegment | null): DayHours[] {
  return entries
    .filter((e) => e.earning_code === 'REG' && e.hours != null && comp(e.work_date)?.pay_type === payType)
    .map((e) => ({ day: e.work_date, h100: toHundredths(e.hours!) }));
}

function addHourlyOvertime(
  acc: LineAccumulator, employeeId: string, entries: TimeEntry[], prior: TimeEntry[],
  allComp: CompSegment[], compByDay: Map<ISODate, CompSegment | null>, s: OvertimeSettings,
) {
  const current = regHoursOn(entries, 'hourly', (d) => compByDay.get(d) ?? null);
  if (current.length === 0) return;
  const priorHours = regHoursOn(prior, 'hourly', (d) => compensationOn(allComp, employeeId, d));
  const otM = toThousandths(s.ot_multiplier);
  const dtM = toThousandths(s.dt_multiplier);
  for (const d of splitOvertime(current, priorHours, s)) {
    const rate = compByDay.get(d.day)!.rate_cents;
    acc.addHours('REG', 'hourly', rate, 1000, d.reg);
    acc.addHours('OT', 'hourly', rate, otM, d.ot);
    acc.addHours('DT', 'hourly', rate, dtM, d.dt);
  }
}

/**
 * Day-rate overtime (FLSA): regular rate = week's day-rate pay / week's hours;
 * premium = (multiplier − 1) × regular rate × hours over the weekly threshold.
 * Only hours past the threshold that fall in this period are paid here.
 */
function addDailyOvertime(
  acc: LineAccumulator, employeeId: string, entries: TimeEntry[], prior: TimeEntry[],
  allComp: CompSegment[], compByDay: Map<ISODate, CompSegment | null>, s: OvertimeSettings,
) {
  if (s.ot_weekly_threshold == null) return;
  const threshold = toHundredths(s.ot_weekly_threshold);
  const premiumM = toThousandths(s.ot_multiplier) - 1000;
  const currentDays = new Set(entries.map((e) => e.work_date));
  const rows = [...prior, ...entries]
    .filter((e) => e.earning_code === 'REG')
    .map((e) => {
      const c = currentDays.has(e.work_date) ? compByDay.get(e.work_date) ?? null : compensationOn(allComp, employeeId, e.work_date);
      return { e, c };
    })
    .filter((r): r is { e: TimeEntry; c: CompSegment } => r.c?.pay_type === 'daily')
    .sort((a, b) => (a.e.work_date < b.e.work_date ? -1 : 1));

  const weeks = new Map<ISODate, typeof rows>();
  for (const r of rows) {
    const wk = weekStart(r.e.work_date, s.week_starts_on);
    weeks.set(wk, [...(weeks.get(wk) ?? []), r]);
  }
  for (const week of weeks.values()) {
    const pay = week.reduce((sum, r) => sum + divRoundHalfUp(toTenths(r.e.days ?? 0) * r.c.rate_cents, 10), 0);
    const hours = week.reduce((sum, r) => sum + toHundredths(r.e.hours ?? 0), 0);
    if (hours <= threshold) continue;
    let cum = 0;
    let otInPeriod = 0;
    for (const r of week) {
      const h = toHundredths(r.e.hours ?? 0);
      const over = Math.max(0, cum + h - Math.max(threshold, cum));
      if (currentDays.has(r.e.work_date)) otInPeriod += over;
      cum += h;
    }
    if (otInPeriod === 0) continue;
    acc.addFixed({
      code: 'OT',
      payType: 'daily',
      rate: divRoundHalfUp(pay * 100, hours),
      amount: divRoundHalfUp(pay * otInPeriod * premiumM, hours * 1000),
      h100: otInPeriod,
      d10: null,
    });
  }
}

function totalsOf(lines: RunLine[], employeeCount: number): RunTotals {
  const by: RunTotals['by_code'] = {};
  let gross = 0;
  for (const l of lines) {
    const t = (by[l.earning_code as EarningCode] ??= { hours: 0, days: 0, amount_cents: 0 });
    t.hours = (toHundredths(t.hours) + toHundredths(l.hours ?? 0)) / 100;
    t.days = (toTenths(t.days) + toTenths(l.days ?? 0)) / 10;
    t.amount_cents += l.amount_cents;
    gross += l.amount_cents;
  }
  return { employee_count: employeeCount, gross_cents: gross, by_code: by };
}
```

- [ ] **Step 5: Run the tests, including under extreme time zones**

Run: `npx vitest run tests/unit/pay-calc.test.ts && npm run test:tz`
Expected: PASS (23 pay-calc tests); `test:tz` passes every unit test twice.

- [ ] **Step 6: Commit**

```sh
git add src/lib/types.ts src/lib/pay-calc tests/unit/fixtures.ts tests/unit/pay-calc.test.ts
git commit -m "feat: calculate gross pay for salary, hourly and daily employees"
```

---
### Task 4: CSV and provider exporters

**Files:**
- Create: `src/lib/csv.ts`, `src/lib/exporters/types.ts`, `src/lib/exporters/presets.ts`, `src/lib/exporters/index.ts`
- Test: `tests/unit/csv.test.ts`, `tests/unit/exporters.test.ts`

**Interfaces:**
- Consumes: `centsToDollars`, `toHundredths` (Task 2); `EarningCode`, `EARNING_CODES`, `RunLine`, `RunTotals` (Task 3).
- Produces (`src/lib/csv.ts`): `csvField(v)`, `toCsv(rows: string[][]): string` (CRLF, trailing CRLF), `guardFormula(v)`, `parseCsv(text): string[][]`.
- Produces (`src/lib/exporters`): `EXPORT_FIELDS`, `ExportField`, `MappingColumn {header, field?, code?, const?}`, `MappingConfig {format, row_mode, date_format, code_map, columns}`, `ExportRun`, `ExportLine`, `Preset`, `RenderedExport {filename, content_type, body}`, `PRESETS`, `findPreset(key)`, `validateMapping(config): string[]`, `render(run, lines, config, mappingKey): RenderedExport`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { guardFormula, parseCsv, toCsv } from '../../src/lib/csv';

describe('toCsv', () => {
  it('quotes only when needed and uses CRLF', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', 'line\nbreak', ' pad', 'ok']])).toBe(
      'a,"b,c","say ""hi""","line\nbreak"," pad",ok\r\n',
    );
  });
});

describe('guardFormula', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(guardFormula('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(guardFormula('+1')).toBe("'+1");
    expect(guardFormula('-2')).toBe("'-2");
    expect(guardFormula('@cmd')).toBe("'@cmd");
    expect(guardFormula('Ada')).toBe('Ada');
  });
});

describe('parseCsv', () => {
  it('round-trips quoted fields, CRLF, LF and a BOM', () => {
    expect(parseCsv('﻿a,"b,c"\r\n"x ""y""",z\nlast,"multi\nline"')).toEqual([
      ['a', 'b,c'], ['x "y"', 'z'], ['last', 'multi\nline'],
    ]);
  });
  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,,\n')).toEqual([['a', '', '']]);
  });
  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('"abc')).toThrow('Unterminated');
  });
});
```
`tests/unit/exporters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PRESETS, findPreset, render, validateMapping, type ExportLine, type ExportRun, type MappingConfig } from '../../src/lib/exporters';

const run: ExportRun = {
  id: 'run-1',
  period_start: '2026-09-01',
  period_end: '2026-09-30',
  finalized_at: '2026-10-01T12:00:00Z',
  totals: { employee_count: 2, gross_cents: 1_118_750, by_code: {} },
};

const base = { work_state: 'CA', pay_type: 'hourly' as const };
const lines: ExportLine[] = [
  { ...base, employee_id: 'e2', external_id: 'E-2', first_name: 'Grace', last_name: 'Hopper', email: 'g@x.com', earning_code: 'OT', hours: 5, days: null, rate_cents: 3750, amount_cents: 18_750 },
  { ...base, employee_id: 'e2', external_id: 'E-2', first_name: 'Grace', last_name: 'Hopper', email: 'g@x.com', earning_code: 'REG', hours: 40, days: null, rate_cents: 2500, amount_cents: 100_000 },
  { ...base, employee_id: 'e1', external_id: '=E-1', first_name: 'Ada', last_name: 'Lovelace, Countess', email: 'a@x.com', pay_type: 'salary', earning_code: 'SAL', hours: null, days: 22, rate_cents: 1_000_000, amount_cents: 1_000_000 },
];

describe('render', () => {
  it('renders the generic CSV per line, sorted, escaped and formula-guarded', () => {
    const out = render(run, lines, findPreset('generic_csv')!.config, 'generic_csv');
    expect(out.filename).toBe('payroll-2026-09-generic_csv.csv');
    expect(out.content_type).toBe('text/csv; charset=utf-8');
    expect(out.body).toBe([
      'Run ID,Period Start,Period End,Employee ID,First Name,Last Name,Email,Pay Type,Work State,Earning Code,Hours,Days,Rate,Amount',
      "run-1,2026-09-01,2026-09-30,E-2,Grace,Hopper,g@x.com,hourly,CA,REG,40.00,,25.00,1000.00",
      "run-1,2026-09-01,2026-09-30,E-2,Grace,Hopper,g@x.com,hourly,CA,OT,5.00,,37.50,187.50",
      "run-1,2026-09-01,2026-09-30,'=E-1,Ada,\"Lovelace, Countess\",a@x.com,salary,CA,SAL,,22.00,10000.00,10000.00",
      '',
    ].join('\r\n'));
  });

  it('pivots earning codes into columns per employee', () => {
    const out = render(run, lines, findPreset('gusto')!.config, 'gusto');
    expect(out.body.split('\r\n')).toEqual([
      'Last Name,First Name,Email,Regular Hours,Overtime Hours,Double Overtime Hours,PTO Hours,Sick Hours,Holiday Hours',
      'Hopper,Grace,g@x.com,40.00,5.00,,,,',
      '"Lovelace, Countess",Ada,a@x.com,,,,,,',
      '',
    ]);
  });

  it('maps codes and formats US dates', () => {
    const out = render(run, lines.slice(0, 1), findPreset('qbo_payroll')!.config, 'qbo_payroll');
    expect(out.body.split('\r\n')[1]).toBe('Grace Hopper,Overtime Hourly,5.00,187.50,09/01/2026,09/30/2026');
  });

  it('writes constants', () => {
    const out = render(run, lines.slice(1, 2), findPreset('adp_wfn')!.config, 'adp_wfn');
    expect(out.body.split('\r\n')[1]).toBe('CHANGE_ME,PAYROLL,E-2,REG,40.00,REG,1000.00');
  });

  it('renders canonical JSON', () => {
    const out = render(run, lines, findPreset('generic_json')!.config, 'generic_json');
    const doc = JSON.parse(out.body);
    expect(out.filename).toBe('payroll-2026-09-generic_json.json');
    expect(doc.schema_version).toBe(1);
    expect(doc.run.id).toBe('run-1');
    expect(doc.lines.map((l: { earning_code: string }) => l.earning_code)).toEqual(['REG', 'OT', 'SAL']);
    expect(doc.lines[0]).toMatchObject({ hours: 40, amount_cents: 100_000, rate_cents: 2500 });
  });

  it('refuses an invalid mapping', () => {
    const bad: MappingConfig = { format: 'csv', row_mode: 'per_line', date_format: 'YYYY-MM-DD', code_map: {}, columns: [] };
    expect(() => render(run, lines, bad, 'x')).toThrow('Add at least one column');
  });
});

describe('validateMapping', () => {
  it('accepts every preset', () => {
    for (const p of PRESETS) expect(validateMapping(p.config), p.key).toEqual([]);
  });

  it('explains each problem', () => {
    const c = {
      format: 'csv', row_mode: 'per_line', date_format: 'YYYY-MM-DD', code_map: { XYZ: 'x' },
      columns: [{ header: '', field: 'nope' }, { header: 'A', field: 'hours', const: '1' }, { header: 'B', field: 'hours', code: 'REG' }],
    } as unknown as MappingConfig;
    expect(validateMapping(c)).toEqual([
      'Unknown earning code "XYZ" in code map',
      'Column 1: header is required',
      'Column 1: unknown field "nope"',
      'Column 2: set exactly one of field or constant',
      'Column 3: earning code columns need per-employee rows',
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/csv.test.ts tests/unit/exporters.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement CSV handling**

`src/lib/csv.ts`:

```ts
// RFC 4180 CSV: CRLF line endings, fields quoted when they contain a comma,
// quote, line break, or leading/trailing whitespace.

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

export function csvField(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Spreadsheet apps execute cells starting with these characters as formulas. */
export function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
```

- [ ] **Step 4: Implement the exporter types, presets and renderer**

`src/lib/exporters/types.ts`:

```ts
import type { ISODate } from '../dates';
import type { EarningCode, RunLine, RunTotals } from '../types';

export const EXPORT_FIELDS = [
  'external_id', 'first_name', 'last_name', 'full_name', 'email', 'pay_type', 'work_state',
  'earning_code', 'hours', 'days', 'rate', 'amount', 'period_start', 'period_end', 'run_id',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export interface MappingColumn {
  header: string;
  field?: ExportField;
  /** per_employee only: take `field` from this employee's lines with this earning code */
  code?: EarningCode;
  /** fixed value, e.g. a company code */
  const?: string;
}

export interface MappingConfig {
  format: 'csv' | 'json';
  row_mode: 'per_line' | 'per_employee';
  date_format: 'YYYY-MM-DD' | 'MM/DD/YYYY';
  code_map: Partial<Record<EarningCode, string>>;
  columns: MappingColumn[];
}

export interface ExportRun {
  id: string;
  period_start: ISODate;
  period_end: ISODate;
  finalized_at: string | null;
  totals: RunTotals;
}

export interface Preset {
  key: string;
  name: string;
  note: string;
  config: MappingConfig;
}

export interface RenderedExport {
  filename: string;
  content_type: string;
  body: string;
}

export type ExportLine = RunLine;
```
`src/lib/exporters/presets.ts`:

```ts
import type { Preset } from './types';

const VERIFY =
  "Starting point based on the provider's published import layout. Verify the column names and earning codes against your account's current import template before first use.";

export const PRESETS: Preset[] = [
  {
    key: 'generic_csv',
    name: 'Generic CSV (all fields)',
    note: 'One row per employee and earning code with every canonical field.',
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'YYYY-MM-DD',
      code_map: {},
      columns: [
        { header: 'Run ID', field: 'run_id' },
        { header: 'Period Start', field: 'period_start' },
        { header: 'Period End', field: 'period_end' },
        { header: 'Employee ID', field: 'external_id' },
        { header: 'First Name', field: 'first_name' },
        { header: 'Last Name', field: 'last_name' },
        { header: 'Email', field: 'email' },
        { header: 'Pay Type', field: 'pay_type' },
        { header: 'Work State', field: 'work_state' },
        { header: 'Earning Code', field: 'earning_code' },
        { header: 'Hours', field: 'hours' },
        { header: 'Days', field: 'days' },
        { header: 'Rate', field: 'rate' },
        { header: 'Amount', field: 'amount' },
      ],
    },
  },
  {
    key: 'generic_json',
    name: 'Generic JSON (schema v1)',
    note: 'Canonical run and lines as JSON; amounts in cents.',
    config: { format: 'json', row_mode: 'per_line', date_format: 'YYYY-MM-DD', code_map: {}, columns: [] },
  },
  {
    key: 'gusto',
    name: 'Gusto — hours import',
    note: VERIFY,
    config: {
      format: 'csv',
      row_mode: 'per_employee',
      date_format: 'MM/DD/YYYY',
      code_map: {},
      columns: [
        { header: 'Last Name', field: 'last_name' },
        { header: 'First Name', field: 'first_name' },
        { header: 'Email', field: 'email' },
        { header: 'Regular Hours', field: 'hours', code: 'REG' },
        { header: 'Overtime Hours', field: 'hours', code: 'OT' },
        { header: 'Double Overtime Hours', field: 'hours', code: 'DT' },
        { header: 'PTO Hours', field: 'hours', code: 'PTO' },
        { header: 'Sick Hours', field: 'hours', code: 'SICK' },
        { header: 'Holiday Hours', field: 'hours', code: 'HOL' },
      ],
    },
  },
  {
    key: 'adp_wfn',
    name: 'ADP Workforce Now — paydata import',
    note: `${VERIFY} Replace the Co Code and Batch ID constants with your values.`,
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'MM/DD/YYYY',
      code_map: { SAL: 'SAL', REG: 'REG', OT: 'OT', DT: 'DT', PTO: 'VAC', SICK: 'SCK', HOL: 'HOL' },
      columns: [
        { header: 'Co Code', const: 'CHANGE_ME' },
        { header: 'Batch ID', const: 'PAYROLL' },
        { header: 'File #', field: 'external_id' },
        { header: 'Hours 3 Code', field: 'earning_code' },
        { header: 'Hours 3 Amount', field: 'hours' },
        { header: 'Earnings 3 Code', field: 'earning_code' },
        { header: 'Earnings 3 Amount', field: 'amount' },
      ],
    },
  },
  {
    key: 'qbo_payroll',
    name: 'QuickBooks Online Payroll — time import',
    note: VERIFY,
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'MM/DD/YYYY',
      code_map: {
        SAL: 'Salary', REG: 'Hourly', OT: 'Overtime Hourly', DT: 'Double Overtime Hourly',
        PTO: 'Paid Time Off', SICK: 'Sick Pay', HOL: 'Holiday Pay',
      },
      columns: [
        { header: 'Employee', field: 'full_name' },
        { header: 'Pay Item', field: 'earning_code' },
        { header: 'Hours', field: 'hours' },
        { header: 'Amount', field: 'amount' },
        { header: 'Period Start', field: 'period_start' },
        { header: 'Period End', field: 'period_end' },
      ],
    },
  },
  {
    key: 'paychex_flex',
    name: 'Paychex Flex — earnings import',
    note: VERIFY,
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'MM/DD/YYYY',
      code_map: {
        SAL: 'Salary', REG: 'Regular', OT: 'Overtime', DT: 'Double Time',
        PTO: 'Vacation', SICK: 'Sick', HOL: 'Holiday',
      },
      columns: [
        { header: 'Worker ID', field: 'external_id' },
        { header: 'Last Name', field: 'last_name' },
        { header: 'First Name', field: 'first_name' },
        { header: 'Earning', field: 'earning_code' },
        { header: 'Hours', field: 'hours' },
        { header: 'Rate', field: 'rate' },
        { header: 'Amount', field: 'amount' },
      ],
    },
  },
];

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((p) => p.key === key);
}
```
`src/lib/exporters/index.ts`:

```ts
import { guardFormula, toCsv } from '../csv';
import type { ISODate } from '../dates';
import { centsToDollars, toHundredths } from '../money';
import { EARNING_CODES, type EarningCode } from '../types';
import {
  EXPORT_FIELDS, type ExportField, type ExportLine, type ExportRun, type MappingColumn,
  type MappingConfig, type RenderedExport,
} from './types';

export * from './types';
export { PRESETS, findPreset } from './presets';

const TEXT_FIELDS = new Set<ExportField>(['external_id', 'first_name', 'last_name', 'full_name', 'email', 'work_state', 'earning_code', 'pay_type']);
const QUANTITY_FIELDS = new Set<ExportField>(['hours', 'days', 'amount']);

export function validateMapping(c: MappingConfig): string[] {
  const errors: string[] = [];
  if (!['csv', 'json'].includes(c.format)) errors.push(`Unknown format "${c.format}"`);
  if (!['per_line', 'per_employee'].includes(c.row_mode)) errors.push(`Unknown row mode "${c.row_mode}"`);
  if (!['YYYY-MM-DD', 'MM/DD/YYYY'].includes(c.date_format)) errors.push(`Unknown date format "${c.date_format}"`);
  for (const [code, label] of Object.entries(c.code_map ?? {})) {
    if (!EARNING_CODES.includes(code as EarningCode)) errors.push(`Unknown earning code "${code}" in code map`);
    if (typeof label !== 'string' || label.trim() === '') errors.push(`Code map label for ${code} is empty`);
  }
  if (c.format === 'json') return errors;
  if (!Array.isArray(c.columns) || c.columns.length === 0) errors.push('Add at least one column');
  (c.columns ?? []).forEach((col, i) => {
    const n = `Column ${i + 1}`;
    if (!col.header?.trim()) errors.push(`${n}: header is required`);
    const hasField = col.field != null;
    const hasConst = col.const != null;
    if (hasField === hasConst) errors.push(`${n}: set exactly one of field or constant`);
    if (hasField && !EXPORT_FIELDS.includes(col.field!)) errors.push(`${n}: unknown field "${col.field}"`);
    if (col.code != null) {
      if (c.row_mode !== 'per_employee') errors.push(`${n}: earning code columns need per-employee rows`);
      if (!EARNING_CODES.includes(col.code)) errors.push(`${n}: unknown earning code "${col.code}"`);
      if (hasField && !['hours', 'days', 'amount', 'rate'].includes(col.field!)) errors.push(`${n}: earning code columns must use hours, days, amount, or rate`);
    }
    if (c.row_mode === 'per_employee' && col.field === 'earning_code') errors.push(`${n}: earning_code needs per-line rows`);
  });
  return errors;
}

function formatDate(d: ISODate, f: MappingConfig['date_format']): string {
  if (f === 'YYYY-MM-DD') return d;
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

const qty = (x: number | null): string => (x == null ? '' : (toHundredths(x) / 100).toFixed(2));

const byEmployee = (a: ExportLine, b: ExportLine): number =>
  a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name) || a.employee_id.localeCompare(b.employee_id);

const byLine = (a: ExportLine, b: ExportLine): number =>
  byEmployee(a, b) || EARNING_CODES.indexOf(a.earning_code) - EARNING_CODES.indexOf(b.earning_code) || a.rate_cents - b.rate_cents;

/** Value of `field` for one line (or the employee part of a group). */
function lineValue(field: ExportField, l: ExportLine, run: ExportRun, c: MappingConfig): string {
  switch (field) {
    case 'external_id': return l.external_id ?? '';
    case 'first_name': return l.first_name;
    case 'last_name': return l.last_name;
    case 'full_name': return `${l.first_name} ${l.last_name}`;
    case 'email': return l.email;
    case 'pay_type': return l.pay_type;
    case 'work_state': return l.work_state ?? '';
    case 'earning_code': return c.code_map[l.earning_code] ?? l.earning_code;
    case 'hours': return qty(l.hours);
    case 'days': return qty(l.days);
    case 'rate': return centsToDollars(l.rate_cents);
    case 'amount': return centsToDollars(l.amount_cents);
    case 'period_start': return formatDate(run.period_start, c.date_format);
    case 'period_end': return formatDate(run.period_end, c.date_format);
    case 'run_id': return run.id;
  }
}

/** Sum of a quantity field over lines; '' when no line has a value. */
function aggregate(field: ExportField, lines: ExportLine[]): string {
  if (field === 'amount') return lines.length ? centsToDollars(lines.reduce((s, l) => s + l.amount_cents, 0)) : '';
  if (field === 'rate') return lines.length ? centsToDollars(lines[0].rate_cents) : '';
  const vals = lines.map((l) => (field === 'hours' ? l.hours : l.days)).filter((v): v is number => v != null);
  return vals.length ? qty(vals.reduce((s, v) => (toHundredths(s) + toHundredths(v)) / 100, 0)) : '';
}

function cell(col: MappingColumn, value: string): string {
  const isText = col.const != null || TEXT_FIELDS.has(col.field!);
  return isText ? guardFormula(value) : value;
}

function csvRows(run: ExportRun, lines: ExportLine[], c: MappingConfig): string[][] {
  const header = c.columns.map((col) => col.header);
  if (c.row_mode === 'per_line') {
    return [header, ...[...lines].sort(byLine).map((l) =>
      c.columns.map((col) => cell(col, col.const ?? lineValue(col.field!, l, run, c))))];
  }
  const groups = new Map<string, ExportLine[]>();
  for (const l of [...lines].sort(byLine)) groups.set(l.employee_id, [...(groups.get(l.employee_id) ?? []), l]);
  const rows = [...groups.values()].map((group) =>
    c.columns.map((col) => {
      if (col.const != null) return cell(col, col.const);
      const field = col.field!;
      if (col.code) return aggregate(field, group.filter((l) => l.earning_code === col.code));
      if (QUANTITY_FIELDS.has(field)) return aggregate(field, group);
      return cell(col, lineValue(field, group[0], run, c));
    }));
  return [header, ...rows];
}

export function render(run: ExportRun, lines: ExportLine[], c: MappingConfig, mappingKey: string): RenderedExport {
  const errors = validateMapping(c);
  if (errors.length) throw new Error(`Invalid mapping: ${errors.join('; ')}`);
  const base = `payroll-${run.period_start.slice(0, 7)}-${mappingKey.replace(/[^a-z0-9_-]/gi, '_')}`;
  if (c.format === 'json') {
    const body = JSON.stringify({
      schema_version: 1,
      run: { id: run.id, period_start: run.period_start, period_end: run.period_end, finalized_at: run.finalized_at, totals: run.totals },
      lines: [...lines].sort(byLine).map((l) => ({
        employee_id: l.employee_id, external_id: l.external_id, first_name: l.first_name, last_name: l.last_name,
        email: l.email, pay_type: l.pay_type, work_state: l.work_state, earning_code: l.earning_code,
        earning_label: c.code_map[l.earning_code] ?? l.earning_code,
        hours: l.hours, days: l.days, rate_cents: l.rate_cents, amount_cents: l.amount_cents,
      })),
    }, null, 2);
    return { filename: `${base}.json`, content_type: 'application/json', body };
  }
  return { filename: `${base}.csv`, content_type: 'text/csv; charset=utf-8', body: toCsv(csvRows(run, lines, c)) };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/csv.test.ts tests/unit/exporters.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```sh
git add src/lib/csv.ts src/lib/exporters tests/unit/csv.test.ts tests/unit/exporters.test.ts
git commit -m "feat: add mapping-driven exporters with provider presets"
```

---
### Task 5: Webhook signing, API keys, random tokens and DB error mapping

**Files:**
- Create: `src/lib/random.ts`, `src/lib/signing.ts`, `src/lib/db-errors.ts`
- Test: `tests/unit/signing.test.ts`, `tests/unit/db-errors.test.ts`

**Interfaces:**
- Produces (`random.ts`, browser + Node): `randomToken(bytes = 32): string` (base64url), `newWebhookSecret(): string` (`whsec_…`).
- Produces (`signing.ts`, Node only): `sha256Hex(s)`, `signWebhook(secret, body, unixSeconds): string`, `verifyWebhookSignature(secret, body, header, nowSec, toleranceSec = 300): boolean`, `generateApiKey(): {key, prefix, hash}` (`pk_<8 hex>_<32 base64url>`), `parseApiKey(key): {prefix} | null`, `apiKeyMatches(key, hash): boolean`, `WEBHOOK_BACKOFF_SECONDS`, `WEBHOOK_MAX_ATTEMPTS`, `nextAttemptAt(attemptsMade, now): Date | null`.
- Produces (`db-errors.ts`): `ParsedDbError {status, code, message}`, `parseDbError(raw): ParsedDbError`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/signing.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newWebhookSecret, randomToken } from '../../src/lib/random';
import {
  apiKeyMatches, generateApiKey, nextAttemptAt, parseApiKey, sha256Hex, signWebhook, verifyWebhookSignature,
} from '../../src/lib/signing';

describe('webhook signatures', () => {
  it('matches an independently computed HMAC', () => {
    const expected = createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex');
    expect(signWebhook('whsec_test', '{"a":1}', 1_700_000_000)).toBe(`t=1700000000,v1=${expected}`);
  });
  it('verifies, and rejects tampering, wrong secrets and stale timestamps', () => {
    const header = signWebhook('s', 'body', 1000);
    expect(verifyWebhookSignature('s', 'body', header, 1100)).toBe(true);
    expect(verifyWebhookSignature('s', 'body2', header, 1100)).toBe(false);
    expect(verifyWebhookSignature('other', 'body', header, 1100)).toBe(false);
    expect(verifyWebhookSignature('s', 'body', header, 1000 + 301)).toBe(false);
    expect(verifyWebhookSignature('s', 'body', 'garbage', 1000)).toBe(false);
  });
});

describe('api keys', () => {
  it('generates parseable keys whose hash matches', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^pk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/);
    expect(parseApiKey(key)).toEqual({ prefix });
    expect(hash).toBe(sha256Hex(key));
    expect(apiKeyMatches(key, hash)).toBe(true);
    expect(apiKeyMatches(`${key.slice(0, -1)}x`, hash)).toBe(false);
  });
  it('rejects malformed keys', () => {
    expect(parseApiKey('pk_123_abc')).toBeNull();
    expect(parseApiKey('Bearer pk_...')).toBeNull();
  });
});

describe('retry schedule', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  it('backs off 1m, 5m, 30m, 2h, 12h then gives up after 6 attempts', () => {
    expect([1, 2, 3, 4, 5].map((n) => (nextAttemptAt(n, now)!.getTime() - now.getTime()) / 1000)).toEqual([60, 300, 1800, 7200, 43200]);
    expect(nextAttemptAt(6, now)).toBeNull();
  });
});

describe('randomToken', () => {
  it('is url-safe and unique', () => {
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(newWebhookSecret()).toMatch(/^whsec_/);
  });
});
```
`tests/unit/db-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDbError } from '../../src/lib/db-errors';

describe('parseDbError', () => {
  it('maps guard errors', () => {
    expect(parseDbError('Query failed: ERROR: CONFLICT:OUTSIDE_PERIOD: 2026-10-07 is outside this pay period (SQLSTATE P0001)'))
      .toEqual({ status: 409, code: 'OUTSIDE_PERIOD', message: '2026-10-07 is outside this pay period' });
    expect(parseDbError('Query failed: ERROR: FORBIDDEN:ADMIN_ONLY: only admins can change payroll runs (SQLSTATE P0001)'))
      .toEqual({ status: 403, code: 'ADMIN_ONLY', message: 'only admins can change payroll runs' });
  });
  it('maps constraint errors', () => {
    expect(parseDbError('ERROR: duplicate key value violates unique constraint "employees_email_key"').code).toBe('DUPLICATE');
    expect(parseDbError('ERROR: new row for relation "time_entries" violates check constraint "x"').status).toBe(400);
  });
  it('passes anything else through as 500', () => {
    expect(parseDbError('Query failed')).toEqual({ status: 500, code: 'DB_ERROR', message: 'Query failed' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/signing.test.ts tests/unit/db-errors.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/lib/random.ts`:

```ts
// Works in browsers and Node 22+ (both expose Web Crypto as globalThis.crypto).
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const newWebhookSecret = (): string => `whsec_${randomToken(32)}`;
```
`src/lib/signing.ts`:

```ts
// Server-only (node:crypto). Webhook signatures and API key hashing.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const hmacHex = (secret: string, msg: string): string => createHmac('sha256', secret).update(msg, 'utf8').digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** `X-Payroll-Signature` value: t=<unix seconds>,v1=<hex hmac_sha256(secret, "<t>.<body>")> */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacHex(secret, `${unixSeconds}.${body}`)}`;
}

/** Receiver-side check, also used by tests. Rejects signatures older than `toleranceSec`. */
export function verifyWebhookSignature(secret: string, body: string, header: string, nowSec: number, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqualHex(parts.v1, hmacHex(secret, `${t}.${body}`));
}

const API_KEY_RE = /^pk_([0-9a-f]{8})_([A-Za-z0-9_-]{32})$/;

/** Returns the plaintext key (show once), its lookup prefix, and the hash to store. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const key = `pk_${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, prefix, hash: sha256Hex(key) };
}

export function parseApiKey(key: string): { prefix: string } | null {
  const m = API_KEY_RE.exec(key);
  return m ? { prefix: m[1] } : null;
}

export const apiKeyMatches = (key: string, storedHash: string): boolean => safeEqualHex(sha256Hex(key), storedHash);

/** Delay before the next try, indexed by attempts already made (1-based). */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_SECONDS.length + 1;

/** After `attemptsMade` failed tries, when to retry — or null to give up. */
export function nextAttemptAt(attemptsMade: number, now: Date): Date | null {
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + WEBHOOK_BACKOFF_SECONDS[attemptsMade - 1] * 1000);
}
```
`src/lib/db-errors.ts`:

```ts
// Database errors arrive as e.g.
//   "Query failed: ERROR: CONFLICT:OUTSIDE_PERIOD: 2026-10-07 is outside this pay period (SQLSTATE P0001)"
// Guards in the migrations raise CONFLICT:<CODE>: / FORBIDDEN:<CODE>: messages.

export interface ParsedDbError { status: number; code: string; message: string }

const GUARD = /(CONFLICT|FORBIDDEN):([A-Z_]+): (.+?)(?: \(SQLSTATE [0-9A-Z]+\))?$/;

export function parseDbError(raw: string): ParsedDbError {
  const m = GUARD.exec(raw);
  if (m) return { status: m[1] === 'CONFLICT' ? 409 : 403, code: m[2], message: m[3] };
  if (/duplicate key|unique constraint/i.test(raw)) return { status: 409, code: 'DUPLICATE', message: 'That record already exists' };
  if (/violates check constraint/i.test(raw)) return { status: 400, code: 'INVALID', message: 'One of the values is not allowed' };
  if (/violates foreign key constraint/i.test(raw)) return { status: 409, code: 'IN_USE', message: 'This record is referenced by other data' };
  return { status: 500, code: 'DB_ERROR', message: raw };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/signing.test.ts tests/unit/db-errors.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```sh
git add src/lib/random.ts src/lib/signing.ts src/lib/db-errors.ts tests/unit/signing.test.ts tests/unit/db-errors.test.ts
git commit -m "feat: add webhook signing, API key hashing and DB error mapping"
```

---
### Task 6: Employee CSV import and timesheet grid logic

**Files:**
- Create: `src/lib/employee-import.ts`, `src/lib/timesheet-grid.ts`
- Test: `tests/unit/employee-import.test.ts`, `tests/unit/timesheet-grid.test.ts`

**Interfaces:**
- Consumes: `parseCsv` (Task 4), `toUtc`, `dollarsToCents`, `toHundredths` (Task 2), `PayType`, `EntryCode`, `ENTRY_CODES` (Task 3).
- Produces (`employee-import.ts`): `Role`, `ROLES`, `PAY_TYPES`, `IMPORT_COLUMNS`, `ImportRow`, `ImportError`, `ImportRecord {line, values}`, `normalizeEmail(s)`, `readEmployeeCsv(text)`, `validateRecords(records): {rows, errors}`, `parseEmployeeCsv(text): {rows, errors, records}`.
- Produces (`timesheet-grid.ts`): `GridEntry`, `CellValues`, `cellKey(date, code)`, `GridDay`, `gridDays(start, end)`, `cellsFromEntries(entries)`, `parseHours(raw)`, `parseDays(raw)`, `inputsFor(payType, code, dailyHours)`, `SavePlan`, `planSave(existing, cells, payType, dailyHours): SavePlan`, `totalsByCode(entries)`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/employee-import.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseEmployeeCsv } from '../../src/lib/employee-import';

const HEADER = 'email,first_name,last_name,external_id,role,manager_email,hire_date,work_state,pay_type,rate,effective_from';

describe('parseEmployeeCsv', () => {
  it('parses and normalises a valid row', () => {
    const r = parseEmployeeCsv(`${HEADER}\n  Ada@Example.COM ,Ada,Lovelace,E1,Manager,BOSS@x.com,2024-01-15,ca,Hourly,"$1,025.50",\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{
      line: 2, email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', external_id: 'E1',
      role: 'manager', manager_email: 'boss@x.com', hire_date: '2024-01-15', work_state: 'CA',
      pay_type: 'hourly', rate_cents: 102_550, effective_from: '2024-01-15',
    }]);
  });

  it('accepts minimal columns in any order and defaults the role', () => {
    const r = parseEmployeeCsv('Last_Name,hire_date,EMAIL,first_name\nHopper,2020-02-29,g@x.com,Grace');
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ email: 'g@x.com', role: 'employee', pay_type: null, rate_cents: null, effective_from: null });
  });

  it('reports every problem with its line number and skips bad rows', () => {
    const r = parseEmployeeCsv([
      HEADER,
      'a@x.com,A,One,,,,2024-01-01,,,,',
      'A@X.com,B,Two,,,,2024-01-01,,,,',
      'bad-email,,Three,,boss,,2024-02-30,California,weekly,abc,',
      'c@x.com,C,Four,,,c@x.com,2024-01-01,,salary,,',
      '',
    ].join('\n'));
    expect(r.rows.map((x) => x.email)).toEqual(['a@x.com']);
    expect(r.errors).toEqual([
      { line: 3, message: 'duplicate email a@x.com (also on line 2)' },
      { line: 4, message: 'invalid email "bad-email"' },
      { line: 4, message: 'first_name is required' },
      { line: 4, message: 'role must be one of employee, manager, admin' },
      { line: 4, message: 'hire_date must be YYYY-MM-DD (got "2024-02-30")' },
      { line: 4, message: 'work_state must be a 2-letter code (got "CALIFORNIA")' },
      { line: 4, message: 'pay_type must be one of salary, hourly, daily' },
      { line: 4, message: 'rate must be a dollar amount (got "abc")' },
      { line: 5, message: 'an employee cannot be their own manager' },
      { line: 5, message: 'pay_type and rate must be given together' },
    ]);
  });

  it('rejects missing or unknown columns', () => {
    expect(parseEmployeeCsv('email,first_name\nx@y.z,X').errors).toEqual([{ line: 1, message: 'Missing required column(s): last_name, hire_date' }]);
    expect(parseEmployeeCsv('email,first_name,last_name,hire_date,salary\n').errors).toEqual([{ line: 1, message: 'Unknown column(s): salary' }]);
    expect(parseEmployeeCsv('').errors).toEqual([{ line: 0, message: 'The file is empty' }]);
  });
});
```
`tests/unit/timesheet-grid.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cellKey, cellsFromEntries, gridDays, parseDays, parseHours, planSave, totalsByCode, type GridEntry } from '../../src/lib/timesheet-grid';

const saved: GridEntry[] = [
  { id: 'e1', work_date: '2026-09-01', earning_code: 'REG', hours: 8, days: null },
  { id: 'e2', work_date: '2026-09-02', earning_code: 'REG', hours: 8, days: null },
  { id: 'e3', work_date: '2026-09-03', earning_code: 'PTO', hours: 8, days: null },
];

describe('gridDays', () => {
  it('labels weekdays and weekends', () => {
    expect(gridDays('2026-09-04', '2026-09-06')).toEqual([
      { date: '2026-09-04', weekday: 'Fri', weekend: false },
      { date: '2026-09-05', weekday: 'Sat', weekend: true },
      { date: '2026-09-06', weekday: 'Sun', weekend: true },
    ]);
  });
});

describe('parsing', () => {
  it('parses hours', () => {
    expect(parseHours('')).toEqual({ ok: true, value: null });
    expect(parseHours('0')).toEqual({ ok: true, value: null });
    expect(parseHours(' 7.5 ')).toEqual({ ok: true, value: 7.5 });
    expect(parseHours('24')).toEqual({ ok: true, value: 24 });
    expect(parseHours('24.5')).toEqual({ ok: false, error: 'At most 24 hours in a day' });
    expect(parseHours('8h')).toEqual({ ok: false, error: 'Enter hours like 8 or 7.5' });
    expect(parseHours('-1')).toEqual({ ok: false, error: 'Enter hours like 8 or 7.5' });
    expect(parseHours('7.555')).toEqual({ ok: false, error: 'Enter hours like 8 or 7.5' });
  });
  it('parses days', () => {
    expect(parseDays('1')).toEqual({ ok: true, value: 1 });
    expect(parseDays('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseDays('')).toEqual({ ok: true, value: null });
    expect(parseDays('2')).toEqual({ ok: false, error: 'Choose a full or half day' });
  });
});

describe('planSave', () => {
  it('inserts, updates and deletes only what changed', () => {
    const cells = cellsFromEntries(saved);
    cells[cellKey('2026-09-01', 'REG')] = { hours: '9', days: '' };   // update
    cells[cellKey('2026-09-02', 'REG')] = { hours: '', days: '' };    // delete
    cells[cellKey('2026-09-04', 'SICK')] = { hours: '4', days: '' };  // insert
    expect(planSave(saved, cells, 'hourly', false)).toEqual({
      inserts: [{ work_date: '2026-09-04', earning_code: 'SICK', hours: 4, days: null }],
      updates: [{ id: 'e1', hours: 9, days: null }],
      deletes: ['e2'],
      errors: {},
    });
  });

  it('reports invalid cells and leaves them untouched', () => {
    const cells = { [cellKey('2026-09-01', 'REG')]: { hours: '30', days: '' } };
    expect(planSave(saved, cells, 'hourly', false)).toEqual({
      inserts: [], updates: [], deletes: [], errors: { '2026-09-01|REG': 'At most 24 hours in a day' },
    });
  });

  it('stores days for daily employees and drops hours unless day-rate OT is on', () => {
    const cells = { [cellKey('2026-09-07', 'REG')]: { hours: '10', days: '1' } };
    expect(planSave([], cells, 'daily', false).inserts).toEqual([{ work_date: '2026-09-07', earning_code: 'REG', hours: null, days: 1 }]);
    expect(planSave([], cells, 'daily', true).inserts).toEqual([{ work_date: '2026-09-07', earning_code: 'REG', hours: 10, days: 1 }]);
  });

  it('does not save hours without a day for daily employees', () => {
    const cells = { [cellKey('2026-09-07', 'REG')]: { hours: '10', days: '' } };
    expect(planSave([], cells, 'daily', true).inserts).toEqual([]);
  });
});

describe('totalsByCode', () => {
  it('sums hours and days without float drift', () => {
    const t = totalsByCode([
      { work_date: '2026-09-01', earning_code: 'REG', hours: 0.1, days: null },
      { work_date: '2026-09-02', earning_code: 'REG', hours: 0.2, days: null },
    ]);
    expect(t.REG).toEqual({ hours: 0.3, days: 0 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/employee-import.test.ts tests/unit/timesheet-grid.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/lib/employee-import.ts`:

```ts
import { parseCsv } from './csv';
import { toUtc, type ISODate } from './dates';
import { dollarsToCents } from './money';
import type { PayType } from './types';

export type Role = 'employee' | 'manager' | 'admin';
export const ROLES: Role[] = ['employee', 'manager', 'admin'];
export const PAY_TYPES: PayType[] = ['salary', 'hourly', 'daily'];

export const IMPORT_COLUMNS = [
  'email', 'first_name', 'last_name', 'external_id', 'role', 'manager_email',
  'hire_date', 'work_state', 'pay_type', 'rate', 'effective_from',
] as const;
const REQUIRED = ['email', 'first_name', 'last_name', 'hire_date'] as const;

export interface ImportRow {
  line: number;
  email: string;
  first_name: string;
  last_name: string;
  external_id: string | null;
  role: Role;
  manager_email: string | null;
  hire_date: ISODate;
  work_state: string | null;
  pay_type: PayType | null;
  /** salary: annual; hourly: per hour; daily: per day */
  rate_cents: number | null;
  effective_from: ISODate | null;
}

export interface ImportError { line: number; message: string }

export const normalizeEmail = (s: string): string => s.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validDate(s: string): boolean {
  try { toUtc(s); return true; } catch { return false; }
}

export interface ImportRecord { line: number; values: Record<string, string> }

/** Splits a CSV into raw records keyed by lower-case column name. */
export function readEmployeeCsv(text: string): { records: ImportRecord[]; errors: ImportError[] } {
  let table: string[][];
  try { table = parseCsv(text); } catch (e) { return { records: [], errors: [{ line: 0, message: (e as Error).message }] }; }
  if (table.length === 0) return { records: [], errors: [{ line: 0, message: 'The file is empty' }] };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { records: [], errors: [{ line: 1, message: `Missing required column(s): ${missing.join(', ')}` }] };
  const unknown = header.filter((h) => h && !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) return { records: [], errors: [{ line: 1, message: `Unknown column(s): ${unknown.join(', ')}` }] };

  const records: ImportRecord[] = [];
  table.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    records.push({ line: i + 2, values: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])) });
  });
  return { records, errors: [] };
}

/** Validates raw records (in the browser for the preview, and again in the import function). */
export function validateRecords(records: ImportRecord[]): { rows: ImportRow[]; errors: ImportError[] } {
  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];
  const seen = new Map<string, number>();

  for (const { line, values } of records) {
    const get = (col: string) => String(values[col] ?? '').trim();
    const opt = (col: string) => get(col) || null;
    const errs: string[] = [];

    const email = normalizeEmail(get('email'));
    if (!EMAIL_RE.test(email)) errs.push(`invalid email "${get('email')}"`);
    else if (seen.has(email)) errs.push(`duplicate email ${email} (also on line ${seen.get(email)})`);
    else seen.set(email, line);

    if (!get('first_name')) errs.push('first_name is required');
    if (!get('last_name')) errs.push('last_name is required');

    const role = (get('role').toLowerCase() || 'employee') as Role;
    if (!ROLES.includes(role)) errs.push(`role must be one of ${ROLES.join(', ')}`);

    const manager = opt('manager_email') ? normalizeEmail(get('manager_email')) : null;
    if (manager && manager === email) errs.push('an employee cannot be their own manager');

    const hire = get('hire_date');
    if (!validDate(hire)) errs.push(`hire_date must be YYYY-MM-DD (got "${hire}")`);

    const state = opt('work_state')?.toUpperCase() ?? null;
    if (state && !/^[A-Z]{2}$/.test(state)) errs.push(`work_state must be a 2-letter code (got "${state}")`);

    const payType = (get('pay_type').toLowerCase() || null) as PayType | null;
    const rateRaw = get('rate');
    let rate: number | null = null;
    if (payType && !PAY_TYPES.includes(payType)) errs.push(`pay_type must be one of ${PAY_TYPES.join(', ')}`);
    if (!!payType !== !!rateRaw) errs.push('pay_type and rate must be given together');
    if (rateRaw) {
      try { rate = dollarsToCents(rateRaw); } catch { errs.push(`rate must be a dollar amount (got "${rateRaw}")`); }
      if (rate === 0) errs.push('rate must be greater than zero');
    }
    const eff = opt('effective_from');
    if (eff && !validDate(eff)) errs.push(`effective_from must be YYYY-MM-DD (got "${eff}")`);

    if (errs.length) { errors.push(...errs.map((message) => ({ line, message }))); continue; }
    rows.push({
      line, email, first_name: get('first_name'), last_name: get('last_name'),
      external_id: opt('external_id'), role, manager_email: manager, hire_date: hire, work_state: state,
      pay_type: payType, rate_cents: rate, effective_from: payType ? (eff ?? hire) : null,
    });
  }
  return { rows, errors };
}

/** Parses and validates an employee CSV. Rows with any error are left out of `rows`. */
export function parseEmployeeCsv(text: string): { rows: ImportRow[]; errors: ImportError[]; records: ImportRecord[] } {
  const read = readEmployeeCsv(text);
  if (read.errors.length) return { rows: [], errors: read.errors, records: [] };
  return { ...validateRecords(read.records), records: read.records };
}
```
`src/lib/timesheet-grid.ts`:

```ts
import { dayOfWeek, eachDay, isWeekday, type ISODate } from './dates';
import { toHundredths } from './money';
import { ENTRY_CODES, type EntryCode, type PayType } from './types';

export interface GridEntry {
  id?: string;
  work_date: ISODate;
  earning_code: EntryCode;
  hours: number | null;
  days: number | null;
}

/** What the employee typed, keyed by `${date}|${code}`. */
export type CellValues = Record<string, { hours: string; days: string }>;

export const cellKey = (date: ISODate, code: EntryCode): string => `${date}|${code}`;

export interface GridDay { date: ISODate; weekday: string; weekend: boolean }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function gridDays(start: ISODate, end: ISODate): GridDay[] {
  return eachDay(start, end).map((date) => ({ date, weekday: WEEKDAYS[dayOfWeek(date)], weekend: !isWeekday(date) }));
}

export function cellsFromEntries(entries: GridEntry[]): CellValues {
  const out: CellValues = {};
  for (const e of entries) {
    out[cellKey(e.work_date, e.earning_code)] = {
      hours: e.hours == null ? '' : String(e.hours),
      days: e.days == null ? '' : String(e.days),
    };
  }
  return out;
}

export type Parsed = { ok: true; value: number | null } | { ok: false; error: string };

/** Hours: blank/0 → none; otherwise 0.01–24 with at most two decimals. */
export function parseHours(raw: string): Parsed {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Enter hours like 8 or 7.5' };
  const n = Number(s);
  if (n > 24) return { ok: false, error: 'At most 24 hours in a day' };
  return { ok: true, value: n === 0 ? null : n };
}

/** Days: blank/0 → none; 0.5 or 1. */
export function parseDays(raw: string): Parsed {
  const s = raw.trim();
  if (s === '' || s === '0') return { ok: true, value: null };
  if (s === '0.5' || s === '1') return { ok: true, value: Number(s) };
  return { ok: false, error: 'Choose a full or half day' };
}

/** Which inputs a pay type gets. Daily REG also takes hours when day-rate overtime is on. */
export function inputsFor(payType: PayType, code: EntryCode, dailyHours: boolean): { hours: boolean; days: boolean } {
  if (payType !== 'daily') return { hours: true, days: false };
  return { hours: dailyHours && code === 'REG', days: true };
}

export interface SavePlan {
  inserts: GridEntry[];
  updates: { id: string; hours: number | null; days: number | null }[];
  deletes: string[];
  errors: Record<string, string>;
}

/** Diff the typed cells against the saved entries. Invalid cells are reported, never saved. */
export function planSave(existing: GridEntry[], cells: CellValues, payType: PayType, dailyHours: boolean): SavePlan {
  const plan: SavePlan = { inserts: [], updates: [], deletes: [], errors: {} };
  const byKey = new Map(existing.map((e) => [cellKey(e.work_date, e.earning_code), e]));
  const keys = new Set([...byKey.keys(), ...Object.keys(cells)]);
  for (const key of keys) {
    const [date, code] = key.split('|') as [ISODate, EntryCode];
    if (!ENTRY_CODES.includes(code)) continue;
    const prev = byKey.get(key);
    const cell = cells[key];
    let hours: number | null = prev?.hours ?? null;
    let days: number | null = prev?.days ?? null;
    if (cell) {
      const want = inputsFor(payType, code, dailyHours);
      const h = want.hours ? parseHours(cell.hours) : ({ ok: true, value: null } as Parsed);
      const d = want.days ? parseDays(cell.days) : ({ ok: true, value: null } as Parsed);
      if (!h.ok || !d.ok) { plan.errors[key] = !h.ok ? h.error : (d as { error: string }).error; continue; }
      hours = h.value;
      days = d.value;
      if (payType === 'daily' && days == null) hours = null;
    }
    const empty = hours == null && days == null;
    if (!prev) {
      if (!empty) plan.inserts.push({ work_date: date, earning_code: code, hours, days });
    } else if (empty) {
      plan.deletes.push(prev.id!);
    } else if (hours !== prev.hours || days !== prev.days) {
      plan.updates.push({ id: prev.id!, hours, days });
    }
  }
  return plan;
}

export function totalsByCode(entries: GridEntry[]): Record<EntryCode, { hours: number; days: number }> {
  const out = Object.fromEntries(ENTRY_CODES.map((c) => [c, { hours: 0, days: 0 }])) as Record<EntryCode, { hours: number; days: number }>;
  for (const e of entries) {
    out[e.earning_code].hours = (toHundredths(out[e.earning_code].hours) + toHundredths(e.hours ?? 0)) / 100;
    out[e.earning_code].days += e.days ?? 0;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/employee-import.test.ts tests/unit/timesheet-grid.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```sh
git add src/lib/employee-import.ts src/lib/timesheet-grid.ts tests/unit/employee-import.test.ts tests/unit/timesheet-grid.test.ts
git commit -m "feat: add employee CSV validation and timesheet grid diffing"
```

---
### Task 7: Migration generator

Volcano executes each migration file as exactly one statement and re-runs all of them on every deploy. We keep related statements together in `db/migrations-src/*.sql`, each preceded by `-- @file NNN_name`, and generate one file per statement.

**Files:**
- Create: `scripts/migrations.ts`, `scripts/gen-migrations.ts`
- Test: `tests/unit/migrations.test.ts`

**Interfaces:**
- Produces: `stripSql(sql)`, `isSingleStatement(sql)`, `splitSource(text, source?)`, `generate(srcDir, outDir): SqlFile[]` (removes stale `NNN_*.sql`, keeps other files such as `README.md`, rejects duplicate names/numbers); `npm run db:generate`.

- [ ] **Step 1: Write the failing test**

`tests/unit/migrations.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, isSingleStatement, splitSource } from '../../scripts/migrations';

describe('isSingleStatement', () => {
  it('ignores semicolons inside function bodies, strings and comments', () => {
    expect(isSingleStatement(`CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;`)).toBe(true);
    expect(isSingleStatement(`INSERT INTO t VALUES ('a;b'); -- trailing; comment`)).toBe(true);
    expect(isSingleStatement(`SELECT 1; SELECT 2;`)).toBe(false);
    expect(isSingleStatement(`-- only a comment`)).toBe(false);
  });
});

describe('splitSource', () => {
  it('splits on markers and trims', () => {
    expect(splitSource('-- group header comment\n-- @file 001_a\nCREATE TABLE a (id int);\n\n-- @file 002_b\nCREATE TABLE b (id int);\n')).toEqual([
      { name: '001_a', sql: 'CREATE TABLE a (id int);\n' },
      { name: '002_b', sql: 'CREATE TABLE b (id int);\n' },
    ]);
  });
  it('rejects two statements under one marker and SQL before any marker', () => {
    expect(() => splitSource('-- @file 001_a\nSELECT 1;\nSELECT 2;\n', 'x.sql')).toThrow('x.sql: 001_a must contain exactly one statement');
    expect(() => splitSource('SELECT 1;\n-- @file 001_a\nSELECT 2;\n', 'x.sql')).toThrow('SQL before the first');
  });
});

describe('generate', () => {
  it('writes files, removes stale ones and refuses duplicate numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    const src = join(dir, 'src');
    const out = join(dir, 'out');
    mkdirSync(src);
    mkdirSync(out);
    writeFileSync(join(out, '999_stale.sql'), 'SELECT 1;\n');
    writeFileSync(join(out, 'README.md'), 'keep');
    writeFileSync(join(src, '01.sql'), '-- @file 001_a\nSELECT 1;\n');
    generate(src, out);
    expect(readdirSync(out).sort()).toEqual(['001_a.sql', 'README.md']);
    expect(readFileSync(join(out, '001_a.sql'), 'utf8')).toBe('SELECT 1;\n');
    writeFileSync(join(src, '02.sql'), '-- @file 001_b\nSELECT 2;\n');
    expect(() => generate(src, out)).toThrow('Duplicate migration number 001');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/migrations.test.ts`
Expected: FAIL, cannot resolve `../../scripts/migrations`.

- [ ] **Step 3: Implement**

`scripts/migrations.ts`:

```ts
// Volcano runs each migration file as exactly one SQL statement. We author
// related statements together in db/migrations-src/*.sql, each preceded by a
// `-- @file NNN_name` marker, and generate one file per statement.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = /^-- @file (\d{3}_[a-z0-9_]+)\s*$/;

export interface SqlFile { name: string; sql: string }

/** Removes comments, string literals and dollar-quoted bodies so `;` can be counted. */
export function stripSql(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; continue; }
    if (rest.startsWith('/*')) { const end = sql.indexOf('*/', i + 2); if (end === -1) throw new Error('Unterminated /* comment'); i = end + 2; continue; }
    if (sql[i] === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j++; continue; } break; } }
      if (j >= sql.length) throw new Error('Unterminated string literal');
      out += "''"; i = j + 1; continue;
    }
    const dollar = /^\$([A-Za-z_]*)\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error(`Unterminated ${tag} body`);
      out += '$$'; i = end + tag.length; continue;
    }
    out += sql[i]; i++;
  }
  return out;
}

export function isSingleStatement(sql: string): boolean {
  const s = stripSql(sql).trim();
  if (s === '') return false;
  const body = s.endsWith(';') ? s.slice(0, -1) : s;
  return !body.includes(';');
}

export function splitSource(text: string, source = 'source'): SqlFile[] {
  const files: SqlFile[] = [];
  let current: SqlFile | null = null;
  const preamble: string[] = [];
  for (const line of text.split('\n')) {
    const m = MARKER.exec(line);
    if (m) { current = { name: m[1], sql: '' }; files.push(current); continue; }
    if (current) current.sql += `${line}\n`;
    else preamble.push(line);
  }
  if (stripSql(preamble.join('\n')).trim() !== '') throw new Error(`${source}: SQL before the first -- @file marker`);
  for (const f of files) {
    f.sql = `${f.sql.trim()}\n`;
    if (!isSingleStatement(f.sql)) throw new Error(`${source}: ${f.name} must contain exactly one statement`);
  }
  return files;
}

/** Regenerates outDir/NNN_*.sql from srcDir; refuses duplicate names and removes stale generated files. */
export function generate(srcDir: string, outDir: string): SqlFile[] {
  const all: SqlFile[] = [];
  for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.sql')).sort()) {
    all.push(...splitSource(readFileSync(join(srcDir, f), 'utf8'), f));
  }
  const names = new Set<string>();
  const numbers = new Set<string>();
  for (const f of all) {
    if (names.has(f.name)) throw new Error(`Duplicate migration name ${f.name}`);
    const num = f.name.slice(0, 3);
    if (numbers.has(num)) throw new Error(`Duplicate migration number ${num} (${f.name})`);
    names.add(f.name);
    numbers.add(num);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const existing of readdirSync(outDir).filter((n) => /^\d{3}_.*\.sql$/.test(n))) {
    if (!names.has(existing.replace(/\.sql$/, ''))) unlinkSync(join(outDir, existing));
  }
  for (const f of all) writeFileSync(join(outDir, `${f.name}.sql`), f.sql);
  return all;
}
```
`scripts/gen-migrations.ts`:

```ts
import { generate } from './migrations';

const files = generate('db/migrations-src', 'volcano/migrations');
console.log(`Wrote ${files.length} migration files to volcano/migrations`);
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/migrations.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests); no type errors.

- [ ] **Step 5: Commit**

```sh
git add scripts/migrations.ts scripts/gen-migrations.ts tests/unit/migrations.test.ts
git commit -m "build: generate single-statement Volcano migrations from grouped SQL"
```

---
### Task 8: Database schema, guards and row-level security

**Files:**
- Create: `db/migrations-src/01_core_tables.sql`, `02_core_logic.sql`, `03_core_rls.sql`, `04_payroll_tables.sql`, `05_payroll_logic.sql`, `06_payroll_rls.sql`
- Generated: `volcano/migrations/NNN_*.sql` (134 files)
- Test: `tests/integration/helpers.ts`, `tests/integration/rls.test.ts`, `tests/integration/lifecycle.test.ts`

**Interfaces:**
- Produces tables: `employees`, `compensation`, `settings` (singleton, `id = true`), `pay_periods`, `timesheets`, `time_entries`, `audit_log`, `payroll_runs`, `payroll_run_lines`, `export_mappings`, `api_keys`, `exports`, `webhook_endpoints`, `webhook_deliveries`.
- Produces SQL helpers: `app_current_employee_id()`, `app_is_admin()`, `app_is_manager_of(uuid)`, `app_can_read_timesheet(uuid)`, `app_owns_timesheet(uuid)`, `app_run_is_finalized(uuid)`, `app_audit(...)`, `app_enqueue_webhook(event, run)`.
- Produces guard error codes (as `CONFLICT:<CODE>:` / `FORBIDDEN:<CODE>:`): `LAST_ADMIN`, `PERIOD_IN_USE`, `IMMUTABLE`, `RUN_EXISTS`, `INVALID_TRANSITION`, `PERIOD_NOT_OPEN`, `PERIOD_FINALIZED`, `NOTE_REQUIRED`, `TIMESHEET_LOCKED`, `OUTSIDE_PERIOD`, `ADMIN_ONLY`, `RUN_FROZEN`, `PERIOD_NOT_LOCKED`, `RUN_HAS_BLOCKING_WARNINGS`, `RUN_STALE`.
- Produces test helpers: `API`, `ANON`, `SERVICE`, `DB`, `PASSWORD`, `service()`, `newUser(label)`, `ok(q)`, `errorOf(q)`, `resetData()`, `Org`, `seedOrg()`, `openPeriod(month?)`.

State machines enforced here: timesheet `draft → submitted → approved | rejected`, `rejected → submitted`, `submitted → draft` (owner recall or admin), `approved → draft` (admin unlock, period open); pay period `open ⇄ locked`, `locked ⇄ finalized` only via run finalize/void; run `draft → finalized → voided`. The service key (`auth.uid()` NULL) bypasses guard checks so tests and system jobs can clean up.

- [ ] **Step 1: Write the core table sources**

`db/migrations-src/01_core_tables.sql`:

```sql
-- Core tables. Volcano re-runs every migration on each deploy (no tracking),
-- so every statement must be idempotent.

-- @file 001_create_employees
CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
    first_name TEXT NOT NULL CHECK (btrim(first_name) <> ''),
    last_name TEXT NOT NULL CHECK (btrim(last_name) <> ''),
    external_id TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'admin')),
    manager_id UUID REFERENCES employees(id) ON DELETE SET NULL CHECK (manager_id <> id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
    hire_date DATE NOT NULL,
    termination_date DATE CHECK (termination_date IS NULL OR termination_date >= hire_date),
    work_state TEXT CHECK (work_state ~ '^[A-Z]{2}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 002_employees_manager_idx
CREATE INDEX IF NOT EXISTS employees_manager_idx ON employees(manager_id);

-- @file 003_create_compensation
CREATE TABLE IF NOT EXISTS compensation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_type TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly', 'daily')),
    rate_cents BIGINT NOT NULL CHECK (rate_cents > 0),
    effective_from DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, effective_from)
);

-- @file 004_create_settings
CREATE TABLE IF NOT EXISTS settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    company_name TEXT NOT NULL DEFAULT 'My Company',
    ot_weekly_threshold NUMERIC(5,2) DEFAULT 40 CHECK (ot_weekly_threshold > 0),
    ot_daily_threshold NUMERIC(5,2) CHECK (ot_daily_threshold > 0 AND ot_daily_threshold <= 24),
    dt_daily_threshold NUMERIC(5,2) CHECK (dt_daily_threshold > 0 AND dt_daily_threshold <= 24),
    ot_multiplier NUMERIC(4,3) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier >= 1),
    dt_multiplier NUMERIC(4,3) NOT NULL DEFAULT 2.0 CHECK (dt_multiplier >= 1),
    ot_applies_to_daily BOOLEAN NOT NULL DEFAULT FALSE,
    week_starts_on SMALLINT NOT NULL DEFAULT 0 CHECK (week_starts_on BETWEEN 0 AND 6),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (dt_daily_threshold IS NULL OR ot_daily_threshold IS NULL OR dt_daily_threshold > ot_daily_threshold)
);

-- @file 005_seed_settings
INSERT INTO settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- @file 006_create_pay_periods
CREATE TABLE IF NOT EXISTS pay_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_date DATE NOT NULL UNIQUE CHECK (start_date = date_trunc('month', start_date)::date),
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'finalized')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date = (start_date + INTERVAL '1 month' - INTERVAL '1 day')::date)
);

-- @file 007_create_timesheets
CREATE TABLE IF NOT EXISTS timesheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    submitted_at TIMESTAMPTZ,
    approved_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejection_note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, pay_period_id)
);

-- @file 008_timesheets_period_idx
CREATE INDEX IF NOT EXISTS timesheets_period_idx ON timesheets(pay_period_id, status);

-- @file 009_create_time_entries
CREATE TABLE IF NOT EXISTS time_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timesheet_id UUID NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
    work_date DATE NOT NULL,
    earning_code TEXT NOT NULL CHECK (earning_code IN ('REG', 'PTO', 'SICK', 'HOL')),
    hours NUMERIC(4,2) CHECK (hours > 0 AND hours <= 24),
    days NUMERIC(2,1) CHECK (days IN (0.5, 1)),
    note TEXT,
    UNIQUE (timesheet_id, work_date, earning_code),
    CHECK (hours IS NOT NULL OR days IS NOT NULL)
);

-- @file 010_create_audit_log
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_employee_id UUID,
    actor_user_id UUID,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 011_audit_log_created_idx
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
```
`db/migrations-src/02_core_logic.sql`:

```sql
-- Role helpers, guard triggers and auditing. Errors raised here use the
-- prefixes CONFLICT:<CODE>: and FORBIDDEN:<CODE>: so functions can map them
-- to HTTP 409 / 403 (see src/server/http.ts).
-- auth.uid() is NULL only for service-key requests (anon requests are
-- stopped by RLS before triggers run), so guards treat NULL as "system".

-- @file 020_fn_app_current_employee_id
CREATE OR REPLACE FUNCTION app_current_employee_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM employees WHERE user_id = auth.uid() AND status = 'active'
$$;

-- @file 021_fn_app_is_admin
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees WHERE user_id = auth.uid() AND status = 'active' AND role = 'admin'
    )
$$;

-- @file 022_fn_app_is_manager_of
CREATE OR REPLACE FUNCTION app_is_manager_of(emp UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.id = emp AND e.manager_id IS NOT NULL AND e.manager_id = app_current_employee_id()
    )
$$;

-- @file 023_fn_app_can_read_timesheet
CREATE OR REPLACE FUNCTION app_can_read_timesheet(ts UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM timesheets t
        WHERE t.id = ts
          AND (t.employee_id = app_current_employee_id() OR app_is_manager_of(t.employee_id) OR app_is_admin())
    )
$$;

-- @file 024_fn_app_owns_timesheet
CREATE OR REPLACE FUNCTION app_owns_timesheet(ts UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM timesheets t WHERE t.id = ts AND t.employee_id = app_current_employee_id())
$$;

-- @file 025_fn_app_audit
CREATE OR REPLACE FUNCTION app_audit(p_action TEXT, p_entity TEXT, p_entity_id TEXT, p_details JSONB) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO audit_log (actor_employee_id, actor_user_id, action, entity, entity_id, details)
    VALUES (app_current_employee_id(), auth.uid(), p_action, p_entity, p_entity_id, COALESCE(p_details, '{}'::jsonb))
$$;

-- @file 026_fn_audit_row_change
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    old_row JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) - 'key_hash' - 'secret' - 'content' END;
    new_row JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) - 'key_hash' - 'secret' - 'content' END;
BEGIN
    PERFORM app_audit(lower(TG_OP), TG_TABLE_NAME, COALESCE(new_row ->> 'id', old_row ->> 'id'),
                      jsonb_build_object('old', old_row, 'new', new_row));
    RETURN NULL;
END
$$;

-- @file 027_fn_touch_updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;

-- @file 028_fn_employees_guard
CREATE OR REPLACE FUNCTION employees_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := now();
    END IF;
    IF auth.uid() IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF OLD.role = 'admin' AND OLD.status = 'active'
       AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.status <> 'active')
       AND NOT EXISTS (SELECT 1 FROM employees WHERE role = 'admin' AND status = 'active' AND id <> OLD.id) THEN
        RAISE EXCEPTION 'CONFLICT:LAST_ADMIN: keep at least one active admin';
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;

-- @file 029_fn_pay_periods_guard
CREATE OR REPLACE FUNCTION pay_periods_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF auth.uid() IS NOT NULL
           AND (OLD.status <> 'open' OR EXISTS (SELECT 1 FROM timesheets WHERE pay_period_id = OLD.id)) THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_IN_USE: only an open period with no timesheets can be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date THEN
        RAISE EXCEPTION 'CONFLICT:IMMUTABLE: pay period dates cannot change';
    END IF;
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'open' AND NEW.status = 'locked' THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'locked' AND NEW.status = 'open' THEN
        IF EXISTS (SELECT 1 FROM payroll_runs WHERE pay_period_id = OLD.id AND status <> 'voided') THEN
            RAISE EXCEPTION 'CONFLICT:RUN_EXISTS: delete the draft run (or void the finalized run) before reopening';
        END IF;
        RETURN NEW;
    END IF;
    -- locked <-> finalized happens only through payroll run finalize/void.
    IF pg_trigger_depth() > 1
       AND ((OLD.status = 'locked' AND NEW.status = 'finalized') OR (OLD.status = 'finalized' AND NEW.status = 'locked')) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: cannot change a pay period from % to %', OLD.status, NEW.status;
END
$$;

-- @file 030_fn_timesheets_guard
CREATE OR REPLACE FUNCTION timesheets_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    me UUID := app_current_employee_id();
    is_admin BOOLEAN := app_is_admin();
    p_status TEXT;
BEGIN
    SELECT status INTO p_status FROM pay_periods WHERE id = NEW.pay_period_id;
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: new timesheets start as draft';
        END IF;
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: this pay period is not open for time entry';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.employee_id <> OLD.employee_id OR NEW.pay_period_id <> OLD.pay_period_id THEN
        RAISE EXCEPTION 'CONFLICT:IMMUTABLE: a timesheet cannot move to another employee or period';
    END IF;
    IF p_status = 'finalized' THEN
        RAISE EXCEPTION 'CONFLICT:PERIOD_FINALIZED: payroll for this period is finalized';
    END IF;
    NEW.updated_at := now();
    IF NEW.status = OLD.status THEN
        IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
            RAISE EXCEPTION 'CONFLICT:IMMUTABLE: approval fields only change with the status';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IN ('draft', 'rejected') AND NEW.status = 'submitted' AND OLD.employee_id = me THEN
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: this pay period is not open for time entry';
        END IF;
        NEW.submitted_at := now();
        NEW.rejection_note := NULL;
    ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected')
          AND (is_admin OR app_is_manager_of(OLD.employee_id)) THEN
        IF NEW.status = 'approved' THEN
            NEW.approved_by := me;
            NEW.approved_at := now();
            NEW.rejection_note := NULL;
        ELSIF btrim(COALESCE(NEW.rejection_note, '')) = '' THEN
            RAISE EXCEPTION 'CONFLICT:NOTE_REQUIRED: give a reason when rejecting a timesheet';
        END IF;
    ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' AND (OLD.employee_id = me OR is_admin) THEN
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: reopen the pay period first';
        END IF;
        NEW.submitted_at := NULL;
    ELSIF OLD.status = 'approved' AND NEW.status = 'draft' AND is_admin THEN
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: reopen the pay period first';
        END IF;
        NEW.submitted_at := NULL;
        NEW.approved_by := NULL;
        NEW.approved_at := NULL;
    ELSE
        RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: cannot change a timesheet from % to %', OLD.status, NEW.status;
    END IF;
    PERFORM app_audit('timesheet.' || NEW.status, 'timesheets', NEW.id::text,
                      jsonb_build_object('from', OLD.status, 'note', NEW.rejection_note));
    RETURN NEW;
END
$$;

-- @file 031_fn_time_entries_guard
CREATE OR REPLACE FUNCTION time_entries_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    ts RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.timesheet_id <> OLD.timesheet_id THEN
        RAISE EXCEPTION 'CONFLICT:IMMUTABLE: an entry cannot move to another timesheet';
    END IF;
    SELECT t.status, p.status AS period_status, p.start_date, p.end_date INTO ts
    FROM timesheets t JOIN pay_periods p ON p.id = t.pay_period_id
    WHERE t.id = COALESCE(NEW.timesheet_id, OLD.timesheet_id);
    IF ts.status NOT IN ('draft', 'rejected') THEN
        RAISE EXCEPTION 'CONFLICT:TIMESHEET_LOCKED: a submitted or approved timesheet cannot be edited';
    END IF;
    IF ts.period_status <> 'open' THEN
        RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: this pay period is not open for time entry';
    END IF;
    IF TG_OP <> 'DELETE' AND (NEW.work_date < ts.start_date OR NEW.work_date > ts.end_date) THEN
        RAISE EXCEPTION 'CONFLICT:OUTSIDE_PERIOD: % is outside this pay period', NEW.work_date;
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;

-- @file 040_trg_employees_guard_drop
DROP TRIGGER IF EXISTS employees_guard ON employees;

-- @file 041_trg_employees_guard_create
CREATE TRIGGER employees_guard BEFORE UPDATE OR DELETE ON employees
    FOR EACH ROW EXECUTE FUNCTION employees_guard();

-- @file 042_trg_employees_audit_drop
DROP TRIGGER IF EXISTS employees_audit ON employees;

-- @file 043_trg_employees_audit_create
CREATE TRIGGER employees_audit AFTER INSERT OR UPDATE OR DELETE ON employees
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 044_trg_compensation_audit_drop
DROP TRIGGER IF EXISTS compensation_audit ON compensation;

-- @file 045_trg_compensation_audit_create
CREATE TRIGGER compensation_audit AFTER INSERT OR UPDATE OR DELETE ON compensation
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 046_trg_settings_touch_drop
DROP TRIGGER IF EXISTS settings_touch ON settings;

-- @file 047_trg_settings_touch_create
CREATE TRIGGER settings_touch BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- @file 048_trg_settings_audit_drop
DROP TRIGGER IF EXISTS settings_audit ON settings;

-- @file 049_trg_settings_audit_create
CREATE TRIGGER settings_audit AFTER UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 050_trg_pay_periods_guard_drop
DROP TRIGGER IF EXISTS pay_periods_guard ON pay_periods;

-- @file 051_trg_pay_periods_guard_create
CREATE TRIGGER pay_periods_guard BEFORE UPDATE OR DELETE ON pay_periods
    FOR EACH ROW EXECUTE FUNCTION pay_periods_guard();

-- @file 052_trg_pay_periods_audit_drop
DROP TRIGGER IF EXISTS pay_periods_audit ON pay_periods;

-- @file 053_trg_pay_periods_audit_create
CREATE TRIGGER pay_periods_audit AFTER INSERT OR UPDATE OR DELETE ON pay_periods
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 054_trg_timesheets_guard_drop
DROP TRIGGER IF EXISTS timesheets_guard ON timesheets;

-- @file 055_trg_timesheets_guard_create
CREATE TRIGGER timesheets_guard BEFORE INSERT OR UPDATE ON timesheets
    FOR EACH ROW EXECUTE FUNCTION timesheets_guard();

-- @file 056_trg_time_entries_guard_drop
DROP TRIGGER IF EXISTS time_entries_guard ON time_entries;

-- @file 057_trg_time_entries_guard_create
CREATE TRIGGER time_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON time_entries
    FOR EACH ROW EXECUTE FUNCTION time_entries_guard();
```
`db/migrations-src/03_core_rls.sql`:

```sql
-- Row-level security for core tables. Policies are OR'ed together.

-- @file 060_employees_rls
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

-- @file 061_compensation_rls
ALTER TABLE compensation ENABLE ROW LEVEL SECURITY;

-- @file 062_settings_rls
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- @file 063_pay_periods_rls
ALTER TABLE pay_periods ENABLE ROW LEVEL SECURITY;

-- @file 064_timesheets_rls
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;

-- @file 065_time_entries_rls
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

-- @file 066_audit_log_rls
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- @file 070_employees_select_drop
DROP POLICY IF EXISTS employees_select ON employees;

-- @file 071_employees_select_create
CREATE POLICY employees_select ON employees FOR SELECT
    USING (id = app_current_employee_id() OR manager_id = app_current_employee_id() OR app_is_admin());

-- @file 072_employees_admin_drop
DROP POLICY IF EXISTS employees_admin ON employees;

-- @file 073_employees_admin_create
CREATE POLICY employees_admin ON employees FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 074_compensation_select_drop
DROP POLICY IF EXISTS compensation_select ON compensation;

-- @file 075_compensation_select_create
CREATE POLICY compensation_select ON compensation FOR SELECT
    USING (employee_id = app_current_employee_id() OR app_is_admin());

-- @file 076_compensation_admin_drop
DROP POLICY IF EXISTS compensation_admin ON compensation;

-- @file 077_compensation_admin_create
CREATE POLICY compensation_admin ON compensation FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 078_settings_select_drop
DROP POLICY IF EXISTS settings_select ON settings;

-- @file 079_settings_select_create
CREATE POLICY settings_select ON settings FOR SELECT
    USING (app_current_employee_id() IS NOT NULL);

-- @file 080_settings_admin_drop
DROP POLICY IF EXISTS settings_admin ON settings;

-- @file 081_settings_admin_create
CREATE POLICY settings_admin ON settings FOR UPDATE
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 082_pay_periods_select_drop
DROP POLICY IF EXISTS pay_periods_select ON pay_periods;

-- @file 083_pay_periods_select_create
CREATE POLICY pay_periods_select ON pay_periods FOR SELECT
    USING (app_current_employee_id() IS NOT NULL);

-- @file 084_pay_periods_admin_drop
DROP POLICY IF EXISTS pay_periods_admin ON pay_periods;

-- @file 085_pay_periods_admin_create
CREATE POLICY pay_periods_admin ON pay_periods FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 086_timesheets_select_drop
DROP POLICY IF EXISTS timesheets_select ON timesheets;

-- @file 087_timesheets_select_create
CREATE POLICY timesheets_select ON timesheets FOR SELECT
    USING (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin());

-- @file 088_timesheets_insert_drop
DROP POLICY IF EXISTS timesheets_insert ON timesheets;

-- @file 089_timesheets_insert_create
CREATE POLICY timesheets_insert ON timesheets FOR INSERT
    WITH CHECK (employee_id = app_current_employee_id() OR app_is_admin());

-- @file 090_timesheets_update_drop
DROP POLICY IF EXISTS timesheets_update ON timesheets;

-- @file 091_timesheets_update_create
CREATE POLICY timesheets_update ON timesheets FOR UPDATE
    USING (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin())
    WITH CHECK (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin());

-- @file 092_timesheets_delete_drop
DROP POLICY IF EXISTS timesheets_delete ON timesheets;

-- @file 093_timesheets_delete_create
CREATE POLICY timesheets_delete ON timesheets FOR DELETE
    USING (app_is_admin());

-- @file 094_time_entries_select_drop
DROP POLICY IF EXISTS time_entries_select ON time_entries;

-- @file 095_time_entries_select_create
CREATE POLICY time_entries_select ON time_entries FOR SELECT
    USING (app_can_read_timesheet(timesheet_id));

-- @file 096_time_entries_write_drop
DROP POLICY IF EXISTS time_entries_write ON time_entries;

-- @file 097_time_entries_write_create
CREATE POLICY time_entries_write ON time_entries FOR ALL
    USING (app_owns_timesheet(timesheet_id) OR app_is_admin())
    WITH CHECK (app_owns_timesheet(timesheet_id) OR app_is_admin());

-- @file 098_audit_log_select_drop
DROP POLICY IF EXISTS audit_log_select ON audit_log;

-- @file 099_audit_log_select_create
CREATE POLICY audit_log_select ON audit_log FOR SELECT
    USING (app_is_admin());
```

- [ ] **Step 2: Write the payroll table sources**

`db/migrations-src/04_payroll_tables.sql`:

```sql
-- Payroll runs, exports and integrations.

-- @file 100_create_payroll_runs
CREATE TABLE IF NOT EXISTS payroll_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'voided')),
    totals JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    skipped_employee_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- JSON text of the calculated lines; expanded into payroll_run_lines by a
    -- trigger on insert (the SDK has no bulk insert or transactions), then cleared.
    lines_input TEXT,
    generated_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    finalized_at TIMESTAMPTZ,
    voided_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    voided_at TIMESTAMPTZ,
    void_reason TEXT
);

-- @file 101_payroll_runs_one_active
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_active ON payroll_runs(pay_period_id) WHERE status <> 'voided';

-- @file 102_create_payroll_run_lines
CREATE TABLE IF NOT EXISTS payroll_run_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    -- copied from the run so employees can group their own lines by month
    -- without reading payroll_runs (admin-only: it holds company totals)
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    external_id TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    pay_type TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly', 'daily')),
    work_state TEXT,
    earning_code TEXT NOT NULL CHECK (earning_code IN ('SAL', 'REG', 'OT', 'DT', 'PTO', 'SICK', 'HOL')),
    hours NUMERIC(8,2),
    days NUMERIC(6,1),
    rate_cents BIGINT NOT NULL,
    amount_cents BIGINT NOT NULL
);

-- @file 103_payroll_run_lines_run_idx
CREATE INDEX IF NOT EXISTS payroll_run_lines_run_idx ON payroll_run_lines(run_id);

-- @file 104_payroll_run_lines_employee_idx
CREATE INDEX IF NOT EXISTS payroll_run_lines_employee_idx ON payroll_run_lines(employee_id);

-- @file 105_create_export_mappings
CREATE TABLE IF NOT EXISTS export_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    based_on TEXT,
    config JSONB NOT NULL,
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 106_create_api_keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    prefix TEXT NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{8}$'),
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- @file 107_create_exports
CREATE TABLE IF NOT EXISTS exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES payroll_runs(id),
    mapping_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 108_exports_run_idx
CREATE INDEX IF NOT EXISTS exports_run_idx ON exports(run_id, created_at DESC);

-- @file 109_create_webhook_endpoints
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL CHECK (url ~ '^https?://'),
    description TEXT,
    secret TEXT NOT NULL CHECK (length(secret) >= 32),
    events JSONB NOT NULL DEFAULT '["payroll_run.finalized", "payroll_run.voided"]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 110_create_webhook_deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_response_code INT,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 111_webhook_deliveries_due_idx
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at);
```
`db/migrations-src/05_payroll_logic.sql`:

```sql
-- Payroll run lifecycle: draft (period locked) → finalized → voided.

-- @file 120_fn_app_run_is_finalized
CREATE OR REPLACE FUNCTION app_run_is_finalized(run UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM payroll_runs WHERE id = run AND status = 'finalized')
$$;

-- @file 121_fn_app_enqueue_webhook
CREATE OR REPLACE FUNCTION app_enqueue_webhook(p_event TEXT, p_run UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    body JSONB;
BEGIN
    SELECT jsonb_build_object(
               'id', gen_random_uuid(),
               'event', p_event,
               'created_at', now(),
               'data', jsonb_build_object(
                   'run_id', r.id, 'status', r.status,
                   'period_start', p.start_date, 'period_end', p.end_date,
                   'totals', r.totals))
    INTO body
    FROM payroll_runs r JOIN pay_periods p ON p.id = r.pay_period_id
    WHERE r.id = p_run;
    INSERT INTO webhook_deliveries (endpoint_id, event, payload)
    SELECT e.id, p_event, body FROM webhook_endpoints e WHERE e.active AND e.events ? p_event;
END
$$;

-- @file 122_fn_payroll_runs_guard
CREATE OR REPLACE FUNCTION payroll_runs_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    p_status TEXT;
    changed TEXT;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT app_is_admin() THEN
        RAISE EXCEPTION 'FORBIDDEN:ADMIN_ONLY: only admins can change payroll runs';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF auth.uid() IS NOT NULL AND OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'CONFLICT:RUN_FROZEN: only draft runs can be deleted';
        END IF;
        RETURN OLD;
    END IF;
    SELECT status INTO p_status FROM pay_periods WHERE id = NEW.pay_period_id;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: new runs start as draft';
        END IF;
        IF p_status <> 'locked' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_LOCKED: lock the pay period before generating a run';
        END IF;
        NEW.generated_by := app_current_employee_id();
        NEW.generated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.pay_period_id <> OLD.pay_period_id OR NEW.totals IS DISTINCT FROM OLD.totals
       OR NEW.warnings IS DISTINCT FROM OLD.warnings OR NEW.skipped_employee_ids IS DISTINCT FROM OLD.skipped_employee_ids
       OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
        RAISE EXCEPTION 'CONFLICT:RUN_FROZEN: regenerate the draft instead of editing it';
    END IF;
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'finalized' THEN
        IF p_status <> 'locked' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_LOCKED: the pay period must be locked to finalize';
        END IF;
        IF jsonb_path_exists(NEW.warnings, '$[*] ? (@.blocking == true)') THEN
            RAISE EXCEPTION 'CONFLICT:RUN_HAS_BLOCKING_WARNINGS: fix or skip the flagged employees, then regenerate';
        END IF;
        SELECT 'timesheets' INTO changed FROM timesheets
            WHERE pay_period_id = NEW.pay_period_id AND updated_at > OLD.generated_at LIMIT 1;
        IF changed IS NULL THEN
            SELECT 'employees' INTO changed FROM employees WHERE updated_at > OLD.generated_at LIMIT 1;
        END IF;
        IF changed IS NULL THEN
            SELECT 'compensation' INTO changed FROM compensation WHERE created_at > OLD.generated_at LIMIT 1;
        END IF;
        IF changed IS NULL THEN
            SELECT 'settings' INTO changed FROM settings WHERE updated_at > OLD.generated_at LIMIT 1;
        END IF;
        IF changed IS NOT NULL THEN
            RAISE EXCEPTION 'CONFLICT:RUN_STALE: % changed after this draft was generated; regenerate it', changed;
        END IF;
        NEW.finalized_by := app_current_employee_id();
        NEW.finalized_at := now();
    ELSIF OLD.status = 'finalized' AND NEW.status = 'voided' THEN
        IF btrim(COALESCE(NEW.void_reason, '')) = '' THEN
            RAISE EXCEPTION 'CONFLICT:NOTE_REQUIRED: give a reason for voiding the run';
        END IF;
        NEW.voided_by := app_current_employee_id();
        NEW.voided_at := now();
    ELSE
        RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: cannot change a run from % to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END
$$;

-- @file 123_fn_payroll_runs_expand_lines
CREATE OR REPLACE FUNCTION payroll_runs_expand_lines() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.lines_input IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO payroll_run_lines (run_id, pay_period_id, employee_id, external_id, first_name, last_name, email, pay_type,
                                   work_state, earning_code, hours, days, rate_cents, amount_cents)
    SELECT NEW.id, NEW.pay_period_id, l.employee_id, l.external_id, l.first_name, l.last_name, l.email, l.pay_type,
           l.work_state, l.earning_code, l.hours, l.days, l.rate_cents, l.amount_cents
    FROM jsonb_to_recordset(NEW.lines_input::jsonb) AS l(
        employee_id UUID, external_id TEXT, first_name TEXT, last_name TEXT, email TEXT, pay_type TEXT,
        work_state TEXT, earning_code TEXT, hours NUMERIC, days NUMERIC, rate_cents BIGINT, amount_cents BIGINT);
    UPDATE payroll_runs SET lines_input = NULL WHERE id = NEW.id;
    RETURN NULL;
END
$$;

-- @file 124_fn_payroll_runs_after_update
CREATE OR REPLACE FUNCTION payroll_runs_after_update() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status = 'finalized' THEN
        UPDATE pay_periods SET status = 'finalized' WHERE id = NEW.pay_period_id;
        PERFORM app_enqueue_webhook('payroll_run.finalized', NEW.id);
    ELSIF NEW.status = 'voided' THEN
        UPDATE pay_periods SET status = 'locked' WHERE id = NEW.pay_period_id;
        PERFORM app_enqueue_webhook('payroll_run.voided', NEW.id);
    END IF;
    PERFORM app_audit('payroll_run.' || NEW.status, 'payroll_runs', NEW.id::text,
                      jsonb_build_object('from', OLD.status, 'reason', NEW.void_reason, 'totals', NEW.totals));
    RETURN NULL;
END
$$;

-- @file 130_trg_payroll_runs_guard_drop
DROP TRIGGER IF EXISTS payroll_runs_guard ON payroll_runs;

-- @file 131_trg_payroll_runs_guard_create
CREATE TRIGGER payroll_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();

-- @file 132_trg_payroll_runs_expand_drop
DROP TRIGGER IF EXISTS payroll_runs_expand ON payroll_runs;

-- @file 133_trg_payroll_runs_expand_create
CREATE TRIGGER payroll_runs_expand AFTER INSERT ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_expand_lines();

-- @file 134_trg_payroll_runs_after_update_drop
DROP TRIGGER IF EXISTS payroll_runs_after_update ON payroll_runs;

-- @file 135_trg_payroll_runs_after_update_create
CREATE TRIGGER payroll_runs_after_update AFTER UPDATE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_after_update();

-- @file 136_trg_export_mappings_touch_drop
DROP TRIGGER IF EXISTS export_mappings_touch ON export_mappings;

-- @file 137_trg_export_mappings_touch_create
CREATE TRIGGER export_mappings_touch BEFORE UPDATE ON export_mappings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- @file 138_trg_export_mappings_audit_drop
DROP TRIGGER IF EXISTS export_mappings_audit ON export_mappings;

-- @file 139_trg_export_mappings_audit_create
CREATE TRIGGER export_mappings_audit AFTER INSERT OR UPDATE OR DELETE ON export_mappings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 140_trg_api_keys_audit_drop
DROP TRIGGER IF EXISTS api_keys_audit ON api_keys;

-- @file 141_trg_api_keys_audit_create
CREATE TRIGGER api_keys_audit AFTER INSERT OR DELETE OR UPDATE OF revoked_at, name ON api_keys
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 142_trg_webhook_endpoints_audit_drop
DROP TRIGGER IF EXISTS webhook_endpoints_audit ON webhook_endpoints;

-- @file 143_trg_webhook_endpoints_audit_create
CREATE TRIGGER webhook_endpoints_audit AFTER INSERT OR UPDATE OR DELETE ON webhook_endpoints
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 144_trg_exports_audit_drop
DROP TRIGGER IF EXISTS exports_audit ON exports;

-- @file 145_trg_exports_audit_create
CREATE TRIGGER exports_audit AFTER INSERT ON exports
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
```
`db/migrations-src/06_payroll_rls.sql`:

```sql
-- Payroll tables are admin-only, except employees can read their own lines
-- from finalized runs. Integrations use the service key (bypasses RLS).

-- @file 160_payroll_runs_rls
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;

-- @file 161_payroll_run_lines_rls
ALTER TABLE payroll_run_lines ENABLE ROW LEVEL SECURITY;

-- @file 162_export_mappings_rls
ALTER TABLE export_mappings ENABLE ROW LEVEL SECURITY;

-- @file 163_exports_rls
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

-- @file 164_api_keys_rls
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- @file 165_webhook_endpoints_rls
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- @file 166_webhook_deliveries_rls
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- @file 170_payroll_runs_admin_drop
DROP POLICY IF EXISTS payroll_runs_admin ON payroll_runs;

-- @file 171_payroll_runs_admin_create
CREATE POLICY payroll_runs_admin ON payroll_runs FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 172_payroll_run_lines_admin_drop
DROP POLICY IF EXISTS payroll_run_lines_admin ON payroll_run_lines;

-- @file 173_payroll_run_lines_admin_create
CREATE POLICY payroll_run_lines_admin ON payroll_run_lines FOR SELECT
    USING (app_is_admin());

-- @file 174_payroll_run_lines_own_drop
DROP POLICY IF EXISTS payroll_run_lines_own ON payroll_run_lines;

-- @file 175_payroll_run_lines_own_create
CREATE POLICY payroll_run_lines_own ON payroll_run_lines FOR SELECT
    USING (employee_id = app_current_employee_id() AND app_run_is_finalized(run_id));

-- @file 176_export_mappings_admin_drop
DROP POLICY IF EXISTS export_mappings_admin ON export_mappings;

-- @file 177_export_mappings_admin_create
CREATE POLICY export_mappings_admin ON export_mappings FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 178_exports_admin_drop
DROP POLICY IF EXISTS exports_admin ON exports;

-- @file 179_exports_admin_create
CREATE POLICY exports_admin ON exports FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 180_api_keys_admin_drop
DROP POLICY IF EXISTS api_keys_admin ON api_keys;

-- @file 181_api_keys_admin_create
CREATE POLICY api_keys_admin ON api_keys FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 182_webhook_endpoints_admin_drop
DROP POLICY IF EXISTS webhook_endpoints_admin ON webhook_endpoints;

-- @file 183_webhook_endpoints_admin_create
CREATE POLICY webhook_endpoints_admin ON webhook_endpoints FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 184_webhook_deliveries_admin_drop
DROP POLICY IF EXISTS webhook_deliveries_admin ON webhook_deliveries;

-- @file 185_webhook_deliveries_admin_create
CREATE POLICY webhook_deliveries_admin ON webhook_deliveries FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
```

- [ ] **Step 3: Generate and apply, twice (proves idempotency)**

Run: `npm run db:migrate && npm run db:migrate`
Expected: `Wrote 134 migration files to volcano/migrations`, then every file `... ok` and `Migrations deployed!` both times.

- [ ] **Step 4: Write the integration helpers and tests**

`tests/integration/helpers.ts`:

```ts
import { VolcanoAuth } from '@volcano.dev/sdk';

export const API = process.env.VOLCANO_API_URL ?? 'http://localhost:8000';
export const ANON = process.env.VOLCANO_ANON_KEY ?? 'ak-0000000000000000000000000000000000000000';
export const SERVICE = process.env.VOLCANO_SERVICE_KEY ?? 'sk-1111111111111111111111111111111111111111';
export const DB = process.env.VOLCANO_DATABASE ?? 'payroll';
export const PASSWORD = 'Integration-Test-Password-1!';

// These tests wipe the database; refuse to run anywhere but the local stack.
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) {
  throw new Error(`Integration tests only run against a local Volcano stack (VOLCANO_API_URL=${API})`);
}

export function service(): VolcanoAuth {
  const v = new VolcanoAuth({ apiUrl: API, anonKey: SERVICE, accessToken: SERVICE });
  v.database(DB);
  return v;
}

export interface TestUser { client: VolcanoAuth; userId: string; email: string }

let counter = 0;

/** Creates and signs in a fresh auth user (local stacks don't require email confirmation). */
export async function newUser(label: string): Promise<TestUser> {
  const email = `${label}-${Date.now()}-${counter++}@example.com`;
  const client = new VolcanoAuth({ apiUrl: API, anonKey: ANON });
  const up = await client.auth.signUp({ email, password: PASSWORD });
  if (up.error) throw up.error;
  const { user, error } = await client.auth.signIn({ email, password: PASSWORD });
  if (error || !user) throw error ?? new Error('sign in failed');
  client.database(DB);
  return { client, userId: user.id, email };
}

type Res = { data: unknown; error: Error | null };

export async function ok<T = Record<string, unknown>>(q: PromiseLike<Res>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function errorOf(q: PromiseLike<Res>): Promise<string> {
  const { error } = await q;
  return error?.message ?? '';
}

const NIL = '00000000-0000-0000-0000-000000000000';

/** Deletes all application data (service key bypasses RLS and guard checks). */
export async function resetData(): Promise<void> {
  const db = service();
  for (const t of ['webhook_deliveries', 'webhook_endpoints', 'exports', 'api_keys', 'export_mappings', 'payroll_runs', 'time_entries', 'timesheets', 'pay_periods', 'compensation']) {
    await ok(db.delete(t).neq('id', NIL));
  }
  await ok(db.delete('audit_log').gte('id', 0));
  await ok(db.update('employees', { manager_id: null }).neq('id', NIL));
  await ok(db.delete('employees').neq('id', NIL));
}

export interface Org {
  admin: TestUser & { employeeId: string };
  manager: TestUser & { employeeId: string };
  alice: TestUser & { employeeId: string };
  bob: TestUser & { employeeId: string };
}

/** Admin, a manager, Alice (reports to the manager, hourly) and Bob (no manager, salaried). */
export async function seedOrg(): Promise<Org> {
  const db = service();
  const make = async (label: string, role: string, extra: Record<string, string | null> = {}) => {
    const u = await newUser(label);
    const [row] = await ok<{ id: string }>(db.insert('employees', {
      email: u.email, first_name: label, last_name: 'Test', role, hire_date: '2020-01-01', user_id: u.userId, ...extra,
    }));
    return { ...u, employeeId: row.id };
  };
  const admin = await make('admin', 'admin');
  const manager = await make('manager', 'manager');
  const alice = await make('alice', 'employee', { manager_id: manager.employeeId, external_id: 'E-ALICE' });
  const bob = await make('bob', 'employee', { external_id: 'E-BOB' });
  await ok(db.insert('compensation', { employee_id: alice.employeeId, pay_type: 'hourly', rate_cents: 2500, effective_from: '2020-01-01' }));
  await ok(db.insert('compensation', { employee_id: bob.employeeId, pay_type: 'salary', rate_cents: 12_000_000, effective_from: '2020-01-01' }));
  await ok(db.insert('compensation', { employee_id: manager.employeeId, pay_type: 'salary', rate_cents: 15_000_000, effective_from: '2020-01-01' }));
  await ok(db.insert('compensation', { employee_id: admin.employeeId, pay_type: 'salary', rate_cents: 18_000_000, effective_from: '2020-01-01' }));
  return { admin, manager, alice, bob };
}

export async function openPeriod(month = '2026-09'): Promise<string> {
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [p] = await ok<{ id: string }>(service().insert('pay_periods', { start_date: `${month}-01`, end_date: end }));
  return p.id;
}
```
`tests/integration/rls.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok, openPeriod, resetData, seedOrg, service, type Org } from './helpers';

let org: Org;
let periodId: string;

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  periodId = await openPeriod();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('employees', () => {
  it('employees see only themselves', async () => {
    expect(ids(await ok(org.alice.client.from('employees').select('id')))).toEqual([org.alice.employeeId]);
  });
  it('managers see themselves and direct reports', async () => {
    expect(ids(await ok(org.manager.client.from('employees').select('id')))).toEqual([org.alice.employeeId, org.manager.employeeId].sort());
  });
  it('admins see everyone', async () => {
    expect(await ok(org.admin.client.from('employees').select('id'))).toHaveLength(4);
  });
  it('employees cannot change their own role (RLS filters the write)', async () => {
    expect(await ok(org.alice.client.update('employees', { role: 'admin' }).eq('id', org.alice.employeeId))).toEqual([]);
    const [me] = await ok<{ role: string }>(service().from('employees').select('role').eq('id', org.alice.employeeId));
    expect(me.role).toBe('employee');
  });
  it('anonymous requests see nothing', async () => {
    const { VolcanoAuth } = await import('@volcano.dev/sdk');
    const { API, ANON, DB } = await import('./helpers');
    const anon = new VolcanoAuth({ apiUrl: API, anonKey: ANON });
    anon.database(DB);
    const { data } = await anon.from('employees').select('id');
    expect(data ?? []).toEqual([]);
  });
  it('the last active admin cannot be demoted', async () => {
    expect(await errorOf(org.admin.client.update('employees', { role: 'employee' }).eq('id', org.admin.employeeId))).toContain('CONFLICT:LAST_ADMIN');
  });
});

describe('compensation', () => {
  it('is visible to its employee and admins only', async () => {
    expect(await ok(org.alice.client.from('compensation').select('id'))).toHaveLength(1);
    expect(await ok(org.manager.client.from('compensation').select('id').eq('employee_id', org.alice.employeeId))).toEqual([]);
    expect(await ok(org.bob.client.from('compensation').select('id').eq('employee_id', org.alice.employeeId))).toEqual([]);
    expect(await ok(org.admin.client.from('compensation').select('id'))).toHaveLength(4);
  });
  it('cannot be written by employees', async () => {
    expect(await errorOf(org.alice.client.insert('compensation', { employee_id: org.alice.employeeId, pay_type: 'hourly', rate_cents: 99_999, effective_from: '2026-01-01' })))
      .not.toBe('');
  });
});

describe('timesheets', () => {
  let aliceSheet: string;
  beforeAll(async () => {
    [{ id: aliceSheet }] = await ok<{ id: string }>(org.alice.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }));
    await ok(org.alice.client.insert('time_entries', { timesheet_id: aliceSheet, work_date: '2026-09-07', earning_code: 'REG', hours: 8 }));
  });

  it('cannot be created for someone else', async () => {
    expect(await errorOf(org.bob.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }))).not.toBe('');
  });
  it('are visible to the owner, their manager and admins only', async () => {
    expect(await ok(org.alice.client.from('timesheets').select('id'))).toHaveLength(1);
    expect(await ok(org.manager.client.from('timesheets').select('id').eq('id', aliceSheet))).toHaveLength(1);
    expect(await ok(org.bob.client.from('timesheets').select('id').eq('id', aliceSheet))).toEqual([]);
    expect(await ok(org.bob.client.from('time_entries').select('id'))).toEqual([]);
    expect(await ok(org.admin.client.from('time_entries').select('id'))).toHaveLength(1);
  });
  it('entries cannot be written by the manager', async () => {
    expect(await ok(org.manager.client.update('time_entries', { hours: 1 }).eq('timesheet_id', aliceSheet))).toEqual([]);
  });
});

describe('payroll tables', () => {
  it('are hidden from non-admins', async () => {
    for (const t of ['payroll_runs', 'exports', 'api_keys', 'webhook_endpoints', 'webhook_deliveries', 'audit_log']) {
      expect(await ok(org.manager.client.from(t).select('id')), t).toEqual([]);
    }
  });
});
```
`tests/integration/lifecycle.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok, openPeriod, resetData, seedOrg, service, type Org } from './helpers';

let org: Org;
let periodId: string;
let sheet: string;

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  periodId = await openPeriod();
  [{ id: sheet }] = await ok<{ id: string }>(org.alice.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }));
});

const status = async (table: string, id: string) =>
  (await ok<{ status: string }>(service().from(table).select('status').eq('id', id)))[0].status;

describe('timesheet workflow', () => {
  it('rejects entries outside the period', async () => {
    expect(await errorOf(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-10-01', earning_code: 'REG', hours: 8 })))
      .toContain('CONFLICT:OUTSIDE_PERIOD');
  });
  it('does not let an employee approve their own timesheet', async () => {
    expect(await errorOf(org.alice.client.update('timesheets', { status: 'approved' }).eq('id', sheet))).toContain('CONFLICT:INVALID_TRANSITION');
  });
  it('locks entries once submitted', async () => {
    await ok(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-09-07', earning_code: 'REG', hours: 9 }));
    await ok(org.alice.client.update('timesheets', { status: 'submitted' }).eq('id', sheet));
    expect(await errorOf(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-09-08', earning_code: 'REG', hours: 8 })))
      .toContain('CONFLICT:TIMESHEET_LOCKED');
  });
  it('needs a note to reject, then lets the owner fix and resubmit', async () => {
    expect(await errorOf(org.manager.client.update('timesheets', { status: 'rejected' }).eq('id', sheet))).toContain('CONFLICT:NOTE_REQUIRED');
    await ok(org.manager.client.update('timesheets', { status: 'rejected', rejection_note: 'Missing Tuesday' }).eq('id', sheet));
    await ok(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-09-08', earning_code: 'REG', hours: 8 }));
    await ok(org.alice.client.update('timesheets', { status: 'submitted' }).eq('id', sheet));
    const [row] = await ok<{ rejection_note: string | null }>(service().from('timesheets').select('rejection_note').eq('id', sheet));
    expect(row.rejection_note).toBeNull();
  });
  it('managers approve their reports and are recorded as approver', async () => {
    await ok(org.manager.client.update('timesheets', { status: 'approved' }).eq('id', sheet));
    const [row] = await ok<{ status: string; approved_by: string }>(service().from('timesheets').select('status,approved_by').eq('id', sheet));
    expect(row).toEqual({ status: 'approved', approved_by: org.manager.employeeId });
  });
});

describe('payroll run lifecycle', () => {
  let runId: string;
  const lines = () => JSON.stringify([{
    employee_id: org.alice.employeeId, external_id: 'E-ALICE', first_name: 'alice', last_name: 'Test', email: org.alice.email,
    pay_type: 'hourly', work_state: null, earning_code: 'REG', hours: 17, days: null, rate_cents: 2500, amount_cents: 42_500,
  }]);

  it('needs a locked period', async () => {
    expect(await errorOf(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: '[]' }))).toContain('CONFLICT:PERIOD_NOT_LOCKED');
  });
  it('expands lines on insert and keeps JSON columns as JSON', async () => {
    await ok(org.admin.client.update('pay_periods', { status: 'locked' }).eq('id', periodId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', {
      pay_period_id: periodId,
      totals: JSON.stringify({ employee_count: 1, gross_cents: 42_500, by_code: {} }),
      warnings: JSON.stringify([{ employee_id: org.bob.employeeId, code: 'NO_APPROVED_TIMESHEET', blocking: true, message: 'x' }]),
      lines_input: lines(),
    }));
    const [run] = await ok<{ totals: { gross_cents: number }; lines_input: string | null }>(service().from('payroll_runs').select('totals,lines_input').eq('id', runId));
    expect(run.totals.gross_cents).toBe(42_500);
    expect(run.lines_input).toBeNull();
    const l = await ok<{ hours: string; amount_cents: number; pay_period_id: string }>(service().from('payroll_run_lines').select('hours,amount_cents,pay_period_id').eq('run_id', runId));
    expect(l).toEqual([{ hours: '17.00', amount_cents: 42_500, pay_period_id: periodId }]);
  });
  it('allows only one active run per period', async () => {
    expect(await errorOf(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: '[]' }))).toMatch(/duplicate key|unique/i);
  });
  it('blocks the reopening of a period with a run', async () => {
    expect(await errorOf(org.admin.client.update('pay_periods', { status: 'open' }).eq('id', periodId))).toContain('CONFLICT:RUN_EXISTS');
  });
  it('refuses to finalize with blocking warnings', async () => {
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_HAS_BLOCKING_WARNINGS');
  });
  it('refuses to finalize a stale draft', async () => {
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines() }));
    await ok(org.admin.client.insert('compensation', { employee_id: org.alice.employeeId, pay_type: 'hourly', rate_cents: 2600, effective_from: '2026-12-01' }));
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_STALE');
  });
  it('finalizes: freezes the run, finalizes the period, shows lines to the employee and queues webhooks', async () => {
    await ok(org.admin.client.insert('webhook_endpoints', { url: 'https://example.com/hook', secret: `whsec_${'x'.repeat(40)}` }));
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines() }));
    expect(await ok(org.alice.client.from('payroll_run_lines').select('id'))).toEqual([]);
    await ok(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId));
    expect(await status('pay_periods', periodId)).toBe('finalized');
    expect(await ok(org.alice.client.from('payroll_run_lines').select('id'))).toHaveLength(1);
    expect(await ok(org.bob.client.from('payroll_run_lines').select('id'))).toEqual([]);
    const d = await ok<{ event: string; payload: { data: { run_id: string } } }>(service().from('webhook_deliveries').select('event,payload'));
    expect(d.map((x) => [x.event, x.payload.data.run_id])).toEqual([['payroll_run.finalized', runId]]);
    expect(await errorOf(org.admin.client.update('payroll_runs', { totals: '{"edited":true}' }).eq('id', runId))).toContain('CONFLICT:RUN_FROZEN');
    expect(await errorOf(org.admin.client.delete('payroll_runs').eq('id', runId))).toContain('CONFLICT:RUN_FROZEN');
    expect(await errorOf(org.admin.client.update('timesheets', { status: 'draft' }).eq('id', sheet))).toContain('CONFLICT:PERIOD_FINALIZED');
  });
  it('voids with a reason and relocks the period', async () => {
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'voided' }).eq('id', runId))).toContain('CONFLICT:NOTE_REQUIRED');
    await ok(org.admin.client.update('payroll_runs', { status: 'voided', void_reason: 'wrong rate' }).eq('id', runId));
    expect(await status('pay_periods', periodId)).toBe('locked');
    expect(await ok(org.alice.client.from('payroll_run_lines').select('id'))).toEqual([]);
    const events = (await ok<{ event: string }>(service().from('webhook_deliveries').select('event'))).map((x) => x.event).sort();
    expect(events).toEqual(['payroll_run.finalized', 'payroll_run.voided']);
  });
  it('audits the important changes', async () => {
    const actions = (await ok<{ action: string }>(org.admin.client.from('audit_log').select('action').limit(500))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['timesheet.approved', 'timesheet.rejected', 'payroll_run.finalized', 'payroll_run.voided']));
  });
});
```

- [ ] **Step 5: Run the integration tests**

Run: `npm run test:integration -- tests/integration/rls.test.ts tests/integration/lifecycle.test.ts`
Expected: PASS (26 tests). This wipes the local `payroll` database.

- [ ] **Step 6: Commit**

```sh
git add db/migrations-src volcano/migrations tests/integration/helpers.ts tests/integration/rls.test.ts tests/integration/lifecycle.test.ts
git commit -m "feat: add payroll schema with RLS, state-machine guards and audit log"
```

---
### Task 9: Server modules (functions and API plumbing)

**Files:**
- Create: `src/server/http.ts`, `src/server/volcano.ts`, `src/server/db.ts`, `src/server/auth.ts`, `src/server/payroll-data.ts`, `src/server/runs.ts`, `src/server/mappings.ts`, `src/server/webhooks.ts`
- Test: `tests/unit/auth-guards.test.ts`, `tests/integration/finalized-run.ts`, `tests/integration/webhooks.test.ts`

**Interfaces:**
- `http.ts`: `HttpError(status, code, message, details?)`, `fromDbError(err)`, `FunctionResponse`, `ok(body)`, `errorResponse(err)`, `VolcanoAuthContext`, `FunctionEvent`, `authOf(event)`, `handle(fn)`, `requireString(v, name)`.
- `volcano.ts`: `databaseName()`, `userClient(accessToken)`, `serviceClient()` (reads `VOLCANO_*` or `NEXT_PUBLIC_VOLCANO_*`).
- `db.ts`: `rows<T>(q)`, `one<T>(q, notFound?)`, `mutated<T>(q, what)`, `selectAll<T>(page, size?)`, `asJson(v)`, `num(v)`, `isoDate(v)`, `chunk(items, size)`.
- `auth.ts`: `Me`, `requireEmployee(db, auth, roles?)`, `assertEmailConfirmed(user, allowUnconfirmed)`.
- `payroll-data.ts`: `PeriodRow`, `loadPeriod(db, id)`, `loadSettings(db)`, `loadCalcInput(db, period, skippedIds): CalcInput`.
- `runs.ts`: `RunRow`, `loadRun(db, id): {run, exportRun}`, `loadRunLines(db, id): ExportLine[]`.
- `mappings.ts`: `resolveMapping(db, key): MappingConfig`.
- `webhooks.ts`: `AttemptResult`, `DispatchSummary {delivered, retrying, failed}`, `DispatchOptions {now?, fetchImpl?, limit?, allowHttp?}`, `deliverOnce(...)`, `dispatchDue(db, opts?)`.

- [ ] **Step 1: Write the failing unit test for the email-confirmation guard**

`tests/unit/auth-guards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertEmailConfirmed } from '../../src/server/auth';
import { HttpError } from '../../src/server/http';

describe('assertEmailConfirmed', () => {
  it('lets confirmed users through', () => {
    expect(() => assertEmailConfirmed({ email_confirmed: true }, false)).not.toThrow();
  });
  it('blocks unconfirmed or unknown confirmation state', () => {
    for (const user of [{ email_confirmed: false }, {}]) {
      try {
        assertEmailConfirmed(user, false);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).code).toBe('EMAIL_NOT_CONFIRMED');
      }
    }
  });
  it('can be relaxed for local development', () => {
    expect(() => assertEmailConfirmed({ email_confirmed: false }, true)).not.toThrow();
  });
});
```

Run: `npx vitest run tests/unit/auth-guards.test.ts`
Expected: FAIL, cannot resolve `../../src/server/auth`.

- [ ] **Step 2: Implement HTTP, client and query plumbing**

`src/server/http.ts`:

```ts
import { parseDbError } from '../lib/db-errors';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const fromDbError = (err: Error): HttpError => {
  const p = parseDbError(err.message);
  return new HttpError(p.status, p.code, p.message);
};

export interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const ok = (body: unknown): FunctionResponse => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });

export function errorResponse(err: unknown): FunctionResponse {
  if (err instanceof HttpError) {
    return { statusCode: err.status, headers: JSON_HEADERS, body: JSON.stringify({ error: err.message, code: err.code, details: err.details }) };
  }
  console.error(err);
  return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', code: 'INTERNAL' }) };
}

export interface VolcanoAuthContext {
  user_id: string;
  email: string;
  access_token: string;
  project_id?: string;
  role?: string;
}

export type FunctionEvent = Record<string, unknown> & { __volcano_auth?: VolcanoAuthContext; __volcano_schedule?: unknown };

export function authOf(event: FunctionEvent): VolcanoAuthContext {
  const a = event.__volcano_auth;
  if (!a?.access_token || !a.user_id) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
  return a;
}

/** Wraps a handler: normalises the event, returns 200 JSON on success and mapped errors otherwise. */
export function handle(fn: (event: FunctionEvent) => Promise<unknown>) {
  return async (event: unknown): Promise<FunctionResponse> => {
    try {
      return ok(await fn((event && typeof event === 'object' && !Array.isArray(event) ? event : {}) as FunctionEvent));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'BAD_REQUEST', `${name} is required`);
  return v.trim();
}
```
`src/server/volcano.ts`:

```ts
import { VolcanoAuth } from '@volcano.dev/sdk';

function env(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing environment variable ${names[0]}`);
}

const apiUrl = () => env('VOLCANO_API_URL', 'NEXT_PUBLIC_VOLCANO_API_URL');

export const databaseName = (): string =>
  process.env.VOLCANO_DATABASE || process.env.NEXT_PUBLIC_VOLCANO_DATABASE || 'payroll';

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
```
`src/server/db.ts`:

```ts
import { HttpError, fromDbError } from './http';

interface Result { data: unknown; error: Error | null }

/** Awaits a query or mutation; throws a mapped HttpError on failure. */
export async function rows<T>(q: PromiseLike<Result>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw fromDbError(error);
  return (data ?? []) as T[];
}

export async function one<T>(q: PromiseLike<Result>, notFound = 'Not found'): Promise<T> {
  const [row] = await rows<T>(q);
  if (!row) throw new HttpError(404, 'NOT_FOUND', notFound);
  return row;
}

/** RLS silently filters writes, so a mutation that touched nothing means "not allowed / not found". */
export async function mutated<T>(q: PromiseLike<Result>, what: string): Promise<T[]> {
  const out = await rows<T>(q);
  if (out.length === 0) throw new HttpError(403, 'FORBIDDEN', `Not allowed to change ${what}, or it does not exist`);
  return out;
}

/** Pages through a query that must apply `.limit(limit).offset(offset)`. */
export async function selectAll<T>(page: (offset: number, limit: number) => PromiseLike<Result>, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += size) {
    const batch = await rows<T>(page(offset, size));
    out.push(...batch);
    if (batch.length < size) return out;
  }
}

/** JSONB columns must be written as JSON text; they read back as parsed values. */
export const asJson = (v: unknown): string => JSON.stringify(v);

/** NUMERIC columns read back as strings. */
export const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** DATE columns: keep the YYYY-MM-DD part whatever the API returns. */
export const isoDate = (v: unknown): string => String(v).slice(0, 10);

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```
`src/server/auth.ts`:

```ts
import type { VolcanoAuth } from '@volcano.dev/sdk';
import type { Role } from '../lib/employee-import';
import { rows } from './db';
import { HttpError, type VolcanoAuthContext } from './http';

export interface Me {
  id: string;
  role: Role;
  first_name: string;
  last_name: string;
  email: string;
}

/** The caller's active employee row (read under RLS with their own token). */
export async function requireEmployee(db: VolcanoAuth, auth: VolcanoAuthContext, roles?: Role[]): Promise<Me> {
  const [me] = await rows<Me>(
    db.from('employees').select('id,role,first_name,last_name,email').eq('user_id', auth.user_id).eq('status', 'active').limit(1),
  );
  if (!me) throw new HttpError(403, 'NOT_INVITED', 'No active employee record is linked to this account');
  if (roles && !roles.includes(me.role)) throw new HttpError(403, 'FORBIDDEN', `This needs the ${roles.join(' or ')} role`);
  return me;
}

/**
 * Volcano issues a session at sign-up before the email is confirmed, so an
 * unconfirmed address must never claim an employee record. Local stacks send
 * no email, hence the explicit opt-out (never set it in the cloud).
 */
export function assertEmailConfirmed(user: { email_confirmed?: boolean }, allowUnconfirmed: boolean): void {
  if (user.email_confirmed !== true && !allowUnconfirmed) {
    throw new HttpError(403, 'EMAIL_NOT_CONFIRMED', 'Confirm your email address, then sign in again');
  }
}
```

Run: `npx vitest run tests/unit/auth-guards.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Implement data loading, runs, mappings and webhook dispatch**

`src/server/payroll-data.ts`:

```ts
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { addDays, monthBounds, weekStart, type ISODate } from '../lib/dates';
import type { CalcInput, CalcTimesheet, CompSegment, EntryCode, OvertimeSettings, PayType, TimeEntry, TimesheetStatus } from '../lib/types';
import { chunk, isoDate, num, one, rows, selectAll } from './db';

export interface PeriodRow { id: string; start_date: ISODate; end_date: ISODate; status: 'open' | 'locked' | 'finalized' }

interface EmployeeRow {
  id: string; external_id: string | null; first_name: string; last_name: string; email: string;
  work_state: string | null; hire_date: string; termination_date: string | null;
}
interface TimesheetRow { id: string; employee_id: string; status: TimesheetStatus }
interface EntryRow { timesheet_id: string; work_date: string; earning_code: EntryCode; hours: unknown; days: unknown }

export async function loadPeriod(db: VolcanoAuth, periodId: string): Promise<PeriodRow> {
  const p = await one<PeriodRow>(db.from('pay_periods').select('id,start_date,end_date,status').eq('id', periodId), 'Pay period not found');
  return { ...p, start_date: isoDate(p.start_date), end_date: isoDate(p.end_date) };
}

export async function loadSettings(db: VolcanoAuth): Promise<OvertimeSettings> {
  const s = await one<Record<string, unknown>>(db.from('settings').select(
    'ot_weekly_threshold,ot_daily_threshold,dt_daily_threshold,ot_multiplier,dt_multiplier,ot_applies_to_daily,week_starts_on'));
  return {
    ot_weekly_threshold: num(s.ot_weekly_threshold),
    ot_daily_threshold: num(s.ot_daily_threshold),
    dt_daily_threshold: num(s.dt_daily_threshold),
    ot_multiplier: num(s.ot_multiplier) ?? 1.5,
    dt_multiplier: num(s.dt_multiplier) ?? 2,
    ot_applies_to_daily: s.ot_applies_to_daily === true,
    week_starts_on: num(s.week_starts_on) ?? 0,
  };
}

async function loadTimesheets(db: VolcanoAuth, periodId: string): Promise<TimesheetRow[]> {
  return selectAll<TimesheetRow>((o, l) =>
    db.from('timesheets').select('id,employee_id,status').eq('pay_period_id', periodId).order('id').limit(l).offset(o));
}

async function loadEntries(db: VolcanoAuth, timesheetIds: string[]): Promise<EntryRow[]> {
  const out: EntryRow[] = [];
  for (const ids of chunk(timesheetIds, 100)) {
    out.push(...await selectAll<EntryRow>((o, l) =>
      db.from('time_entries').select('timesheet_id,work_date,earning_code,hours,days').in('timesheet_id', ids).order('id').limit(l).offset(o)));
  }
  return out;
}

const toEntry = (e: EntryRow): TimeEntry => ({
  work_date: isoDate(e.work_date), earning_code: e.earning_code, hours: num(e.hours), days: num(e.days),
});

/** Everything calculateRun needs for one period. */
export async function loadCalcInput(db: VolcanoAuth, period: PeriodRow, skippedEmployeeIds: string[]): Promise<CalcInput> {
  const settings = await loadSettings(db);

  const employees = (await selectAll<EmployeeRow>((o, l) =>
    db.from('employees').select('id,external_id,first_name,last_name,email,work_state,hire_date,termination_date')
      .lte('hire_date', period.end_date).order('id').limit(l).offset(o)))
    .map((e) => ({ ...e, hire_date: isoDate(e.hire_date), termination_date: e.termination_date ? isoDate(e.termination_date) : null }))
    .filter((e) => !e.termination_date || e.termination_date >= period.start_date);

  const compensation: CompSegment[] = (await selectAll<{ employee_id: string; pay_type: PayType; rate_cents: unknown; effective_from: string }>((o, l) =>
    db.from('compensation').select('employee_id,pay_type,rate_cents,effective_from').order('id').limit(l).offset(o)))
    .map((c) => ({ ...c, rate_cents: Number(c.rate_cents), effective_from: isoDate(c.effective_from) }));

  const sheets = await loadTimesheets(db, period.id);
  const entries = await loadEntries(db, sheets.map((t) => t.id));
  const timesheets: CalcTimesheet[] = sheets.map((t) => ({
    employee_id: t.employee_id,
    status: t.status,
    entries: entries.filter((e) => e.timesheet_id === t.id).map(toEntry),
  }));

  // Approved entries from the previous month that share the first workweek.
  const priorEntries: Record<string, TimeEntry[]> = {};
  const firstWeek = weekStart(period.start_date, settings.week_starts_on);
  if (firstWeek < period.start_date) {
    const prevStart = monthBounds(addDays(period.start_date, -1).slice(0, 7)).start;
    const [prev] = await rows<{ id: string }>(db.from('pay_periods').select('id').eq('start_date', prevStart).limit(1));
    if (prev) {
      const prevSheets = (await loadTimesheets(db, prev.id)).filter((t) => t.status === 'approved');
      const prevEntries = await loadEntries(db, prevSheets.map((t) => t.id));
      for (const t of prevSheets) {
        priorEntries[t.employee_id] = prevEntries
          .filter((e) => e.timesheet_id === t.id).map(toEntry)
          .filter((e) => e.work_date >= firstWeek);
      }
    }
  }

  return {
    period: { start: period.start_date, end: period.end_date },
    employees,
    compensation,
    timesheets,
    priorEntries,
    settings,
    skippedEmployeeIds,
  };
}
```
`src/server/runs.ts`:

```ts
import type { VolcanoAuth } from '@volcano.dev/sdk';
import type { ExportLine, ExportRun } from '../lib/exporters';
import type { EarningCode, PayType, RunTotals } from '../lib/types';
import { isoDate, num, one, selectAll } from './db';

export interface RunRow {
  id: string;
  pay_period_id: string;
  status: 'draft' | 'finalized' | 'voided';
  totals: RunTotals;
  warnings: unknown[];
  finalized_at: string | null;
  voided_at: string | null;
}

interface LineRow {
  employee_id: string; external_id: string | null; first_name: string; last_name: string; email: string;
  pay_type: PayType; work_state: string | null; earning_code: EarningCode;
  hours: unknown; days: unknown; rate_cents: unknown; amount_cents: unknown;
}

export async function loadRun(db: VolcanoAuth, runId: string): Promise<{ run: RunRow; exportRun: ExportRun }> {
  const run = await one<RunRow>(db.from('payroll_runs')
    .select('id,pay_period_id,status,totals,warnings,finalized_at,voided_at').eq('id', runId), 'Payroll run not found');
  const p = await one<{ start_date: string; end_date: string }>(db.from('pay_periods').select('start_date,end_date').eq('id', run.pay_period_id));
  return {
    run,
    exportRun: { id: run.id, period_start: isoDate(p.start_date), period_end: isoDate(p.end_date), finalized_at: run.finalized_at, totals: run.totals },
  };
}

export async function loadRunLines(db: VolcanoAuth, runId: string): Promise<ExportLine[]> {
  const raw = await selectAll<LineRow>((o, l) => db.from('payroll_run_lines')
    .select('employee_id,external_id,first_name,last_name,email,pay_type,work_state,earning_code,hours,days,rate_cents,amount_cents')
    .eq('run_id', runId).order('id').limit(l).offset(o));
  return raw.map((l) => ({
    ...l, hours: num(l.hours), days: num(l.days), rate_cents: Number(l.rate_cents), amount_cents: Number(l.amount_cents),
  }));
}
```
`src/server/mappings.ts`:

```ts
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { findPreset, type MappingConfig } from '../lib/exporters';
import { one } from './db';
import { HttpError } from './http';

/** Preset keys ("gusto") are used as-is; custom mappings are addressed as "custom:<uuid>". */
export async function resolveMapping(db: VolcanoAuth, key: string): Promise<MappingConfig> {
  if (key.startsWith('custom:')) {
    const id = key.slice(7);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'NOT_FOUND', `Unknown export mapping "${key}"`);
    const m = await one<{ config: MappingConfig }>(db.from('export_mappings').select('config').eq('id', id), 'Export mapping not found');
    return m.config;
  }
  const preset = findPreset(key);
  if (!preset) throw new HttpError(404, 'NOT_FOUND', `Unknown export mapping "${key}"`);
  return preset.config;
}
```
`src/server/webhooks.ts`:

```ts
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { nextAttemptAt, signWebhook } from '../lib/signing';
import { rows } from './db';

interface Delivery { id: string; endpoint_id: string; event: string; payload: unknown; attempts: number }
interface Endpoint { id: string; url: string; secret: string; active: boolean }
export interface AttemptResult { ok: boolean; code: number | null; error: string | null }
export interface DispatchSummary { delivered: number; retrying: number; failed: number }

export interface DispatchOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  limit?: number;
  /** Plain-http targets are refused unless PAYROLL_ALLOW_HTTP_WEBHOOKS=true (local testing only). */
  allowHttp?: boolean;
}

export async function deliverOnce(ep: Endpoint, d: Delivery, now: Date, fetchImpl: typeof fetch, allowHttp: boolean): Promise<AttemptResult> {
  if (!ep.active) return { ok: false, code: null, error: 'Endpoint is inactive' };
  if (!allowHttp && !ep.url.startsWith('https://')) return { ok: false, code: null, error: 'Webhook URLs must use https' };
  const body = JSON.stringify(d.payload);
  try {
    const res = await fetchImpl(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'payroll-webhooks/1',
        'X-Payroll-Event': d.event,
        'X-Payroll-Delivery': d.id,
        'X-Payroll-Signature': signWebhook(ep.secret, body, Math.floor(now.getTime() / 1000)),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return res.status >= 200 && res.status < 300
      ? { ok: true, code: res.status, error: null }
      : { ok: false, code: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, code: null, error: String((e as Error).message ?? e).slice(0, 500) };
  }
}

/** Sends every pending delivery that is due, recording the outcome and scheduling retries. Needs a service client. */
export async function dispatchDue(db: VolcanoAuth, opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowHttp = opts.allowHttp ?? process.env.PAYROLL_ALLOW_HTTP_WEBHOOKS === 'true';
  const summary: DispatchSummary = { delivered: 0, retrying: 0, failed: 0 };

  const due = await rows<Delivery>(db.from('webhook_deliveries').select('id,endpoint_id,event,payload,attempts')
    .eq('status', 'pending').lte('next_attempt_at', now.toISOString()).order('next_attempt_at').limit(opts.limit ?? 50));
  if (due.length === 0) return summary;
  const endpoints = new Map((await rows<Endpoint>(db.from('webhook_endpoints').select('id,url,secret,active')
    .in('id', [...new Set(due.map((d) => d.endpoint_id))]))).map((e) => [e.id, e]));

  for (const d of due) {
    const ep = endpoints.get(d.endpoint_id);
    const r = ep ? await deliverOnce(ep, d, now, fetchImpl, allowHttp) : { ok: false, code: null, error: 'Endpoint deleted' };
    const attempts = d.attempts + 1;
    if (r.ok) {
      summary.delivered++;
      await rows(db.update('webhook_deliveries', {
        status: 'delivered', attempts, delivered_at: now.toISOString(), last_response_code: r.code, last_error: null,
      }).eq('id', d.id));
      continue;
    }
    const next = nextAttemptAt(attempts, now);
    if (next) summary.retrying++; else summary.failed++;
    await rows(db.update('webhook_deliveries', {
      status: next ? 'pending' : 'failed', attempts, next_attempt_at: (next ?? now).toISOString(),
      last_response_code: r.code, last_error: r.error,
    }).eq('id', d.id));
  }
  return summary;
}
```

- [ ] **Step 4: Write the webhook integration test**

`tests/integration/finalized-run.ts`:

```ts
import { ok, openPeriod, service, type Org } from './helpers';

/** A finalized September run with one line for Alice, created through the service key. */
export async function finalizedRun(org: Org): Promise<{ periodId: string; runId: string }> {
  const db = service();
  const periodId = await openPeriod('2026-09');
  await ok(db.update('pay_periods', { status: 'locked' }).eq('id', periodId));
  const [{ id: runId }] = await ok<{ id: string }>(db.insert('payroll_runs', {
    pay_period_id: periodId,
    totals: JSON.stringify({ employee_count: 1, gross_cents: 100_000, by_code: { REG: { hours: 40, days: 0, amount_cents: 100_000 } } }),
    lines_input: JSON.stringify([{
      employee_id: org.alice.employeeId, external_id: 'E-ALICE', first_name: 'Alice', last_name: 'Test', email: org.alice.email,
      pay_type: 'hourly', work_state: 'CA', earning_code: 'REG', hours: 40, days: null, rate_cents: 2500, amount_cents: 100_000,
    }]),
  }));
  await ok(db.update('payroll_runs', { status: 'finalized' }).eq('id', runId));
  return { periodId, runId };
}
```
`tests/integration/webhooks.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/lib/signing';
import { dispatchDue } from '../../src/server/webhooks';
import { finalizedRun } from './finalized-run';
import { ok, resetData, seedOrg, service } from './helpers';

const SECRET = `whsec_${'s'.repeat(40)}`;
let server: Server;
let url: string;
let respondWith = 200;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = respondWith;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  await resetData();
  const org = await seedOrg();
  await ok(service().insert('webhook_endpoints', { url, secret: SECRET }));
  await finalizedRun(org);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const deliveries = () => ok<{ status: string; attempts: number; next_attempt_at: string; last_response_code: number | null }>(
  service().from('webhook_deliveries').select('status,attempts,next_attempt_at,last_response_code'));

describe('dispatchDue', () => {
  it('refuses plain http unless allowed', async () => {
    const r = await dispatchDue(service(), { allowHttp: false });
    expect(r).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    expect(received).toHaveLength(0);
  });

  it('retries a failing receiver with backoff', async () => {
    respondWith = 500;
    const later = new Date(Date.now() + 2 * 60_000); // past the 1-minute backoff from the first attempt
    expect(await dispatchDue(service(), { allowHttp: true, now: later })).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    const [d] = await deliveries();
    expect(d).toMatchObject({ status: 'pending', attempts: 2, last_response_code: 500 });
    expect(new Date(d.next_attempt_at).getTime() - later.getTime()).toBe(300_000);
  });

  it('delivers a signed payload the receiver can verify', async () => {
    respondWith = 204;
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await dispatchDue(service(), { allowHttp: true, now: later })).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    const last = received[received.length - 1];
    expect(last.headers['x-payroll-event']).toBe('payroll_run.finalized');
    expect(verifyWebhookSignature(SECRET, last.body, String(last.headers['x-payroll-signature']), Math.floor(later.getTime() / 1000))).toBe(true);
    expect(JSON.parse(last.body)).toMatchObject({ event: 'payroll_run.finalized', data: { period_start: '2026-09-01' } });
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 3 });
  });

  it('does nothing when nothing is due', async () => {
    expect(await dispatchDue(service(), { allowHttp: true })).toEqual({ delivered: 0, retrying: 0, failed: 0 });
  });
});
```

- [ ] **Step 5: Run the tests and type check**

Run: `npx tsc --noEmit && npm test && npm run test:integration -- tests/integration/webhooks.test.ts`
Expected: no type errors; all unit tests pass; webhooks PASS (4 tests).

- [ ] **Step 6: Commit**

```sh
git add src/server tests/unit/auth-guards.test.ts tests/integration/finalized-run.ts tests/integration/webhooks.test.ts
git commit -m "feat: add server plumbing, payroll data loading and webhook dispatch"
```

---
### Task 10: Read-only integration API

**Files:**
- Create: `src/server/integration-api.ts`
- Test: `tests/integration/integration-api.test.ts`

**Interfaces:**
- Consumes: `render` (Task 4), `apiKeyMatches`, `parseApiKey`, `sha256Hex` (Task 5), `rows`, `isoDate`, `HttpError`, `resolveMapping`, `loadRun`, `loadRunLines` (Task 9).
- Produces: `ApiResponse {status, headers, body}`, `handleIntegrationRequest(db, method, path: string[], query: URLSearchParams, authorization: string | null): Promise<ApiResponse>`. Routes: `GET runs?status=finalized|voided`, `GET runs/{id}`, `GET runs/{id}/lines`, `GET runs/{id}/export?mapping=<key>`. Draft runs are invisible (404). Exports made through the API are recorded with `api_key_id`.

- [ ] **Step 1: Write the failing test**

`tests/integration/integration-api.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/lib/signing';
import { handleIntegrationRequest } from '../../src/server/integration-api';
import { finalizedRun } from './finalized-run';
import { ok, resetData, seedOrg, service } from './helpers';

let key: string;
let runId: string;

const call = (path: string[], query = '', auth: string | null = `Bearer ${key}`, method = 'GET') =>
  handleIntegrationRequest(service(), method, path, new URLSearchParams(query), auth);

beforeAll(async () => {
  await resetData();
  const org = await seedOrg();
  ({ runId } = await finalizedRun(org));
  const k = generateApiKey();
  key = k.key;
  await ok(service().insert('api_keys', { name: 'test', prefix: k.prefix, key_hash: k.hash }));
});

describe('integration API', () => {
  it('requires a valid key', async () => {
    expect((await call(['runs'], '', null)).status).toBe(401);
    expect((await call(['runs'], '', 'Bearer pk_00000000_' + 'a'.repeat(32))).status).toBe(401);
    expect((await call(['runs'], '', `Bearer ${key.slice(0, -1)}x`)).status).toBe(401);
  });

  it('is read-only', async () => {
    expect((await call(['runs'], '', `Bearer ${key}`, 'POST')).status).toBe(405);
  });

  it('lists finalized runs', async () => {
    const r = await call(['runs']);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).data).toEqual([expect.objectContaining({ id: runId, status: 'finalized', period_start: '2026-09-01', period_end: '2026-09-30' })]);
  });

  it('returns canonical lines', async () => {
    const r = await call(['runs', runId, 'lines']);
    expect(JSON.parse(r.body).data).toEqual([expect.objectContaining({ external_id: 'E-ALICE', earning_code: 'REG', hours: 40, amount_cents: 100_000 })]);
  });

  it('exports a preset and records the export', async () => {
    const r = await call(['runs', runId, 'export'], 'mapping=gusto');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="payroll-2026-09-gusto.csv"');
    expect(r.body.split('\r\n')[1]).toBe(`Test,Alice,${(await ok<{ email: string }>(service().from('employees').select('email').eq('external_id', 'E-ALICE')))[0].email},40.00,,,,,`);
    expect(await ok(service().from('exports').select('id'))).toHaveLength(1);
  });

  it('404s unknown runs, mappings and paths', async () => {
    expect((await call(['runs', 'not-a-uuid'])).status).toBe(404);
    expect((await call(['runs', '00000000-0000-4000-8000-000000000000'])).status).toBe(404);
    expect((await call(['runs', runId, 'export'], 'mapping=nope')).status).toBe(404);
    expect((await call(['employees'])).status).toBe(404);
  });

  it('rejects revoked keys', async () => {
    await ok(service().update('api_keys', { revoked_at: new Date().toISOString() }).neq('id', '00000000-0000-0000-0000-000000000000'));
    expect((await call(['runs'])).status).toBe(401);
  });
});
```

Run: `npm run test:integration -- tests/integration/integration-api.test.ts`
Expected: FAIL, cannot resolve `../../src/server/integration-api`.

- [ ] **Step 2: Implement**

`src/server/integration-api.ts`:

```ts
// Read-only REST API for payroll providers and connectors, served by the
// Next.js route web/app/api/v1/[...path]/route.ts. Uses the service client;
// every request must carry a valid API key.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { render } from '../lib/exporters';
import { apiKeyMatches, parseApiKey, sha256Hex } from '../lib/signing';
import { isoDate, rows } from './db';
import { HttpError } from './http';
import { resolveMapping } from './mappings';
import { loadRun, loadRunLines, type RunRow } from './runs';

export interface ApiResponse { status: number; headers: Record<string, string>; body: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown): ApiResponse => ({ status, headers: JSON_HEADERS, body: JSON.stringify(body) });

async function authenticate(db: VolcanoAuth, authorization: string | null): Promise<string> {
  const key = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const parsed = parseApiKey(key);
  const fail = new HttpError(401, 'UNAUTHENTICATED', 'Send a valid API key as "Authorization: Bearer pk_..."');
  if (!parsed) throw fail;
  const [row] = await rows<{ id: string; key_hash: string; revoked_at: string | null }>(
    db.from('api_keys').select('id,key_hash,revoked_at').eq('prefix', parsed.prefix).limit(1));
  if (!row || row.revoked_at || !apiKeyMatches(key, row.key_hash)) throw fail;
  await db.update('api_keys', { last_used_at: new Date().toISOString() }).eq('id', row.id);
  return row.id;
}

function runView(run: RunRow, period: { start_date: string; end_date: string }) {
  return {
    id: run.id, status: run.status, period_start: isoDate(period.start_date), period_end: isoDate(period.end_date),
    finalized_at: run.finalized_at, voided_at: run.voided_at, totals: run.totals,
  };
}

async function visibleRun(db: VolcanoAuth, id: string) {
  if (!UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', 'Payroll run not found');
  const loaded = await loadRun(db, id);
  if (loaded.run.status === 'draft') throw new HttpError(404, 'NOT_FOUND', 'Payroll run not found');
  return loaded;
}

async function route(db: VolcanoAuth, path: string[], query: URLSearchParams, apiKeyId: string): Promise<ApiResponse> {
  if (path.length === 1 && path[0] === 'runs') {
    const status = query.get('status') ?? 'finalized';
    if (!['finalized', 'voided'].includes(status)) throw new HttpError(400, 'BAD_REQUEST', 'status must be finalized or voided');
    const runs = await rows<RunRow>(db.from('payroll_runs').select('id,pay_period_id,status,totals,warnings,finalized_at,voided_at')
      .eq('status', status).order('finalized_at', { ascending: false }).limit(100));
    const periods = runs.length
      ? new Map((await rows<{ id: string; start_date: string; end_date: string }>(db.from('pay_periods').select('id,start_date,end_date')
        .in('id', [...new Set(runs.map((r) => r.pay_period_id))]))).map((p) => [p.id, p]))
      : new Map();
    return json(200, { data: runs.map((r) => runView(r, periods.get(r.pay_period_id)!)) });
  }
  if (path[0] !== 'runs' || path.length < 2 || path.length > 3) throw new HttpError(404, 'NOT_FOUND', 'Unknown endpoint');

  const { run, exportRun } = await visibleRun(db, path[1]);
  if (path.length === 2) {
    return json(200, { data: runView(run, { start_date: exportRun.period_start, end_date: exportRun.period_end }) });
  }
  if (path[2] === 'lines') return json(200, { data: await loadRunLines(db, run.id) });
  if (path[2] === 'export') {
    if (run.status !== 'finalized') throw new HttpError(409, 'RUN_NOT_FINALIZED', 'Only finalized runs can be exported');
    const mappingKey = query.get('mapping') ?? 'generic_csv';
    const config = await resolveMapping(db, mappingKey);
    let file;
    try {
      file = render(exportRun, await loadRunLines(db, run.id), config, mappingKey);
    } catch (e) {
      throw new HttpError(400, 'INVALID_MAPPING', (e as Error).message);
    }
    const sha256 = sha256Hex(file.body);
    await rows(db.insert('exports', {
      run_id: run.id, mapping_key: mappingKey, filename: file.filename, content_type: file.content_type,
      content: file.body, sha256, api_key_id: apiKeyId,
    }));
    return {
      status: 200,
      headers: {
        'Content-Type': file.content_type,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Content-SHA256': sha256,
        'Cache-Control': 'no-store',
      },
      body: file.body,
    };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Unknown endpoint');
}

export async function handleIntegrationRequest(
  db: VolcanoAuth, method: string, path: string[], query: URLSearchParams, authorization: string | null,
): Promise<ApiResponse> {
  try {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This API is read-only');
    const apiKeyId = await authenticate(db, authorization);
    return await route(db, path, query, apiKeyId);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code });
    console.error('integration api error', e);
    return json(500, { error: 'Internal error', code: 'INTERNAL' });
  }
}
```

- [ ] **Step 3: Run the test**

Run: `npm run test:integration -- tests/integration/integration-api.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```sh
git add src/server/integration-api.ts tests/integration/integration-api.test.ts
git commit -m "feat: add API-key authenticated read-only integration API"
```

---
### Task 11: Volcano Functions, config and admin bootstrap

**Files:**
- Create: `src/functions/employee-link.ts`, `employee-import.ts`, `payroll-run.ts`, `payroll-export.ts`, `webhook-dispatch.ts`, `api-key-create.ts`
- Create: `volcano/volcano-config.yaml`, `scripts/bootstrap-admin.ts`
- Generated (commit): `volcano/functions/*.js`
- Test: `tests/integration/functions.test.ts`

**Interfaces (payload → 200 body; errors are `{error, code, details?}`):**
- `employee-link`: `{}` → `{employee}`. Errors `NOT_INVITED` 403, `EMAIL_NOT_CONFIRMED` 403, `TERMINATED` 403, `ALREADY_LINKED` 409.
- `employee-import` (admin): `{records: ImportRecord[] (≤200), dry_run?}` → `{dry_run, created, updated, errors, outcomes[]}`. `INVALID_ROWS` 400 with `details`.
- `payroll-run` (admin): `{action:'generate', period_id, skipped_employee_ids?}` → `{run_id, totals, warnings, line_count}`; `{action:'finalize'|'void'|'discard', run_id, reason?}` → `{run_id, status, webhooks?}`.
- `payroll-export` (admin): `{run_id, mapping_key}` → `{export_id, filename, content_type, body, sha256}`.
- `webhook-dispatch` (admin or scheduler): `{test_endpoint_id?}` → `DispatchSummary`.
- `api-key-create` (admin): `{name}` → `{id, name, prefix, key}` (key shown once).

- [ ] **Step 1: Write the functions**

`src/functions/employee-link.ts`:

```ts
// Links the signed-in account to the invited employee record with the same email.
import { normalizeEmail } from '../lib/employee-import';
import { assertEmailConfirmed } from '../server/auth';
import { mutated, rows } from '../server/db';
import { HttpError, authOf, handle } from '../server/http';
import { serviceClient, userClient } from '../server/volcano';

const COLUMNS = 'id,user_id,email,first_name,last_name,role,status,manager_id';

interface EmployeeRow { id: string; user_id: string | null; email: string; first_name: string; last_name: string; role: string; status: string; manager_id: string | null }

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = serviceClient();

  const [linked] = await rows<EmployeeRow>(db.from('employees').select(COLUMNS).eq('user_id', auth.user_id).limit(1));
  if (linked) {
    if (linked.status !== 'active') throw new HttpError(403, 'TERMINATED', 'This employee record is no longer active');
    return { employee: linked };
  }

  const { user, error } = await userClient(auth.access_token).auth.getUser();
  if (error || !user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in again');
  assertEmailConfirmed(user, process.env.PAYROLL_ALLOW_UNCONFIRMED_EMAIL === 'true');

  const [match] = await rows<EmployeeRow>(db.from('employees').select(COLUMNS).eq('email', normalizeEmail(user.email)).limit(1));
  if (!match || match.status !== 'active') {
    throw new HttpError(403, 'NOT_INVITED', 'This email has not been invited. Ask your payroll administrator.');
  }
  if (match.user_id) throw new HttpError(409, 'ALREADY_LINKED', 'This employee record is already linked to another account');

  await mutated(db.update('employees', { user_id: auth.user_id }).eq('id', match.id).is('user_id', null), 'employee');
  return { employee: { ...match, user_id: auth.user_id } };
});
```
`src/functions/employee-import.ts`:

```ts
// Admin-only bulk create/update of employees (and optional compensation) from
// rows already parsed and validated in the browser by parseEmployeeCsv.
import { validateRecords, type ImportRecord, type ImportRow } from '../lib/employee-import';
import { requireEmployee } from '../server/auth';
import { rows } from '../server/db';
import { HttpError, authOf, handle } from '../server/http';
import { userClient } from '../server/volcano';

const MAX_ROWS = 200;

interface Existing { id: string; email: string }
interface Outcome { line: number; email: string; result: 'created' | 'updated' | 'error'; message?: string }

/** Re-validates on the server: the browser could send anything. */
function revalidate(input: unknown): ImportRow[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'records must be a non-empty array');
  if (input.length > MAX_ROWS) throw new HttpError(400, 'TOO_MANY_ROWS', `Send at most ${MAX_ROWS} rows per request`);
  const records: ImportRecord[] = input.map((r: { line?: unknown; values?: unknown }) => ({
    line: Number(r?.line) || 0,
    values: r && typeof r.values === 'object' && r.values ? Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, String(v ?? '')])) : {},
  }));
  const { rows: parsed, errors } = validateRecords(records);
  if (errors.length) throw new HttpError(400, 'INVALID_ROWS', 'Some rows are invalid', errors);
  return parsed;
}

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  await requireEmployee(db, auth, ['admin']);
  const input = revalidate(event.records);
  const dryRun = event.dry_run === true;

  const emails = [...new Set([...input.map((r) => r.email), ...input.flatMap((r) => (r.manager_email ? [r.manager_email] : []))])];
  const existing = new Map((await rows<Existing>(db.from('employees').select('id,email').in('email', emails))).map((e) => [e.email, e.id]));

  const outcomes: Outcome[] = [];
  const idByEmail = new Map(existing);
  for (const r of input) {
    const fields = {
      email: r.email, first_name: r.first_name, last_name: r.last_name, external_id: r.external_id,
      role: r.role, hire_date: r.hire_date, work_state: r.work_state,
    };
    const id = existing.get(r.email);
    if (dryRun) {
      outcomes.push({ line: r.line, email: r.email, result: id ? 'updated' : 'created' });
      continue;
    }
    const res = id ? await db.update('employees', fields).eq('id', id) : await db.insert('employees', fields);
    if (res.error) {
      outcomes.push({ line: r.line, email: r.email, result: 'error', message: res.error.message });
      continue;
    }
    const saved = (res.data as { id: string }[])[0];
    idByEmail.set(r.email, saved.id);
    outcomes.push({ line: r.line, email: r.email, result: id ? 'updated' : 'created' });

    if (r.pay_type && r.rate_cents && r.effective_from) {
      const comp = { employee_id: saved.id, pay_type: r.pay_type, rate_cents: r.rate_cents, effective_from: r.effective_from };
      const [current] = await rows<{ id: string }>(db.from('compensation').select('id').eq('employee_id', saved.id).eq('effective_from', r.effective_from));
      const c = current ? await db.update('compensation', comp).eq('id', current.id) : await db.insert('compensation', comp);
      if (c.error) outcomes[outcomes.length - 1] = { line: r.line, email: r.email, result: 'error', message: `saved, but compensation failed: ${c.error.message}` };
    }
  }

  // Managers are resolved after everyone in the batch exists.
  for (const r of input) {
    if (!r.manager_email) continue;
    const managerId = idByEmail.get(r.manager_email);
    const out = outcomes.find((o) => o.line === r.line)!;
    if (!managerId) {
      out.message = `${out.message ? `${out.message}; ` : ''}manager ${r.manager_email} not found`;
      continue;
    }
    if (dryRun || out.result === 'error') continue;
    const m = await db.update('employees', { manager_id: managerId }).eq('id', idByEmail.get(r.email)!);
    if (m.error) out.message = `manager not set: ${m.error.message}`;
  }

  return {
    dry_run: dryRun,
    created: outcomes.filter((o) => o.result === 'created').length,
    updated: outcomes.filter((o) => o.result === 'updated').length,
    errors: outcomes.filter((o) => o.result === 'error' || o.message).length,
    outcomes,
  };
});
```
`src/functions/payroll-run.ts`:

```ts
// Admin-only payroll run lifecycle: generate (draft), finalize, void.
// State rules are enforced by database triggers (05_payroll_logic.sql); this
// function computes pay and turns trigger errors into HTTP responses.
import { calculateRun } from '../lib/pay-calc';
import { requireEmployee } from '../server/auth';
import { asJson, mutated, one, rows } from '../server/db';
import { HttpError, authOf, handle, requireString } from '../server/http';
import { loadCalcInput, loadPeriod } from '../server/payroll-data';
import { serviceClient, userClient } from '../server/volcano';
import { dispatchDue } from '../server/webhooks';

async function sendWebhooks() {
  try {
    return await dispatchDue(serviceClient());
  } catch (e) {
    console.error('webhook dispatch failed', e);
    return null;
  }
}

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  await requireEmployee(db, auth, ['admin']);
  const action = requireString(event.action, 'action');

  if (action === 'generate') {
    const period = await loadPeriod(db, requireString(event.period_id, 'period_id'));
    if (period.status !== 'locked') throw new HttpError(409, 'PERIOD_NOT_LOCKED', 'Lock the pay period before generating a run');
    const skipped = Array.isArray(event.skipped_employee_ids) ? event.skipped_employee_ids.map(String) : [];
    const result = calculateRun(await loadCalcInput(db, period, skipped));

    await rows(db.delete('payroll_runs').eq('pay_period_id', period.id).eq('status', 'draft'));
    const [run] = await rows<{ id: string }>(db.insert('payroll_runs', {
      pay_period_id: period.id,
      totals: asJson(result.totals),
      warnings: asJson(result.warnings),
      skipped_employee_ids: asJson(skipped),
      lines_input: asJson(result.lines),
    }));
    return { run_id: run.id, totals: result.totals, warnings: result.warnings, line_count: result.lines.length };
  }

  const runId = requireString(event.run_id, 'run_id');
  if (action === 'finalize') {
    await mutated(db.update('payroll_runs', { status: 'finalized' }).eq('id', runId).eq('status', 'draft'), 'this draft run');
    return { run_id: runId, status: 'finalized', webhooks: await sendWebhooks() };
  }
  if (action === 'void') {
    const reason = requireString(event.reason, 'reason');
    await mutated(db.update('payroll_runs', { status: 'voided', void_reason: reason }).eq('id', runId).eq('status', 'finalized'), 'this finalized run');
    return { run_id: runId, status: 'voided', webhooks: await sendWebhooks() };
  }
  if (action === 'discard') {
    await one(db.from('payroll_runs').select('id').eq('id', runId).eq('status', 'draft'), 'Draft run not found');
    await rows(db.delete('payroll_runs').eq('id', runId));
    return { run_id: runId, status: 'deleted' };
  }
  throw new HttpError(400, 'BAD_REQUEST', `Unknown action "${action}"`);
});
```
`src/functions/payroll-export.ts`:

```ts
// Admin-only: render a finalized run with a preset or custom mapping, record it, return the file.
import { render } from '../lib/exporters';
import { sha256Hex } from '../lib/signing';
import { requireEmployee } from '../server/auth';
import { rows } from '../server/db';
import { resolveMapping } from '../server/mappings';
import { HttpError, authOf, handle, requireString } from '../server/http';
import { loadRun, loadRunLines } from '../server/runs';
import { userClient } from '../server/volcano';

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  const me = await requireEmployee(db, auth, ['admin']);
  const runId = requireString(event.run_id, 'run_id');
  const mappingKey = requireString(event.mapping_key, 'mapping_key');

  const { run, exportRun } = await loadRun(db, runId);
  if (run.status !== 'finalized') throw new HttpError(409, 'RUN_NOT_FINALIZED', 'Only finalized runs can be exported');
  const config = await resolveMapping(db, mappingKey);
  let file;
  try {
    file = render(exportRun, await loadRunLines(db, runId), config, mappingKey);
  } catch (e) {
    throw new HttpError(400, 'INVALID_MAPPING', (e as Error).message);
  }
  const sha256 = sha256Hex(file.body);
  const [saved] = await rows<{ id: string }>(db.insert('exports', {
    run_id: runId, mapping_key: mappingKey, filename: file.filename, content_type: file.content_type,
    content: file.body, sha256, created_by: me.id,
  }));
  return { export_id: saved.id, ...file, sha256 };
});
```
`src/functions/webhook-dispatch.ts`:

```ts
// Delivers due webhooks. Runs on a schedule (SUPERAGENT plan) and on demand
// from the admin Integrations page. Delivery state is only reachable with the
// service key, so callers are checked first.
import { requireEmployee } from '../server/auth';
import { one, rows } from '../server/db';
import { authOf, handle } from '../server/http';
import { serviceClient, userClient } from '../server/volcano';
import { dispatchDue } from '../server/webhooks';

export const handler = handle(async (event) => {
  // Scheduled runs carry __volcano_schedule and no user. A forged marker is
  // harmless: dispatch only sends deliveries that are already due.
  if (!event.__volcano_schedule) {
    const auth = authOf(event);
    await requireEmployee(userClient(auth.access_token), auth, ['admin']);
  }
  const db = serviceClient();
  if (typeof event.test_endpoint_id === 'string') {
    const ep = await one<{ id: string }>(db.from('webhook_endpoints').select('id').eq('id', event.test_endpoint_id), 'Webhook endpoint not found');
    await rows(db.insert('webhook_deliveries', {
      endpoint_id: ep.id,
      event: 'ping',
      payload: JSON.stringify({ id: globalThis.crypto.randomUUID(), event: 'ping', created_at: new Date().toISOString(), data: {} }),
    }));
  }
  return dispatchDue(db);
});
```
`src/functions/api-key-create.ts`:

```ts
// Admin-only: create an integration API key. The plaintext key is returned once; only its hash is stored.
import { generateApiKey } from '../lib/signing';
import { requireEmployee } from '../server/auth';
import { rows } from '../server/db';
import { authOf, handle, requireString } from '../server/http';
import { userClient } from '../server/volcano';

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  const me = await requireEmployee(db, auth, ['admin']);
  const name = requireString(event.name, 'name');
  const { key, prefix, hash } = generateApiKey();
  const [row] = await rows<{ id: string }>(db.insert('api_keys', { name, prefix, key_hash: hash, created_by: me.id }));
  return { id: row.id, name, prefix, key };
});
```

- [ ] **Step 2: Bundle and smoke-load them**

Run:
```sh
npx tsc --noEmit && npm run build:functions
node -e "for (const f of ['employee-link','employee-import','payroll-run','payroll-export','webhook-dispatch','api-key-create']) console.log(f, typeof require('./volcano/functions/'+f+'.js').handler)"
node -e "require('./volcano/functions/payroll-run.js').handler({}).then(r => console.log(r.statusCode, r.body))"
```
Expected: six lines ending in `function`; then `401 {"error":"Sign in first","code":"UNAUTHENTICATED"}`.

- [ ] **Step 3: Add the Volcano config and the bootstrap script**

`volcano/volcano-config.yaml`:

```yaml
version: 1

auth:
  signup:
    # Accounts only matter once an admin has invited the email; guests are never needed.
    enable_anonymous_signins: false

# Every function checks the caller itself; none is callable without a signed-in user.
functions:
  - name: employee-link
    public: false
  - name: employee-import
    public: false
  - name: payroll-run
    public: false
  - name: payroll-export
    public: false
  - name: webhook-dispatch
    public: false
  - name: api-key-create
    public: false
```
`scripts/bootstrap-admin.ts`:

```ts
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
```

- [ ] **Step 4: Deploy locally**

Run:
```sh
volcano variables deploy
volcano functions deploy --all
volcano config deploy
volcano functions list
```
Expected: six functions deployed; config reports the six functions `unchanged` or `updated` and no `skipped` warnings. (The local stack is shared with `../tinyurl`; these variables and functions are local-only.)

- [ ] **Step 5: Smoke-test one invocation**

Run: `volcano functions invoke payroll-run --payload '{"action":"nope"}' --json`
Expected: an error response with code `NOT_INVITED` (the local CLI user has no employee row). That proves the function runs, reaches the API with the deployed variables, and reads the `payroll` database. If it reports `Missing environment variable`, check `volcano/volcano.env` and redeploy variables. If it can't reach `VOLCANO_API_URL`, inspect `volcano functions logs payroll-run --type runtime` and search `volcano docs search "function local api url"`.

- [ ] **Step 6: Write the end-to-end function test**

`tests/integration/functions.test.ts`:

```ts
// Exercises the deployed functions end to end. Needs, on the local stack:
//   npm run build:functions && volcano variables deploy && volcano functions deploy --all
// with VOLCANO_DATABASE and PAYROLL_ALLOW_UNCONFIRMED_EMAIL=true in volcano/volcano.env.
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser, ok, openPeriod, resetData, seedOrg, service, type Org, type TestUser } from './helpers';

let org: Org;
let periodId: string;

async function call<T = Record<string, unknown>>(user: TestUser, name: string, payload: Record<string, unknown> = {}): Promise<{ status: number | null; body: T }> {
  const { data, status } = await user.client.functions.invoke(name, payload as never);
  return { status, body: (typeof data === 'string' ? JSON.parse(data) : data) as T };
}

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  periodId = await openPeriod('2026-09');
  const [{ id: sheet }] = await ok<{ id: string }>(org.alice.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }));
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
    await ok(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: d, earning_code: 'REG', hours: 9 }));
  }
  await ok(org.alice.client.update('timesheets', { status: 'submitted' }).eq('id', sheet));
  await ok(org.manager.client.update('timesheets', { status: 'approved' }).eq('id', sheet));
  await ok(org.admin.client.update('pay_periods', { status: 'locked' }).eq('id', periodId));
});

describe('employee-link', () => {
  it('links an invited account by email, idempotently', async () => {
    const u = await newUser('invitee');
    const [{ id }] = await ok<{ id: string }>(service().insert('employees', { email: u.email, first_name: 'In', last_name: 'Vitee', hire_date: '2026-01-01' }));
    const first = await call<{ employee: { id: string; user_id: string } }>(u, 'employee-link');
    expect(first.status).toBe(200);
    expect(first.body.employee).toMatchObject({ id, user_id: u.userId });
    expect((await call(u, 'employee-link')).status).toBe(200);
  });
  it('refuses accounts that were not invited', async () => {
    const u = await newUser('stranger');
    expect(await call(u, 'employee-link')).toMatchObject({ status: 403, body: { code: 'NOT_INVITED' } });
  });
});

describe('payroll-run and payroll-export', () => {
  let runId: string;

  it('is admin-only', async () => {
    expect(await call(org.manager, 'payroll-run', { action: 'generate', period_id: periodId })).toMatchObject({ status: 403 });
  });

  it('generates a draft with overtime and flags missing timesheets', async () => {
    const r = await call<{ run_id: string; totals: { gross_cents: number }; warnings: { employee_id: string; code: string }[] }>(
      org.admin, 'payroll-run', { action: 'generate', period_id: periodId });
    expect(r.status).toBe(200);
    runId = r.body.run_id;
    expect(r.body.totals.gross_cents).toBe(118_750); // 40h × $25 + 5h × $37.50
    expect(r.body.warnings.map((w) => w.code)).toEqual(['NO_APPROVED_TIMESHEET', 'NO_APPROVED_TIMESHEET', 'NO_APPROVED_TIMESHEET']);
    expect(await call(org.admin, 'payroll-run', { action: 'finalize', run_id: runId })).toMatchObject({ status: 409, body: { code: 'RUN_HAS_BLOCKING_WARNINGS' } });
  });

  it('finalizes after skipping the flagged employees', async () => {
    const skip = [org.admin.employeeId, org.manager.employeeId, org.bob.employeeId];
    const r = await call<{ run_id: string; warnings: unknown[] }>(org.admin, 'payroll-run', { action: 'generate', period_id: periodId, skipped_employee_ids: skip });
    expect(r.body.warnings).toEqual([]);
    runId = r.body.run_id;
    expect(await call(org.admin, 'payroll-run', { action: 'finalize', run_id: runId })).toMatchObject({ status: 200, body: { status: 'finalized' } });
    // A second click (or a second admin) cannot finalize again.
    expect((await call(org.admin, 'payroll-run', { action: 'finalize', run_id: runId })).status).toBe(403);
  });

  it('exports the finalized run', async () => {
    const r = await call<{ filename: string; body: string }>(org.admin, 'payroll-export', { run_id: runId, mapping_key: 'gusto' });
    expect(r.status).toBe(200);
    expect(r.body.filename).toBe('payroll-2026-09-gusto.csv');
    expect(r.body.body.split('\r\n')[1]).toBe(`Test,alice,${org.alice.email},40.00,5.00,,,,`);
  });
});

describe('api-key-create', () => {
  it('returns a key once and stores only its hash', async () => {
    const r = await call<{ key: string; prefix: string }>(org.admin, 'api-key-create', { name: 'connector' });
    expect(r.body.key).toMatch(/^pk_[0-9a-f]{8}_/);
    const [row] = await ok<{ key_hash: string }>(service().from('api_keys').select('key_hash').eq('prefix', r.body.prefix));
    expect(row.key_hash).not.toContain(r.body.key);
  });
});

describe('employee-import', () => {
  it('creates new employees, updates existing ones and links managers', async () => {
    const records = [
      { line: 2, values: { email: 'new.person@example.com', first_name: 'New', last_name: 'Person', hire_date: '2026-02-01', manager_email: org.manager.email, pay_type: 'daily', rate: '200' } },
      { line: 3, values: { email: org.bob.email.toUpperCase(), first_name: 'Robert', last_name: 'Test', hire_date: '2020-01-01' } },
    ];
    const r = await call<{ created: number; updated: number; errors: number }>(org.admin, 'employee-import', { records });
    expect(r.body).toMatchObject({ created: 1, updated: 1, errors: 0 });
    const [p] = await ok<{ id: string; manager_id: string }>(service().from('employees').select('id,manager_id').eq('email', 'new.person@example.com'));
    expect(p.manager_id).toBe(org.manager.employeeId);
    expect(await ok(service().from('compensation').select('id').eq('employee_id', p.id))).toHaveLength(1);
  });
  it('rejects invalid rows without writing anything', async () => {
    const r = await call<{ code: string }>(org.admin, 'employee-import', { records: [{ line: 2, values: { email: 'bad' } }] });
    expect(r).toMatchObject({ status: 400, body: { code: 'INVALID_ROWS' } });
  });
});
```

- [ ] **Step 7: Run it**

Run: `npm run test:integration -- tests/integration/functions.test.ts`
Expected: PASS (9 tests). If `employee-link` returns `EMAIL_NOT_CONFIRMED`, `PAYROLL_ALLOW_UNCONFIRMED_EMAIL=true` is missing from the deployed local variables.

- [ ] **Step 8: Run the whole integration suite**

Run: `npm run test:integration`
Expected: PASS (46 tests across 5 files).

- [ ] **Step 9: Commit**

```sh
git add src/functions volcano/functions volcano/volcano-config.yaml scripts/bootstrap-admin.ts tests/integration/functions.test.ts
git commit -m "feat: add payroll, export, import, linking and webhook functions"
```

---
### Task 12: Web app foundation (session, layout, login, API route)

UI tasks (12–17) have no component unit tests. Their logic lives in the tested `src/lib` modules, and each task is gated by `npm run typecheck` + `npm run build`. Task 18 exercises every screen in a real browser.

**Files:**
- Create: `web/next.config.ts`, `web/tsconfig.json`, `web/app/globals.css`, `web/app/layout.tsx`, `web/app/page.tsx`, `web/app/login/page.tsx`, `web/app/api/v1/[...path]/route.ts`
- Create: `web/lib/volcano.ts`, `web/lib/api.ts`, `web/lib/format.ts`, `web/lib/session.tsx`, `web/lib/data.ts`
- Create: `web/components/ui.tsx`, `web/components/AppShell.tsx`

**Interfaces:**
- `web/lib/volcano.ts`: `getVolcano()` (browser client, RLS applies).
- `web/lib/api.ts`: `ApiError(message, code, details?)`, `q<T>(query)`, `write<T>(query, what)`, `invoke<T>(name, payload?)`, `errorMessage(e)`.
- `web/lib/format.ts`: `money(cents)`, `qty(v)`, `monthLabel(isoDate)`, `dateTime(iso)`, `RATE_UNIT`, `downloadFile(filename, contentType, body)`.
- `web/lib/session.tsx`: `Employee`, `SessionProvider`, `useSession(): {status: 'loading'|'signed_out'|'unlinked'|'ready', user, employee, linkError, signIn, signUp, signOut}`, `homeFor(role)`.
- `web/lib/data.ts`: `Period`, `Timesheet`, `Entry`, `Comp`, `EmployeeRow`, `Run`, `SettingsRow`, `EMPLOYEE_COLUMNS`, `listPeriods()`, `listEmployees()`, `timesheetsForPeriod(id)`, `entriesFor(timesheetId)`, `compensationFor(employeeId)`, `compAt(comps, date)`, `loadSettings()`, `listRuns()`.
- `web/components/ui.tsx`: `Loading`, `ErrorBanner`, `Notice`, `Empty`, `Badge`, `Field`.
- `web/components/AppShell.tsx`: `AppShell({roles, children})` (redirects signed-out users to `/login`; shows a no-access message to other roles).

- [ ] **Step 1: Next.js config and TypeScript**

`web/next.config.ts`:

```ts
import path from 'node:path';
import type { NextConfig } from 'next';

// The app imports shared code from ../src, so the workspace root is the repo root.
const root = path.resolve(__dirname, '..');

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
```
`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "incremental": true,
    "module": "esnext",
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "types": ["node"],
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 2: Client libraries**

`web/lib/volcano.ts`:

```ts
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
```
`web/lib/api.ts`:

```ts
'use client';
import { parseDbError } from '../../src/lib/db-errors';
import { getVolcano } from './volcano';

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) {
    super(message);
  }
}

interface Result { data: unknown; error: Error | null }

/** Awaits a query/mutation and returns its rows, throwing a readable ApiError on failure. */
export async function q<T>(query: PromiseLike<Result>): Promise<T[]> {
  const { data, error } = await query;
  if (error) {
    const p = parseDbError(error.message);
    throw new ApiError(p.message, p.code);
  }
  return (data ?? []) as T[];
}

/** Like q, but a write that matched no rows (RLS or a stale id) is an error. */
export async function write<T>(query: PromiseLike<Result>, what: string): Promise<T[]> {
  const out = await q<T>(query);
  if (out.length === 0) throw new ApiError(`Could not update ${what}. Refresh and try again.`, 'FORBIDDEN');
  return out;
}

/** Invokes a Volcano Function and returns its JSON body, throwing ApiError for non-200 responses. */
export async function invoke<T>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, status, error } = await getVolcano().functions.invoke<Record<string, unknown>, T>(name, payload as never);
  const body = (typeof data === 'string' ? safeJson(data) : data) as (T & { error?: string; code?: string; details?: unknown }) | null;
  if (status === 200 && body) return body;
  if (body && typeof body === 'object' && 'error' in body && body.error) throw new ApiError(body.error, body.code ?? 'ERROR', body.details);
  throw new ApiError(error?.message ?? `The ${name} service failed (status ${status ?? 'unknown'})`, 'FUNCTION_ERROR');
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return { error: s }; }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
```
`web/lib/format.ts`:

```ts
import { centsToDollars } from '../../src/lib/money';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (cents: number | string | null | undefined): string =>
  cents == null ? '—' : usd.format(Number(centsToDollars(Number(cents))));

export const qty = (v: number | string | null | undefined): string =>
  v == null || v === '' ? '—' : String(Number(v));

export const monthLabel = (isoDate: string): string => {
  const [y, m] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export const dateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const RATE_UNIT = { salary: '/ year', hourly: '/ hour', daily: '/ day' } as const;

/** Saves a string as a file download in the browser. */
export function downloadFile(filename: string, contentType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```
`web/lib/session.tsx`:

```tsx
'use client';
import type { User } from '@volcano.dev/sdk';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role } from '../../src/lib/employee-import';
import { ApiError, errorMessage, invoke } from './api';
import { getVolcano } from './volcano';

export interface Employee {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: Role;
  manager_id: string | null;
}

type Status = 'loading' | 'signed_out' | 'unlinked' | 'ready';

interface SessionValue {
  status: Status;
  user: User | null;
  employee: Employee | null;
  /** Why the account could not be linked (not invited, email not confirmed, …). */
  linkError: string | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ confirmationRequired: boolean }>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const link = useCallback(async (u: User | null) => {
    setUser(u);
    if (!u) {
      setEmployee(null);
      setStatus('signed_out');
      return;
    }
    try {
      const { employee: e } = await invoke<{ employee: Employee }>('employee-link');
      setEmployee(e);
      setLinkError(null);
      setStatus('ready');
    } catch (err) {
      setEmployee(null);
      setLinkError(err instanceof ApiError ? err.message : errorMessage(err));
      setStatus('unlinked');
    }
  }, []);

  useEffect(() => {
    const volcano = getVolcano();
    volcano.initialize().then(({ user: u }) => link(u)).catch(() => setStatus('signed_out'));
  }, [link]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user: u, error } = await getVolcano().auth.signIn({ email: email.trim().toLowerCase(), password });
    if (error) throw error;
    await link(u);
  }, [link]);

  const signUp = useCallback(async (email: string, password: string) => {
    const r = await getVolcano().auth.signUp({ email: email.trim().toLowerCase(), password, signInWhenAllowed: true });
    if (r.error) throw r.error;
    if (r.user) await link(r.user);
    return { confirmationRequired: r.confirmationRequired };
  }, [link]);

  const signOut = useCallback(async () => {
    await getVolcano().auth.signOut();
    await link(null);
  }, [link]);

  return (
    <SessionContext.Provider value={{ status, user, employee, linkError, signIn, signUp, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

export const homeFor = (role: Role): string => (role === 'admin' ? '/admin' : role === 'manager' ? '/manage' : '/portal');
```
`web/lib/data.ts`:

```ts
'use client';
// Typed reads shared by several pages. All run as the signed-in user under RLS.
import type { EntryCode, PayType, RunTotals, TimesheetStatus } from '../../src/lib/types';
import type { OvertimeSettings } from '../../src/lib/types';
import { q } from './api';
import { getVolcano } from './volcano';

export interface Period { id: string; start_date: string; end_date: string; status: 'open' | 'locked' | 'finalized' }
export interface Timesheet { id: string; employee_id: string; pay_period_id: string; status: TimesheetStatus; rejection_note: string | null; submitted_at: string | null; approved_at: string | null }
export interface Entry { id: string; timesheet_id: string; work_date: string; earning_code: EntryCode; hours: number | null; days: number | null }
export interface Comp { id: string; employee_id: string; pay_type: PayType; rate_cents: number; effective_from: string }
export interface EmployeeRow {
  id: string; user_id: string | null; email: string; first_name: string; last_name: string; external_id: string | null;
  role: 'employee' | 'manager' | 'admin'; manager_id: string | null; status: 'active' | 'terminated';
  hire_date: string; termination_date: string | null; work_state: string | null;
}
export interface Run { id: string; pay_period_id: string; status: 'draft' | 'finalized' | 'voided'; totals: RunTotals; warnings: { employee_id: string; code: string; blocking: boolean; message: string }[]; skipped_employee_ids: string[]; generated_at: string; finalized_at: string | null; voided_at: string | null; void_reason: string | null }

const day = (v: unknown) => String(v).slice(0, 10);
const n = (v: unknown) => (v == null ? null : Number(v));

export const EMPLOYEE_COLUMNS = 'id,user_id,email,first_name,last_name,external_id,role,manager_id,status,hire_date,termination_date,work_state';

export async function listPeriods(): Promise<Period[]> {
  const rows = await q<Period>(getVolcano().from('pay_periods').select('id,start_date,end_date,status').order('start_date', { ascending: false }).limit(36));
  return rows.map((p) => ({ ...p, start_date: day(p.start_date), end_date: day(p.end_date) }));
}

export async function listEmployees(): Promise<EmployeeRow[]> {
  const out: EmployeeRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await q<EmployeeRow>(getVolcano().from('employees').select(EMPLOYEE_COLUMNS).order('last_name').order('first_name').limit(1000).offset(offset));
    out.push(...batch.map((e) => ({ ...e, hire_date: day(e.hire_date), termination_date: e.termination_date ? day(e.termination_date) : null })));
    if (batch.length < 1000) return out;
  }
}

export async function timesheetsForPeriod(periodId: string): Promise<Timesheet[]> {
  return q<Timesheet>(getVolcano().from('timesheets')
    .select('id,employee_id,pay_period_id,status,rejection_note,submitted_at,approved_at').eq('pay_period_id', periodId).limit(5000));
}

export async function entriesFor(timesheetId: string): Promise<Entry[]> {
  const rows = await q<Entry>(getVolcano().from('time_entries').select('id,timesheet_id,work_date,earning_code,hours,days')
    .eq('timesheet_id', timesheetId).order('work_date').limit(500));
  return rows.map((e) => ({ ...e, work_date: day(e.work_date), hours: n(e.hours), days: n(e.days) }));
}

export async function compensationFor(employeeId: string): Promise<Comp[]> {
  const rows = await q<Comp>(getVolcano().from('compensation').select('id,employee_id,pay_type,rate_cents,effective_from')
    .eq('employee_id', employeeId).order('effective_from', { ascending: false }));
  return rows.map((c) => ({ ...c, rate_cents: Number(c.rate_cents), effective_from: day(c.effective_from) }));
}

/** The compensation in effect at the end of a period (what the timesheet grid should ask for). */
export const compAt = (comps: Comp[], date: string): Comp | null =>
  comps.filter((c) => c.effective_from <= date).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;

export interface SettingsRow extends OvertimeSettings { company_name: string }

export async function loadSettings(): Promise<SettingsRow> {
  const [s] = await q<Record<string, unknown>>(getVolcano().from('settings')
    .select('company_name,ot_weekly_threshold,ot_daily_threshold,dt_daily_threshold,ot_multiplier,dt_multiplier,ot_applies_to_daily,week_starts_on'));
  return {
    company_name: String(s?.company_name ?? ''),
    ot_weekly_threshold: n(s?.ot_weekly_threshold),
    ot_daily_threshold: n(s?.ot_daily_threshold),
    dt_daily_threshold: n(s?.dt_daily_threshold),
    ot_multiplier: n(s?.ot_multiplier) ?? 1.5,
    dt_multiplier: n(s?.dt_multiplier) ?? 2,
    ot_applies_to_daily: s?.ot_applies_to_daily === true,
    week_starts_on: n(s?.week_starts_on) ?? 0,
  };
}

export async function listRuns(): Promise<Run[]> {
  return q<Run>(getVolcano().from('payroll_runs')
    .select('id,pay_period_id,status,totals,warnings,skipped_employee_ids,generated_at,finalized_at,voided_at,void_reason')
    .order('generated_at', { ascending: false }).limit(100));
}
```

- [ ] **Step 3: Shared components, styles, layout, home and login**

`web/components/ui.tsx`:

```tsx
'use client';
import type { ReactNode } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted" role="status" aria-live="polite">{label}</p>;
}

export function ErrorBanner({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <span>{error}</span>
      {onRetry && <button type="button" className="secondary small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="alert info" role="status">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

const BADGE: Record<string, string> = {
  draft: 'neutral', open: 'ok', submitted: 'warn', locked: 'warn', approved: 'ok', finalized: 'ok',
  rejected: 'bad', voided: 'bad', terminated: 'bad', active: 'ok', pending: 'warn', delivered: 'ok', failed: 'bad',
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${BADGE[value] ?? 'neutral'}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
```
`web/components/AppShell.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { Role } from '../../src/lib/employee-import';
import { useSession } from '../lib/session';
import { Loading } from './ui';

const LINKS: { href: string; label: string; roles: Role[] }[] = [
  { href: '/portal', label: 'My timesheet', roles: ['employee', 'manager', 'admin'] },
  { href: '/portal/history', label: 'History', roles: ['employee', 'manager', 'admin'] },
  { href: '/manage', label: 'Approvals', roles: ['manager', 'admin'] },
  { href: '/admin/employees', label: 'Employees', roles: ['admin'] },
  { href: '/admin/periods', label: 'Pay periods', roles: ['admin'] },
  { href: '/admin/runs', label: 'Payroll runs', roles: ['admin'] },
  { href: '/admin/integrations', label: 'Integrations', roles: ['admin'] },
  { href: '/admin/settings', label: 'Settings', roles: ['admin'] },
];

/** Signed-in layout with role-based navigation. RLS is the real enforcement; this only hides what a role can't use. */
export function AppShell({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { status, employee, linkError, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'signed_out') router.replace('/login');
  }, [status, router]);

  if (status === 'loading' || status === 'signed_out') return <main className="page"><Loading /></main>;
  if (status === 'unlinked' || !employee) {
    return (
      <main className="page narrow">
        <h1>Your account isn&apos;t set up yet</h1>
        <p role="alert">{linkError}</p>
        <button type="button" onClick={() => void signOut()}>Sign out</button>
      </main>
    );
  }

  const links = LINKS.filter((l) => l.roles.includes(employee.role));
  return (
    <>
      <header className="topbar">
        <nav aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>{l.label}</Link>
          ))}
        </nav>
        <div className="who">
          <span>{employee.first_name} {employee.last_name}</span>
          <button type="button" className="secondary small" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main className="page">
        {roles.includes(employee.role) ? children : (
          <>
            <h1>No access</h1>
            <p>This page is for {roles.join(' / ')} users. <Link href="/portal">Go to your timesheet</Link>.</p>
          </>
        )}
      </main>
    </>
  );
}
```
`web/app/globals.css`:

```css
:root {
  --bg: #f7f7f5;
  --surface: #ffffff;
  --text: #1c1c1a;
  --muted: #5f5f5a;
  --border: #d9d9d4;
  --accent: #2456c9;
  --accent-text: #ffffff;
  --ok-bg: #e3f4e8; --ok-text: #1d6b34;
  --warn-bg: #fff3d6; --warn-text: #7a5300;
  --bad-bg: #fde6e6; --bad-text: #a32020;
  --info-bg: #e7eefc; --info-text: #1d3f8f;
  --weekend: #f0f0ec;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #20201e; --text: #ececea; --muted: #a3a39d; --border: #3a3a37;
    --accent: #7aa2ff; --accent-text: #0d1426;
    --ok-bg: #18361f; --ok-text: #8fdba5; --warn-bg: #3a2f10; --warn-text: #f1cd74;
    --bad-bg: #3d1717; --bad-text: #ff9c9c; --info-bg: #182544; --info-text: #a9c1ff; --weekend: #1b1b19;
  }
}

* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--accent); }
h1 { font-size: 1.6rem; margin: 0 0 1rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
h2 { font-size: 1.2rem; margin: 0 0 0.75rem; }
code, .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
.code { display: block; padding: 0.75rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; white-space: pre; }

.topbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 0.5rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar nav { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.topbar nav a { padding: 0.5rem 0.75rem; border-radius: 8px; text-decoration: none; color: var(--text); }
.topbar nav a[aria-current="page"] { background: var(--info-bg); color: var(--info-text); font-weight: 600; }
.who { display: flex; gap: 0.75rem; align-items: center; color: var(--muted); }

.page { max-width: 1200px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.narrow { max-width: 28rem; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; margin: 1rem 0; }
.tiles { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; }
.stack { display: grid; gap: 1rem; }
.toolbar { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; margin-bottom: 1rem; }
.actions, .row-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-top: 0.75rem; }
.row-actions { margin: 0; }
.form-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); align-items: end; }
.form-actions { grid-column: 1 / -1; }

.field { display: grid; gap: 0.25rem; }
.label { font-weight: 600; font-size: 0.9rem; }
.hint { color: var(--muted); font-size: 0.85rem; }
.field-error { color: var(--bad-text); font-size: 0.85rem; }
.inline { display: inline-flex; gap: 0.4rem; align-items: center; margin-right: 1rem; }
fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; }

input, select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.6rem; min-height: 40px; }
input[type="checkbox"] { min-height: auto; }
input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
input[aria-invalid="true"] { border-color: var(--bad-text); }

button, .button { font: inherit; font-weight: 600; min-height: 40px; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid transparent; background: var(--accent); color: var(--accent-text); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
button.secondary, .button.secondary { background: transparent; color: var(--text); border-color: var(--border); }
button.danger { background: var(--bad-text); color: var(--surface); }
button.small, .button.small { min-height: 32px; padding: 0.25rem 0.6rem; font-size: 0.875rem; }
button.link { background: none; border: none; padding: 0; min-height: auto; color: var(--accent); text-decoration: underline; font-weight: inherit; }

.alert { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 0.75rem 1rem; border-radius: 8px; margin: 0.75rem 0; }
.alert.error { background: var(--bad-bg); color: var(--bad-text); }
.alert.info { background: var(--info-bg); color: var(--info-text); }
.muted { color: var(--muted); }
.empty { padding: 2rem; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 12px; }
.badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; text-transform: capitalize; }
.badge.ok { background: var(--ok-bg); color: var(--ok-text); }
.badge.warn { background: var(--warn-bg); color: var(--warn-text); }
.badge.bad { background: var(--bad-bg); color: var(--bad-text); }
.badge.neutral { background: var(--weekend); color: var(--muted); }

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--surface); }
th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
thead th { font-size: 0.85rem; color: var(--muted); }
table.grid input { width: 5.5rem; }
table.grid select { width: 4.5rem; }
table.grid tr.weekend { background: var(--weekend); }
td.cell-error input { border-color: var(--bad-text); }
.save-state { min-height: 1.5em; color: var(--muted); }

.cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 0.75rem 1rem; }
.card-head { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.plain { list-style: none; padding: 0; margin: 0.25rem 0; }
.problems { margin: 0.5rem 0; padding-left: 1.25rem; color: var(--bad-text); }
.details { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
.details dt { font-weight: 600; }
.details dd { margin: 0; }
.pager { display: flex; gap: 1rem; align-items: center; justify-content: center; margin-top: 1rem; }
.secret { display: block; margin-top: 0.5rem; word-break: break-all; }

.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
```
`web/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '../lib/session';
import './globals.css';

export const metadata: Metadata = { title: 'Payroll', description: 'Time tracking and payroll' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
```
`web/app/page.tsx`:

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '../components/ui';
import { homeFor, useSession } from '../lib/session';

export default function Home() {
  const { status, employee } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'ready' && employee) router.replace(homeFor(employee.role));
    else if (status === 'signed_out' || status === 'unlinked') router.replace('/login');
  }, [status, employee, router]);
  return <main className="page"><Loading /></main>;
}
```
`web/app/login/page.tsx`:

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Notice } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { homeFor, useSession } from '../../lib/session';

const MIN_PASSWORD = 15;

export default function LoginPage() {
  const { status, employee, linkError, signIn, signUp, signOut } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'ready' && employee) router.replace(homeFor(employee.role));
  }, [status, employee, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (mode === 'signup' && password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, password);
      else {
        const { confirmationRequired } = await signUp(email, password);
        if (confirmationRequired) setNotice('Check your email for a confirmation link, then sign in.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(mode === 'signin' ? 'signup' : 'signin');
    setError(null);
    setNotice(null);
  }

  return (
    <main className="page narrow">
      <h1>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
      {mode === 'signup' && <p className="muted">Use the work email your administrator invited.</p>}
      {status === 'unlinked' && (
        <div className="alert error" role="alert">
          <span>{linkError}</span>
          <button type="button" className="secondary small" onClick={() => void signOut()}>Use another account</button>
        </div>
      )}
      <form onSubmit={submit} className="stack">
        <Field label="Work email">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint={mode === 'signup' ? `At least ${MIN_PASSWORD} characters` : undefined}>
          <input
            type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={mode === 'signup' ? MIN_PASSWORD : undefined}
          />
        </Field>
        <button type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      </form>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      <p className="muted">
        {mode === 'signin' ? 'First time here? ' : 'Already have an account? '}
        <button type="button" className="link" onClick={switchMode}>
          {mode === 'signin' ? 'Create your account' : 'Sign in'}
        </button>
      </p>
    </main>
  );
}
```

- [ ] **Step 4: The integration API route**

`web/app/api/v1/[...path]/route.ts`:

```ts
import { handleIntegrationRequest } from '../../../../../src/server/integration-api';
import { serviceClient } from '../../../../../src/server/volcano';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = new URL(request.url);
  const res = await handleIntegrationRequest(serviceClient(), 'GET', path, url.searchParams, request.headers.get('authorization'));
  return new Response(res.body, { status: res.status, headers: res.headers });
}
```

- [ ] **Step 5: Build and type check**

Run: `npm run build && npm run typecheck`
Expected: build lists `/`, `/login` and `ƒ /api/v1/[...path]`; no type errors. (The first build creates `web/next-env.d.ts`, which `tsc -p web` needs.)

- [ ] **Step 6: Smoke-test in dev**

Run `npm run dev`, then in another shell: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/runs`
Expected: `401`. Open http://localhost:3000. It should redirect to `/login`. Stop the dev server.

- [ ] **Step 7: Commit**

```sh
git add web/next.config.ts web/tsconfig.json web/app/globals.css web/app/layout.tsx web/app/page.tsx web/app/login web/app/api web/lib web/components/ui.tsx web/components/AppShell.tsx
git commit -m "feat: add web app foundation with session linking and integration API route"
```

---
### Task 13: Employee portal

**Files:**
- Create: `web/components/TimesheetGrid.tsx`, `web/app/portal/page.tsx`, `web/app/portal/history/page.tsx`, `web/app/portal/profile/page.tsx`

**Interfaces:**
- `TimesheetGrid({timesheetId, periodStart, periodEnd, payType: PayType | 'auto', dailyHours, readOnly, onSaved?})`: one row per day, a column per entry code; hours inputs (hourly/salary) or ½/1 day selects (daily); debounced autosave via `planSave`; invalid cells are highlighted and never saved; `'auto'` infers daily vs hours from saved entries (used by reviewers, who can't read pay).

- [ ] **Step 1: Write the grid and portal pages**

`web/components/TimesheetGrid.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cellKey, cellsFromEntries, gridDays, inputsFor, planSave, totalsByCode, type CellValues,
} from '../../src/lib/timesheet-grid';
import { ENTRY_CODES, type EntryCode, type PayType } from '../../src/lib/types';
import { errorMessage, q } from '../lib/api';
import { entriesFor, type Entry } from '../lib/data';
import { getVolcano } from '../lib/volcano';
import { ErrorBanner, Loading } from './ui';

const CODE_LABEL: Record<EntryCode, string> = { REG: 'Worked', PTO: 'PTO', SICK: 'Sick', HOL: 'Holiday' };
const AUTOSAVE_MS = 800;

interface Props {
  timesheetId: string;
  periodStart: string;
  periodEnd: string;
  /** 'auto' infers from saved entries — for reviewers, who can't read the employee's pay. */
  payType: PayType | 'auto';
  /** Daily employees also enter hours when day-rate overtime is on. */
  dailyHours: boolean;
  readOnly: boolean;
  /** Called after each successful save with the saved entries. */
  onSaved?: (entries: Entry[]) => void;
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export function TimesheetGrid({ timesheetId, periodStart, periodEnd, payType: payTypeProp, dailyHours, readOnly, onSaved }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cells, setCells] = useState<CellValues>({});
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const e = await entriesFor(timesheetId);
      setEntries(e);
      setCells(cellsFromEntries(e));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [timesheetId]);

  useEffect(() => { void load(); }, [load]);

  const payType: PayType = payTypeProp !== 'auto' ? payTypeProp
    : entries?.some((e) => e.days != null) ? 'daily' : 'hourly';

  const save = useCallback(async () => {
    if (!entries) return;
    const plan = planSave(entries, cells, payType, dailyHours);
    setCellErrors(plan.errors);
    if (plan.inserts.length + plan.updates.length + plan.deletes.length === 0) {
      setSaveState(Object.keys(plan.errors).length ? 'error' : 'saved');
      return;
    }
    setSaveState('saving');
    const db = getVolcano();
    try {
      for (const id of plan.deletes) await q(db.delete('time_entries').eq('id', id));
      for (const u of plan.updates) await q(db.update('time_entries', { hours: u.hours, days: u.days }).eq('id', u.id));
      for (const i of plan.inserts) {
        await q(db.insert('time_entries', { timesheet_id: timesheetId, work_date: i.work_date, earning_code: i.earning_code, hours: i.hours, days: i.days }));
      }
      const fresh = await entriesFor(timesheetId);
      setEntries(fresh);
      dirty.current = false;
      setSaveState(Object.keys(plan.errors).length ? 'error' : 'saved');
      onSaved?.(fresh);
    } catch (err) {
      setSaveState('error');
      setError(errorMessage(err));
    }
  }, [entries, cells, payType, dailyHours, timesheetId, onSaved]);

  // Debounced autosave; saves never overlap.
  useEffect(() => {
    if (readOnly || !dirty.current) return;
    setSaveState('pending');
    const t = setTimeout(() => {
      const run = async () => {
        if (saving.current) await saving.current;
        saving.current = save();
        await saving.current;
        saving.current = null;
      };
      void run();
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [cells, readOnly, save]);

  function setCell(date: string, code: EntryCode, field: 'hours' | 'days', value: string) {
    dirty.current = true;
    const key = cellKey(date, code);
    setCells((prev) => ({ ...prev, [key]: { hours: prev[key]?.hours ?? '', days: prev[key]?.days ?? '', [field]: value } }));
  }

  if (error && !entries) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!entries) return <Loading label="Loading timesheet…" />;

  const totals = totalsByCode(entries);
  const unit = payType === 'daily' ? 'days' : 'hours';

  return (
    <div>
      {!readOnly && (
        <p className="save-state" aria-live="polite">
          {saveState === 'pending' && 'Unsaved changes…'}
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && 'All changes saved'}
          {saveState === 'error' && 'Some cells could not be saved — see the highlighted fields'}
        </p>
      )}
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="grid">
          <caption className="sr-only">Time entries, one row per day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {ENTRY_CODES.map((c) => <th key={c} scope="col">{CODE_LABEL[c]} ({unit})</th>)}
            </tr>
          </thead>
          <tbody>
            {gridDays(periodStart, periodEnd).map((d) => (
              <tr key={d.date} className={d.weekend ? 'weekend' : undefined}>
                <th scope="row">{d.weekday} {d.date.slice(5)}</th>
                {ENTRY_CODES.map((code) => {
                  const key = cellKey(d.date, code);
                  const want = inputsFor(payType, code, dailyHours);
                  const v = cells[key] ?? { hours: '', days: '' };
                  const err = cellErrors[key];
                  return (
                    <td key={code} className={err ? 'cell-error' : undefined}>
                      {want.days && (
                        <select
                          aria-label={`${CODE_LABEL[code]} days on ${d.date}`} disabled={readOnly}
                          value={v.days} onChange={(e) => setCell(d.date, code, 'days', e.target.value)}
                        >
                          <option value="">—</option>
                          <option value="0.5">½</option>
                          <option value="1">1</option>
                        </select>
                      )}
                      {want.hours && (
                        <input
                          aria-label={`${CODE_LABEL[code]} hours on ${d.date}`} inputMode="decimal" disabled={readOnly}
                          value={v.hours} onChange={(e) => setCell(d.date, code, 'hours', e.target.value)}
                          aria-invalid={err ? true : undefined} title={err} placeholder={want.days ? 'hrs' : ''}
                        />
                      )}
                      {err && <span className="sr-only">{err}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {ENTRY_CODES.map((c) => (
                <td key={c}>{unit === 'days' ? totals[c].days : totals[c].hours}{unit === 'days' && totals[c].hours ? ` (${totals[c].hours} h)` : ''}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
```
`web/app/portal/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { TimesheetGrid } from '../../components/TimesheetGrid';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { errorMessage, q, write } from '../../lib/api';
import { compAt, compensationFor, listPeriods, loadSettings, type Comp, type Period, type Timesheet } from '../../lib/data';
import { monthLabel } from '../../lib/format';
import { useSession } from '../../lib/session';
import { getVolcano } from '../../lib/volcano';

function MyTimesheet() {
  const { employee } = useSession();
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [periodId, setPeriodId] = useState<string>('');
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [dailyHours, setDailyHours] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBase = useCallback(async () => {
    setError(null);
    try {
      const [p, c, s] = await Promise.all([listPeriods(), compensationFor(employee!.id), loadSettings()]);
      setPeriods(p);
      setComps(c);
      setDailyHours(s.ot_applies_to_daily);
      setPeriodId((cur) => cur || (p.find((x) => x.status === 'open') ?? p[0])?.id || '');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [employee]);

  useEffect(() => { void loadBase(); }, [loadBase]);

  const loadSheet = useCallback(async () => {
    if (!periodId || !employee) return;
    setSheet(null);
    try {
      const [s] = await q<Timesheet>(getVolcano().from('timesheets')
        .select('id,employee_id,pay_period_id,status,rejection_note,submitted_at,approved_at')
        .eq('employee_id', employee.id).eq('pay_period_id', periodId));
      setSheet(s ?? null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [periodId, employee]);

  useEffect(() => { void loadSheet(); }, [loadSheet]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); await loadSheet(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const start = () => act(() => q(getVolcano().insert('timesheets', { employee_id: employee!.id, pay_period_id: periodId })));
  const submit = () => act(() => write(getVolcano().update('timesheets', { status: 'submitted' }).eq('id', sheet!.id), 'the timesheet'));
  const recall = () => act(() => write(getVolcano().update('timesheets', { status: 'draft' }).eq('id', sheet!.id), 'the timesheet'));

  if (!periods) return error ? <ErrorBanner error={error} onRetry={() => void loadBase()} /> : <Loading />;
  if (periods.length === 0) return <Empty>No pay periods are open yet. Your administrator will open one.</Empty>;

  const period = periods.find((p) => p.id === periodId)!;
  const comp = compAt(comps, period.end_date);
  const editable = !!sheet && ['draft', 'rejected'].includes(sheet.status) && period.status === 'open';

  return (
    <>
      <div className="toolbar">
        <Field label="Pay period">
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.start_date)} ({p.status})</option>)}
          </select>
        </Field>
        {sheet && <Badge value={sheet.status} />}
      </div>
      <ErrorBanner error={error} />
      {!comp && <Notice>Your pay details aren&apos;t set up yet. You can still record time.</Notice>}
      {sheet?.status === 'rejected' && <div className="alert error" role="alert">Returned by your manager: {sheet.rejection_note}</div>}
      {period.status !== 'open' && <Notice>This period is {period.status}; time can no longer be changed.</Notice>}

      {!sheet ? (
        period.status === 'open'
          ? <button type="button" onClick={() => void start()} disabled={busy}>Start my {monthLabel(period.start_date)} timesheet</button>
          : <Empty>You did not record time for this period.</Empty>
      ) : (
        <>
          <TimesheetGrid
            timesheetId={sheet.id} periodStart={period.start_date} periodEnd={period.end_date}
            payType={comp?.pay_type ?? 'hourly'} dailyHours={dailyHours} readOnly={!editable}
          />
          <div className="actions">
            {editable && <button type="button" onClick={() => void submit()} disabled={busy}>Submit for approval</button>}
            {sheet.status === 'submitted' && period.status === 'open' && (
              <button type="button" className="secondary" onClick={() => void recall()} disabled={busy}>Recall to edit</button>
            )}
          </div>
        </>
      )}
    </>
  );
}

export default function PortalPage() {
  return (
    <AppShell roles={['employee', 'manager', 'admin']}>
      <h1>My timesheet</h1>
      <MyTimesheet />
    </AppShell>
  );
}
```
`web/app/portal/history/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { Badge, Empty, ErrorBanner, Loading } from '../../../components/ui';
import { errorMessage, q } from '../../../lib/api';
import { listPeriods, type Period, type Timesheet } from '../../../lib/data';
import { money, monthLabel, qty } from '../../../lib/format';
import { useSession } from '../../../lib/session';
import { getVolcano } from '../../../lib/volcano';

interface Line { pay_period_id: string; earning_code: string; hours: string | null; days: string | null; amount_cents: number }

function History() {
  const { employee } = useSession();
  const [data, setData] = useState<{ periods: Period[]; sheets: Timesheet[]; lines: Line[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const db = getVolcano();
      const [periods, sheets, lines] = await Promise.all([
        listPeriods(),
        q<Timesheet>(db.from('timesheets').select('id,employee_id,pay_period_id,status,rejection_note,submitted_at,approved_at').eq('employee_id', employee!.id)),
        // RLS returns only this employee's lines, and only from finalized runs.
        q<Line>(db.from('payroll_run_lines').select('pay_period_id,earning_code,hours,days,amount_cents').eq('employee_id', employee!.id).limit(2000)),
      ]);
      setData({ periods, sheets, lines });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [employee]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;
  if (data.sheets.length === 0) return <Empty>No timesheets yet.</Empty>;

  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th scope="col">Month</th><th scope="col">Timesheet</th><th scope="col">Gross pay</th></tr></thead>
        <tbody>
          {data.periods.filter((p) => data.sheets.some((s) => s.pay_period_id === p.id)).map((p) => {
            const sheet = data.sheets.find((s) => s.pay_period_id === p.id)!;
            const lines = data.lines.filter((l) => l.pay_period_id === p.id);
            return (
              <tr key={p.id}>
                <td>{monthLabel(p.start_date)}</td>
                <td><Badge value={sheet.status} /></td>
                <td>
                  {lines.length > 0 ? (
                    <details>
                      <summary>{money(lines.reduce((s, l) => s + Number(l.amount_cents), 0))}</summary>
                      <ul className="plain">
                        {lines.map((l, i) => (
                          <li key={i}>{l.earning_code}: {l.hours != null ? `${qty(l.hours)} h` : `${qty(l.days)} d`} — {money(l.amount_cents)}</li>
                        ))}
                      </ul>
                    </details>
                  ) : <span className="muted">Not finalized</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">Gross pay before taxes and deductions, which your payroll provider calculates.</p>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <AppShell roles={['employee', 'manager', 'admin']}>
      <h1>History</h1>
      <History />
    </AppShell>
  );
}
```
`web/app/portal/profile/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { ErrorBanner, Loading } from '../../../components/ui';
import { errorMessage, q } from '../../../lib/api';
import { EMPLOYEE_COLUMNS, compensationFor, type Comp, type EmployeeRow } from '../../../lib/data';
import { RATE_UNIT, money } from '../../../lib/format';
import { useSession } from '../../../lib/session';
import { getVolcano } from '../../../lib/volcano';

function Profile() {
  const { employee } = useSession();
  const [me, setMe] = useState<EmployeeRow | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [row] = await q<EmployeeRow>(getVolcano().from('employees').select(EMPLOYEE_COLUMNS).eq('id', employee!.id));
      setMe(row);
      setComps(await compensationFor(employee!.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [employee]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!me) return <Loading />;
  return (
    <>
      <dl className="details">
        <dt>Name</dt><dd>{me.first_name} {me.last_name}</dd>
        <dt>Email</dt><dd>{me.email}</dd>
        <dt>Employee ID</dt><dd>{me.external_id ?? '—'}</dd>
        <dt>Role</dt><dd>{me.role}</dd>
        <dt>Hire date</dt><dd>{String(me.hire_date).slice(0, 10)}</dd>
        <dt>Work state</dt><dd>{me.work_state ?? '—'}</dd>
      </dl>
      <h2>Pay</h2>
      {comps.length === 0 ? <p className="muted">Not set up yet.</p> : (
        <ul className="plain">
          {comps.map((c) => <li key={c.id}>{c.pay_type}: {money(c.rate_cents)} {RATE_UNIT[c.pay_type]} from {c.effective_from}</li>)}
        </ul>
      )}
      <p className="muted">To change these details, contact your payroll administrator.</p>
    </>
  );
}

export default function ProfilePage() {
  return (
    <AppShell roles={['employee', 'manager', 'admin']}>
      <h1>Profile</h1>
      <Profile />
    </AppShell>
  );
}
```

- [ ] **Step 2: Build and type check**

Run: `npm run build && npm run typecheck`
Expected: `/portal`, `/portal/history`, `/portal/profile` listed; no errors.

- [ ] **Step 3: Commit**

```sh
git add web/components/TimesheetGrid.tsx web/app/portal
git commit -m "feat: add employee timesheet portal with autosave, history and profile"
```

---
### Task 14: Manager approvals

**Files:**
- Create: `web/app/manage/page.tsx`

**Interfaces:**
- Managers see direct reports (RLS); admins see everyone and can unlock approved timesheets in open periods. Returning a timesheet requires a note (the DB also enforces this).

- [ ] **Step 1: Write the page**

`web/app/manage/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { TimesheetGrid } from '../../components/TimesheetGrid';
import { Badge, Empty, ErrorBanner, Field, Loading } from '../../components/ui';
import { errorMessage, write } from '../../lib/api';
import {
  listEmployees, listPeriods, loadSettings, timesheetsForPeriod, type EmployeeRow, type Period, type Timesheet,
} from '../../lib/data';
import { monthLabel } from '../../lib/format';
import { useSession } from '../../lib/session';
import { getVolcano } from '../../lib/volcano';

const ORDER = { submitted: 0, rejected: 1, draft: 2, approved: 3 } as const;

function Approvals() {
  const { employee: me } = useSession();
  const isAdmin = me!.role === 'admin';
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [periodId, setPeriodId] = useState('');
  const [team, setTeam] = useState<EmployeeRow[]>([]);
  const [sheets, setSheets] = useState<Timesheet[]>([]);
  const [dailyHours, setDailyHours] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    setError(null);
    try {
      const [p, employees, s] = await Promise.all([listPeriods(), listEmployees(), loadSettings()]);
      // RLS returns direct reports to managers and everyone to admins.
      const people = employees.filter((e) => e.status === 'active' && (isAdmin || e.manager_id === me!.id));
      setPeriods(p);
      setTeam(people);
      setDailyHours(s.ot_applies_to_daily);
      setPeriodId((cur) => cur || (p.find((x) => x.status !== 'finalized') ?? p[0])?.id || '');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [isAdmin, me]);

  useEffect(() => { void loadBase(); }, [loadBase]);

  const loadSheets = useCallback(async () => {
    if (!periodId) return;
    try { setSheets(await timesheetsForPeriod(periodId)); } catch (err) { setError(errorMessage(err)); }
  }, [periodId]);

  useEffect(() => { void loadSheets(); }, [loadSheets]);

  async function decide(sheet: Timesheet, status: 'approved' | 'rejected' | 'draft') {
    setBusy(sheet.id);
    setError(null);
    try {
      const values: Record<string, string> = { status };
      if (status === 'rejected') values.rejection_note = (notes[sheet.id] ?? '').trim();
      await write(getVolcano().update('timesheets', values).eq('id', sheet.id), 'the timesheet');
      await loadSheets();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!periods) return error ? <ErrorBanner error={error} onRetry={() => void loadBase()} /> : <Loading />;
  if (periods.length === 0) return <Empty>No pay periods yet.</Empty>;
  const period = periods.find((p) => p.id === periodId)!;

  const rows = team
    .map((e) => ({ e, sheet: sheets.find((s) => s.employee_id === e.id) ?? null }))
    .sort((a, b) => (a.sheet ? ORDER[a.sheet.status] : 9) - (b.sheet ? ORDER[b.sheet.status] : 9) || a.e.last_name.localeCompare(b.e.last_name));
  const waiting = rows.filter((r) => r.sheet?.status === 'submitted').length;

  return (
    <>
      <div className="toolbar">
        <Field label="Pay period">
          <select value={periodId} onChange={(e) => { setPeriodId(e.target.value); setOpen(null); }}>
            {periods.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.start_date)} ({p.status})</option>)}
          </select>
        </Field>
        <p>{waiting} waiting for approval · {rows.filter((r) => !r.sheet || r.sheet.status === 'draft').length} not submitted</p>
      </div>
      <ErrorBanner error={error} />
      {rows.length === 0 ? <Empty>No one reports to you yet.</Empty> : (
        <ul className="cards">
          {rows.map(({ e, sheet }) => (
            <li key={e.id} className="card">
              <div className="card-head">
                <strong>{e.last_name}, {e.first_name}</strong>
                {sheet ? <Badge value={sheet.status} /> : <span className="muted">not started</span>}
                {sheet && <button type="button" className="secondary small" onClick={() => setOpen(open === sheet.id ? null : sheet.id)} aria-expanded={open === sheet.id}>{open === sheet.id ? 'Hide' : 'View'}</button>}
              </div>
              {sheet?.status === 'rejected' && <p className="muted">Returned: {sheet.rejection_note}</p>}
              {sheet && open === sheet.id && (
                <TimesheetGrid
                  timesheetId={sheet.id} periodStart={period.start_date} periodEnd={period.end_date}
                  payType="auto"
                  dailyHours={dailyHours} readOnly
                />
              )}
              {sheet?.status === 'submitted' && period.status !== 'finalized' && (sheet.employee_id !== me!.id || isAdmin) && (
                <div className="actions">
                  <button type="button" disabled={busy === sheet.id} onClick={() => void decide(sheet, 'approved')}>Approve</button>
                  <input
                    aria-label={`Reason for returning ${e.first_name}'s timesheet`} placeholder="Reason for returning"
                    value={notes[sheet.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [sheet.id]: ev.target.value })}
                  />
                  <button type="button" className="secondary" disabled={busy === sheet.id || !(notes[sheet.id] ?? '').trim()} onClick={() => void decide(sheet, 'rejected')}>Return</button>
                </div>
              )}
              {isAdmin && sheet?.status === 'approved' && period.status === 'open' && (
                <div className="actions">
                  <button type="button" className="secondary small" disabled={busy === sheet.id} onClick={() => void decide(sheet, 'draft')}>Unlock for edits</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function ManagePage() {
  return (
    <AppShell roles={['manager', 'admin']}>
      <h1>Approvals</h1>
      <Approvals />
    </AppShell>
  );
}
```

- [ ] **Step 2: Build and type check**

Run: `npm run build && npm run typecheck`
Expected: `/manage` listed; no errors.

- [ ] **Step 3: Commit**

```sh
git add web/app/manage
git commit -m "feat: add manager approval queue"
```

---
### Task 15: Admin dashboard and employee management

**Files:**
- Create: `web/app/admin/page.tsx`, `web/components/EmployeeForm.tsx`, `web/app/admin/employees/page.tsx`, `web/app/admin/employees/[id]/page.tsx`, `web/app/admin/employees/import/page.tsx`

**Interfaces:**
- `EmployeeForm({initial?, managers, submitLabel, busy, onSubmit(values: EmployeeValues)})`; `EmployeeValues {email, first_name, last_name, external_id, role, manager_id, hire_date, work_state}`.
- The import page parses in the browser (`parseEmployeeCsv`) for the preview, then sends valid raw records to `employee-import` in batches of 100.

- [ ] **Step 1: Write the pages**

`web/app/admin/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { Badge, ErrorBanner, Loading } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { listEmployees, listPeriods, listRuns, timesheetsForPeriod, type Period, type Run, type Timesheet } from '../../lib/data';
import { money, monthLabel } from '../../lib/format';

function Dashboard() {
  const [data, setData] = useState<{ period: Period | null; sheets: Timesheet[]; active: number; run: Run | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [periods, employees, runs] = await Promise.all([listPeriods(), listEmployees(), listRuns()]);
      const period = periods.find((p) => p.status !== 'finalized') ?? periods[0] ?? null;
      const sheets = period ? await timesheetsForPeriod(period.id) : [];
      setData({ period, sheets, active: employees.filter((e) => e.status === 'active').length, run: runs[0] ?? null });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;
  const count = (s: string) => data.sheets.filter((t) => t.status === s).length;
  return (
    <div className="tiles">
      <section className="tile">
        <h2>Current period</h2>
        {data.period ? (
          <>
            <p>{monthLabel(data.period.start_date)} <Badge value={data.period.status} /></p>
            <p>{count('approved')} approved · {count('submitted')} waiting · {data.active - count('approved') - count('submitted')} not submitted</p>
            <Link href="/admin/periods">Manage periods</Link>
          </>
        ) : <p><Link href="/admin/periods">Open your first pay period</Link></p>}
      </section>
      <section className="tile">
        <h2>Latest payroll run</h2>
        {data.run ? (
          <>
            <p><Badge value={data.run.status} /> {money(data.run.totals?.gross_cents ?? 0)} gross</p>
            <Link href={`/admin/runs/${data.run.id}`}>Open run</Link>
          </>
        ) : <p><Link href="/admin/runs">No runs yet</Link></p>}
      </section>
      <section className="tile">
        <h2>People</h2>
        <p>{data.active} active employees</p>
        <Link href="/admin/employees">Manage employees</Link>
      </section>
    </div>
  );
}

export default function AdminHome() {
  return (
    <AppShell roles={['admin']}>
      <h1>Payroll admin</h1>
      <Dashboard />
    </AppShell>
  );
}
```
`web/components/EmployeeForm.tsx`:

```tsx
'use client';
import { useState, type FormEvent } from 'react';
import { normalizeEmail, ROLES, type Role } from '../../src/lib/employee-import';
import type { EmployeeRow } from '../lib/data';
import { Field } from './ui';

export interface EmployeeValues {
  email: string; first_name: string; last_name: string; external_id: string | null; role: Role;
  manager_id: string | null; hire_date: string; work_state: string | null;
}

interface Props {
  initial?: Partial<EmployeeRow>;
  managers: EmployeeRow[];
  submitLabel: string;
  busy: boolean;
  onSubmit(values: EmployeeValues): void;
}

export function EmployeeForm({ initial = {}, managers, submitLabel, busy, onSubmit }: Props) {
  const [v, setV] = useState({
    email: initial.email ?? '', first_name: initial.first_name ?? '', last_name: initial.last_name ?? '',
    external_id: initial.external_id ?? '', role: (initial.role ?? 'employee') as Role, manager_id: initial.manager_id ?? '',
    hire_date: initial.hire_date ? String(initial.hire_date).slice(0, 10) : '', work_state: initial.work_state ?? '',
  });
  const [stateError, setStateError] = useState<string | undefined>();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    const state = v.work_state.trim().toUpperCase();
    if (state && !/^[A-Z]{2}$/.test(state)) { setStateError('Use a 2-letter state code, e.g. CA'); return; }
    setStateError(undefined);
    onSubmit({
      email: normalizeEmail(v.email), first_name: v.first_name.trim(), last_name: v.last_name.trim(),
      external_id: v.external_id.trim() || null, role: v.role, manager_id: v.manager_id || null,
      hire_date: v.hire_date, work_state: state || null,
    });
  }

  return (
    <form onSubmit={submit} className="form-grid">
      <Field label="Work email"><input type="email" required value={v.email} onChange={set('email')} /></Field>
      <Field label="First name"><input required value={v.first_name} onChange={set('first_name')} /></Field>
      <Field label="Last name"><input required value={v.last_name} onChange={set('last_name')} /></Field>
      <Field label="Employee ID" hint="The ID your payroll provider uses"><input value={v.external_id} onChange={set('external_id')} /></Field>
      <Field label="Role">
        <select value={v.role} onChange={set('role')}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      </Field>
      <Field label="Manager">
        <select value={v.manager_id} onChange={set('manager_id')}>
          <option value="">None</option>
          {managers.filter((m) => m.id !== initial.id).map((m) => <option key={m.id} value={m.id}>{m.last_name}, {m.first_name}</option>)}
        </select>
      </Field>
      <Field label="Hire date"><input type="date" required value={v.hire_date} onChange={set('hire_date')} /></Field>
      <Field label="Work state" error={stateError}><input maxLength={2} value={v.work_state} onChange={set('work_state')} /></Field>
      <div className="form-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
    </form>
  );
}
```
`web/app/admin/employees/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { EmployeeForm, type EmployeeValues } from '../../../components/EmployeeForm';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, q } from '../../../lib/api';
import { listEmployees, type EmployeeRow } from '../../../lib/data';
import { getVolcano } from '../../../lib/volcano';

const PAGE = 50;

function Employees() {
  const [all, setAll] = useState<EmployeeRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'active' | 'terminated' | 'all'>('active');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setAll(await listEmployees()); } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (all ?? []).filter((e) => (status === 'all' || e.status === status)
      && (!s || `${e.first_name} ${e.last_name} ${e.email} ${e.external_id ?? ''}`.toLowerCase().includes(s)));
  }, [all, search, status]);

  async function add(values: EmployeeValues) {
    setBusy(true);
    setError(null);
    try {
      await q(getVolcano().insert('employees', { ...values }));
      setNotice(`${values.first_name} added. Ask them to create an account with ${values.email}.`);
      setAdding(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!all) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const managers = all.filter((e) => e.status === 'active' && e.role !== 'employee');
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const managerName = (id: string | null) => { const m = all.find((e) => e.id === id); return m ? `${m.first_name} ${m.last_name}` : '—'; };

  return (
    <>
      <div className="toolbar">
        <Field label="Search"><input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Name, email or ID" /></Field>
        <Field label="Status">
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(0); }}>
            <option value="active">Active</option><option value="terminated">Terminated</option><option value="all">All</option>
          </select>
        </Field>
        <button type="button" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Cancel' : 'Add employee'}</button>
        <Link href="/admin/employees/import" className="button secondary">Import CSV</Link>
      </div>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      {adding && <section className="panel"><h2>New employee</h2><EmployeeForm managers={managers} submitLabel="Add employee" busy={busy} onSubmit={(v) => void add(v)} /></section>}
      {filtered.length === 0 ? <Empty>No employees match.</Empty> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">ID</th><th scope="col">Role</th><th scope="col">Manager</th><th scope="col">Account</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/admin/employees/${e.id}`}>{e.last_name}, {e.first_name}</Link></td>
                    <td>{e.email}</td>
                    <td>{e.external_id ?? '—'}</td>
                    <td>{e.role}</td>
                    <td>{managerName(e.manager_id)}</td>
                    <td>{e.user_id ? 'linked' : <span className="muted">invited</span>}</td>
                    <td><Badge value={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Pages">
            <button type="button" className="secondary small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page + 1} of {pages} · {filtered.length} employees</span>
            <button type="button" className="secondary small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </nav>
        </>
      )}
    </>
  );
}

export default function EmployeesPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Employees</h1>
      <Employees />
    </AppShell>
  );
}
```
`web/app/admin/employees/[id]/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { dollarsToCents } from '../../../../../src/lib/money';
import type { PayType } from '../../../../../src/lib/types';
import { AppShell } from '../../../../components/AppShell';
import { EmployeeForm, type EmployeeValues } from '../../../../components/EmployeeForm';
import { Badge, ErrorBanner, Field, Loading, Notice } from '../../../../components/ui';
import { errorMessage, q, write } from '../../../../lib/api';
import { compensationFor, listEmployees, type Comp, type EmployeeRow } from '../../../../lib/data';
import { RATE_UNIT, money } from '../../../../lib/format';
import { getVolcano } from '../../../../lib/volcano';

function EmployeeDetail({ id }: { id: string }) {
  const [all, setAll] = useState<EmployeeRow[] | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comp, setComp] = useState({ pay_type: 'hourly' as PayType, rate: '', effective_from: '' });
  const [termDate, setTermDate] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [e, c] = await Promise.all([listEmployees(), compensationFor(id)]);
      setAll(e);
      setComps(c);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); setNotice(done); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const save = (v: EmployeeValues) => run(() => write(getVolcano().update('employees', { ...v }).eq('id', id), 'the employee'), 'Saved.');

  function addComp(e: FormEvent) {
    e.preventDefault();
    let cents: number;
    try { cents = dollarsToCents(comp.rate); } catch { setError('Enter the rate as a dollar amount, e.g. 25.50'); return; }
    if (cents <= 0) { setError('The rate must be more than zero'); return; }
    void run(() => q(getVolcano().insert('compensation', {
      employee_id: id, pay_type: comp.pay_type, rate_cents: cents, effective_from: comp.effective_from,
    })), 'Pay change added.');
  }

  if (!all) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const emp = all.find((e) => e.id === id);
  if (!emp) return <p>Employee not found. <Link href="/admin/employees">Back to employees</Link></p>;
  const managers = all.filter((e) => e.status === 'active' && e.role !== 'employee');

  return (
    <>
      <p><Link href="/admin/employees">← Employees</Link></p>
      <h1>{emp.first_name} {emp.last_name} <Badge value={emp.status} /></h1>
      <p className="muted">{emp.user_id ? 'Account linked.' : `Invited — not signed up yet. They should create an account with ${emp.email}.`}</p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <h2>Details</h2>
        <EmployeeForm key={emp.id + emp.email} initial={emp} managers={managers} submitLabel="Save changes" busy={busy} onSubmit={(v) => void save(v)} />
      </section>

      <section className="panel">
        <h2>Pay</h2>
        {comps.length === 0 ? <p className="muted">No pay set up. Payroll will flag this employee until you add one.</p> : (
          <table>
            <thead><tr><th scope="col">Effective from</th><th scope="col">Type</th><th scope="col">Rate</th></tr></thead>
            <tbody>{comps.map((c) => <tr key={c.id}><td>{c.effective_from}</td><td>{c.pay_type}</td><td>{money(c.rate_cents)} {RATE_UNIT[c.pay_type]}</td></tr>)}</tbody>
          </table>
        )}
        <form onSubmit={addComp} className="form-grid">
          <Field label="Pay type">
            <select value={comp.pay_type} onChange={(e) => setComp({ ...comp, pay_type: e.target.value as PayType })}>
              <option value="salary">Salary (per year)</option><option value="hourly">Hourly</option><option value="daily">Daily</option>
            </select>
          </Field>
          <Field label={`Rate ${RATE_UNIT[comp.pay_type]}`}><input inputMode="decimal" required value={comp.rate} onChange={(e) => setComp({ ...comp, rate: e.target.value })} placeholder="0.00" /></Field>
          <Field label="Effective from"><input type="date" required value={comp.effective_from} onChange={(e) => setComp({ ...comp, effective_from: e.target.value })} /></Field>
          <div className="form-actions"><button type="submit" disabled={busy}>Add pay change</button></div>
        </form>
      </section>

      <section className="panel">
        <h2>Employment</h2>
        {emp.status === 'active' ? (
          <form className="form-grid" onSubmit={(e) => {
            e.preventDefault();
            void run(() => write(getVolcano().update('employees', { status: 'terminated', termination_date: termDate }).eq('id', id), 'the employee'), 'Employee terminated.');
          }}>
            <Field label="Last day worked"><input type="date" required min={String(emp.hire_date).slice(0, 10)} value={termDate} onChange={(e) => setTermDate(e.target.value)} /></Field>
            <div className="form-actions"><button type="submit" className="danger" disabled={busy}>Terminate</button></div>
          </form>
        ) : (
          <>
            <p>Terminated effective {String(emp.termination_date).slice(0, 10)}.</p>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => void run(() => write(getVolcano().update('employees', { status: 'active', termination_date: null }).eq('id', id), 'the employee'), 'Employee reactivated.')}>
              Reactivate
            </button>
          </>
        )}
      </section>
    </>
  );
}

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  return <AppShell roles={['admin']}><EmployeeDetail id={id} /></AppShell>;
}
```
`web/app/admin/employees/import/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useState } from 'react';
import { IMPORT_COLUMNS, parseEmployeeCsv, type ImportError, type ImportRecord, type ImportRow } from '../../../../../src/lib/employee-import';
import { AppShell } from '../../../../components/AppShell';
import { ErrorBanner, Notice } from '../../../../components/ui';
import { ApiError, errorMessage, invoke } from '../../../../lib/api';
import { downloadFile } from '../../../../lib/format';

const BATCH = 100;

interface Outcome { line: number; email: string; result: 'created' | 'updated' | 'error'; message?: string }

function Importer() {
  const [parsed, setParsed] = useState<{ rows: ImportRow[]; errors: ImportError[]; records: ImportRecord[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setParsed(null);
    setOutcomes([]);
    setError(null);
    if (!file) return;
    if (file.size > 2_000_000) { setError('That file is larger than 2 MB. Split it and import in parts.'); return; }
    setParsed(parseEmployeeCsv(await file.text()));
  }

  async function runImport() {
    if (!parsed) return;
    const valid = new Set(parsed.rows.map((r) => r.line));
    const records = parsed.records.filter((r) => valid.has(r.line));
    setOutcomes([]);
    setError(null);
    setProgress({ done: 0, total: records.length });
    const all: Outcome[] = [];
    try {
      for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        const res = await invoke<{ outcomes: Outcome[] }>('employee-import', { records: batch, dry_run: false });
        all.push(...res.outcomes);
        setOutcomes([...all]);
        setProgress({ done: Math.min(i + BATCH, records.length), total: records.length });
      }
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? ` (${(err.details as ImportError[]).map((d) => `line ${d.line}: ${d.message}`).join('; ')})` : '';
      setError(`Import stopped: ${errorMessage(err)}${details}. Rows already imported were saved; fix the file and import again — existing emails are updated, not duplicated.`);
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <p><Link href="/admin/employees">← Employees</Link></p>
      <p>
        Columns: <code>{IMPORT_COLUMNS.join(', ')}</code>. Required: email, first_name, last_name, hire_date (YYYY-MM-DD).
        Rate is dollars per year (salary), hour (hourly) or day (daily). Existing employees are matched by email and updated.{' '}
        <button type="button" className="link" onClick={() => downloadFile('employees-template.csv', 'text/csv', `${IMPORT_COLUMNS.join(',')}\r\nada@example.com,Ada,Lovelace,E-001,employee,,2024-01-15,CA,hourly,32.50,\r\n`)}>
          Download a template
        </button>
      </p>
      <label className="field">
        <span className="label">CSV file</span>
        <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      <ErrorBanner error={error} />
      {parsed && (
        <section className="panel">
          <p>{parsed.rows.length} row(s) ready · {new Set(parsed.errors.map((e) => e.line)).size} row(s) with problems</p>
          {parsed.errors.length > 0 && (
            <ul className="problems">
              {parsed.errors.map((e, i) => <li key={i}>Line {e.line}: {e.message}</li>)}
            </ul>
          )}
          <button type="button" disabled={parsed.rows.length === 0 || !!progress} onClick={() => void runImport()}>
            {progress ? `Importing ${progress.done} / ${progress.total}…` : `Import ${parsed.rows.length} row(s)`}
          </button>
          {parsed.errors.length > 0 && parsed.rows.length > 0 && <p className="muted">Rows with problems are skipped.</p>}
        </section>
      )}
      {outcomes.length > 0 && (
        <section className="panel">
          <Notice>
            {outcomes.filter((o) => o.result === 'created').length} created · {outcomes.filter((o) => o.result === 'updated').length} updated · {outcomes.filter((o) => o.result === 'error' || o.message).length} need attention
          </Notice>
          <ul className="problems">
            {outcomes.filter((o) => o.result === 'error' || o.message).map((o) => <li key={o.line}>Line {o.line} ({o.email}): {o.message}</li>)}
          </ul>
        </section>
      )}
    </>
  );
}

export default function ImportPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Import employees</h1>
      <Importer />
    </AppShell>
  );
}
```

- [ ] **Step 2: Build and type check**

Run: `npm run build && npm run typecheck`
Expected: `/admin`, `/admin/employees`, `ƒ /admin/employees/[id]`, `/admin/employees/import` listed; no errors.

- [ ] **Step 3: Commit**

```sh
git add web/app/admin/page.tsx web/components/EmployeeForm.tsx web/app/admin/employees
git commit -m "feat: add admin dashboard, employee management and CSV import"
```

---
### Task 16: Admin pay periods and payroll runs

**Files:**
- Create: `web/app/admin/periods/page.tsx`, `web/app/admin/runs/page.tsx`, `web/app/admin/runs/[id]/page.tsx`

**Interfaces:**
- Periods: open a month (`monthBounds`), lock, reopen, delete when empty.
- Runs: generate drafts for locked periods; run detail shows totals, warnings with per-employee "leave out" (regenerate), lines with search, finalize (confirm), discard, export (preset or `custom:<id>`) with download and re-download, void with reason.

- [ ] **Step 1: Write the pages**

`web/app/admin/periods/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { addDays, monthBounds } from '../../../../src/lib/dates';
import { AppShell } from '../../../components/AppShell';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, q, write } from '../../../lib/api';
import { listPeriods, type Period } from '../../../lib/data';
import { monthLabel } from '../../../lib/format';
import { getVolcano } from '../../../lib/volcano';

type Counts = Record<string, Record<string, number>>;

function Periods() {
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [counts, setCounts] = useState<Counts>({});
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await listPeriods();
      const sheets = p.length
        ? await q<{ pay_period_id: string; status: string }>(getVolcano().from('timesheets').select('pay_period_id,status').in('pay_period_id', p.map((x) => x.id)).limit(20000))
        : [];
      const c: Counts = {};
      for (const s of sheets) (c[s.pay_period_id] ??= {})[s.status] = ((c[s.pay_period_id] ??= {})[s.status] ?? 0) + 1;
      setPeriods(p);
      setCounts(c);
      setMonth((m) => m || (p[0] ? addDays(p[0].end_date, 1).slice(0, 7) : new Date().toISOString().slice(0, 7)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); setNotice(done); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  function openMonth(e: FormEvent) {
    e.preventDefault();
    const { start, end } = monthBounds(month);
    void run(() => q(getVolcano().insert('pay_periods', { start_date: start, end_date: end })), `${monthLabel(start)} is open for time entry.`);
  }

  const setStatus = (p: Period, status: Period['status'], done: string) =>
    run(() => write(getVolcano().update('pay_periods', { status }).eq('id', p.id), 'the pay period'), done);

  if (!periods) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  return (
    <>
      <form className="toolbar" onSubmit={openMonth}>
        <Field label="Month"><input type="month" required value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <button type="submit" disabled={busy}>Open month</button>
      </form>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      {periods.length === 0 ? <Empty>No pay periods yet. Open the current month to let employees record time.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Month</th><th scope="col">Status</th><th scope="col">Timesheets</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {periods.map((p) => {
                const c = counts[p.id] ?? {};
                return (
                  <tr key={p.id}>
                    <td>{monthLabel(p.start_date)}</td>
                    <td><Badge value={p.status} /></td>
                    <td>{c.approved ?? 0} approved · {c.submitted ?? 0} submitted · {(c.draft ?? 0) + (c.rejected ?? 0)} in progress</td>
                    <td className="row-actions">
                      {p.status === 'open' && <button type="button" className="small" disabled={busy} onClick={() => void setStatus(p, 'locked', 'Locked. Employees can no longer change time; generate a payroll run next.')}>Lock</button>}
                      {p.status === 'locked' && <button type="button" className="small secondary" disabled={busy} onClick={() => void setStatus(p, 'open', 'Reopened for time entry.')}>Reopen</button>}
                      {p.status === 'locked' && <Link className="button small" href="/admin/runs">Payroll run</Link>}
                      {p.status === 'open' && Object.keys(c).length === 0 && (
                        <button type="button" className="small danger" disabled={busy} onClick={() => void run(() => write(getVolcano().delete('pay_periods').eq('id', p.id), 'the pay period'), 'Deleted.')}>Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function PeriodsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Pay periods</h1>
      <p className="muted">Open a month for time entry, lock it when timesheets are approved, then run payroll.</p>
      <Periods />
    </AppShell>
  );
}
```
`web/app/admin/runs/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { Badge, Empty, ErrorBanner, Loading } from '../../../components/ui';
import { errorMessage, invoke } from '../../../lib/api';
import { listPeriods, listRuns, type Period, type Run } from '../../../lib/data';
import { dateTime, money, monthLabel } from '../../../lib/format';

function Runs() {
  const router = useRouter();
  const [data, setData] = useState<{ periods: Period[]; runs: Run[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [periods, runs] = await Promise.all([listPeriods(), listRuns()]);
      setData({ periods, runs });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function generate(periodId: string) {
    setBusy(periodId);
    setError(null);
    try {
      const r = await invoke<{ run_id: string }>('payroll-run', { action: 'generate', period_id: periodId });
      router.push(`/admin/runs/${r.run_id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  if (!data) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const period = (id: string) => data.periods.find((p) => p.id === id);
  const ready = data.periods.filter((p) => p.status === 'locked' && !data.runs.some((r) => r.pay_period_id === p.id && r.status !== 'voided'));

  return (
    <>
      <ErrorBanner error={error} />
      {ready.length > 0 && (
        <section className="panel">
          <h2>Ready to run</h2>
          {ready.map((p) => (
            <p key={p.id}>
              {monthLabel(p.start_date)}{' '}
              <button type="button" disabled={!!busy} onClick={() => void generate(p.id)}>{busy === p.id ? 'Calculating…' : 'Generate draft run'}</button>
            </p>
          ))}
        </section>
      )}
      {data.runs.length === 0 ? <Empty>No payroll runs yet. Lock a pay period on the Pay periods page, then generate a run here.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Month</th><th scope="col">Status</th><th scope="col">Employees</th><th scope="col">Gross</th><th scope="col">Generated</th><th scope="col">Finalized</th></tr></thead>
            <tbody>
              {data.runs.map((r) => {
                const p = period(r.pay_period_id);
                return (
                  <tr key={r.id}>
                    <td><Link href={`/admin/runs/${r.id}`}>{p ? monthLabel(p.start_date) : r.pay_period_id}</Link></td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.totals?.employee_count ?? 0}</td>
                    <td>{money(r.totals?.gross_cents ?? 0)}</td>
                    <td>{dateTime(r.generated_at)}</td>
                    <td>{dateTime(r.finalized_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function RunsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Payroll runs</h1>
      <Runs />
    </AppShell>
  );
}
```
`web/app/admin/runs/[id]/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PRESETS } from '../../../../../src/lib/exporters';
import { EARNING_CODES } from '../../../../../src/lib/types';
import { AppShell } from '../../../../components/AppShell';
import { Badge, ErrorBanner, Field, Loading, Notice } from '../../../../components/ui';
import { errorMessage, invoke, q } from '../../../../lib/api';
import { listPeriods, type Period, type Run } from '../../../../lib/data';
import { dateTime, downloadFile, money, monthLabel, qty } from '../../../../lib/format';
import { getVolcano } from '../../../../lib/volcano';

interface Line { id: string; employee_id: string; first_name: string; last_name: string; external_id: string | null; pay_type: string; earning_code: string; hours: string | null; days: string | null; rate_cents: number; amount_cents: number }
interface ExportRow { id: string; mapping_key: string; filename: string; created_at: string; sha256: string; api_key_id: string | null }
interface Mapping { id: string; name: string }

function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [mappingKey, setMappingKey] = useState('generic_csv');
  const [voidReason, setVoidReason] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const db = getVolcano();
      const [r] = await q<Run>(db.from('payroll_runs')
        .select('id,pay_period_id,status,totals,warnings,skipped_employee_ids,generated_at,finalized_at,voided_at,void_reason').eq('id', id));
      if (!r) { setError('Payroll run not found'); return; }
      const [periods, l, ex, maps] = await Promise.all([
        listPeriods(),
        q<Line>(db.from('payroll_run_lines').select('id,employee_id,first_name,last_name,external_id,pay_type,earning_code,hours,days,rate_cents,amount_cents').eq('run_id', id).order('last_name').limit(10000)),
        q<ExportRow>(db.from('exports').select('id,mapping_key,filename,created_at,sha256,api_key_id').eq('run_id', id).order('created_at', { ascending: false }).limit(50)),
        q<Mapping>(db.from('export_mappings').select('id,name').order('name')),
      ]);
      setRun(r);
      setPeriod(periods.find((p) => p.id === r.pay_period_id) ?? null);
      setLines(l);
      setExports(ex);
      setMappings(maps);
      setSkip(new Set(r.skipped_employee_ids ?? []));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done: string, after?: (result: unknown) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      setNotice(done);
      after?.(result);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return lines.filter((l) => !s || `${l.first_name} ${l.last_name} ${l.external_id ?? ''}`.toLowerCase().includes(s));
  }, [lines, search]);

  if (!run) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const blocking = run.warnings.filter((w) => w.blocking);
  const regenerate = () => act(
    () => invoke<{ run_id: string }>('payroll-run', { action: 'generate', period_id: run.pay_period_id, skipped_employee_ids: [...skip] }),
    'Draft regenerated.',
    (r) => { const next = (r as { run_id: string }).run_id; if (next !== id) window.location.assign(`/admin/runs/${next}`); },
  );

  return (
    <>
      <p><Link href="/admin/runs">← Payroll runs</Link></p>
      <h1>{period ? monthLabel(period.start_date) : 'Payroll run'} <Badge value={run.status} /></h1>
      <p className="muted">
        Generated {dateTime(run.generated_at)}
        {run.finalized_at && ` · finalized ${dateTime(run.finalized_at)}`}
        {run.voided_at && ` · voided ${dateTime(run.voided_at)}: ${run.void_reason}`}
      </p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <h2>Totals</h2>
        <p><strong>{money(run.totals.gross_cents)}</strong> gross for {run.totals.employee_count} employees</p>
        <table>
          <thead><tr><th scope="col">Code</th><th scope="col">Hours</th><th scope="col">Days</th><th scope="col">Amount</th></tr></thead>
          <tbody>
            {EARNING_CODES.filter((c) => run.totals.by_code[c]).map((c) => (
              <tr key={c}><td>{c}</td><td>{run.totals.by_code[c]!.hours}</td><td>{run.totals.by_code[c]!.days}</td><td>{money(run.totals.by_code[c]!.amount_cents)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {run.warnings.length > 0 && (
        <section className="panel">
          <h2>Warnings</h2>
          <ul className="problems">
            {run.warnings.map((w, i) => (
              <li key={i}>
                {w.blocking ? <strong>Must fix: </strong> : 'Note: '}{w.message}
                {w.blocking && run.status === 'draft' && (
                  <label className="inline">
                    <input type="checkbox" checked={skip.has(w.employee_id)} onChange={(e) => {
                      const next = new Set(skip);
                      if (e.target.checked) next.add(w.employee_id); else next.delete(w.employee_id);
                      setSkip(next);
                    }} /> leave out of this run
                  </label>
                )}
              </li>
            ))}
          </ul>
          {run.status === 'draft' && <p className="muted">Fix the problem (approve the timesheet, add pay) or tick “leave out”, then regenerate.</p>}
        </section>
      )}

      {run.status === 'draft' && (
        <section className="panel actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void regenerate()}>Regenerate draft</button>
          <button type="button" disabled={busy || blocking.length > 0} onClick={() => {
            if (window.confirm('Finalize this payroll run? Lines are frozen and integrations are notified.')) {
              void act(() => invoke('payroll-run', { action: 'finalize', run_id: id }), 'Finalized. You can now export it.');
            }
          }}>Finalize</button>
          <button type="button" className="danger" disabled={busy} onClick={() => {
            if (window.confirm('Discard this draft?')) void act(() => invoke('payroll-run', { action: 'discard', run_id: id }), 'Draft discarded.', () => window.location.assign('/admin/runs'));
          }}>Discard draft</button>
          {blocking.length > 0 && <p className="muted">Finalize is disabled until every “must fix” warning is resolved.</p>}
        </section>
      )}

      {run.status === 'finalized' && (
        <section className="panel">
          <h2>Export</h2>
          <div className="toolbar">
            <Field label="Format">
              <select value={mappingKey} onChange={(e) => setMappingKey(e.target.value)}>
                <optgroup label="Built-in">{PRESETS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>
                {mappings.length > 0 && <optgroup label="Custom">{mappings.map((m) => <option key={m.id} value={`custom:${m.id}`}>{m.name}</option>)}</optgroup>}
              </select>
            </Field>
            <button type="button" disabled={busy} onClick={() => void act(
              () => invoke<{ filename: string; content_type: string; body: string }>('payroll-export', { run_id: id, mapping_key: mappingKey }),
              'Export created.',
              (r) => { const f = r as { filename: string; content_type: string; body: string }; downloadFile(f.filename, f.content_type, f.body); },
            )}>Export and download</button>
          </div>
          <p className="muted">{PRESETS.find((p) => p.key === mappingKey)?.note}</p>
          {exports.length > 0 && (
            <table>
              <thead><tr><th scope="col">File</th><th scope="col">Created</th><th scope="col">By</th><th scope="col" /></tr></thead>
              <tbody>
                {exports.map((x) => (
                  <tr key={x.id}>
                    <td>{x.filename}</td><td>{dateTime(x.created_at)}</td><td>{x.api_key_id ? 'API' : 'admin'}</td>
                    <td><button type="button" className="link" onClick={async () => {
                      try {
                        const [f] = await q<{ filename: string; content_type: string; content: string }>(getVolcano().from('exports').select('filename,content_type,content').eq('id', x.id));
                        downloadFile(f.filename, f.content_type, f.content);
                      } catch (err) { setError(errorMessage(err)); }
                    }}>Download again</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>Void</h3>
          <p className="muted">Voiding reopens the period for a corrected run and notifies integrations.</p>
          <div className="toolbar">
            <Field label="Reason"><input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></Field>
            <button type="button" className="danger" disabled={busy || !voidReason.trim()} onClick={() => {
              if (window.confirm('Void this finalized run?')) void act(() => invoke('payroll-run', { action: 'void', run_id: id, reason: voidReason.trim() }), 'Run voided. The period is locked again; generate a new run when ready.');
            }}>Void run</button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Lines</h2>
        <Field label="Find employee"><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Employee</th><th scope="col">ID</th><th scope="col">Type</th><th scope="col">Code</th><th scope="col">Hours</th><th scope="col">Days</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <td>{l.last_name}, {l.first_name}</td><td>{l.external_id ?? '—'}</td><td>{l.pay_type}</td><td>{l.earning_code}</td>
                  <td>{qty(l.hours)}</td><td>{qty(l.days)}</td><td>{money(l.rate_cents)}</td><td>{money(l.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  return <AppShell roles={['admin']}><RunDetail id={id} /></AppShell>;
}
```

- [ ] **Step 2: Build and type check**

Run: `npm run build && npm run typecheck`
Expected: `/admin/periods`, `/admin/runs`, `ƒ /admin/runs/[id]` listed; no errors.

- [ ] **Step 3: Commit**

```sh
git add web/app/admin/periods web/app/admin/runs
git commit -m "feat: add pay period management and payroll run review, finalize and export"
```

---
### Task 17: Admin integrations and settings

**Files:**
- Create: `web/components/MappingEditor.tsx`, `web/app/admin/integrations/page.tsx`, `web/app/admin/settings/page.tsx`

**Interfaces:**
- `MappingEditor({name, config, busy, onSave(name, config), onCancel})`: edits format, row mode, date format, earning code names and columns (field / fixed text / per-code), validated live with `validateMapping`.
- Integrations page: export formats (presets plus custom CRUD), API keys (create via `api-key-create`, shown once; revoke), webhooks (add with a browser-generated secret, pause/resume, delete, show secret, send test), recent deliveries with retry and "Send due deliveries now".
- Settings page: company name, workweek start, OT/DT thresholds and multipliers, daily-rate OT toggle.

- [ ] **Step 1: Write the components and pages**

`web/components/MappingEditor.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { EXPORT_FIELDS, validateMapping, type ExportField, type MappingColumn, type MappingConfig } from '../../src/lib/exporters';
import { EARNING_CODES, type EarningCode } from '../../src/lib/types';
import { Field } from './ui';

interface Props {
  name: string;
  config: MappingConfig;
  busy: boolean;
  onSave(name: string, config: MappingConfig): void;
  onCancel(): void;
}

/** Column-by-column editor for a custom export mapping, validated with the same rules the exporter uses. */
export function MappingEditor({ name: initialName, config: initial, busy, onSave, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [c, setC] = useState<MappingConfig>(structuredClone(initial));
  const errors = validateMapping(c);

  const setCol = (i: number, patch: Partial<MappingColumn>) =>
    setC({ ...c, columns: c.columns.map((col, j) => (j === i ? { ...col, ...patch } : col)) });
  const move = (i: number, d: -1 | 1) => {
    const cols = [...c.columns];
    [cols[i], cols[i + d]] = [cols[i + d], cols[i]];
    setC({ ...c, columns: cols });
  };

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Format">
          <select value={c.format} onChange={(e) => setC({ ...c, format: e.target.value as MappingConfig['format'] })}>
            <option value="csv">CSV</option><option value="json">JSON</option>
          </select>
        </Field>
        <Field label="Rows">
          <select value={c.row_mode} onChange={(e) => setC({ ...c, row_mode: e.target.value as MappingConfig['row_mode'] })}>
            <option value="per_line">One per employee and earning code</option>
            <option value="per_employee">One per employee (codes as columns)</option>
          </select>
        </Field>
        <Field label="Dates">
          <select value={c.date_format} onChange={(e) => setC({ ...c, date_format: e.target.value as MappingConfig['date_format'] })}>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option><option value="MM/DD/YYYY">MM/DD/YYYY</option>
          </select>
        </Field>
      </div>

      <fieldset>
        <legend>Earning code names in the provider</legend>
        <div className="form-grid">
          {EARNING_CODES.map((code) => (
            <Field key={code} label={code}>
              <input value={c.code_map[code] ?? ''} placeholder={code} onChange={(e) => {
                const code_map = { ...c.code_map };
                if (e.target.value) code_map[code] = e.target.value; else delete code_map[code];
                setC({ ...c, code_map });
              }} />
            </Field>
          ))}
        </div>
      </fieldset>

      {c.format === 'csv' && (
        <fieldset>
          <legend>Columns</legend>
          <table>
            <thead><tr><th scope="col">Header</th><th scope="col">Value</th><th scope="col">Earning code</th><th scope="col" /></tr></thead>
            <tbody>
              {c.columns.map((col, i) => (
                <tr key={i}>
                  <td><input aria-label={`Column ${i + 1} header`} value={col.header} onChange={(e) => setCol(i, { header: e.target.value })} /></td>
                  <td>
                    <select aria-label={`Column ${i + 1} value`} value={col.const != null ? '__const' : col.field}
                      onChange={(e) => setCol(i, e.target.value === '__const' ? { field: undefined, const: '' } : { field: e.target.value as ExportField, const: undefined })}>
                      {EXPORT_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                      <option value="__const">fixed text…</option>
                    </select>
                    {col.const != null && <input aria-label={`Column ${i + 1} fixed text`} value={col.const} onChange={(e) => setCol(i, { const: e.target.value })} />}
                  </td>
                  <td>
                    {c.row_mode === 'per_employee' && col.const == null && (
                      <select aria-label={`Column ${i + 1} earning code`} value={col.code ?? ''} onChange={(e) => setCol(i, { code: (e.target.value || undefined) as EarningCode | undefined })}>
                        <option value="">all</option>
                        {EARNING_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="row-actions">
                    <button type="button" className="secondary small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button type="button" className="secondary small" disabled={i === c.columns.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button type="button" className="secondary small" onClick={() => setC({ ...c, columns: c.columns.filter((_, j) => j !== i) })} aria-label="Remove column">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="secondary small" onClick={() => setC({ ...c, columns: [...c.columns, { header: 'New column', field: 'external_id' }] })}>Add column</button>
        </fieldset>
      )}

      {errors.length > 0 && <ul className="problems" aria-live="polite">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="actions">
        <button type="button" disabled={busy || errors.length > 0 || !name.trim()} onClick={() => onSave(name.trim(), c)}>Save mapping</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
```
`web/app/admin/integrations/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PRESETS, type MappingConfig } from '../../../../src/lib/exporters';
import { newWebhookSecret } from '../../../../src/lib/random';
import { AppShell } from '../../../components/AppShell';
import { MappingEditor } from '../../../components/MappingEditor';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, invoke, q, write } from '../../../lib/api';
import { dateTime } from '../../../lib/format';
import { getVolcano } from '../../../lib/volcano';

interface Mapping { id: string; name: string; based_on: string | null; config: MappingConfig; updated_at: string }
interface ApiKey { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface Endpoint { id: string; url: string; description: string | null; secret: string; events: string[]; active: boolean }
interface Delivery { id: string; endpoint_id: string; event: string; status: string; attempts: number; next_attempt_at: string; last_response_code: number | null; last_error: string | null; created_at: string }

const EVENTS = ['payroll_run.finalized', 'payroll_run.voided'];

function Integrations() {
  const [data, setData] = useState<{ mappings: Mapping[]; keys: ApiKey[]; endpoints: Endpoint[]; deliveries: Delivery[] } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string; based_on: string | null; config: MappingConfig } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [hook, setHook] = useState({ url: '', description: '', events: EVENTS });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const db = getVolcano();
      const [mappings, keys, endpoints, deliveries] = await Promise.all([
        q<Mapping>(db.from('export_mappings').select('id,name,based_on,config,updated_at').order('name')),
        q<ApiKey>(db.from('api_keys').select('id,name,prefix,created_at,last_used_at,revoked_at').order('created_at', { ascending: false })),
        q<Endpoint>(db.from('webhook_endpoints').select('id,url,description,secret,events,active').order('created_at')),
        q<Delivery>(db.from('webhook_deliveries').select('id,endpoint_id,event,status,attempts,next_attempt_at,last_response_code,last_error,created_at').order('created_at', { ascending: false }).limit(50)),
      ]);
      setData({ mappings, keys, endpoints, deliveries });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); if (done) setNotice(done); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  function saveMapping(name: string, config: MappingConfig) {
    const db = getVolcano();
    const values = { name, based_on: editing!.based_on, config: JSON.stringify(config) };
    void run(async () => {
      if (editing!.id) await write(db.update('export_mappings', values).eq('id', editing!.id), 'the mapping');
      else await q(db.insert('export_mappings', values));
      setEditing(null);
    }, 'Mapping saved. Use it from a finalized run’s Export section.');
  }

  function createKey(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const r = await invoke<{ key: string }>('api-key-create', { name: keyName.trim() });
      setNewKey(r.key);
      setKeyName('');
    }, null);
  }

  function addHook(e: FormEvent) {
    e.preventDefault();
    const secret = newWebhookSecret();
    void run(async () => {
      await q(getVolcano().insert('webhook_endpoints', {
        url: hook.url.trim(), description: hook.description.trim() || null, secret, events: JSON.stringify(hook.events),
      }));
      setHook({ url: '', description: '', events: EVENTS });
    }, `Webhook added. Its signing secret is ${secret} — give it to the receiver so it can verify X-Payroll-Signature.`);
  }

  if (!data) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <h2>Export formats</h2>
        <p className="muted">Built-in formats are starting points for common payroll providers. Copy one to adjust columns or earning code names for your account.</p>
        <ul className="cards">
          {PRESETS.map((p) => (
            <li key={p.key} className="card">
              <div className="card-head"><strong>{p.name}</strong>
                <button type="button" className="secondary small" onClick={() => setEditing({ id: null, name: `${p.name} (custom)`, based_on: p.key, config: p.config })}>Copy and edit</button>
              </div>
              <p className="muted">{p.note}</p>
            </li>
          ))}
          {data.mappings.map((m) => (
            <li key={m.id} className="card">
              <div className="card-head"><strong>{m.name}</strong> <span className="muted">custom{m.based_on ? `, from ${m.based_on}` : ''}</span>
                <button type="button" className="secondary small" onClick={() => setEditing({ id: m.id, name: m.name, based_on: m.based_on, config: m.config })}>Edit</button>
                <button type="button" className="danger small" disabled={busy} onClick={() => {
                  if (window.confirm(`Delete ${m.name}?`)) void run(() => write(getVolcano().delete('export_mappings').eq('id', m.id), 'the mapping'), 'Mapping deleted.');
                }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <div className="panel">
            <h3>{editing.id ? 'Edit mapping' : 'New mapping'}</h3>
            <MappingEditor name={editing.name} config={editing.config} busy={busy} onSave={saveMapping} onCancel={() => setEditing(null)} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2>API keys</h2>
        <p className="muted">Let a payroll provider or connector pull finalized runs. Read-only.</p>
        <pre className="code">{`curl -H "Authorization: Bearer pk_..." ${origin}/api/v1/runs
curl -H "Authorization: Bearer pk_..." ${origin}/api/v1/runs/<run-id>/lines
curl -H "Authorization: Bearer pk_..." "${origin}/api/v1/runs/<run-id>/export?mapping=gusto"`}</pre>
        {newKey && (
          <div className="alert info" role="status">
            <span>Copy this key now — it won’t be shown again: <code>{newKey}</code></span>
            <button type="button" className="secondary small" onClick={() => void navigator.clipboard.writeText(newKey)}>Copy</button>
            <button type="button" className="secondary small" onClick={() => setNewKey(null)}>Done</button>
          </div>
        )}
        <form className="toolbar" onSubmit={createKey}>
          <Field label="Key name"><input required value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Gusto connector" /></Field>
          <button type="submit" disabled={busy}>Create key</button>
        </form>
        {data.keys.length === 0 ? <Empty>No API keys.</Empty> : (
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col" /></tr></thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td><td><code>pk_{k.prefix}_…</code></td><td>{dateTime(k.created_at)}</td><td>{dateTime(k.last_used_at)}</td>
                  <td>{k.revoked_at ? <Badge value="revoked" /> : (
                    <button type="button" className="danger small" disabled={busy} onClick={() => {
                      if (window.confirm(`Revoke ${k.name}? Anything using it stops working.`)) {
                        void run(() => write(getVolcano().update('api_keys', { revoked_at: new Date().toISOString() }).eq('id', k.id), 'the key'), 'Key revoked.');
                      }
                    }}>Revoke</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Webhooks</h2>
        <p className="muted">We POST JSON when a run is finalized or voided, signed with <code>X-Payroll-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256 of “t.body”&gt;</code>. Failed deliveries retry after 1 m, 5 m, 30 m, 2 h and 12 h.</p>
        <form className="form-grid" onSubmit={addHook}>
          <Field label="URL" hint="Must use https"><input type="url" required value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} /></Field>
          <Field label="Description"><input value={hook.description} onChange={(e) => setHook({ ...hook, description: e.target.value })} /></Field>
          <fieldset>
            <legend>Events</legend>
            {EVENTS.map((ev) => (
              <label key={ev} className="inline">
                <input type="checkbox" checked={hook.events.includes(ev)} onChange={(e) => setHook({ ...hook, events: e.target.checked ? [...hook.events, ev] : hook.events.filter((x) => x !== ev) })} /> {ev}
              </label>
            ))}
          </fieldset>
          <div className="form-actions"><button type="submit" disabled={busy || hook.events.length === 0}>Add webhook</button></div>
        </form>
        {data.endpoints.length > 0 && (
          <table>
            <thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Status</th><th scope="col" /></tr></thead>
            <tbody>
              {data.endpoints.map((ep) => (
                <tr key={ep.id}>
                  <td>{ep.url}{ep.description && <div className="muted">{ep.description}</div>}</td>
                  <td>{ep.events.join(', ')}</td>
                  <td><Badge value={ep.active ? 'active' : 'paused'} /></td>
                  <td className="row-actions">
                    <button type="button" className="secondary small" disabled={busy} onClick={() => void run(() => invoke('webhook-dispatch', { test_endpoint_id: ep.id }), 'Test event sent — see deliveries below.')}>Send test</button>
                    <button type="button" className="secondary small" onClick={() => setRevealed(revealed === ep.id ? null : ep.id)}>{revealed === ep.id ? 'Hide secret' : 'Show secret'}</button>
                    <button type="button" className="secondary small" disabled={busy} onClick={() => void run(() => write(getVolcano().update('webhook_endpoints', { active: !ep.active }).eq('id', ep.id), 'the webhook'), null)}>{ep.active ? 'Pause' : 'Resume'}</button>
                    <button type="button" className="danger small" disabled={busy} onClick={() => {
                      if (window.confirm('Delete this webhook and its delivery history?')) void run(() => write(getVolcano().delete('webhook_endpoints').eq('id', ep.id), 'the webhook'), 'Webhook deleted.');
                    }}>Delete</button>
                    {revealed === ep.id && <code className="secret">{ep.secret}</code>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>Recent deliveries</h3>
        <button type="button" className="secondary small" disabled={busy} onClick={() => void run(async () => {
          const r = await invoke<{ delivered: number; retrying: number; failed: number }>('webhook-dispatch');
          setNotice(`${r.delivered} delivered, ${r.retrying} will retry, ${r.failed} failed.`);
        }, null)}>Send due deliveries now</button>
        {data.deliveries.length === 0 ? <Empty>No deliveries yet.</Empty> : (
          <table>
            <thead><tr><th scope="col">Event</th><th scope="col">Endpoint</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last result</th><th scope="col">Next try</th><th scope="col" /></tr></thead>
            <tbody>
              {data.deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{d.event}</td>
                  <td>{data.endpoints.find((e) => e.id === d.endpoint_id)?.url ?? '—'}</td>
                  <td><Badge value={d.status} /></td>
                  <td>{d.attempts}</td>
                  <td>{d.last_response_code ?? ''} {d.last_error ?? ''}</td>
                  <td>{d.status === 'pending' ? dateTime(d.next_attempt_at) : '—'}</td>
                  <td>{d.status === 'failed' && (
                    <button type="button" className="secondary small" disabled={busy} onClick={() => void run(
                      () => write(getVolcano().update('webhook_deliveries', { status: 'pending', next_attempt_at: new Date().toISOString() }).eq('id', d.id), 'the delivery'),
                      'Queued for retry. Use “Send due deliveries now” to send it immediately.',
                    )}>Retry</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

export default function IntegrationsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Integrations</h1>
      <Integrations />
    </AppShell>
  );
}
```
`web/app/admin/settings/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '../../../components/AppShell';
import { ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, write } from '../../../lib/api';
import { loadSettings, type SettingsRow } from '../../../lib/data';
import { getVolcano } from '../../../lib/volcano';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Form = Record<'company_name' | 'ot_weekly_threshold' | 'ot_daily_threshold' | 'dt_daily_threshold' | 'ot_multiplier' | 'dt_multiplier' | 'week_starts_on', string> & { ot_applies_to_daily: boolean };

const toForm = (s: SettingsRow): Form => ({
  company_name: s.company_name,
  ot_weekly_threshold: s.ot_weekly_threshold?.toString() ?? '',
  ot_daily_threshold: s.ot_daily_threshold?.toString() ?? '',
  dt_daily_threshold: s.dt_daily_threshold?.toString() ?? '',
  ot_multiplier: String(s.ot_multiplier),
  dt_multiplier: String(s.dt_multiplier),
  week_starts_on: String(s.week_starts_on),
  ot_applies_to_daily: s.ot_applies_to_daily,
});

/** Blank → null; otherwise a positive number or an error message. */
function optionalNumber(v: string, label: string, max?: number): number | null | string {
  if (v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a positive number`;
  if (max != null && n > max) return `${label} must be at most ${max}`;
  return n;
}

function Settings() {
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setForm(toForm(await loadSettings())); } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setNotice(null);
    const weekly = optionalNumber(form.ot_weekly_threshold, 'Weekly overtime threshold', 168);
    const daily = optionalNumber(form.ot_daily_threshold, 'Daily overtime threshold', 24);
    const dbl = optionalNumber(form.dt_daily_threshold, 'Daily double-time threshold', 24);
    const otm = optionalNumber(form.ot_multiplier, 'Overtime multiplier');
    const dtm = optionalNumber(form.dt_multiplier, 'Double-time multiplier');
    const problem = [weekly, daily, dbl, otm, dtm].find((x) => typeof x === 'string') as string | undefined;
    if (problem) { setError(problem); return; }
    if (typeof dbl === 'number' && typeof daily === 'number' && dbl <= daily) { setError('Double time must start after daily overtime'); return; }
    if ((otm as number | null) == null || (otm as number) < 1 || (dtm as number | null) == null || (dtm as number) < 1) { setError('Multipliers must be 1 or more'); return; }
    setBusy(true);
    setError(null);
    try {
      await write(getVolcano().update('settings', {
        company_name: form.company_name.trim() || 'My Company',
        ot_weekly_threshold: weekly as number | null, ot_daily_threshold: daily as number | null, dt_daily_threshold: dbl as number | null,
        ot_multiplier: otm as number, dt_multiplier: dtm as number,
        ot_applies_to_daily: form.ot_applies_to_daily, week_starts_on: Number(form.week_starts_on),
      }).eq('id', true), 'settings');
      setNotice('Settings saved. Draft payroll runs must be regenerated to use them.');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!form) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <form className="form-grid" onSubmit={save}>
      <Field label="Company name"><input value={form.company_name} onChange={set('company_name')} /></Field>
      <Field label="Workweek starts on">
        <select value={form.week_starts_on} onChange={set('week_starts_on')}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
      </Field>
      <Field label="Weekly overtime after (hours)" hint="Federal rule: 40. Blank = no weekly overtime."><input inputMode="decimal" value={form.ot_weekly_threshold} onChange={set('ot_weekly_threshold')} /></Field>
      <Field label="Daily overtime after (hours)" hint="California: 8. Blank = none."><input inputMode="decimal" value={form.ot_daily_threshold} onChange={set('ot_daily_threshold')} /></Field>
      <Field label="Daily double time after (hours)" hint="California: 12. Blank = none."><input inputMode="decimal" value={form.dt_daily_threshold} onChange={set('dt_daily_threshold')} /></Field>
      <Field label="Overtime multiplier"><input inputMode="decimal" value={form.ot_multiplier} onChange={set('ot_multiplier')} /></Field>
      <Field label="Double-time multiplier"><input inputMode="decimal" value={form.dt_multiplier} onChange={set('dt_multiplier')} /></Field>
      <label className="inline">
        <input type="checkbox" checked={form.ot_applies_to_daily} onChange={(e) => setForm({ ...form, ot_applies_to_daily: e.target.checked })} />
        Pay weekly overtime to daily-rate employees (they then also enter hours)
      </label>
      <p className="muted">These rules are a convenience, not legal advice. Confirm overtime rules for each work state with your payroll provider.</p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      <div className="form-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></div>
    </form>
  );
}

export default function SettingsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Settings</h1>
      <Settings />
    </AppShell>
  );
}
```

- [ ] **Step 2: Build and type check**

Run: `npm run build && npm run typecheck`
Expected: all 17 routes listed (`/`, `/login`, `/portal` ×3, `/manage`, `/admin` ×9, `/api/v1/[...path]`, `/_not-found`); no errors.

- [ ] **Step 3: Commit**

```sh
git add web/components/MappingEditor.tsx web/app/admin/integrations web/app/admin/settings
git commit -m "feat: add export format editor, API keys, webhooks and settings"
```

---
### Task 18: End-to-end verification and README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# Payroll & Time Tracking

Monthly time tracking and gross-pay payroll on [Volcano](https://volcano.dev). Employees enter time in a
portal, managers approve it, and admins run a monthly payroll that is frozen and exported to whichever
payroll provider you use (Gusto, ADP, QuickBooks Online Payroll, Paychex, or anything that takes CSV/JSON).
The provider handles taxes, deductions, net pay and paying people.

Design: `docs/superpowers/specs/2026-10-02-payroll-time-tracking-design.md`.

## How it fits together

| Piece | Where |
|---|---|
| Web app (employee portal, approvals, admin) | `web/` (Next.js) |
| Pay calculation, exporters, CSV, signing | `src/lib/` (pure TypeScript, unit tested) |
| Server helpers shared by functions and `/api/v1` | `src/server/` |
| Volcano Functions (privileged work) | `src/functions/*.ts` → bundled to `volcano/functions/*.js` |
| Database schema, guards, row-level security | `db/migrations-src/*.sql` → generated into `volcano/migrations/` |

Access control lives in the database: row-level security decides who can read and write each row, and
triggers enforce the timesheet and payroll-run state machines, so the UI can't bypass them.

## Local development

Prerequisites: Node 22+, Docker, the Volcano CLI (`volcano --version`).

```sh
npm install
volcano start
volcano databases create payroll
cp volcano/volcano.env.example volcano/volcano.env   # fill in keys from `volcano status`
cp web/.env.example web/.env.local                   # same keys
npm run db:migrate                                    # generate + apply migrations
npm run build:functions
volcano variables deploy
volcano functions deploy --all
volcano config deploy
npm run bootstrap-admin -- you@company.com Your Name
npm run dev                                           # http://localhost:3000
```

Then open the app, choose **Create your account** with the admin email, and sign in. Passwords need at
least 15 characters.

Migrations are not tracked by Volcano: every `npm run db:migrate` re-runs all files, so every statement is
idempotent. Each generated file holds exactly one statement (a Volcano requirement); edit the grouped
sources in `db/migrations-src/` and regenerate, never the generated files.

## Tests

```sh
npm test                   # unit tests
npm run test:tz            # unit tests under two extreme time zones
npm run typecheck
npm run test:integration   # needs the local stack; WIPES the local payroll database
```

`tests/integration/functions.test.ts` also needs the functions deployed locally (see above).

## Monthly payroll

1. **Pay periods → Open month.** Employees record time under **My timesheet** and submit it.
2. Managers approve under **Approvals**. Admins can approve anyone and unlock approved timesheets.
3. **Pay periods → Lock** when time is in.
4. **Payroll runs → Generate draft run.** Fix or skip anyone flagged, regenerate, then **Finalize**.
5. **Export** with your provider's format, or let the provider pull it through the API.

A finalized run never changes. To correct one, **Void** it (with a reason), fix the data, and generate a
new run. Any change to timesheets, employees, pay or settings after a draft is generated makes finalize
refuse until you regenerate.

## Integrating a payroll provider

- **File export**: built-in formats for Gusto, ADP Workforce Now, QuickBooks Online Payroll and Paychex
  Flex, plus generic CSV and JSON. The provider formats are starting points: check them against your
  account's current import template, then adjust a copy under **Integrations → Export formats**.
- **API** (read-only; create a key under **Integrations → API keys**):

  ```sh
  curl -H "Authorization: Bearer pk_..." https://<app>/api/v1/runs
  curl -H "Authorization: Bearer pk_..." https://<app>/api/v1/runs/<id>
  curl -H "Authorization: Bearer pk_..." https://<app>/api/v1/runs/<id>/lines
  curl -H "Authorization: Bearer pk_..." "https://<app>/api/v1/runs/<id>/export?mapping=gusto"
  ```

  `mapping` is a built-in key (`generic_csv`, `generic_json`, `gusto`, `adp_wfn`, `qbo_payroll`,
  `paychex_flex`) or `custom:<mapping id>`. Amounts in JSON are integer cents.
- **Webhooks**: `payroll_run.finalized` and `payroll_run.voided`, POSTed as JSON with
  `X-Payroll-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Reject
  signatures older than 5 minutes. Failed deliveries retry after 1 m, 5 m, 30 m, 2 h and 12 h, then stop.
  Retries are sent when a run is finalized or voided, when an admin clicks **Send due deliveries now**,
  and every minute if you add a scheduler (SUPERAGENT plan):
  `volcano cloud functions schedulers create webhook-dispatch --cron "* * * * *"`.

## Cloud deploy (project `1dc794d1-99e0-4c56-af27-e10b6842f924`)

Deploy only when you mean to: this touches real data.

```sh
volcano login
volcano use 1dc794d1-99e0-4c56-af27-e10b6842f924
volcano cloud databases create payroll            # first time only
npm run db:generate
volcano cloud databases migration up --all -d payroll
npm run build:functions
volcano cloud variables deploy --file <cloud env file>
volcano cloud functions deploy --all
volcano cloud config deploy
volcano cloud frontends deploy --name payroll --path . --variable-scope scoped \
  --variable NEXT_PUBLIC_VOLCANO_API_URL --variable NEXT_PUBLIC_VOLCANO_ANON_KEY \
  --variable NEXT_PUBLIC_VOLCANO_DATABASE --variable VOLCANO_SERVICE_KEY
```

Cloud variables:

| Variable | Value |
|---|---|
| `VOLCANO_API_URL`, `NEXT_PUBLIC_VOLCANO_API_URL` | `https://api.volcano.dev` |
| `VOLCANO_ANON_KEY`, `NEXT_PUBLIC_VOLCANO_ANON_KEY` | `volcano projects keys anon list` |
| `VOLCANO_SERVICE_KEY` | `volcano projects keys service list` (secret; server-only) |
| `VOLCANO_DATABASE`, `NEXT_PUBLIC_VOLCANO_DATABASE` | `payroll` |

Never set `PAYROLL_ALLOW_UNCONFIRMED_EMAIL` in the cloud. Turn on email confirmation for the project
(`require_email_confirmation` plus SMTP settings) so a person can't sign up with a colleague's invited
email before confirming it. Then create the first admin with
`VOLCANO_API_URL=https://api.volcano.dev VOLCANO_SERVICE_KEY=... VOLCANO_DATABASE=payroll npx tsx scripts/bootstrap-admin.ts you@company.com Your Name`.
````

- [ ] **Step 2: Fresh full check**

Run:
```sh
npm test && npm run test:tz && npm run typecheck && npm run build
npm run db:migrate && npm run build:functions && volcano variables deploy && volcano functions deploy --all && volcano config deploy
npm run test:integration
```
Expected: everything passes (74 unit, 46 integration). `git status` shows no changes to `volcano/functions/*.js` (the committed bundles are current).

- [ ] **Step 3: Seed a realistic month and walk through every role in a browser**

The integration tests wiped the database, so start clean:

1. `npm run bootstrap-admin -- admin@example.com Ada Admin`, then `npm run dev`.
2. In the browser (use the `agent-browser` or Playwright tooling; take a screenshot at each numbered point): create an account for `admin@example.com` (15+ character password) → lands on `/admin`.
3. **Settings**: set daily OT 8, double time 12. Save.
4. **Employees → Import CSV**: upload a file with a manager (`mia@example.com`, salary 90000), an hourly employee reporting to Mia (`hal@example.com`, 30.00), a daily employee (`dee@example.com`, 250.00) and one bad row (bad email). Expect the preview to flag the bad row, and the import to report 3 created.
5. **Pay periods**: open the current month.
6. Sign out. Create accounts for `hal@` and `dee@`. As Hal: start the timesheet, enter 9 h on 5 weekdays plus 13 h on one day, wait for "All changes saved", submit. As Dee: mark 4 full days and 1 half day plus 1 PTO day, submit. Try typing `25` hours: expect the cell to flag "At most 24 hours in a day".
7. As Mia (create her account): **Approvals** shows Hal only. Return Hal's timesheet with a note. As Hal, see the note, fix it, resubmit. As Mia, approve.
8. As admin: **Approvals** → approve Dee. **Pay periods** → Lock. **Payroll runs** → Generate. Expect blocking warnings for Mia and the admin (no timesheets). Tick "leave out" for both, regenerate, and check Hal's REG/OT/DT and Dee's REG/PTO against hand calculations. Finalize.
9. **Export** with Gusto and generic JSON. Open the downloaded files and check the totals match the run. **Integrations → API keys**: create a key and run `curl -H "Authorization: Bearer <key>" http://localhost:3000/api/v1/runs`. Expect the finalized run.
10. **Integrations → Webhooks**: add `https://example.com/hook`, then **Send test**. Expect a delivery row with a result (example.com returns an error status, so it shows as pending with a retry time).
11. As Hal: **History** shows gross pay for the month. As Dee: **Profile** shows the day rate and nobody else's data.
12. Resize to 375 px wide and check that `/portal` still works (the grid scrolls horizontally inside its container).

Record anything that fails, fix it (with a regression test where the logic lives in `src/lib` or SQL), and re-run Step 2.

- [ ] **Step 4: Commit**

```sh
git add README.md
git commit -m "docs: add README with local setup, integration guide and cloud runbook"
```

- [ ] **Step 5: Stop for approval before any cloud deploy**

Report results to the user. Deploying to project `1dc794d1-99e0-4c56-af27-e10b6842f924` (README → Cloud deploy) changes real data and needs the user's explicit go-ahead, plus decisions on email confirmation/SMTP and the frontend domain.
