// Folds the race topic into what the TUI draws. Replays publish some events again, so events are deduped by id.
import { CANDIDATES, type RaceEvent, type Submission, type Verdict } from '../protocol.js';

export type Entry =
  | { kind: 'status'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'sql'; migration: boolean; sql: string; output: string; exitCode: number; ms?: number }
  | { kind: 'steer'; text: string }
  | { kind: 'submit'; submission: Submission }
  | { kind: 'verdict'; verdict: Verdict }
  | { kind: 'note'; text: string }
  | { kind: 'failed'; text: string };

export type Phase = 'waiting' | 'sandbox' | 'thinking' | 'sql' | 'judging' | 'done' | 'failed';

export type Lane = {
  k: number;
  label: string;
  strategy: string;
  phase: Phase;
  turns: number;
  usageTurns: number;
  tokensIn: number;
  tokensOut: number;
  execs: number;
  inboxReads: number;
  best?: number;
  entries: Entry[];
  submission?: Submission;
  verdict?: Verdict;
  /** Task runs to link to: the candidate itself, its latest model turn, and its judge. */
  runId?: string;
  llmRun?: { runId: string; label: string };
  judgeRunId?: string;
};

export type FeedItem = { at: number; k?: number; type: string; text: string };

export type RaceState = {
  raceId?: string;
  runId?: string;
  baselineJudgeRunId?: string;
  status: string;
  task?: string;
  query?: string;
  baselineRunning: boolean;
  baseline?: Verdict;
  lanes: Lane[];
  ranking?: { k: number; medianMs: number; valid: boolean }[];
  waitingForPick: boolean;
  result?: Extract<RaceEvent, { type: 'result' }>;
  /** Why the race failed, when it did. */
  failed?: string;
  startedAt?: number;
  finishedAt?: number;
  seen: Set<string>;
  events: number;
  /** The newest events on the race topic, one line each. */
  feed: FeedItem[];
};

export const initialState = (): RaceState => ({
  status: 'No race yet',
  baselineRunning: false,
  lanes: CANDIDATES.map(({ k, label, strategy }) => ({
    k,
    label,
    strategy,
    phase: 'waiting',
    turns: 0,
    usageTurns: 0,
    tokensIn: 0,
    tokensOut: 0,
    execs: 0,
    inboxReads: 0,
    entries: [],
  })),
  waitingForPick: false,
  seen: new Set(),
  events: 0,
  feed: [],
});

/** The time a run_sql call measured: EXPLAIN ANALYZE's execution time, else the slowest statement psql timed. */
export function sqlTime(output: string): number | undefined {
  const exec = [...output.matchAll(/Execution Time: ([\d.]+) ms/g)];
  if (exec.length) return Number(exec[exec.length - 1][1]);
  const times = [...output.matchAll(/^Time: ([\d.]+) ms/gm)].map((m) => Number(m[1]));
  return times.length ? Math.max(...times) : undefined;
}

const short = (text: string, n = 90) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function summary(event: RaceEvent): string {
  switch (event.type) {
    case 'race':
      return 'race published';
    case 'baseline':
      return `baseline ${Math.round(event.verdict.medianMs)} ms, ${event.verdict.rows} rows`;
    case 'status':
      return event.text;
    case 'thinking':
      return short(event.text);
    case 'message':
      return short(event.text);
    case 'usage':
      return `turn ${event.turn} tokens in ${event.input} out ${event.output}`;
    case 'sql': {
      const ms = event.exitCode === 0 ? sqlTime(event.output) : undefined;
      return `${event.kind === 'migration' ? 'migration' : 'sql'} ${event.exitCode ? `exit ${event.exitCode}` : ms !== undefined ? `${ms} ms` : 'ok'}: ${short(event.sql, 60)}`;
    }
    case 'steer':
      return `operator: ${short(event.text)}`;
    case 'submit':
      return `submitted: ${short(event.submission.notes)}`;
    case 'verdict':
      return `verdict ${event.verdict.medianMs} ms, ${event.verdict.matches === false ? 'wrong rows' : 'rows match'}`;
    case 'ranking':
      return `ranking ${event.ranking.map((r) => r.k + 1).join(' > ')}`;
    case 'result':
      return `result: candidate ${event.k + 1}, ${event.reason}`;
    case 'run':
      return `${event.task} ${event.label} run ${event.runId.slice(0, 8)}`;
    case 'failed':
      return `failed: ${short(event.error)}`;
  }
}

