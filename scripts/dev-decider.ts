// DEVELOPMENT ONLY: a keyword-rule stand-in for a decision model, speaking the Strands
// Decider `/v1/systemone` API, so the chat works locally without downloading a model.
// It is not a decider: it never generalises. Point DECIDER_URL at a real one for anything
// beyond trying the UI.  Run: npm run dev:decider   (listens on http://127.0.0.1:8100)
import { createServer } from 'node:http';

type Question = { type: 'choice'; instructions: string; criteria: Record<string, string | null> } | { type: 'noul'; instructions: string };

const RULES: [RegExp, string][] = [
  [/^\s*(yes|yep|yeah|ok|okay|sure|go ahead|do it|confirm)\b/i, 'confirm'],
  [/^\s*(no|nope|cancel|stop|never ?mind)\b/i, 'cancel'],
  [/\b(help|what can you do)\b/i, 'help'],
  [/\b(add|log|record|worked|took|take)\b.*\b(\d|hour|hours|day|pto|sick|holiday|vacation)\b/i, 'log_time'],
  [/\b(clear|remove|delete)\b.*\b(time|hours|today|yesterday|day)\b/i, 'clear_time'],
  [/\bsubmit\b/i, 'submit_timesheet'],
  [/\brecall\b/i, 'recall_timesheet'],
  [/\b(my )?pay(check|slip)?\b.*\b(last|this|month)\b|\bhow much did i (get|earn)/i, 'show_my_pay'],
  [/\b(my profile|my rate|who is my manager)\b/i, 'show_profile'],
  [/\b(needs? my approval|waiting|pending|to approve)\b/i, 'list_pending_approvals'],
  [/\bapprove\b/i, 'approve_timesheets'],
  [/\b(return|send back|reject)\b/i, 'return_timesheet'],
  [/\b(team|who).*\b(submitted|status|started)\b/i, 'team_status'],
  [/\bopen\b.*\b(month|period|january|february|march|april|may|june|july|august|september|october|november|december)\b/i, 'open_period'],
  [/\block\b/i, 'lock_period'],
  [/\breopen\b/i, 'reopen_period'],
  [/\b(generate|calculate|run payroll)\b/i, 'generate_run'],
  [/\bfinali[sz]e\b/i, 'finalize_run'],
  [/\bexport\b/i, 'export_run'],
  [/\bdiscard\b/i, 'discard_draft'],
  [/\b(list|show)\b.*\bperiods?\b/i, 'list_periods'],
  [/\b(settings|api keys?|webhooks?)\b/i, 'show_settings'],
  [/\b(my )?(timesheet|time sheet)\b|\bwhat (did|have) i log/i, 'show_timesheet'],
];

function answerChoice(message: string, q: Extract<Question, { type: 'choice' }>) {
  const keys = Object.keys(q.criteria);
  let pick: string | undefined;
  if (q.instructions.startsWith('What does the message ask')) {
    pick = RULES.find(([re, intent]) => re.test(message) && keys.includes(intent))?.[1];
  } else if (/\b(all|every|everyone)\b/i.test(message) && keys.includes('all')) {
    pick = 'all';
  } else {
    // Target questions: the option whose description shares a word with the message.
    const words = message.toLowerCase().match(/[a-z]{3,}/g) ?? [];
    pick = keys.find((k) => k !== 'none' && k !== 'all' && words.some((w) => String(q.criteria[k] ?? '').toLowerCase().split(/[^a-z]+/).includes(w)));
  }
  const choice = pick ?? (keys.includes('other') ? 'other' : keys.includes('none') ? 'none' : keys[0]);
  return { type: 'choice', choice, confidence: pick ? 0.95 : 0.3, probabilities: { [choice]: pick ? 0.95 : 0.3 } };
}

function answerNoul(message: string, q: Extract<Question, { type: 'noul' }>) {
  if (q.instructions.includes('add time on top')) return { type: 'noul', noul: /\b(more|another|extra|add)\b/i.test(message) ? 0.95 : 0.05 };
  if (q.instructions.includes('why or how')) return { type: 'noul', noul: /^\s*(why|how come|how does|explain)\b/i.test(message) ? 0.9 : 0.05 };
  return { type: 'noul', noul: 0.5 };
}

const port = Number(process.env.PORT ?? 8100);
createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/systemone') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      const { state, questions } = JSON.parse(raw) as { state: string; questions: Record<string, Question> };
      const message = /Message: "([\s\S]*)"$/.exec(state)?.[1] ?? state;
      const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === 'choice' ? answerChoice(message, q) : answerNoul(message, q)]));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: 'dev-rules', answers, usage: {} }));
    } catch {
      res.writeHead(422).end();
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`dev decider (keyword rules) on http://127.0.0.1:${port}`));
