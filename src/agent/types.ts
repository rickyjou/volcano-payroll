// Shared types for the chat agent. Everything here is plain data or interfaces so the
// agent runs the same in the Next.js route, in tests and in the evaluation script.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import type { ISODate } from '../lib/dates';
import type { Role } from '../lib/employee-import';
import type { PayType } from '../lib/types';

export type { Role };

/** The signed-in user's employee record. */
export interface AgentUser {
  id: string;
  role: Role;
  first_name: string;
  last_name: string;
  email: string;
}

/** What every tool runs with: the user's own client, so RLS applies to every query. */
export interface ToolCtx {
  db: VolcanoAuth;
  me: AgentUser;
  today: ISODate;
  /** Calls a deployed Volcano Function as the user; throws HttpError on failure. */
  invoke<T>(name: string, payload: Record<string, unknown>): Promise<T>;
}

/** A request to run one tool with complete arguments (card buttons send these). */
export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface Choice {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
}

export interface RowAction {
  label: string;
  request: ToolRequest;
  /** The UI asks for a note and sends it as `args.note` (e.g. returning a timesheet). */
  needsNote?: boolean;
}

export type Card =
  | { kind: 'confirm'; actionId: string; title: string; lines: string[]; choices: Choice[] }
  | { kind: 'undo'; actionId: string; label: string }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][]; rowActions?: RowAction[][] }
  | { kind: 'choices'; prompt: string; options: { label: string; request: ToolRequest }[] }
  | { kind: 'download'; filename: string; contentType: string; body: string; warnings: string[] }
  | { kind: 'secret'; label: string; value: string }
  | { kind: 'link'; label: string; href: string };

export interface ToolResult {
  text: string;
  cards?: Card[];
  /** Data areas that changed, so open pages reload ('timesheets', 'runs', ...). */
  changed?: string[];
  /** Compact facts handed back to the LLM when it called the tool. */
  data?: unknown;
  /** Stored with the action so an Undo can reverse it. */
  undo?: unknown;
}

/** Asked before a write runs. `choices` defaults to Confirm / Cancel. */
export interface Confirmation {
  title: string;
  lines: string[];
  choices?: Choice[];
}

/** A tool declining to act, with a message for the user (not an error). */
export class Refusal extends Error {
  constructor(message: string, readonly cards: Card[] = []) {
    super(message);
  }
}

export type ArgType = 'string' | 'number' | 'date' | 'month' | 'uuid' | 'uuids' | 'boolean' | { enum: readonly string[] };

/** Where the deterministic path fills an argument from (see router.ts). */
export type Slot = 'day' | 'code' | 'amount' | 'mode' | 'period' | 'timesheet' | 'timesheets' | 'employee' | 'run' | 'month' | 'format';

export interface ArgDef {
  type: ArgType;
  description: string;
  required?: boolean;
  slot?: Slot;
}

export interface AgentTool {
  name: string;
  roles: Role[];
  /** One line: shown to the LLM and used as the decider's option description. */
  description: string;
  args: Record<string, ArgDef>;
  kind: 'read' | 'write';
  /** Writes: return a Confirmation to ask first, or null to run at once (with Undo). */
  confirm?(ctx: ToolCtx, args: Record<string, unknown>): Promise<Confirmation | null>;
  run(ctx: ToolCtx, args: Record<string, unknown>, choice?: string): Promise<ToolResult>;
  undo?(ctx: ToolCtx, undo: unknown): Promise<ToolResult>;
}

export interface PeriodRef { id: string; start_date: ISODate; end_date: ISODate; status: 'open' | 'locked' | 'finalized' }
export interface PendingRef { id: string; employee_id: string; name: string; period_id: string; status: string }
export interface PersonRef { id: string; name: string; email: string; status: string }
export interface RunRef { id: string; period_id: string; status: 'draft' | 'finalized' | 'voided' }

/** Everything the router knows about the user's world for one turn (built on the server). */
export interface AgentContext {
  me: AgentUser;
  today: ISODate;
  page?: string;
  payType: PayType | null;
  periods: PeriodRef[];
  /** The period containing today, else the latest open one, else the latest. */
  current: PeriodRef | null;
  /** Timesheets this user may approve now (managers and admins). */
  pending: PendingRef[];
  /** Employees this user may act on (admins). */
  people: PersonRef[];
  runs: RunRef[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: Card[];
  created_at: string;
}
