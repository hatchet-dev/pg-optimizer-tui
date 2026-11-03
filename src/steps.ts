// The small tasks a candidate runs as durable children, so a replay reads their stored results instead of running
// them again: one model turn, and one read of the candidate's steering inbox.
import Anthropic from '@anthropic-ai/sdk';
import '@hatchet-dev/sandbox';
import type { JsonObject } from '@hatchet-dev/typescript-sdk/v1';
import { hatchet } from './client.js';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

const MODEL = process.env.RACE_MODEL ?? 'claude-opus-5-5';
const decoder = new TextDecoder();

// created on first use, so the worker starts without a key
let anthropic: Anthropic | undefined;

export type LlmTurnInput = { system: string; tools: Anthropic.Beta.Messages.BetaTool[]; messages: BetaMessageParam[]; effort?: 'low' | 'medium' };
export type LlmTurnOutput = {
  content: BetaContentBlock[];
  stopReason: string | null;
  usage: { input: number; output: number };
  /** This turn's task run, for a dashboard link. */
  runId: string;
};

export const raceLlmTurn = hatchet.task({
  name: 'race-llm-turn',
  executionTimeout: '5m',
  retries: 2,
  // Hatchet payloads are JSON objects, so the Anthropic types are cast at this boundary.
  fn: async (payload: JsonObject, ctx): Promise<JsonObject> => {
    const input = payload as unknown as LlmTurnInput;
    anthropic ??= new Anthropic();
    ctx.logger.info(`Calling ${MODEL} with ${input.messages.length} messages and tools ${input.tools.map((t) => t.name).join(', ')}`);
    const started = Date.now();
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 8_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: input.effort ?? 'low' },
      cache_control: { type: 'ephemeral' },
      system: input.system,
      tools: input.tools,
      messages: input.messages,
    });
    const output: LlmTurnOutput = {
      content: response.content,
      stopReason: response.stop_reason,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      runId: ctx.taskRunExternalId(),
    };
    const u = response.usage;
    ctx.logger.info(
      `${response.model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s: stop ${response.stop_reason}, tokens in ${u.input_tokens} (cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}) out ${u.output_tokens}`,
    );
    for (const block of response.content) {
      if (block.type === 'tool_use') ctx.logger.info(`Tool call ${block.name}: ${JSON.stringify(block.input).slice(0, 300)}`);
      else if (block.type === 'text' && block.text) ctx.logger.info(`Text: ${block.text.slice(0, 300)}`);
      else if (block.type === 'thinking' && block.thinking) ctx.logger.debug(`Thinking: ${block.thinking.slice(0, 300)}`);
    }
    return output as unknown as JsonObject;
  },
});

export type InboxRead = { messages: string[]; cursor?: string };

/** Returns the messages published to `topic` after `cursor`, without waiting for new ones. */
export const raceReadInbox = hatchet.task({
  name: 'race-read-inbox',
  executionTimeout: '1m',
  retries: 2,
  fn: async (input: { topic: string; cursor?: string }, ctx): Promise<InboxRead> => {
    let latest: string | undefined;
    try {
      latest = (await hatchet.streams.topicMetadata(input.topic)).latestCursor;
    } catch {
      // nothing was ever published to the inbox
      ctx.logger.info(`Topic ${input.topic} has no messages yet`);
      return { messages: [], cursor: input.cursor };
    }
    if (!latest || latest === input.cursor) {
      ctx.logger.info(`No new messages on ${input.topic}`);
      return { messages: [], cursor: input.cursor };
    }

    const messages: string[] = [];
    const abort = new AbortController();
    let cursor = input.cursor;
    for await (const event of hatchet.streams.events(input.topic, { cursor: input.cursor, signal: abort.signal })) {
      messages.push(decoder.decode(event.payload));
      cursor = event.cursor;
      if (event.cursor === latest) break;
    }
    ctx.logger.info(`Read ${messages.length} operator message(s) from ${input.topic}`);
    for (const message of messages) ctx.logger.info(`Operator: ${message.slice(0, 300)}`);
    return { messages, cursor };
  },
});

export type SandboxCall =
  | { op: 'create'; sandboxId: string; template: string; metadata: Record<string, string> }
  | { op: 'exec'; sandboxId: string; template: string; cmd: string; timeoutMs: number }
  | { op: 'kill'; sandboxId: string; template: string };
export type SandboxResult = { stdout: string; stderr: string; exitCode: number; ms: number };

/**
 * One call to a candidate's sandbox. The candidate runs each as a durable child, so a replay reads the stored result
 * instead of running the SQL again: psql's timings differ from run to run, and a different tool result would make the
 * next model turn's input differ from the one in the event log.
 */
export const raceSandbox = hatchet.task({
  name: 'race-sandbox',
  executionTimeout: '5m',
  // a migration isn't safe to run twice
  retries: 0,
  fn: async (input: SandboxCall, ctx): Promise<SandboxResult> => {
    const started = Date.now();
    const done = (result: Omit<SandboxResult, 'ms'>): SandboxResult => ({ ...result, ms: Date.now() - started });
    if (input.op === 'create') {
      await hatchet.sandbox.create({ id: input.sandboxId, template: input.template, metadata: input.metadata });
      ctx.logger.info(`Created sandbox ${input.sandboxId} from ${input.template}`);
      return done({ stdout: '', stderr: '', exitCode: 0 });
    }
    const sandbox = await hatchet.sandbox.connect(input.sandboxId, { template: input.template });
    if (input.op === 'kill') {
      await sandbox.kill();
      ctx.logger.info(`Killed sandbox ${input.sandboxId}`);
      return done({ stdout: '', stderr: '', exitCode: 0 });
    }
    ctx.logger.info(`Running in ${input.sandboxId}:\n${input.cmd.slice(0, 2_000)}`);
    const result = await sandbox.exec(input.cmd, { timeoutMs: input.timeoutMs });
    if (typeof result.stdout !== 'string') throw new Error(`the sandbox returned no output (exit code ${result.exitCode})`);
    const summary = `Exit ${result.exitCode} after ${((Date.now() - started) / 1000).toFixed(1)} s:\n${(result.stdout + result.stderr).slice(-2_000)}`;
    if (result.exitCode === 0) ctx.logger.info(summary);
    else ctx.logger.warn(summary);
    return done({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  },
});
