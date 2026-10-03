// Decides how a message is handled: by a tool directly (decider + parsers fill every
// argument), by asking one short question, or by the LLM. Pure: no I/O.
import { addDays } from '../lib/dates';
import { missingArgs, validateArgs } from './args';
import { picked, probability, type DeciderAnswer, type DeciderQuestion } from './decider';
import { isAdditive, parseAmount, parseCode, parseDay, parseFormat, parseMonth } from './parse';
import { dayLabel, monthLabel } from './tools/common';
import type { AgentContext, AgentTool, Card, Slot } from './types';

export const DEFAULT_THRESHOLD = 0.9;
const NONE = 'none';
const ALL = 'all';
const MAX_ASK_CHOICES = 6;

export type Answers = Record<string, DeciderAnswer>;

export type Route =
  | { kind: 'tool'; tool: AgentTool; args: Record<string, unknown>; confidence: number }
  | { kind: 'confirm' | 'cancel' | 'help'; confidence: number }
  | { kind: 'ask'; text: string; card: Card; confidence: number }
  | { kind: 'llm'; reason: string; confidence: number | null };

/** The typed questions for one message. Only questions the role can use are asked. */
export function deciderQuestions(c: AgentContext, tools: AgentTool[], hasPending: boolean): Record<string, DeciderQuestion> {
  const intents: Record<string, string> = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  if (hasPending) {
    intents.confirm = 'yes, go ahead with the action waiting for confirmation';
    intents.cancel = 'no, cancel the action waiting for confirmation';
  }
  intents.help = 'asks what the assistant can do';
  intents.other = 'anything else: chit-chat, a question that needs explaining, or a request none of the others fits';

  const q: Record<string, DeciderQuestion> = {
    intent: { type: 'choice', instructions: 'What does the message ask the payroll assistant to do?', criteria: intents },
    adds_to_existing: { type: 'noul', instructions: 'Does the message add time on top of what is already logged for that day, rather than setting the day\'s total?' },
    is_question: { type: 'noul', instructions: 'Is the message asking why or how something is so (needs an explanation), rather than asking to do or show something?' },
  };
  if (c.pending.length) {
    q.target_timesheet = {
      type: 'choice',
      instructions: 'Which timesheet waiting for approval does the message mean?',
      criteria: {
        ...Object.fromEntries(c.pending.map((p) => [p.id, `${p.name} (${monthOf(c, p.period_id)}, ${p.status})`])),
        [ALL]: 'every timesheet waiting for approval',
        [NONE]: 'no particular timesheet',
      },
    };
  }
  if (c.people.length && c.people.length <= 250) {
    q.target_employee = {
      type: 'choice',
      instructions: 'Which employee does the message mean?',
      criteria: { ...Object.fromEntries(c.people.map((p) => [p.id, `${p.name} <${p.email}>`])), [NONE]: 'no particular employee' },
    };
  }
  if (c.periods.length >= 2) {
    q.target_period = {
      type: 'choice',
      instructions: 'Which pay period (month) does the message mean?',
      criteria: { ...Object.fromEntries(c.periods.map((p) => [p.id, `${monthLabel(p.start_date)} (${p.status})`])), [NONE]: 'no particular month, or the current one' },
    };
  }
  return q;
}

/** The decider's state: who and when, then the message itself. */
export const deciderState = (contextText: string, text: string): string => `${contextText}\nMessage: "${text}"`;

const monthOf = (c: AgentContext, periodId: string) => {
  const p = c.periods.find((x) => x.id === periodId);
  return p ? monthLabel(p.start_date) : 'unknown month';
};

