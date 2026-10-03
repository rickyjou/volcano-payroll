# Payroll Chat Agent — Design

**Date:** 2026-10-03
**Builds on:** `2026-10-02-payroll-time-tracking-design.md` (the payroll app)
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Intent

Let every user run the payroll app by chatting. An employee says "log 8 hours for
today" each day they work and "submit my timesheet" at the end of the month; a
manager asks "what needs my approval?" and approves or returns timesheets in the
chat; an admin locks periods, generates, finalizes and exports runs, and manages
people and settings the same way. The chat sits beside the existing screens; it
does not replace them.

Most turns are routine. They are handled by a small **decision model** (a
"decider", e.g. Strands Decider 2B or Jev) that picks the intent and its targets
from typed options, plus deterministic code. A generative **LLM** is called only
when the decider is unsure or the request is open-ended. This keeps routine turns
fast, cheap and predictable.

### Success criteria
- An employee can log a day's hours, correct them, and submit the month entirely
  in chat; existing hours are never overwritten without an explicit choice.
- A manager can list pending timesheets, approve one or several, and return one
  with a note in chat.
- An admin can run the monthly cycle (open, lock, generate, finalize, export) and
  manage employees, pay, settings, API keys and webhooks in chat.
- The agent can never do anything the signed-in user could not do in the UI.
- Routine requests ("log 8 hours today", "what needs my approval?") complete
  with one decider call and no LLM call.
- Every write except logging one's own hours on an empty day (or explicitly
  adding to it) requires an explicit confirmation.

### Decisions (from brainstorming)
| Topic | Decision |
|---|---|
| Approach | Decider-first hybrid: decider + deterministic tools; LLM tool-calling fallback |
| Scope | All four areas: employee time, manager approvals, admin payroll ops, admin people & settings |
| Time entry | One total per day per earning code ("log 8 hours today"); no work sessions, no clock in/out |
| Overwrites | Read existing hours first; never overwrite silently (Replace / Add / Cancel card) |
| Confirmations | Tiered: logging own hours instant with Undo (unless it would replace hours); every other write needs a confirmation |
| UI | Docked side panel on every page (full-screen sheet on phones) |
| History | Saved per user, owner-only (RLS), deleted after 30 days |
| Model access | Behind adapters; endpoints assumed reachable (see §9) |

### Out of scope
Voice; clock in/out or stored work sessions; CSV import and the export-mapping
editor in chat (the agent links to those pages); proactive messages (reminders);
languages other than English; admins reading other users' conversations.

## 2. Architecture

```
Browser                            Next.js server (Volcano frontend)              External
┌────────────────────┐   POST /api/agent    ┌──────────────────────────────┐
│ ChatPanel (docked) │ ───────────────────▶ │ route.ts                     │
│  messages, cards,  │  {text | action,     │  1. verify user (access token)│
│  Confirm / Undo    │   page context}      │  2. Agent.turn()              │──▶ Decider  (POST /v1/systemone)
│  page refresh hook │ ◀─────────────────── │  3. tools run AS THE USER     │──▶ LLM      (tool calling)
└────────────────────┘  {messages, changed} │     → RLS + existing functions│
                                            └──────────────┬───────────────┘
                                                           ▼
                                             Volcano Postgres (RLS) + Functions
                                             + chat_messages, agent_actions
```

- The agent loop runs in a **Next.js route handler** (`web/app/api/agent/route.ts`),
  not a Volcano Function: Functions on HOBBY time out at 30 s and an LLM-fallback
  turn can take longer. (Frontend request limits are not documented; verify early —
  see §10.)
- The route takes the caller's Volcano access token (`Authorization: Bearer`),
  resolves the user with `requireEmployee`, and builds `userClient(token)`. **The
  agent never uses the service key.** Database tools therefore run under RLS;
  privileged tools invoke the existing Functions (`payroll-run`, `payroll-export`,
  `api-key-create`, `webhook-dispatch`) with the same token, so their admin checks
  apply. The database guards and state machines remain the final authority.

