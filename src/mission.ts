// The race itself, a durable task: judge the original query, race the four candidates in parallel, rank their
// verdicts, and wait for the operator to pick the winner. Ten minutes without a pick goes to the fastest correct one.
import { ConcurrencyLimitStrategy, Or, SleepCondition, UserEventCondition } from '@hatchet-dev/typescript-sdk/v1';
import { hatchet } from './client.js';
import { type CandidateOutput, raceCandidate } from './candidate.js';
import { raceJudge } from './judge.js';
import { CANDIDATES, PICK_EVENT, QUERY, type RaceEvent, raceMetadata, raceTopic, TASK, type Verdict } from './protocol.js';

/** Finds the candidate index in a waitFor result, whose payload sits a level or two down. */
function pickedCandidate(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (result as Record<string, unknown>).candidate;
  if (typeof value === 'number') return value;
  for (const inner of Object.values(result)) {
    const found = pickedCandidate(inner);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const raceMission = hatchet.durableTask({
  name: 'race-mission',
  executionTimeout: '60m',
  // One race at a time: a second race's agents would compete with the first one's for the CPU, and its 28 s baseline
  // ran past the judge's timeout. A queued race waits up to 30 minutes for the one before it.
  concurrency: { expression: "'race-mission'", maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN },
  scheduleTimeout: '30m',
  fn: async (input: { raceId: string }, ctx) => {
    const { raceId } = input;
    const emit = (event: RaceEvent) => hatchet.streams.publish(raceTopic(raceId), JSON.stringify(event));
    const log = ctx.logger;
    try {
      log.info(`Race ${raceId}: publishing to topic ${raceTopic(raceId)}`);
      await emit({ id: 'race', type: 'race', task: TASK, query: QUERY, candidates: CANDIDATES });
      await emit({ id: 'run-mission', type: 'run', task: 'race-mission', runId: ctx.workflowRunId(), label: raceId });
      await emit({ id: 'status-baseline', type: 'status', text: 'Judging the original query' });
      log.info('Judging the original query on a fresh copy of the database');
      const baseline = (await ctx.spawnChild(
        raceJudge,
        { raceId, label: 'baseline', query: QUERY, migration: '', runs: 1 },
        raceMetadata(raceId, { judged: 'baseline' }),
      )) as Verdict;
      if (baseline.runId) await emit({ id: 'run-baseline-judge', type: 'run', task: 'race-judge', runId: baseline.runId, label: 'baseline' });
      await emit({ id: 'baseline', type: 'baseline', verdict: baseline });
      if (!baseline.ok) {
        log.error(`The baseline failed: ${baseline.error}`);
        throw new Error(`the baseline failed: ${baseline.error}`);
      }
      log.info(`Baseline: ${baseline.medianMs} ms, ${baseline.rows} rows, md5 ${baseline.fingerprint}`);

      await emit({ id: 'status-race', type: 'status', text: 'Racing' });
      log.info(`Spawning ${CANDIDATES.length} candidates: ${CANDIDATES.map((c) => c.label).join(', ')}`);
      const results = (await ctx.spawnChildren(
        CANDIDATES.map(({ k, label }) => ({
          workflow: raceCandidate,
          input: { raceId, k, baseline: { ms: baseline.medianMs, rows: baseline.rows, fingerprint: baseline.fingerprint } },
          options: raceMetadata(raceId, { candidate: label }),
        })),
      )) as CandidateOutput[];

      const ranking = results
        .map((r) => ({ k: r.k, medianMs: r.verdict.medianMs, valid: !!r.verdict.matches }))
        .sort((a, b) => Number(b.valid) - Number(a.valid) || a.medianMs - b.medianMs);
      for (const [i, r] of ranking.entries()) {
        log.info(`#${i + 1} ${CANDIDATES[r.k].label}: ${r.medianMs} ms${r.valid ? '' : ' (rejected: wrong rows or failed)'}`);
      }
      await emit({ id: 'ranking', type: 'ranking', ranking });

      await emit({ id: 'status-pick', type: 'status', text: 'Waiting for the operator to pick a winner' });
      log.info(`Waiting up to 10 minutes for a ${PICK_EVENT} event with raceId ${raceId}`);
      const picked = pickedCandidate(
        await ctx.waitFor(
          Or(new SleepCondition('10m', 'timeout'), new UserEventCondition(PICK_EVENT, `input.raceId == '${raceId}'`, 'pick')),
        ),
      );
      const fastest = ranking.find((r) => r.valid)?.k ?? ranking[0].k;
      const k = picked !== undefined && results.some((r) => r.k === picked) ? picked : fastest;
      const winner = results.find((r) => r.k === k)!;
      if (picked === undefined) log.info(`No pick after 10 minutes: ${CANDIDATES[k].label} wins as the fastest correct submission`);
      else if (picked !== k) log.warn(`The pick ${picked} is not a candidate; ${CANDIDATES[k].label} wins as the fastest`);
      else log.info(`The operator picked ${CANDIDATES[k].label}`);
      log.info(`Winner: ${CANDIDATES[k].label}, ${baseline.medianMs} ms -> ${winner.verdict.medianMs} ms. Migration:\n${winner.submission.migration || '(none)'}`);

      await emit({
        id: 'result',
        type: 'result',
        k,
        reason: picked === undefined ? 'fastest' : 'picked',
        submission: winner.submission,
        verdict: winner.verdict,
        baselineMs: baseline.medianMs,
      });
      return { raceId, winner: k, query: winner.submission.query, migration: winner.submission.migration, ms: winner.verdict.medianMs };
    } catch (error) {
      // an eviction or a cancellation isn't a failure: the run resumes, or was stopped on purpose
      if (ctx.cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Race ${raceId} failed: ${message}`);
      await emit({ id: 'failed', type: 'failed', error: message.slice(0, 1_000) });
      throw error;
    }
  },
});
