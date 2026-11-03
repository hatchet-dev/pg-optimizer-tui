// Starts the race TUI. Live by default: n starts a race through Hatchet. --attach <raceId> follows a race started
// elsewhere, such as the web console, and --replay [recording] plays a recording back without Hatchet or the Anthropic
// API: a race id from recordings/ (205e0931 by default), or a .jsonl path.
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { RACE_ID } from '../protocol.js';
import { App } from './app.js';
import { LiveSource, RECORDINGS, ReplaySource, type Source } from './source.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    replay: { type: 'boolean', default: false },
    attach: { type: 'string' },
    speed: { type: 'string', default: '1' },
  },
});
const replayArg = values.replay ? (positionals[0] ?? '205e0931') : undefined;

let source: Source;
if (replayArg !== undefined) {
  const file = replayArg.endsWith('.jsonl') ? path.resolve(replayArg) : path.join(RECORDINGS, `${replayArg}.jsonl`);
  source = new ReplaySource(file, Number(values.speed) || 1);
} else {
  if (values.attach && !RACE_ID.test(values.attach)) {
    console.error(`--attach takes a race id like 205e0931, not ${values.attach}`);
    process.exit(2);
  }
  // the client logs to the console, which would draw over the TUI
  process.env.HATCHET_CLIENT_LOG_LEVEL ??= 'ERROR';
  source = new LiveSource(values.attach);
}

const app = render(<App source={source} autoStart={source.mode === 'replay' || !!values.attach} />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  maxFps: 20,
});
await app.waitUntilExit();
// the Hatchet client keeps gRPC connections open
process.exit(0);
