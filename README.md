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

`tests/integration/functions.test.ts`, `agent.test.ts` and `agent-tools.test.ts` also need the functions deployed locally (see above).

## Chat assistant

Every page has a **Chat** button. Employees log time ("log 8 hours for today") and submit
at month end; managers ask "what needs my approval?" and approve or return timesheets;
admins run the monthly cycle and manage people, pay, settings, API keys and webhooks.

How a message is handled (`src/agent/`):

1. A **decision model** (a "decider", e.g. Strands Decider 2B or Jev) answers typed
   questions about the message: which tool, which timesheet / employee / month.
   Dates, hours, earning codes and export formats are read by plain parsers.
2. When it is confident (`AGENT_DECIDER_THRESHOLD`, default 0.9) and every argument is
   filled, the tool runs **without an LLM call**. If only the day or the timesheet is
   missing, the assistant asks with buttons.
3. Otherwise a **generative LLM** with tool calling handles the turn, using the same tools.

The agent always acts **as the signed-in user** (their token, so RLS and the Functions'
checks apply) and never uses the service key. Logging your own hours on an empty day
happens at once with Undo; anything that would replace hours, and every other change,
shows a confirmation card first. Conversations are private to each user and kept 30 days.

Server-only variables (in `web/.env.local` locally, frontend variables in the cloud):

| Variable | Meaning |
|---|---|
| `DECIDER_URL`, `DECIDER_TOKEN`, `DECIDER_MODEL` | A Strands Decider-compatible `POST /v1/systemone` endpoint (token and model optional) |
| `LLM_URL`, `LLM_MODEL`, `LLM_TOKEN` | An OpenAI-compatible chat-completions endpoint with tool calling (`{LLM_URL}/chat/completions`) |
| `AGENT_DECIDER_THRESHOLD` | Minimum decider confidence for acting without the LLM (default 0.9) |

Without a decider every message goes to the LLM; without an LLM only requests the decider
handles work. Locally you can run either:

```sh
npm run dev:decider                         # keyword stand-in on :8100 (DEVELOPMENT ONLY)
# or the real model (downloads ~4.5 GB the first time; Apple silicon: --device mps)
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 --port 8000
```

Then set `DECIDER_URL=http://127.0.0.1:8100` (or `:8000`) in `web/.env.local` and restart `npm run dev`.

**Choosing the threshold.** `tests/agent/decider-cases.jsonl` holds 150 labelled messages
(50 per role). `npm run eval:decider -- --url <decider>` reports accuracy, how many turns
skip the LLM, and wrong answers per threshold, and exits non-zero if any write is wrong at
the chosen threshold. Use the lowest threshold with no wrong writes, and re-run it whenever
the model or the questions change. The keyword stand-in fails this on purpose.

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

The cloud project belongs to a different Volcano account than other local projects, so cloud
commands go through `npm run cloud -- <volcano args>` (`scripts/volcano-cloud.sh`). It runs the
Volcano CLI with `HOME` pointed at the gitignored `.volcano-cloud/` directory, so this repo keeps
its own login and active project and the global `volcano login` stays as it is. Keep using plain
`volcano` for the local stack.

```sh
npm run cloud -- login                            # browser login to the payroll account
npm run cloud -- use 1dc794d1-99e0-4c56-af27-e10b6842f924
npm run cloud -- cloud databases create payroll --region us-east-1 --pg-version 16   # first time only
npm run db:generate
npm run cloud -- cloud databases migration up --all -d payroll
npm run build:functions
cp volcano/cloud.env.example volcano/cloud.env    # then fill in the keys (gitignored)
npm run cloud -- cloud variables deploy --file volcano/cloud.env
npm run cloud -- cloud functions deploy --all
npm run cloud -- cloud config deploy
# Deploy the frontend from a clean export of committed files, so nothing gitignored
# (the .volcano-cloud login, volcano/cloud.env) can be uploaded. web/ is an npm workspace.
rm -rf /tmp/payroll-src && mkdir /tmp/payroll-src && git archive HEAD | tar -x -C /tmp/payroll-src
npm run cloud -- cloud frontends deploy --name payroll --path /tmp/payroll-src --app-root web \
  --variable-scope scoped --variable NEXT_PUBLIC_VOLCANO_API_URL --variable NEXT_PUBLIC_VOLCANO_ANON_KEY \
  --variable NEXT_PUBLIC_VOLCANO_DATABASE --variable VOLCANO_API_URL --variable VOLCANO_DATABASE --variable VOLCANO_SERVICE_KEY \
  --variable DECIDER_URL --variable DECIDER_TOKEN --variable LLM_URL --variable LLM_MODEL --variable LLM_TOKEN --variable AGENT_DECIDER_THRESHOLD
```

Cloud variables:

| Variable | Value |
|---|---|
| `VOLCANO_API_URL`, `NEXT_PUBLIC_VOLCANO_API_URL` | `https://api.volcano.dev` |
| `VOLCANO_ANON_KEY`, `NEXT_PUBLIC_VOLCANO_ANON_KEY` | `npm run cloud -- projects keys anon list` |
| `VOLCANO_SERVICE_KEY` | `npm run cloud -- projects keys service list` (secret; server-only) |
| `VOLCANO_DATABASE`, `NEXT_PUBLIC_VOLCANO_DATABASE` | `payroll` |

The `/api/v1` route reads `VOLCANO_API_URL`, `VOLCANO_DATABASE` and `VOLCANO_SERVICE_KEY` at runtime; `NEXT_PUBLIC_*` values only exist at build time, so the frontend needs both sets.

Never set `PAYROLL_ALLOW_UNCONFIRMED_EMAIL` in the cloud. Turn on email confirmation for the project
(`require_email_confirmation` plus SMTP settings) so a person can't sign up with a colleague's invited
email before confirming it. Then create the first admin with
`npx tsx --env-file=volcano/cloud.env scripts/bootstrap-admin.ts you@company.com Your Name` (reads the keys from `volcano/cloud.env`).
