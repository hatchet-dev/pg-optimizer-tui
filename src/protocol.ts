// What the race publishes and reads: the stream topics, the event shapes, and the four candidate strategies.

/** Everything a race does goes to one topic, in order, so a reader can replay the whole race from its first event. */
export const raceTopic = (raceId: string) => `race-${raceId}`;

/** The operator's messages to one candidate. The candidate reads them before each model turn. */
export const steerTopic = (raceId: string, k: number) => `race-${raceId}-steer-${k}`;

/** The event the operator pushes to choose the winner. */
export const PICK_EVENT = 'race:pick';

export const RACE_ID = /^[a-z0-9]{8}$/;

export const QUERY = `SELECT o.id, o.customer_id, c.email, c.region, o.amount, o.created_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE date_trunc('day', o.created_at) >= date '2026-10-30' - 7
  AND o.amount > 450
  AND o.status <> 'cancelled'
  AND o.created_at = (SELECT min(o2.created_at) FROM orders o2
                      WHERE o2.customer_id = o.customer_id)
ORDER BY o.amount DESC`;

export const TASK = 'Fraud review queue: big orders from the last 7 days that are the customer\'s first order.';

export type Strategy = 'settings' | 'rewrite' | 'indexes' | 'open';

export const CANDIDATES: { k: number; strategy: Strategy; label: string; brief: string }[] = [
  {
    k: 0,
    strategy: 'settings',
    label: 'Settings',
    brief: 'You may only change server settings, with ALTER SYSTEM. Keep the query text and the schema as they are.',
  },
  {
    k: 1,
    strategy: 'rewrite',
    label: 'Rewrite',
    brief: 'You may only rewrite the query. Do not change the schema or the settings.',
  },
  {
    k: 2,
    strategy: 'indexes',
    label: 'Indexes',
    brief: 'You may only add indexes. Keep the query text exactly as it is.',
  },
  {
    k: 3,
    strategy: 'open',
    label: 'Open',
    brief: 'You may rewrite the query, add indexes, and change settings, in any combination.',
  },
];

/** What a judge measured for one query and migration, on a fresh copy of the database. */
export type Verdict = {
  ok: boolean;
  error?: string;
  rows: number;
  fingerprint: string;
  /** Whether the rows match the original query's. Absent on the baseline. */
  matches?: boolean;
  medianMs: number;
  runsMs: number[];
  plan: string;
  /** Size of the indexes the migration added. */
  indexBytes: number;
  /** The judge's own task run, for a dashboard link. */
  runId?: string;
};

/** The Hatchet tasks a race runs, which the race announces with their run ids so readers can link to them. */
export type RaceTask = 'race-mission' | 'race-candidate' | 'race-judge' | 'race-llm-turn';

/** Every run of a race carries this metadata, so the dashboard's run list can filter on it. */
export const raceMetadata = (raceId: string, extra: Record<string, string> = {}) => ({
  additionalMetadata: { race: raceId, ...extra },
});

export type Submission = { query: string; migration: string; notes: string };

/** One event on the race topic. `id` is stable across replays, so readers drop the copies a replay publishes again. */
export type RaceEvent =
  | { id: string; type: 'race'; task: string; query: string; candidates: typeof CANDIDATES }
  | { id: string; type: 'baseline'; verdict: Verdict }
  | { id: string; type: 'status'; k?: number; text: string }
  | { id: string; type: 'run'; task: RaceTask; runId: string; k?: number; label: string }
  /** A candidate (with `k`) or the whole race failed. */
  | { id: string; type: 'failed'; k?: number; error: string }
  | { id: string; type: 'thinking'; k: number; text: string }
  | { id: string; type: 'message'; k: number; text: string }
  | { id: string; type: 'sql'; k: number; kind: 'query' | 'migration'; sql: string; output: string; exitCode: number; ms?: number }
  | { id: string; type: 'steer'; k: number; text: string }
  | { id: string; type: 'submit'; k: number; submission: Submission }
  | { id: string; type: 'verdict'; k: number; verdict: Verdict }
  | { id: string; type: 'usage'; k: number; turn: number; input: number; output: number }
  | { id: string; type: 'ranking'; ranking: { k: number; medianMs: number; valid: boolean }[] }
  | {
      id: string;
      type: 'result';
      k: number;
      reason: 'picked' | 'fastest';
      submission: Submission;
      verdict: Verdict;
      baselineMs: number;
    };
