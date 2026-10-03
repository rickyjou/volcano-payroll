# Payroll & Time Tracking on Volcano — Design

**Date:** 2026-10-02
**Volcano project:** `1dc794d1-99e0-4c56-af27-e10b6842f924`
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Intent

A single-company system of record for employee time and gross pay. Employees
log time in a portal; managers approve; admins run a monthly payroll that
produces a frozen, provider-neutral snapshot and exports it to whichever
third-party payroll provider is chosen later (Gusto, ADP, QuickBooks Online
Payroll, Paychex, …). The provider — not this app — handles tax withholding,
deductions, net pay, filings, and payment.

### Success criteria
- Employees (salary, hourly, daily) can enter and submit a monthly timesheet.
- Managers approve/reject their direct reports' timesheets.
- Admins can produce a finalized monthly run with correct gross pay (incl.
  configurable overtime) and export it in a format importable by any major
  provider without code changes, or have a provider pull it via API/webhook.
- No employee can see another employee's time or pay unless they are that
  employee's manager (time only) or an admin.

### Decisions (from brainstorming)
| Topic | Decision |
|---|---|
| Calc scope | Gross pay only; taxes/net done by provider |
| Time entry | Daily-hours grid (hourly/salary); day marks full/half (daily) |
| Overtime | Configurable: weekly threshold + optional daily tiers |
| Time off | PTO / SICK / HOL recorded as earning codes; no accrual balances |
| Accounts | Admin-invited, 50–500 employees, CSV bulk import |
| Roles | employee, manager (approves direct reports), admin |
| Pay period | Calendar month |
| Integration | Canonical run snapshot + config-driven file exporters + read-only API + signed webhook |
| Tenancy | Single company |

### Out of scope (YAGNI)
Tax calculation, deductions/benefits, net pay, direct deposit, PTO accrual
balances, clock in/out, multi-company, non-monthly pay periods, direct
provider API connectors (added later on top of the canonical snapshot).

## 2. Architecture

```
web/ (Next.js on Volcano Hosting)
  /portal   employee        ─┐
  /manage   manager          ├─ Volcano SDK (Auth + DB under RLS)
  /admin    admin           ─┘        │
                                      ▼
volcano/ ── Postgres (RLS) ── Functions (privileged logic) ── Storage (exports bucket)
                                      ▲
External provider / connector ── integration-api (API key) ◄── webhook-dispatch (HMAC)
```

- **Frontend:** Next.js app under `web/`, deployed as a Volcano frontend.
  Reads/writes ordinary data directly via the SDK under RLS. Privileged
  operations go through Volcano Functions.
- **Functions (`volcano/functions/`)**, authored in TypeScript under
  `src/functions/` and bundled with esbuild (build model B):
  - `payroll-run` — actions `generate`, `finalize`, `void` (admin only).
  - `payroll-export` — render a run with a mapping, store in bucket, return signed URL.
  - `employee-import` — validate + upsert CSV rows (admin only).
  - `employee-link` — on sign-in, link `auth.uid()` to the employee row whose
    email matches the authenticated email (once).
  - `integration-api` — public function; API-key auth; read-only routes.
  - `webhook-dispatch` — scheduled; delivers pending webhook events with retries.
  - `api-key-create` — admin only; returns plaintext key once, stores SHA-256.
- **Shared pure modules** (`src/lib/`): `pay-calc`, `exporters`, `csv`,
  `signing`. No I/O; fully unit-tested.

## 3. Data model

All tables in database `app`, RLS enabled. Money stored as integer cents;
hours as `numeric(6,2)`; days as `numeric(3,1)`.