/** Fills a tool's arguments from the decider's answers and the parsers. */
export function fillArgs(tool: AgentTool, text: string, c: AgentContext, answers: Answers, threshold: number): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const periodId = (): string | undefined => {
    const p = picked(answers, 'target_period', threshold);
    if (p && p.value !== NONE) return p.value;
    const month = parseMonth(text, c.today);
    return month ? c.periods.find((x) => x.start_date.startsWith(month))?.id : undefined;
  };
  const fill: Record<Slot, (name: string) => void> = {
    day: (n) => { args[n] = parseDay(text, c.today) ?? undefined; },
    code: (n) => { args[n] = parseCode(text); },
    amount: (n) => {
      const a = parseAmount(text);
      if (n === 'hours' && a?.hours != null) args.hours = a.hours;
      if (n === 'days' && a?.days != null) args.days = a.days;
    },
    mode: (n) => { args[n] = isAdditive(text) || (probability(answers, 'adds_to_existing') ?? 0) >= threshold ? 'add' : 'set'; },
    period: (n) => { args[n] = periodId(); },
    month: (n) => { args[n] = parseMonth(text, c.today) ?? undefined; },
    timesheet: (n) => {
      const p = picked(answers, 'target_timesheet', threshold);
      args[n] = p && p.value !== NONE && p.value !== ALL ? p.value : undefined;
    },
    timesheets: (n) => {
      const p = picked(answers, 'target_timesheet', threshold);
      if (!p || p.value === NONE) return;
      args[n] = p.value === ALL ? c.pending.filter((x) => x.status === 'submitted').map((x) => x.id) : [p.value];
      if ((args[n] as string[]).length === 0) args[n] = undefined;
    },
    employee: (n) => {
      const p = picked(answers, 'target_employee', threshold);
      args[n] = p && p.value !== NONE ? p.value : undefined;
    },
    run: (n) => {
      const pid = periodId() ?? c.current?.id;
      args[n] = c.runs.find((r) => r.period_id === pid && r.status !== 'voided')?.id;
    },
    format: (n) => { args[n] = parseFormat(text) ?? undefined; },
  };
  for (const [name, def] of Object.entries(tool.args)) if (def.slot) fill[def.slot](name);
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

export function route(input: {
  text: string;
  context: AgentContext;
  tools: AgentTool[];
  answers: Answers | null;
  threshold: number;
  hasPending: boolean;
}): Route {
  const { text, context: c, tools, answers, threshold: T, hasPending } = input;
  if (!answers) return { kind: 'llm', reason: 'no decider', confidence: null };
  const intent = picked(answers, 'intent', T);
  const raw = answers.intent?.type === 'choice' ? answers.intent.confidence : null;
  if (!intent) return { kind: 'llm', reason: 'unsure of intent', confidence: raw };
  const conf = intent.confidence;

  if (intent.value === 'confirm' || intent.value === 'cancel') {
    return hasPending ? { kind: intent.value, confidence: conf } : { kind: 'llm', reason: 'nothing to confirm', confidence: conf };
  }
  if (intent.value === 'help') return { kind: 'help', confidence: conf };
  const tool = tools.find((t) => t.name === intent.value);
  if (!tool) return { kind: 'llm', reason: intent.value === 'other' ? 'other' : 'unknown intent', confidence: conf };
  if (tool.kind === 'write' && (probability(answers, 'is_question') ?? 0) >= 0.5) return { kind: 'llm', reason: 'question', confidence: conf };

  const filled = fillArgs(tool, text, c, answers, T);
  const missing = missingArgs(tool.args, filled);
  // An amount is required for log_time even though neither hours nor days is required alone.
  if (tool.name === 'log_time' && filled.hours == null && filled.days == null) return { kind: 'llm', reason: 'no amount', confidence: conf };
  if (missing.length === 0) {
    const v = validateArgs(tool.args, filled);
    return v.ok ? { kind: 'tool', tool, args: v.args, confidence: conf } : { kind: 'llm', reason: v.error, confidence: conf };
  }
  if (missing.length === 1) {
    const ask = askFor(missing[0], tool, filled, c);
    if (ask) return { ...ask, confidence: conf };
  }
  return { kind: 'llm', reason: `missing ${missing.join(', ')}`, confidence: conf };
}

/** One short question with ready-to-run answers, when the missing value has few options. */
function askFor(name: string, tool: AgentTool, filled: Record<string, unknown>, c: AgentContext): { kind: 'ask'; text: string; card: Card } | null {
  const slot = tool.args[name]?.slot;
  const option = (label: string, value: unknown) => ({ label, request: { tool: tool.name, args: { ...filled, [name]: value } } });
  if (slot === 'day') {
    const options = [option(`Today (${dayLabel(c.today)})`, c.today), option(`Yesterday (${dayLabel(addDays(c.today, -1))})`, addDays(c.today, -1))];
    return { kind: 'ask', text: 'Which day?', card: { kind: 'choices', prompt: 'Which day?', options } };
  }
  if ((slot === 'timesheet' || slot === 'timesheets') && c.pending.length > 0 && c.pending.length <= MAX_ASK_CHOICES) {
    const options = c.pending.map((p) => option(`${p.name} (${monthOf(c, p.period_id)})`, slot === 'timesheets' ? [p.id] : p.id));
    return { kind: 'ask', text: 'Which timesheet?', card: { kind: 'choices', prompt: 'Which timesheet?', options } };
  }
  return null;
}
