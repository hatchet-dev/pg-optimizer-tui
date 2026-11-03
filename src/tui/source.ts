// Where the TUI's events come from. Live talks to Hatchet: it starts a race (or attaches to one), follows the race
// topic, and records it. Replay plays a recording back at its real pace, without Hatchet or the Anthropic API.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PICK_EVENT, type RaceEvent, raceMetadata, raceTopic, steerTopic, type Submission, type Verdict } from '../protocol.js';

export const RECORDINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'recordings');

export type Sink = {
  event: (event: RaceEvent, at: number) => void;
  started: (raceId: string, runId?: string) => void;
  info: (text: string) => void;
};

export interface Source {
  readonly mode: 'live' | 'replay';
  /** Starts a new race, or the recording, and feeds its events to the sink. */
  start(sink: Sink): Promise<void>;
  steer(k: number, text: string): Promise<void>;
  /** The lane's submission and verdict are what a replay's result carries when the pick differs from the recording's. */
  pick(k: number, lane: { submission?: Submission; verdict?: Verdict }, baselineMs: number): Promise<void>;
  /** Replay speed, or undefined when live. */
  speed?: number;
  setSpeed?(speed: number): void;
  stop(): void;
}

/** The time the engine stored an event, from its cursor (`v1:` + base64 JSON with `created_at`). */
function cursorTime(cursor: string): number | undefined {
  try {
    const meta = JSON.parse(Buffer.from(cursor.split(':', 2)[1], 'base64url').toString()) as { created_at?: string };
    return meta.created_at ? Date.parse(meta.created_at) : undefined;
  } catch {
    return undefined;
  }
}

export class LiveSource implements Source {
  readonly mode = 'live';
  private abort = new AbortController();
  private raceId?: string;

  constructor(private attachTo?: string) {}

  async start(sink: Sink) {
    // imported here, so a replay runs without a Hatchet token
    const { hatchet } = await import('../client.js');
    const { raceMission } = await import('../mission.js');

    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    let raceId = this.attachTo;
    this.attachTo = undefined;
    let runId: string | undefined;
    if (!raceId) {
      raceId = randomUUID().replaceAll('-', '').slice(0, 8);
      const run = await raceMission.runNoWait({ raceId }, raceMetadata(raceId));
      runId = await run.getWorkflowRunId();
    }
    this.raceId = raceId;
    sink.started(raceId, runId);

    mkdirSync(RECORDINGS, { recursive: true });
    const recording = path.join(RECORDINGS, `${raceId}.jsonl`);
    const decoder = new TextDecoder();

    // the engine hangs up idle subscriptions, so follow the topic from the last cursor until the race ends
    let cursor: string | undefined;
    let done = false;
    while (!signal.aborted && !done) {
      try {
        for await (const item of hatchet.streams.events(raceTopic(raceId), { cursor, signal })) {
          cursor = item.cursor;
          const event = JSON.parse(decoder.decode(item.payload)) as RaceEvent;
          const at = cursorTime(item.cursor) ?? Date.now();
          appendFileSync(recording, `${JSON.stringify({ at: new Date(at).toISOString(), event })}\n`);
          sink.event(event, at);
          if (event.type === 'result' || (event.type === 'failed' && event.k === undefined)) done = true;
        }
      } catch (error) {
        if (signal.aborted) return;
        sink.info(`stream: ${error instanceof Error ? error.message : String(error)}; reconnecting`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  async steer(k: number, text: string) {
    if (!this.raceId) return;
    const { hatchet } = await import('../client.js');
    await hatchet.streams.publish(steerTopic(this.raceId, k), text);
  }

  async pick(k: number) {
    if (!this.raceId) return;
    const { hatchet } = await import('../client.js');
    await hatchet.events.push(PICK_EVENT, { raceId: this.raceId, candidate: k });
  }

  stop() {
    this.abort.abort();
  }
}

type Recorded = { at: string; event: RaceEvent };

export class ReplaySource implements Source {
  readonly mode = 'replay';
  private items: Recorded[];
  private timer?: NodeJS.Timeout;
  private index = 0;
  /** Recording time (ms) the playback has reached, and the wall clock when it got there. */
  private clock = { recorded: 0, wall: 0 };
  private sink?: Sink;
  private held?: Extract<RaceEvent, { type: 'result' }>;

  private raceId: string;

  constructor(
    file: string,
    public speed = 1,
  ) {
    // recordings are named after their race
    this.raceId = path.basename(file, '.jsonl');
    this.items = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Recorded);
  }

  async start(sink: Sink) {
    this.stop();
    this.sink = sink;
    this.index = 0;
    this.held = undefined;
    const first = this.items[0];
    sink.started(this.raceId);
    this.clock = { recorded: first ? Date.parse(first.at) : 0, wall: Date.now() };
    this.schedule();
  }

  /** The recording time playback is at now, which the TUI's clock shows instead of the wall clock. */
  now(): number {
    return this.clock.recorded + (Date.now() - this.clock.wall) * this.speed;
  }

  private schedule() {
    const item = this.items[this.index];
    if (!item || !this.sink) return;
    // the operator makes the pick, so the recorded result waits for one
    if (item.event.type === 'result') {
      this.held = item.event;
      return;
    }
    const due = Date.parse(item.at);
    this.timer = setTimeout(
      () => {
        this.clock = { recorded: Math.max(due, this.now()), wall: Date.now() };
        this.sink?.event(item.event, due);
        this.index += 1;
        this.schedule();
      },
      Math.max(0, (due - this.now()) / this.speed),
    );
  }

  setSpeed(speed: number) {
    this.clock = { recorded: this.now(), wall: Date.now() };
    this.speed = speed;
    if (this.timer) {
      clearTimeout(this.timer);
      this.schedule();
    }
  }

  async steer() {
    this.sink?.info('Steering needs a live race; this is a replay.');
  }

  async pick(k: number, lane: { submission?: Submission; verdict?: Verdict }, baselineMs: number) {
    const held = this.held;
    if (!held || !this.sink) return;
    this.held = undefined;
    // the same result the mission would publish for this pick
    const result: RaceEvent =
      k === held.k || !lane.submission || !lane.verdict
        ? { ...held, reason: 'picked' }
        : { id: 'result', type: 'result', k, reason: 'picked', submission: lane.submission, verdict: lane.verdict, baselineMs };
    const at = this.now();
    this.clock = { recorded: at, wall: Date.now() };
    this.sink.event(result, at);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