| Table | Key columns |
|---|---|
| `employees` | `id`, `user_id` (nullable, unique), `email` (unique, lowercased), `first_name`, `last_name`, `external_id` (provider employee id), `role` (`employee`/`manager`/`admin`), `manager_id` → employees, `status` (`active`/`terminated`), `hire_date`, `termination_date`, `work_state` |
| `compensation` | `id`, `employee_id`, `pay_type` (`salary`/`hourly`/`daily`), `rate_cents` (annual / per hour / per day), `effective_from`; unique (`employee_id`,`effective_from`) |
| `pay_periods` | `id`, `start_date`, `end_date` (calendar month), `status` (`open`/`locked`/`finalized`) |
| `timesheets` | `id`, `employee_id`, `pay_period_id`, `status` (`draft`/`submitted`/`approved`/`rejected`), `submitted_at`, `approved_by`, `approved_at`, `rejection_note`; unique (`employee_id`,`pay_period_id`) |
| `time_entries` | `id`, `timesheet_id`, `work_date`, `earning_code` (`REG`/`PTO`/`SICK`/`HOL`), `hours`, `days`, `note`; unique (`timesheet_id`,`work_date`,`earning_code`) |
| `settings` | singleton: `company_name`, `ot_weekly_threshold` (default 40), `ot_weekly_multiplier` (1.5), `ot_daily_threshold` (null), `ot_daily_multiplier` (1.5), `dt_daily_threshold` (null), `dt_multiplier` (2.0), `ot_applies_to_daily` (false), `week_starts_on` (0=Sunday) |
| `payroll_runs` | `id`, `pay_period_id`, `status` (`draft`/`finalized`/`voided`), `totals` jsonb, `skipped_employee_ids` uuid[], `generated_at`, `finalized_by`, `finalized_at`, `voided_at` |
| `payroll_run_lines` | `id`, `run_id`, `employee_id`, snapshot fields (`external_id`, `first_name`, `last_name`, `email`, `pay_type`, `work_state`), `earning_code` (`REG`/`OT`/`DT`/`PTO`/`SICK`/`HOL`/`SAL`), `hours`, `days`, `rate_cents`, `amount_cents` |
| `export_mappings` | `id`, `name`, `preset_key` (nullable), `format` (`csv`/`json`), `config` jsonb (columns, code map, date format, row mode) |
| `exports` | `id`, `run_id`, `mapping_id`, `storage_path`, `sha256`, `created_by`, `created_at` |
| `api_keys` | `id`, `name`, `prefix`, `key_hash`, `created_by`, `last_used_at`, `revoked_at` |
| `webhook_endpoints` | `id`, `url`, `secret`, `events` text[], `active` |
| `webhook_deliveries` | `id`, `endpoint_id`, `event`, `payload` jsonb, `status` (`pending`/`delivered`/`failed`), `attempts`, `next_attempt_at`, `last_response_code`, `last_error` |
| `audit_log` | `id`, `actor_employee_id`, `action`, `entity`, `entity_id`, `details` jsonb, `created_at` |

### Role helpers (SQL)
- `app_current_employee_id()` → employee id where `user_id = auth.uid()`.
- `app_is_admin()`, `app_is_manager_of(emp uuid)`.
Both `SECURITY DEFINER`, stable, used by policies.

### RLS summary
| Table | Employee | Manager | Admin |
|---|---|---|---|
| employees | read own | read direct reports | all |
| compensation | read own | — | all |
| timesheets / time_entries | read own; write own when timesheet `draft`/`rejected` and period `open` | read reports; update status of reports' `submitted` timesheets to `approved`/`rejected` | all |
| payroll_run_lines | read own lines of `finalized` runs | — | all |
| pay_periods, settings | read | read | all |
| payroll_runs, export_mappings, exports, api_keys, webhook_*, audit_log | — | — | all (writes to runs/exports/keys only via functions) |

Timesheet status transitions are enforced by a trigger:
`draft→submitted` (owner), `submitted→approved|rejected` (manager of owner or
admin), `rejected→draft/submitted` (owner), `approved→draft` (admin unlock).
Entry edits blocked unless status is `draft`/`rejected` and period `open`.

## 4. Pay calculation (`src/lib/pay-calc`)

Pure function: `calculateRun(period, employees, compensationHistory,
timesheets, settings) → { lines, warnings }`. All arithmetic in integer
cents; rounding = half-up to the cent per line.

- **Working days** = Mon–Fri in the period (holidays are not excluded
  automatically; HOL is an entry code).
- **Salary:** for each compensation segment active in the period, amount =
  `annual/12 × (segment working days ∩ employment days) / period working days`.
  Emitted as `SAL`. PTO/SICK/HOL hours emitted as informational lines with
  `amount_cents = 0`.
- **Hourly:** REG hours split into REG/OT/DT:
  1. Daily tiers (if configured) per day: >`dt_daily_threshold` → DT,
     >`ot_daily_threshold` → OT.
  2. Weekly: remaining REG hours beyond `ot_weekly_threshold` in a workweek → OT.
     For workweeks crossing the period start, prior-period approved REG hours
     of that week count toward the threshold (read from the prior period's
     timesheet).
  3. Amounts = hours × rate × multiplier. PTO/SICK/HOL paid at base rate,
     not counted toward OT.
- **Daily:** REG days × daily rate. PTO/SICK/HOL days at daily rate. OT only
  if `ot_applies_to_daily` (uses `hours` if entered).
- Rate changes mid-period: each day uses the compensation effective that day.
- **Warnings:** active employee with no approved timesheet; no compensation;
  hours > 24 in a day.

## 5. Payroll run lifecycle

1. Admin locks period (`open→locked`) — employees can no longer edit.
2. `payroll-run generate` — replaces any existing draft for the period;
   computes lines and totals; returns warnings.