### Units
| Unit | Location | Purpose |
|---|---|---|
| Queries | `src/agent/queries.ts` | RLS reads/writes used by tools (timesheets, entries, approvals, periods, runs, employees) |
| Types | `src/agent/types.ts` | `AgentTool`, `ToolResult`, `Card`, `Reply`, `TurnInput`, `TurnOutput`, `DeciderQuestion`, `LlmMessage` |
| Tool registry | `src/agent/tools/{time,approvals,payroll,people,settings}.ts`, `index.ts` | Tool definitions (§3); `toolsFor(role)` |
| Parsers | `src/agent/parse.ts` | Amounts (hours / days) and relative dates (§4.2) |
| Context | `src/agent/context.ts` | Builds the per-turn state and candidate lists from the database as the user |
| Router | `src/agent/router.ts` | Builds decider questions, applies thresholds, returns a route: deterministic / llm / ask (pure) |
| Agent | `src/agent/agent.ts` | Orchestrates one turn; actions (confirm / cancel / undo); persistence |
| Decider adapter | `src/agent/decider.ts` | `Decider.decide(state, questions)`; HTTP client for the Strands-style API; fake for tests |
| LLM adapter | `src/agent/llm.ts` | `Llm.complete({system, messages, tools})`; HTTP client; fake for tests |
| Route | `web/app/api/agent/route.ts` | Auth, request validation, calls `Agent.turn`, JSON response |
| Panel | `web/components/ChatPanel.tsx`, `web/components/chat/*` | Docked chat, cards, page-refresh event |

All `src/agent` logic is plain TypeScript shared like `src/lib`; adapters are
injected so the agent is testable without network access.

## 3. Tools

```ts
interface AgentTool<A> {
  name: string;
  roles: Role[];                        // tools are filtered by role before routing
  description: string;                  // used in decider option text and the LLM tool list
  args: ArgSchema<A>;                   // typed validation, applied on every path
  tier: 'read' | 'instant' | 'confirm';
  run(ctx: UserCtx, args: A): Promise<ToolResult>;
  undo?(ctx: UserCtx, result: ToolResult): Promise<void>;     // instant tools only
  render(result: ToolResult): Reply;    // text + optional card; no LLM needed
}
```

Role filtering is a convenience; RLS and Function checks are the security
boundary. Managers also get every employee tool; admins get everything.

### Employee (everyone)
| Tool | Tier | Behaviour |
|---|---|---|
| `show_timesheet(period?)` | read | Totals by code, days logged, status, return note |
| `log_time(day, code, amount, mode)` | instant / confirm | §4.3 read-first rule; creates the timesheet if missing |
| `clear_time(day, code?)` | confirm | Shows what will be removed, then removes it; Undo after |
| `submit_timesheet(period)` | confirm | Card shows totals by code and **weekdays with nothing logged** |
| `recall_timesheet(period)` | confirm | `submitted → draft` |
| `show_my_pay(period?)` | read | Gross lines from finalized runs |
| `show_profile()` | read | Pay type, rate, manager |

### Manager (direct reports; admins see everyone)
| Tool | Tier | Behaviour |
|---|---|---|
| `list_pending_approvals(period?)` | read | Card with Approve / Return per timesheet |
| `show_employee_timesheet(timesheet)` | read | Days and totals |
| `team_status(period)` | read | Submitted / in progress / not started |
| `approve_timesheets(timesheets[])` | confirm | One or many |
| `return_timesheet(timesheet, note)` | confirm | Note required; the agent asks for it when missing |

### Admin — payroll operations (all `confirm` except reads)
`list_periods` (read), `open_period(month)`, `lock_period(period)`,
`reopen_period(period)`, `generate_run(period, leave_out?)`, `explain_run(run)`
(read: totals, warnings, lines), `finalize_run(run)`, `void_run(run, reason)`,
`discard_draft(run)`, `export_run(run, format)` (download card plus export
warnings), `approve_for_leaver(timesheet)`.

### Admin — people and settings (all `confirm` except reads)
`find_employee(query)` (read), `add_employee(fields)`, `update_employee(employee, fields)`,
`terminate_employee(employee, date)`, `set_pay(employee, pay_type, rate, effective_from)`,
`show_settings` (read), `update_settings(fields)`, `create_api_key(name)`,
`revoke_api_key(key)`, `add_webhook(url, events)`, `send_test_webhook(endpoint)`.

### Not in chat
CSV bulk import and the export-mapping editor need a file upload or visual
editor; the agent answers with a link to the page.

### Implementation rules
- Tools reuse existing logic: the same RLS queries the pages use, written as
  server-side helpers in `src/agent/queries.ts` on `userClient(token)`, and the
  deployed Functions for runs, exports, keys and webhooks. No new business rules.
- A new API key appears once in its card and is **never written to
  `chat_messages`** (the stored card holds only name and prefix).
- Tool writes go through the existing tables, so the audit log records them;
  `agent_actions` links each write to the chat turn.

## 4. A turn

```
message ──▶ 1 Context ──▶ 2 Decider ──▶ 3 Gate ──┬─ deterministic ─▶ 4 Tool ─▶ 5 Reply
                                                   ├─ ask (one short question)
                                                   └─ LLM fallback ─▶ tool calls (same tools) ─▶ 5 Reply
```

