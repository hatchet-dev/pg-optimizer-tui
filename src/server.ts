// Serves the race console. It starts races, relays a race's topic to the browser as server-sent events, and passes
// the operator's steering and pick on. The SSE event id is the stream cursor, so the browser's reconnect
// (Last-Event-ID) resumes right after the last event it saw, and a new page replays the race from its first event.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { hatchet } from './client.js';
import { raceMission } from './mission.js';
import { CANDIDATES, PICK_EVENT, RACE_ID, raceMetadata, raceTopic, steerTopic } from './protocol.js';

const PORT = Number(process.env.PORT ?? 3335);
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const decoder = new TextDecoder();

const Candidate = z.number().int().min(0).max(CANDIDATES.length - 1);
const Steer = z.object({ candidate: Candidate, text: z.string().trim().min(1).max(500) });
const Pick = z.object({ candidate: Candidate });

const app = express();
app.use(express.json({ limit: '10kb' }));

app.get('/', (_req, res) => res.sendFile(PAGE));

app.post('/api/races', async (_req, res) => {
  const raceId = randomUUID().replaceAll('-', '').slice(0, 8);
  const run = await raceMission.runNoWait({ raceId }, raceMetadata(raceId));
  res.status(201).json({ raceId, runId: await run.getWorkflowRunId() });
});

app.param('raceId', (_req, res, next, value) => {
  if (RACE_ID.test(value)) next();
  else res.status(404).end();
});

app.post('/api/races/:raceId/steer', async (req, res) => {
  const parsed = Steer.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  await hatchet.streams.publish(steerTopic(req.params.raceId, parsed.data.candidate), parsed.data.text);
  res.status(202).json({});
});

app.post('/api/races/:raceId/pick', async (req, res) => {
  const parsed = Pick.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  await hatchet.events.push(PICK_EVENT, { raceId: req.params.raceId, candidate: parsed.data.candidate });
  res.status(202).json({});
});

app.get('/api/races/:raceId/events', async (req, res) => {
  const resumeFrom = req.get('last-event-id');
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: meta\ndata: ${JSON.stringify({ resumed: !!resumeFrom })}\n\n`);
  try {
    for await (const event of hatchet.streams.events(raceTopic(req.params.raceId), {
      cursor: resumeFrom || undefined,
      signal: abort.signal,
    })) {
      res.write(`id: ${event.cursor}\ndata: ${decoder.decode(event.payload)}\n\n`);
    }
  } catch (error) {
    if (!abort.signal.aborted) console.error(`race ${req.params.raceId}:`, error);
  }
  // the engine hangs up idle subscriptions; ending here lets the browser reconnect from its cursor
  res.end();
});

app.listen(PORT, () => console.log(`query race console on http://localhost:${PORT}`));