3. Admin reviews; may mark employees as skipped.
4. `payroll-run finalize` — refuses if any warning of type
   "no approved timesheet" exists for a non-skipped employee; sets run
   `finalized`, period `finalized`, writes audit entry, enqueues
   `payroll_run.finalized` webhook deliveries.
5. `payroll-run void` — finalized → voided, period back to `locked`;
   audit + `payroll_run.voided` webhook. A new run can then be generated.

Only one non-voided run per period (partial unique index).

## 6. Integration

### Exporters (`src/lib/exporters`)
`render(runLines, run, mapping) → { filename, contentType, body }`.
Mapping config:
```json
{
  "row_mode": "per_line" | "per_employee",
  "date_format": "YYYY-MM-DD" | "MM/DD/YYYY",
  "code_map": { "REG": "Regular", "OT": "Overtime", ... },
  "columns": [ { "header": "Employee ID", "field": "external_id" },
               { "header": "Regular Hours", "field": "hours", "code": "REG" } ]
}
```
`per_employee` pivots codes into columns (via `code` on a column).
Available fields: `external_id, first_name, last_name, email, pay_type,
work_state, earning_code, hours, days, rate, amount, period_start,
period_end, run_id`.

Seeded mappings:
- `generic_csv` and `generic_json` (canonical, `schema_version: 1`).
- Presets `gusto`, `adp_wfn`, `qbo_payroll`, `paychex_flex` — per-employee
  hours/earnings import layouts based on each provider's published import
  template. Each preset is labelled "verify against your provider's current
  template" in the UI; admins can clone and edit any preset.
- CSV output: RFC 4180 quoting; formula-injection guard (prefix `'` to cells
  starting with `= + - @`).

Exports are stored in private bucket `payroll-exports` at
`runs/{run_id}/{mapping}-{timestamp}.{ext}`, SHA-256 recorded, downloaded via
short-lived signed URL.

### Integration API (`integration-api`, public function, API key)
- `Authorization: Bearer pk_<prefix>_<secret>`; lookup by prefix, constant-time
  compare of SHA-256; revoked keys rejected; `last_used_at` updated.
- Routes (by `event.route` in payload since functions are payload-invoked;
  web exposes REST paths via a Next.js route handler that forwards):
  - `GET /api/v1/runs?status=finalized`
  - `GET /api/v1/runs/{id}`
  - `GET /api/v1/runs/{id}/lines`
  - `GET /api/v1/runs/{id}/export?mapping={key}`
- Only `finalized` (and `voided`, flagged) runs exposed.

### Webhooks
- Events: `payroll_run.finalized`, `payroll_run.voided`.
- Payload: `{ id, event, created_at, data: { run_id, period_start, period_end, totals } }`.
- Header `X-Payroll-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`.
- `webhook-dispatch` runs every minute via scheduler; backoff
  1m, 5m, 30m, 2h, 12h; failed after 6 attempts; admin can retry or
  send test event.

## 7. UI

- `/login` — Volcano Auth email/password; after sign-in `employee-link`
  is called; users with no matching employee see "not invited".
- `/portal` — monthly grid timesheet, autosave, submit; history; profile.
- `/manage` — approvals queue, team status board (managers + admins).
- `/admin` — employees (search, paginate, invite, CSV import with preview,
  edit, terminate, compensation history), pay periods, payroll runs
  (generate/review/finalize/void/export), integrations (mappings editor,
  API keys, webhooks + delivery log), settings.
- Role-gated routing by `employees.role`; RLS is the real enforcement.

## 8. Error handling

- Functions return `200` on success, `400` bad input, `401` unauthenticated,
  `403` wrong role, `409` state conflict (e.g. finalize with unresolved
  warnings), `500` otherwise; body `{ error, details? }`.
- UI surfaces warnings before finalize; all mutations show loading/error states.
- Every privileged action writes `audit_log`.

## 9. Testing

- **Unit (vitest):** pay-calc (salary proration, mid-month hire/term, rate
  change mid-month, weekly OT, daily OT/DT tiers, cross-period workweek,
  half-days, PTO excluded from OT, cent rounding); exporters (golden files per
  preset, pivoting, CSV escaping, formula guard); signing (HMAC vectors);
  timesheet state machine.
- **Local integration:** `volcano start`, migrations deploy, functions deploy,
  `volcano functions invoke` smoke tests, SDK script with real test users
  verifying RLS isolation (employee A vs B, manager vs non-report, comp
  visibility) and a full monthly cycle end-to-end.
- **Browser:** click-through of employee, manager, admin flows.

## 10. Deployment

Build and verify fully on local Volcano. Cloud deploy to project
`1dc794d1-99e0-4c56-af27-e10b6842f924` only after explicit user approval.
