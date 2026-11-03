// One racer: a Claude agent with its own Postgres sandbox and one strategy. It's a durable task, and every model turn,
// inbox read, sandbox call, and the judge's verdict is a step in its event log, so a worker crash replays what finished
// and carries on. Everything it does goes to the race topic.
import type Anthropic from '@anthropic-ai/sdk';
import type { JsonObject } from '@hatchet-dev/typescript-sdk/v1';
import { hatchet } from './client.js';
import { raceJudge } from './judge.js';
import { ENSURE_UP, IMAGE, measuredMs, migrate, PSQL, readOnlySql, settingsOnly } from './pg.js';
import { CANDIDATES, QUERY, type RaceEvent, raceMetadata, raceTopic, steerTopic, type Strategy, type Submission, TASK, type Verdict } from './protocol.js';
import { type InboxRead, type LlmTurnOutput, raceLlmTurn, raceReadInbox, raceSandbox, type SandboxCall, type SandboxResult } from './steps.js';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type UserBlock = Anthropic.Beta.Messages.BetaContentBlockParam;

// Token guards: a cap on turns and output, the model's effort, and clipped tool output. Open gets the bigger budget: it
// is the only lane that can combine a rewrite with indexes, and that takes more turns to find.
const BUDGETS: Record<Strategy, { turns: number; outputTokens: number; effort: 'low' | 'medium' }> = {
  settings: { turns: 10, outputTokens: 30_000, effort: 'low' },
  rewrite: { turns: 10, outputTokens: 30_000, effort: 'low' },
  indexes: { turns: 10, outputTokens: 30_000, effort: 'low' },
  open: { turns: 16, outputTokens: 60_000, effort: 'medium' },
};
const MAX_TOOL_OUTPUT_CHARS = 4_000;
const JUDGE_RUNS = 3;

const clip = (text: string) =>
  text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (${text.length - MAX_TOOL_OUTPUT_CHARS} more characters)` : text;

const sqlTool = (name: string, description: string): BetaTool => ({
  name,
  description,
  strict: true,
  input_schema: {
    type: 'object',
    properties: { sql: { type: 'string', description: 'One or more SQL statements.' } },
    required: ['sql'],
    additionalProperties: false,
  },
});

const RUN_SQL = sqlTool(
  'run_sql',
  'Runs SQL in a read-only transaction that is rolled back, with a 60 s statement timeout, and returns psql\'s output with timings. Use it for EXPLAIN (ANALYZE, BUFFERS), for trying a query, and for SET to try a setting for this transaction only.',
);
const APPLY_MIGRATION = sqlTool(
  'apply_migration',
  'Runs DDL that changes the database, such as CREATE INDEX, and adds it to your migration. The judge applies your migration to a fresh copy of the database before it measures your query.',
);
const APPLY_SETTINGS = sqlTool(
  'apply_settings',
  'Runs ALTER SYSTEM SET statements followed by SELECT pg_reload_conf(), and adds them to your migration. The judge applies your migration to a fresh copy of the database before it measures your query.',
);

function submitTool(withQuery: boolean): BetaTool {
  return {
    name: 'submit',
    description: withQuery
      ? 'Submits your final query for judging, and ends your turn in the race. Call it once.'
      : 'Submits your migration for judging with the original query, and ends your turn in the race. Call it once.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ...(withQuery ? { query: { type: 'string', description: 'The final query, returning exactly the same rows as the original.' } } : {}),
        notes: { type: 'string', description: 'One or two sentences on what you changed and why it is faster.' },
      },
      required: withQuery ? ['query', 'notes'] : ['notes'],
      additionalProperties: false,
    },
  };
}

const TOOLS: Record<Strategy, BetaTool[]> = {
  settings: [RUN_SQL, APPLY_SETTINGS, submitTool(false)],
  rewrite: [RUN_SQL, submitTool(true)],
  indexes: [RUN_SQL, APPLY_MIGRATION, submitTool(false)],
  open: [RUN_SQL, APPLY_MIGRATION, submitTool(true)],
};

function system(brief: string, baselineMs: number, rows: number, maxTurns: number): string {
  return `You are a Postgres 17 performance engineer in a race against other engineers. Each of you has your own copy of the same database, and the fastest correct result wins.

The task: ${TASK}

The original query takes about ${Math.round(baselineMs)} ms and returns ${rows} rows:

${QUERY}

Your strategy: ${brief}