### 4.1 Context (server-built, never trusted from the browser)
Role, name, today (UTC date), the open pay period, and **candidate lists** the
user may act on: this period's dates; their own timesheet status; pending
timesheets with employee names (managers); periods and runs (admins); the page
they are on; the last 6 turns; any pending confirmation.

### 4.2 Decider questions (one call per message)
| Question | Type | Options |
|---|---|---|
| `intent` | choice | The role's tool names + `confirm`, `cancel`, `help`, `other` |
| `target_day` | choice | The period's dates + `today`, `yesterday`, `none` |
| `code` | choice | `REG`, `PTO`, `SICK`, `HOL` |
| `target_timesheet` | choice | Candidate timesheets (by employee name) + `none` |
| `target_employee` | choice | Candidate employees + `none` |
| `target_period` | choice | Candidate periods + `none` |
| `adds_to_existing` | noul | "more", "another", "extra" |
| `is_question` | noul | Asking rather than instructing |

Only questions relevant to the role are sent. Option text includes a short
description (e.g. `log_time: record hours or days worked on a date`).
Numbers and free text are **not** decided: `parse.ts` reads amounts ("8",
"7.5h", "8:30", "half day", "full day") and relative dates ("last Friday", "the
12th"); notes and names for new records come from the text or the LLM.

### 4.3 `log_time` read-first rule
The tool always reads that day's entries first.

| Situation | Result |
|---|---|
| No hours for that day and code | Logged at once — "Logged 8h REG for Fri Oct 3 — week total 32h. [Undo]" |
| Hours exist and the message sets a value | Nothing written; card: "Fri Oct 3 already has 4h REG. [Replace with 8h] [Add → 12h] [Cancel]" |
| `adds_to_existing` (or the user picked Add) | Added; reply shows old → new total; Undo restores the old value |
| Result would exceed 24 h in a day | Refused before any card, with the reason |
| Timesheet submitted/approved, or period not open | Refused with the way out ("recall it to edit? [Recall]") |

Daily-rate employees use days ("log a full day today", "half day yesterday").
The same read-first rule applies to `clear_time` and to edits by managers/admins.

### 4.4 Gate
Deterministic only when **all** hold: `intent` confidence ≥ `T` (initially 0.9,
tuned in §8); every required argument is filled by the decider (confidence ≥ `T`)
or the parser; `intent ∉ {other}`; `is_question < 0.5` or the intent is a read.
If exactly one required argument is missing, the agent **asks** one short
question with suggested choices (e.g. "Which day?" [Today] [Yesterday]).
Otherwise the turn goes to the LLM with the role's tools; the LLM's tool calls go
through the same validation, tiers and confirmations.

### 4.5 Actions, confirmation and Undo
- `read` and `instant` tools run immediately; `instant` tools store an Undo.
- `confirm` tools store the exact tool and validated arguments as an
  `agent_actions` row (`pending`, expires in 10 minutes) and return a card.
- The client confirms with `{action: {id, choice?}}`. A text "yes" / "go ahead"
  (decider intent `confirm`) confirms the single pending action; "no" cancels it.
- Confirm, Cancel and Undo look the action up by id **and** owner and act only
  from the right status, so a second click is a no-op and nobody can act on
  another user's action. Arguments are never taken from the client at confirm time.

### 4.6 Reply
Deterministic: the tool's template and card, no LLM. LLM path: the LLM's text
plus the tool's card. Every reply returns `changed: string[]` (e.g.
`['timesheets']`) so the open page reloads, and the turn is saved.

## 5. Model adapters

### Decider
```ts
interface Decider {
  decide(state: string, questions: Record<string, DeciderQuestion>): Promise<Record<string, DeciderAnswer>>;
}
```
HTTP client for the Strands-style API: `POST {DECIDER_URL}/v1/systemone` with
`{state, questions}` where each question is `{type: 'choice'|'noul'|'score',
instructions, criteria?}`; answers carry the choice / probability and
`confidence`. Timeout 2 s; on error or timeout the turn goes to the LLM.

### LLM
```ts
interface Llm {
  complete(req: { system: string; messages: LlmMessage[]; tools: LlmTool[] }): Promise<LlmResult>;
}
// LlmResult = { text?: string; toolCalls?: { id: string; name: string; args: unknown }[] }
```
The wire format is unknown until the Volcano team confirms their model endpoint.
v1 ships one HTTP client for an **OpenAI-compatible chat-completions API with
tool calling** (the most common shape), isolated in `llm.ts` so another format
is a single new class. Up to 4 tool rounds per turn; 20 s budget for the LLM part.

