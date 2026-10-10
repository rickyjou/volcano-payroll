// Measures a decider on the labelled cases and picks the confidence threshold.
//   npm run eval:decider -- [--url http://127.0.0.1:8000 | --rules] [--threshold 0.9]
// The router is pure, so each case is asked once and then replayed at several thresholds.
// Exit code 1 when any write error (see eval-judge.ts) happens at the chosen threshold.
import { readFileSync } from 'node:fs';
import { describeContext } from '../src/agent/context';
import { HttpDecider, type Decider, type DeciderAnswer } from '../src/agent/decider';
import { RuleDecider } from '../src/agent/rule-decider';
import { deciderQuestions, deciderState, route } from '../src/agent/router';
import { toolsFor } from '../src/agent/tools';
import { fixtureContext } from '../tests/agent/fixture';
import { judge, type Case } from './eval-judge';

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const rules = process.argv.includes('--rules');
const url = rules ? 'the built-in rules' : flag('url') ?? process.env.DECIDER_URL ?? 'http://127.0.0.1:8000';
const chosen = Number(flag('threshold') ?? process.env.AGENT_DECIDER_THRESHOLD ?? 0.9);
const THRESHOLDS = [0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99];

const cases: Case[] = readFileSync('tests/agent/decider-cases.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  if (cases.length === 0) throw new Error('tests/agent/decider-cases.jsonl has no cases');
  const decider: Decider = rules ? new RuleDecider() : new HttpDecider({ url, timeoutMs: 30_000 });
  const asked: { c: Case; answers: Record<string, DeciderAnswer>; ms: number }[] = [];
  for (const c of cases) {
    const ctx = fixtureContext(c.role);
    const hasPending = c.intent === 'confirm' || c.intent === 'cancel';
    const started = Date.now();
    const answers = await decider.decide(deciderState(describeContext(ctx), c.text), deciderQuestions(ctx, toolsFor(c.role), hasPending));
    asked.push({ c, answers, ms: Date.now() - started });
  }
  const replay = (T: number) => asked.map(({ c, answers }) => {
    const ctx = fixtureContext(c.role);
    return { c, ...judge(c, route({ text: c.text, context: ctx, tools: toolsFor(c.role), answers, threshold: T, hasPending: c.intent === 'confirm' || c.intent === 'cancel' })) };
  });

  const top = asked.filter(({ c, answers }) => answers.intent?.type === 'choice' && answers.intent.choice === c.intent).length;
  const ms = asked.map((a) => a.ms).sort((x, y) => x - y);
  console.log(`Decider ${url}: ${cases.length} cases, top-choice intent accuracy ${(top / cases.length * 100).toFixed(1)}%, median latency ${ms[Math.floor(ms.length / 2)]} ms\n`);
  console.log('threshold  coverage  correct  wrong  wrong-writes');
  let suggested: number | null = null;
  for (const T of THRESHOLDS) {
    const r = replay(T);
    const handled = r.filter((x) => x.verdict !== 'llm');
    const wrong = r.filter((x) => x.verdict === 'wrong');
    const wrongWrites = wrong.filter((x) => x.writeError);
    if (suggested === null && wrongWrites.length === 0) suggested = T;
    console.log(`${T.toFixed(2).padStart(9)}  ${(handled.length / r.length * 100).toFixed(1).padStart(7)}%  ${String(handled.length - wrong.length).padStart(7)}  ${String(wrong.length).padStart(5)}  ${String(wrongWrites.length).padStart(12)}`);
  }

  const atChosen = replay(chosen);
  const byIntent = new Map<string, { n: number; correct: number; llm: number; wrong: number; writeErrors: number }>();
  for (const { c, verdict, writeError } of atChosen) {
    const s = byIntent.get(c.intent) ?? { n: 0, correct: 0, llm: 0, wrong: 0, writeErrors: 0 };
    s.n += 1;
    s[verdict] += 1;
    if (writeError) s.writeErrors += 1;
    byIntent.set(c.intent, s);
  }
  console.log(`\nPer intent at threshold ${chosen}:`);
  for (const [intent, s] of [...byIntent].sort()) console.log(`  ${intent.padEnd(26)} n=${s.n} correct=${s.correct} llm=${s.llm} wrong=${s.wrong}${s.writeErrors ? '  <-- WRITE ERROR' : ''}`);
  const errors = atChosen.filter((x) => x.verdict === 'wrong');
  if (errors.length) {
    console.log('\nWrong at the chosen threshold:');
    for (const { c, writeError } of errors) console.log(`  [${c.role}] "${c.text}" expected ${c.intent}${writeError ? '  (write error)' : ''}`);
  }
  console.log(`\nLowest threshold with no wrong writes: ${suggested ?? 'none of those tried'}`);
  if (errors.some((x) => x.writeError)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