Rules:
- Your result must return exactly the same rows as the original query. A judge applies your migration to a fresh copy of the database, runs your query several times, and rejects it if any row differs.
- Statements in run_sql time out after 60 s, and the original query alone takes most of that, so measure it at most once.
- You have at most ${maxTurns} turns, so measure what matters and don't explore more than you need.
- When you are done, call submit. If you find no improvement, submit anyway and say so.`;
}

export type CandidateInput = { raceId: string; k: number; baseline: { ms: number; rows: number; fingerprint: string } };
export type CandidateOutput = { k: number; submission: Submission; verdict: Verdict; turns: number };

export const raceCandidate = hatchet.durableTask({
  name: 'race-candidate',
  executionTimeout: '30m',
  fn: async (input: CandidateInput, ctx): Promise<CandidateOutput> => {
    const { k, raceId } = input;
    const { strategy, label, brief } = CANDIDATES[k];
    const emit = (event: RaceEvent) => hatchet.streams.publish(raceTopic(raceId), JSON.stringify(event));
    const tools = TOOLS[strategy];
    const budget = BUDGETS[strategy];
    const log = ctx.logger;
    const meta = raceMetadata(raceId, { candidate: label });
    try {

      await emit({ id: `c${k}-run`, type: 'run', task: 'race-candidate', runId: ctx.taskRunExternalId(), k, label });
      log.info(`${label} agent, race ${raceId}. Strategy: ${brief}`);
      log.info(`Tools: ${tools.map((t) => t.name).join(', ')}. Guards: ${budget.turns} turns, ${budget.outputTokens} output tokens, ${budget.effort} effort`);
      await emit({ id: `c${k}-status-start`, type: 'status', k, text: 'Starting a Postgres sandbox' });
      const sandboxId = `race-${raceId}-c${k}`;
      // every sandbox call is a durable child, so a replay reads its stored result instead of calling the sandbox again
      const call = (c: SandboxCall) => ctx.spawnChild(raceSandbox, c, meta) as Promise<SandboxResult>;
      const exec = (cmd: string, timeoutMs: number) => call({ op: 'exec', sandboxId, template: IMAGE, cmd, timeoutMs });
      await call({ op: 'create', sandboxId, template: IMAGE, metadata: { source: 'race-candidate', race: raceId, candidate: label } });
      log.info(`Sandbox ${sandboxId} from ${IMAGE}`);
      const schema = await exec(`${ENSURE_UP}\n${PSQL} -c '\\d customers' -c '\\d orders' 2>&1`, 60_000);
      log.info(`Postgres is up; read the schema (exit ${schema.exitCode})`);

      let migration = '';
      let submission: Submission | undefined;
      let inboxCursor: string | undefined;
      const messages: BetaMessageParam[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: `The schema:\n\n${clip(schema.stdout)}\n\nStart when you're ready.` }],
        },
      ];

      let turns = 0;
      let outputTokens = 0;
      while (!submission && turns < budget.turns && outputTokens < budget.outputTokens) {
        // the operator's messages since the last turn join the next model call
        const inbox = (await ctx.spawnChild(raceReadInbox, { topic: steerTopic(raceId, k), cursor: inboxCursor }, meta)) as InboxRead;
        inboxCursor = inbox.cursor;
        if (inbox.messages.length) log.info(`${inbox.messages.length} operator message(s) join the next turn: ${inbox.messages.join(' | ').slice(0, 300)}`);
        const last = messages[messages.length - 1].content as UserBlock[];
        for (const [i, text] of inbox.messages.entries()) {
          await emit({ id: `c${k}-steer-${turns}-${i}`, type: 'steer', k, text });
          last.push({ type: 'text', text: `Message from the operator running the race: ${text}` });
        }

        turns += 1;
        await emit({ id: `c${k}-status-turn-${turns}`, type: 'status', k, text: `Turn ${turns}: thinking` });
        log.info(`Turn ${turns}: asking the model (${outputTokens} output tokens so far)`);
        const turn = (await ctx.spawnChild(
          raceLlmTurn,
          { system: system(brief, input.baseline.ms, input.baseline.rows, budget.turns), tools, messages, effort: budget.effort } as unknown as JsonObject,
          meta,
        )) as unknown as LlmTurnOutput;
        outputTokens += turn.usage.output;
        if (turn.runId) await emit({ id: `c${k}-run-llm-${turns}`, type: 'run', task: 'race-llm-turn', runId: turn.runId, k, label: `turn ${turns}` });
        await emit({ id: `c${k}-usage-${turns}`, type: 'usage', k, turn: turns, input: turn.usage.input, output: turn.usage.output });
        const calls = turn.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name);
        log.info(`Turn ${turns}: stop ${turn.stopReason}, ${turn.usage.output} output tokens, tool calls: ${calls.join(', ') || 'none'}`);

        for (const [i, block] of turn.content.entries()) {
          if (block.type === 'thinking' && block.thinking) {
            await emit({ id: `c${k}-t${turns}-thinking-${i}`, type: 'thinking', k, text: block.thinking });
          } else if (block.type === 'text' && block.text) {
            await emit({ id: `c${k}-t${turns}-text-${i}`, type: 'message', k, text: block.text });
          }
        }
        messages.push({ role: 'assistant', content: turn.content });
        if (turn.stopReason !== 'tool_use') {
          log.warn(`Turn ${turns} ended without a tool call; nudging the agent`);
          messages.push({ role: 'user', content: [{ type: 'text', text: 'Call a tool, or call submit if you are done.' }] });
          continue;
        }

        const results: UserBlock[] = [];
        for (const block of turn.content) {
          if (block.type !== 'tool_use') continue;
          const args = block.input as { sql?: string; query?: string; notes?: string };
          let output: string;

          if (block.name === 'submit') {
            submission = { query: args.query?.trim() || QUERY, migration: migration.trim(), notes: args.notes ?? '' };
            log.info(`Submitted: ${submission.notes}`);
            log.info(`Query ${submission.query === QUERY ? 'unchanged' : 'rewritten'}; migration:\n${submission.migration || '(none)'}`);
            await emit({ id: `c${k}-submit`, type: 'submit', k, submission });
            output = 'Submitted for judging.';
          } else {
            const sql = args.sql ?? '';
            const refusal = block.name === 'apply_settings' ? settingsOnly(sql) : undefined;
            if (refusal) {
              log.warn(`Refused apply_settings: ${refusal}`);
              output = `error: ${refusal}`;
            } else {
              const isMigration = block.name !== 'run_sql';
              const firstLine = sql.trim().split('\n')[0].slice(0, 160);
              log.info(`${block.name} in ${sandboxId}: ${firstLine}`);
              const result = await exec(isMigration ? migrate(sql) : readOnlySql(sql), 180_000);
              output = clip(result.stdout + result.stderr);
              const took = (result.ms / 1000).toFixed(1);
              const ms = measuredMs(output);
              if (result.exitCode !== 0) {
                const error = output.split('\n').find((l) => l.includes('ERROR')) ?? `exit ${result.exitCode}`;
                log.warn(`${block.name} failed after ${took} s: ${error}`);
              } else {
                log.info(`${block.name} ok after ${took} s${ms !== undefined ? `, psql measured ${ms} ms` : ''}`);
              }
              if (isMigration && result.exitCode === 0) {
                migration += `\n${sql.trim()}`;
                log.info(`Migration is now ${migration.trim().split('\n').length} lines`);
              }
              await emit({
                id: `c${k}-sql-${block.id}`,
                type: 'sql',
                k,
                kind: isMigration ? 'migration' : 'query',
                sql,
                output,
                exitCode: result.exitCode,
                ms: measuredMs(output),
              });
              output = `exit code ${result.exitCode}\n${output}`;
            }
          }
          results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
        }
        messages.push({ role: 'user', content: results });
      }

      // out of turns or tokens: judge whatever the migration holds, with the original query
      if (!submission) {
        log.warn(`Out of turns or tokens after ${turns} turns and ${outputTokens} output tokens; judging the migration as it stands`);
        submission = { query: QUERY, migration: migration.trim(), notes: `No submission after ${turns} turns.` };
        await emit({ id: `c${k}-submit`, type: 'submit', k, submission });
      }
      await call({ op: 'kill', sandboxId, template: IMAGE });
      log.info(`Sandbox ${sandboxId} killed`);

      await emit({ id: `c${k}-status-judge`, type: 'status', k, text: 'Waiting for the judge' });
      log.info('Queued for the judge, which runs one submission at a time');
      const verdict = (await ctx.spawnChild(
        raceJudge,
        {
          raceId,
          label: String(k),
          query: submission.query,
          migration: submission.migration,
          runs: JUDGE_RUNS,
          expected: input.baseline.fingerprint,
        },
        raceMetadata(raceId, { candidate: label, judged: label }),
      )) as Verdict;
      if (verdict.runId) await emit({ id: `c${k}-run-judge`, type: 'run', task: 'race-judge', runId: verdict.runId, k, label: 'judge' });
      if (!verdict.ok) log.warn(`Judge: the submission failed: ${verdict.error}`);
      else
        log.info(
          `Judge: ${verdict.medianMs} ms (baseline ${input.baseline.ms} ms, ${Math.round(input.baseline.ms / verdict.medianMs)}x), rows ${verdict.matches ? 'match' : 'DIFFER'}`,
        );
      await emit({ id: `c${k}-verdict`, type: 'verdict', k, verdict });
      return { k, submission, verdict, turns };
    } catch (error) {
      if (ctx.cancelled) throw error;
      // the race topic is what the consoles read, so a failure goes there too
      const message = error instanceof Error ? error.message : String(error);
      log.error(`${label} failed: ${message}`);
      await emit({ id: `c${k}-failed`, type: 'failed', k, error: message.slice(0, 1_000) });
      throw error;
    }
  },
});
