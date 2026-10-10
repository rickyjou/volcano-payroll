// A decider made of keyword rules, run in-process: the chat works without any model.
// It answers the same typed questions as a decision model, but it is tuned for
// precision over coverage. When no rule clearly fits it answers with low confidence, so
// the turn goes to the LLM if one is configured, or to a short "try one of these" reply.
// Every write it picks still shows a confirmation card (or Undo for one's own hours).
import { isAdditive, parseAmount } from './parse';
import { messageOf } from './router';
import type { Decider, DeciderAnswer, DeciderQuestion } from './decider';

const SURE = 0.95;
const UNSURE = 0.3;

/** People a message can name, from the target questions' option text. */
interface Targets {
  timesheets: string[];
  employees: string[];
  all: boolean;
}

interface Rule {
  intent: string;
  test(t: string, x: Targets): boolean;
}

const has = (re: RegExp) => (t: string) => re.test(t);
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

const YES = /^(yes|yep|yeah|yup|ok|okay|sure|confirm|confirmed|go ahead|do it|please do|sounds good)\b/;
const NO = /^(no|nope|cancel|stop|never ?mind|forget it|don'?t)\b/;
const MONTH = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|next month|this month|last month)\b/;
const DAYISH = /\b(today|yesterday|(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?|\d{1,2}(st|nd|rd|th)|time|hours?|entry|entries)\b/;
const TIME_WORD = /\b(\d+(\.\d+)?|hours?|hrs?|h|days?|time|pto|sick|holiday|vacation)\b/;

// Checked in order; the first that fits wins. Specific phrasings come before the
// general ones that would also match them ("create an api key" before "generate").
const RULES: Rule[] = [
  // Answers to a waiting confirmation: the whole message is a yes/no, or a short one with it.
  { intent: 'confirm', test: (t) => (YES.test(t) && words(t) <= 3) || (words(t) <= 4 && /\b(yes|confirm|go ahead)\b/.test(t) && !/\d|\b(no|not|don'?t)\b/.test(t)) },
  { intent: 'cancel', test: (t) => NO.test(t) && words(t) <= 4 },
  { intent: 'help', test: has(/^(help|what can you do|what can i (ask|say|do)|commands|how do i use this)\b/) },
  // Questions that need an explanation are not for the rules.
  { intent: 'other', test: has(/^(why|how come|how do(es)?|explain why|thanks?|thank you|hi|hello|hey|good (morning|afternoon|evening))\b/) },

  // Settings and integrations
  { intent: 'create_api_key', test: has(/\b(create|make|new|generate|add|issue)\b.*\bapi[ -]?key\b/) },
  { intent: 'revoke_api_key', test: has(/\b(revoke|delete|remove|disable)\b.*\bapi[ -]?key\b/) },
  { intent: 'send_test_webhook', test: has(/\btest\b.*\bwebhook|\bwebhook\b.*\btest\b/) },
  { intent: 'add_webhook', test: has(/\b(add|create|new|register|set ?up)\b.*\bwebhook\b/) },
  { intent: 'open_page', test: has(/\bimport\b.*\b(employees?|csv|people)\b|\b(edit|change|add)\b.*\bexport (format|mapping)s?\b/) },
  // Changing settings or an employee's details needs free-form values only an LLM can
  // fill, so those are not matched here; reading them is.
  { intent: 'show_settings', test: has(/\b(settings|api keys|webhooks)\b|\bovertime (rules?|threshold)\b/) },

  // People
  { intent: 'set_pay', test: has(/\b(raise|pay rate|pay cut)\b|\bset\b.*\$\s?\d/) },
  { intent: 'add_employee', test: has(/\b(add|invite|hire|onboard)\b.*\b(employee|staff|person|@)|\bnew (hire|employee)\b/) },
  { intent: 'terminate_employee', test: (t, x) => x.employees.length > 0 && /\b(terminate|fire|let go|offboard|last day)\b|\b(left|leaves|leaving)\b.*\b(on|today|yesterday)\b/.test(t) },
  { intent: 'find_employee', test: has(/^(find|look ?up|search( for)?|who is)\b/) },

  // Payroll runs and periods
  { intent: 'void_run', test: has(/\bvoid\b/) },
  { intent: 'discard_draft', test: has(/\b(discard|throw away|scrap)\b|\bdelete the draft\b/) },
  { intent: 'finalize_run', test: has(/\bfinali[sz]e\b/) },
  { intent: 'export_run', test: has(/\bexport\b/) },
  { intent: 'explain_run', test: has(/\b(explain|warnings?|details)\b.*\brun\b|\b(show|see)\b.*\brun\b/) },
  { intent: 'generate_run', test: has(/\b(generate|calculate|regenerate)\b|\brun (the )?payroll\b/) },
  { intent: 'reopen_period', test: has(/\b(reopen|re-open|unlock)\b/) },
  { intent: 'lock_period', test: has(/\block\b/) },
  { intent: 'list_periods', test: has(/\b(list|show|which|what)\b.*\bperiods\b/) },
  { intent: 'open_period', test: (t) => /^open\b/.test(t) && MONTH.test(t) },

  // Submitting one's own timesheet ("submit it for approval") before the approval rules.
  { intent: 'recall_timesheet', test: has(/\b(recall|unsubmit|withdraw)\b|\b(take|pull|get)\b.*\bback\b/) },
  { intent: 'submit_timesheet', test: has(/\bsubmit\b/) },

  // Approvals
  { intent: 'return_timesheet', test: has(/\b(return|reject|bounce)\b|\bsend\b.*\bback\b/) },
  { intent: 'approve_timesheets', test: has(/^(ok(ay)?,? |please |yes,? )?approve\b/) },
  { intent: 'list_pending_approvals', test: has(/\b(approv(e|al|als)|pending|waiting)\b/) },
  { intent: 'team_status', test: has(/\bteam\b|\bwho\b.*\b(submitted|started|logged)\b/) },
  { intent: 'show_employee_timesheet', test: (t, x) => x.timesheets.length === 1 && !/\b(my|i)\b/.test(t) && /\b(timesheet|time ?sheet|log(ged)?|hours|show|open|see)\b/.test(t) },

  // One's own time and pay
  { intent: 'clear_time', test: (t) => /\b(clear|remove|delete|erase|wipe)\b/.test(t) && DAYISH.test(t) },
  { intent: 'log_time', test: (t) => (/\b(log|add|record|put|worked|work|did|took|take|enter|book)\b/.test(t) && TIME_WORD.test(t)) || (parseAmount(t) != null && /\b(today|yesterday|on|for)\b/.test(t)) },
  { intent: 'show_profile', test: has(/\b(profile|my (hourly |daily )?rate|my salary|my manager|pay type)\b/) },
  { intent: 'show_my_pay', test: has(/\b(my pay|paid|paycheck|pay ?slip|earn(ed)?|gross)\b/) },
  { intent: 'show_timesheet', test: has(/\b(timesheet|time ?sheet|my hours|what did i log|logged)\b|\bhow many hours\b/) },
];

/**
 * Option ids whose person the message names, from "Name (...)" or "Name <email>" text: by
 * first name, full name or email. A surname alone doesn't count, since many are ordinary
 * words ("set daily overtime" is not about Dee Daily).
 */
function named(t: string, criteria: Record<string, string | null>, cut: RegExp): string[] {
  const said = ` ${t.replace(/'s\b/g, '')} `;
  return Object.entries(criteria)
    .filter(([id, text]) => id !== 'none' && id !== 'all' && text)
    .filter(([, text]) => {
      const [name, rest = ''] = text!.toLowerCase().split(cut);
      const first = name.match(/[a-z]+/)?.[0];
      const email = /([a-z0-9._-]+@[a-z0-9.-]+)/.exec(rest)?.[1];
      return (!!first && first.length >= 2 && said.includes(` ${first} `)) || said.includes(` ${name.trim()} `) || (!!email && t.includes(email));
    })
    .map(([id]) => id);
}

const choice = (value: string, confidence: number): DeciderAnswer => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: confidence } });

export class RuleDecider implements Decider {
  async decide(state: string, questions: Record<string, DeciderQuestion>): Promise<Record<string, DeciderAnswer>> {
    return decideByRules(messageOf(state), questions);
  }
}

export function decideByRules(message: string, questions: Record<string, DeciderQuestion>): Record<string, DeciderAnswer> {
  const t = message.toLowerCase().replace(/[’']/g, "'").replace(/[?!,;:]+|\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const criteria = (name: string) => (questions[name]?.type === 'choice' ? (questions[name] as { criteria: Record<string, string | null> }).criteria : {});
  const sheets = criteria('target_timesheet');
  const sheetIds = Object.keys(sheets).filter((k) => k !== 'all' && k !== 'none');
  const x: Targets = {
    timesheets: named(t, sheets, / \(/),
    employees: named(t, criteria('target_employee'), / </),
    all: /\b(all|every\w*|each)\b/.test(t) || (/\bboth\b/.test(t) && sheetIds.length === 2),
  };

  const answers: Record<string, DeciderAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      if (name === 'adds_to_existing') answers[name] = { type: 'noul', noul: isAdditive(t) ? SURE : 0.05 };
      else if (name === 'is_question') answers[name] = { type: 'noul', noul: /^(why|how come|how do(es)?|explain)\b/.test(t) ? 0.9 : 0.05 };
      else answers[name] = { type: 'noul', noul: 0.5 };
      continue;
    }
    const options = Object.keys(q.criteria);
    const fallback = options.includes('other') ? 'other' : options.includes('none') ? 'none' : options[0];
    let pick: string | undefined;
    if (name === 'intent') {
      // A rule for a tool this role doesn't have is a miss, not a reason to try the next one.
      const rule = RULES.find((r) => r.test(t, x));
      pick = rule && rule.intent !== 'other' && options.includes(rule.intent) ? rule.intent : undefined;
    } else if (name === 'target_timesheet') {
      pick = x.all && sheetIds.length ? 'all' : x.timesheets.length === 1 ? x.timesheets[0] : undefined;
    } else if (name === 'target_employee') {
      pick = x.employees.length === 1 ? x.employees[0] : undefined;
    }
    // target_period and anything else: left to the month parser.
    answers[name] = pick ? choice(pick, SURE) : choice(fallback, UNSURE);
  }
  return answers;
}