/** Applies one event at time `at` (ms). Returns the same state object when the event is a duplicate. */
export function reduce(state: RaceState, event: RaceEvent, at: number): RaceState {
  if (state.seen.has(event.id)) return state;
  const next: RaceState = { ...state, seen: new Set(state.seen).add(event.id), events: state.events + 1 };
  next.startedAt ??= at;
  next.feed = [...state.feed.slice(-199), { at, k: 'k' in event ? event.k : undefined, type: event.type, text: summary(event) }];

  const lane = (k: number, change: (lane: Lane) => Partial<Lane>, entry?: Entry) => {
    next.lanes = next.lanes.map((l) =>
      l.k === k ? { ...l, ...change(l), entries: entry ? [...l.entries, entry] : l.entries } : l,
    );
  };

  switch (event.type) {
    case 'race':
      next.task = event.task;
      next.query = event.query;
      break;
    case 'baseline':
      next.baseline = event.verdict;
      next.baselineRunning = false;
      break;
    case 'status':
      if (event.k === undefined) {
        next.status = event.text;
        if (event.id === 'status-baseline') next.baselineRunning = true;
        if (event.id === 'status-pick') next.waitingForPick = true;
      } else if (event.id.endsWith('-status-start')) {
        lane(event.k, () => ({ phase: 'sandbox', execs: 1 }), { kind: 'status', text: event.text });
      } else if (event.id.endsWith('-status-judge')) {
        lane(event.k, () => ({ phase: 'judging' }), { kind: 'status', text: event.text });
      } else {
        lane(event.k, (l) => ({ phase: 'thinking', turns: l.turns + 1, inboxReads: l.inboxReads + 1 }), {
          kind: 'status',
          text: event.text,
        });
      }
      break;
    case 'thinking':
      lane(event.k, () => ({}), { kind: 'thinking', text: event.text });
      break;
    case 'message':
      lane(event.k, () => ({}), { kind: 'message', text: event.text });
      break;
    case 'usage':
      lane(event.k, (l) => ({
        phase: 'sql',
        usageTurns: l.usageTurns + 1,
        tokensIn: l.tokensIn + event.input,
        tokensOut: l.tokensOut + event.output,
      }));
      break;
    case 'sql': {
      // only runs of the race query count, not SET or SHOW
      const timed =
        event.exitCode === 0 && event.kind === 'query' && /^\s*(EXPLAIN|SELECT|WITH)\b[\s\S]*\borders\b/i.test(event.sql)
          ? sqlTime(event.output)
          : undefined;
      lane(
        event.k,
        (l) => ({
          execs: l.execs + 1,
          best: timed !== undefined && (l.best === undefined || timed < l.best) ? timed : l.best,
        }),
        { kind: 'sql', migration: event.kind === 'migration', sql: event.sql, output: event.output, exitCode: event.exitCode, ms: sqlTime(event.output) },
      );
      break;
    }
    case 'steer':
      lane(event.k, () => ({}), { kind: 'steer', text: event.text });
      break;
    case 'submit':
      lane(event.k, () => ({ submission: event.submission }), { kind: 'submit', submission: event.submission });
      break;
    case 'verdict':
      lane(event.k, () => ({ verdict: event.verdict, phase: 'done' }), { kind: 'verdict', verdict: event.verdict });
      break;
    case 'ranking':
      next.ranking = event.ranking;
      break;
    case 'failed':
      if (event.k === undefined) {
        next.failed = event.error;
        next.waitingForPick = false;
        next.baselineRunning = false;
        next.finishedAt = at;
        next.status = `Race failed: ${event.error}`;
      } else {
        lane(event.k, () => ({ phase: 'failed' }), { kind: 'failed', text: event.error });
      }
      break;
    case 'run':
      if (event.k === undefined) {
        if (event.task === 'race-mission') next.runId = event.runId;
        else if (event.task === 'race-judge') next.baselineJudgeRunId = event.runId;
      } else if (event.task === 'race-candidate') lane(event.k, () => ({ runId: event.runId }));
      else if (event.task === 'race-llm-turn') lane(event.k, () => ({ llmRun: { runId: event.runId, label: event.label } }));
      else if (event.task === 'race-judge') lane(event.k, () => ({ judgeRunId: event.runId }));
      break;
    case 'result':
      next.result = event;
      next.waitingForPick = false;
      next.finishedAt = at;
      next.status = event.reason === 'picked' ? 'Winner picked by the operator' : 'No pick in 10 minutes: the fastest wins';
      break;
  }
  return next;
}

/** Adds a line to one lane's log that isn't from the race topic, such as a refused steer. */
export function note(state: RaceState, k: number, text: string): RaceState {
  return { ...state, lanes: state.lanes.map((l) => (l.k === k ? { ...l, entries: [...l.entries, { kind: 'note', text }] } : l)) };
}