### Configuration (server-only frontend variables; never `NEXT_PUBLIC_`)
`DECIDER_URL`, `DECIDER_TOKEN` (optional), `AGENT_DECIDER_THRESHOLD` (default 0.9),
`LLM_URL`, `LLM_TOKEN` (optional), `LLM_MODEL`. Missing decider config → every
turn uses the LLM; missing LLM config → deterministic turns only, with a clear
message otherwise.

## 6. UI

- A **Chat** button in the app header opens a docked right panel (full-screen
  sheet under 640 px). It persists across pages and loads saved history.
- Message bubbles plus cards: timesheet summary; pending-approvals list (per-row
  Approve / Return); confirmation (action, values, Confirm / Cancel or Replace /
  Add / Cancel); run summary with warnings; export download; one-time API key.
- Card buttons send structured actions, never free text.
- On `changed`, the panel dispatches a `payroll:data-changed` window event; the
  portal, manage and admin pages listen and reload.
- Empty state shows role-specific suggestions ("Log 8 hours today", "What needs my
  approval?", "Generate October's run").
- Accessibility as elsewhere in the app: keyboard reachable, focus management on
  open/close, replies in an `aria-live` region, loading and error states.

## 7. Data

New migration source `db/migrations-src/08_agent.sql` (single statements,
idempotent, generated like the rest):

| Table | Columns |
|---|---|
| `chat_messages` | `id`, `user_id` (default `auth.uid()`), `role` (`user`/`assistant`), `content`, `cards` jsonb, `path` (`decider`/`llm`/`ask`/`action`, assistant only), `confidence` numeric, `latency_ms` int, `created_at` |
| `agent_actions` | `id`, `user_id`, `tool`, `args` jsonb, `status` (`pending`/`confirmed`/`cancelled`/`expired`/`undone`/`failed`), `undo` jsonb, `result` jsonb, `expires_at`, `created_at`, `updated_at` |

RLS: both tables owner-only (`user_id = auth.uid()`) for select/insert/update;
no deletes by users. Retention: messages older than 30 days are deleted when a
user loads the chat (no scheduler on HOBBY). Writes made by tools carry
`via: 'agent'` into `audit_log.details` where the write path already audits.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| Decider unreachable / > 2 s | Skip to the LLM path |
| LLM unreachable / not configured | Deterministic turns still work; otherwise "I can't handle that right now — try a simpler request, or use the [page]" |
| Tool refused by a guard (`PERIOD_NOT_OPEN`, `RUN_STALE`, …) | Existing friendly message plus a suggested next step where one exists |
| LLM proposes an unknown tool or invalid arguments | Rejected by validation; one retry with the error, then "please rephrase" |
| Turn approaching 25 s | Return what is done with "still working on that"; no half-done write (each tool call is one DB operation or Function call) |
| Pending action expired | "That confirmation expired — ask again" |

## 9. Assumptions

- A decider endpoint compatible with Strands Decider's `/v1/systemone` and an LLM
  endpoint with tool calling are reachable from the Next.js server. Hosting
  (Volcano-provided, self-hosted, or a local Mac during development) is decided
  separately; only the variables in §5 change.
- Frontend route handlers can run for at least ~25 s (to be verified, §10).

## 10. Testing

- **Unit (Vitest, fakes for decider and LLM):** parsers (amounts, relative dates
  across month/year ends, under `test:tz`); router gate (thresholds, boundary
  values, missing arguments → ask); `log_time` read-first decisions; argument
  validation; role filtering; templates and cards.
- **Integration (local Volcano, real users, scripted fake decider/LLM):**
  permissions (employee told "approve" by the fake decider is still refused;
  manager limited to reports; nobody confirms/undoes another user's action;
  double confirm is a no-op); overwrite protection (4 h + "log 8" leaves 4 h and
  returns the card; Replace → 8 h; Add → 12 h; Undo restores); one end-to-end path
  per role with DB checks after each step; failure modes (decider down → LLM; LLM
  down → deterministic still works; guard refusal → friendly message).
- **Decider evaluation:** `tests/agent/decider-cases.jsonl`, ~150 labelled
  messages per role; `npm run eval:decider` against a real decider reports
  accuracy, coverage (share of turns without the LLM) and errors at or above `T`
  per intent. **Rule: zero errors at or above `T` for any write intent**; raise
  `T` until it holds; re-run when the model or questions change. An LLM-path set
  (~40 messages) is run manually to check tool choice.
- **Early check:** a throwaway long-running route on the deployed frontend to
  confirm the request time limit before relying on it.
- **Browser walkthrough** per role through the chat panel, including live grid
  refresh and the mobile sheet.
- **In use:** `chat_messages.path`, `confidence` and `latency_ms` show the share
  of turns that avoided the LLM.
