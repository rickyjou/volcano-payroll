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

The local stack has a single Volcano project shared by every repo you run locally, so project
variables are shared too. Payroll's Functions therefore read the database name from
`PAYROLL_DATABASE`, not the generic `VOLCANO_DATABASE`, which another local app may set. Keep
`VOLCANO_DATABASE` out of `volcano/volcano.env`. In the cloud project, `VOLCANO_DATABASE` still
works.

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

The integration run ends by restoring your local admin with `npm run bootstrap-admin`, using
`LOCAL_ADMIN_EMAIL`, `LOCAL_ADMIN_FIRST_NAME` and `LOCAL_ADMIN_LAST_NAME` from `volcano/volcano.env`
(see `volcano/volcano.env.example`). Without them it prints a reminder instead.

`tests/integration/functions.test.ts`, `agent.test.ts` and `agent-tools.test.ts` also need the functions deployed locally (see above).

## Chat assistant

Every page has a **Chat** button. Employees log time ("log 8 hours for today") and submit
at month end; managers ask "what needs my approval?" and approve or return timesheets;
admins run the monthly cycle and manage people, pay, settings, API keys and webhooks.

How a message is handled (`src/agent/`):

1. A **decider** answers typed questions about the message: which tool, which timesheet /
   employee / month. By default this is the built-in keyword rules
   (`src/agent/rule-decider.ts`), which run in the route and need no model. A decision
   model such as Strands Decider 2B can replace them (`DECIDER_URL`). Dates, hours, earning
   codes, export formats, notes, URLs and key names are read by plain parsers.
2. When the decider is confident (`AGENT_DECIDER_THRESHOLD`, default 0.9) and every
   argument is filled, the tool runs **without an LLM call**. If only the day, the amount or
   the timesheet is missing, the assistant asks with buttons.
3. Otherwise a **generative LLM** with tool calling handles the turn, using the same tools.
   Without one, the assistant says what it needs ("…I also need: what the employee should
   fix") or lists requests it can handle.

The agent always acts **as the signed-in user** (their token, so RLS and the Functions'
checks apply) and never uses the service key. Logging your own hours on an empty day
happens at once with Undo; anything that would replace hours, and every other change,
shows a confirmation card first. Conversations are private to each user and kept 30 days.

Server-only variables (in `web/.env.local` locally, frontend variables in the cloud):

| Variable | Meaning |
|---|---|
| `DECIDER_URL`, `DECIDER_TOKEN`, `DECIDER_MODEL` | Optional. A Strands Decider-compatible `POST /v1/systemone` endpoint instead of the built-in rules (token and model optional) |
| `LLM_URL`, `LLM_MODEL`, `LLM_TOKEN` | An OpenAI-compatible chat-completions endpoint with tool calling (`{LLM_URL}/chat/completions`) |
| `AGENT_DECIDER_THRESHOLD` | Minimum decider confidence for acting without the LLM (default 0.9) |

For Amazon Bedrock, use its OpenAI-compatible endpoint with a Bedrock API key:
`LLM_URL=https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1`,
`LLM_MODEL=openai.gpt-oss-120b-1:0`, `LLM_TOKEN=<Bedrock API key>`. Prefer the 120b model:
in testing, `gpt-oss-20b` often got weekdays wrong ("Wednesday" as the week before). Bedrock
doesn't store prompts or use them for training. A short-term key expires within 12 hours, so
the cloud needs a long-term key.

**With no variables set, the chat works without any model**: the built-in rules handle the
routine requests (85% of the labelled messages, with no wrong answers), and everything else
gets a short reply saying what to include or what to try. Volcano has no hosted models. An
LLM means calling a provider directly with your own key, stored as a server-only variable,
and that provider's data-retention terms apply to the payroll data in each turn. A decision
model can't be self-hosted on Volcano either. To try one locally (downloads ~4.5 GB the first
time; Apple silicon: `--device mps`):

```sh
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 --port 8000
```

Then set `DECIDER_URL=http://127.0.0.1:8000` in `web/.env.local` and restart `npm run dev`.

A turn runs in the Next.js route, not a Function. Volcano caps a frontend request at 30 s on
HOBBY (180 s on SUPERAGENT) and ignores `maxDuration`, so the agent keeps a whole turn within
25 s.

**Choosing the threshold.** `tests/agent/decider-cases.jsonl` holds 150 labelled messages
(50 per role). `npm run eval:decider -- --url <decider>` (or `-- --rules` for the built-in
rules) reports accuracy, how many turns skip the LLM, and wrong answers per threshold. It
exits non-zero if any write is wrong at the chosen threshold. Use the lowest threshold with no
wrong writes. Re-run it whenever the model, the rules or the questions change. The rules were
tuned on this set, so `tests/unit/agent-rule-decider.test.ts` also checks phrasings outside
it, including ones that must never become writes.

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
  --variable NEXT_PUBLIC_VOLCANO_DATABASE --variable VOLCANO_API_URL --variable VOLCANO_ANON_KEY --variable VOLCANO_DATABASE --variable VOLCANO_SERVICE_KEY \
  --variable LLM_URL --variable LLM_MODEL --variable LLM_TOKEN
```

The deploy fails up front if a scoped `--variable` names a variable that isn't deployed, so
pass only the chat variables you've set: drop the `LLM_*` flags to run on the built-in rules
alone, and add `--variable DECIDER_URL` (plus `DECIDER_TOKEN`) or
`--variable AGENT_DECIDER_THRESHOLD` only when you use them.

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
