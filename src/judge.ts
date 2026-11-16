// The judge: measures one query and migration on a fresh copy of the database. Judges run one at a time across the
// whole tenant, so a candidate's timing never competes with another sandbox for the CPU.
import '@hatchet-dev/sandbox';
import { ConcurrencyLimitStrategy } from '@hatchet-dev/typescript-sdk/v1';
import { hatchet } from './client.js';
import { IMAGE, judgeScript, parseJudge } from './pg.js';
import type { Verdict } from './protocol.js';

export type JudgeInput = {
  raceId: string;
  /** `baseline`, or the candidate's index. */
  label: string;
  query: string;
  migration: string;
  runs: number;
  /** The original query's row fingerprint; absent when judging the baseline itself. */
  expected?: string;
};

export const raceJudge = hatchet.task({
  name: 'race-judge',
  executionTimeout: '20m',
  // judges queue behind each other, and a race has up to five
  scheduleTimeout: '60m',
  retries: 1,
  // queue: the default strategy, CANCEL_IN_PROGRESS, would cancel the running judge whenever another one arrives
  concurrency: { expression: "'race-judge'", maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN },
  fn: async (input: JudgeInput, ctx): Promise<Verdict> => {
    const runId = ctx.taskRunExternalId();
    const what = input.label === 'baseline' ? 'the original query' : `candidate ${Number(input.label) + 1}`;
    ctx.logger.info(`Judging ${what} of race ${input.raceId}: ${input.runs} timed runs, migration ${input.migration ? `${input.migration.split('\n').length} lines` : 'empty'}`);
    const sandbox = await hatchet.sandbox.create({
      template: IMAGE,
      metadata: { source: 'race-judge', race: input.raceId, judged: input.label },
    });
    ctx.logger.info(`Fresh sandbox ${sandbox.sandboxId} from ${IMAGE}`);
    try {
      let script: string;
      try {
        script = judgeScript(input.migration, input.query, input.runs);
      } catch (err) {
        ctx.logger.warn(`Rejected before running: ${String(err)}`);
        return { ok: false, error: String(err), rows: 0, fingerprint: '', medianMs: 0, runsMs: [], plan: '', indexBytes: 0, runId };
      }
      const started = Date.now();
      // two runs of a slow query under the 300 s statement timeout, plus the fingerprint and the plan
      const result = await sandbox.exec(script, { timeoutMs: 900_000 });
      ctx.logger.info(`Judge script exited ${result.exitCode} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
      // seen under heavy load: the sandbox call completes with an empty output; fail so the retry runs the script again
      if (typeof result.stdout !== 'string') throw new Error(`the sandbox returned no output (exit code ${result.exitCode})`);
      const verdict: Verdict = { ...parseJudge(result.stdout + (result.stderr ?? ''), result.exitCode), runId };
      if (input.expected !== undefined) verdict.matches = verdict.ok && verdict.fingerprint === input.expected;
      if (!verdict.ok) {
        ctx.logger.warn(`The query failed: ${verdict.error}`);
      } else {
        ctx.logger.info(`Median ${verdict.medianMs} ms (runs ${verdict.runsMs.join(', ')} ms), ${verdict.rows} rows, md5 ${verdict.fingerprint}, indexes ${verdict.indexBytes} bytes`);
        if (verdict.matches === false) ctx.logger.warn(`Wrong result: the rows differ from the original query's (expected md5 ${input.expected})`);
        else if (verdict.matches) ctx.logger.info('The rows match the original query');
      }
      return verdict;
    } finally {
      await sandbox.kill();
      ctx.logger.info(`Sandbox ${sandbox.sandboxId} killed`);
    }
  },
});
