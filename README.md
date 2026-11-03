# Postgres query optimizer race

Four Claude agents race to make one slow Postgres query fast. Each agent gets its own Postgres sandbox and one strategy:

| Agent | May change |
|---|---|
| Settings | server settings (`ALTER SYSTEM`) |
| Rewrite | the query text |
| Indexes | indexes |
| Open | the query, indexes and settings, in any combination |

A judge measures every submission on a fresh copy of the database and rejects it if a single row differs from the original query's. The race ranks the verdicts, and the operator picks the winner.

The whole race runs as [Hatchet](https://hatchet.run) durable tasks. Every model turn, sandbox command and judgement is a step in a task's event log, so you can kill the worker mid-race and the next one carries on where it stopped. Everything the race does is published to one Hatchet stream, which the web console and the terminal console follow live.

## The puzzle

The query lists the fraud review queue: big orders from the last 7 days that are the customer's first order.

```sql
SELECT o.id, o.customer_id, c.email, c.region, o.amount, o.created_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE date_trunc('day', o.created_at) >= date '2026-10-30' - 7
  AND o.amount > 450
  AND o.status <> 'cancelled'
  AND o.created_at = (SELECT min(o2.created_at) FROM orders o2
                      WHERE o2.customer_id = o.customer_id)
ORDER BY o.amount DESC
```

On 200k customers and 1M orders it takes about 15 to 25 s: the correlated `min()` scans `orders` once per candidate row. Each strategy has a different floor:

- **Indexes** can index the `min()` lookup, but not the date filter: `date_trunc` on a `timestamptz` isn't immutable, so Postgres refuses to index it. That leaves about 20 to 40 ms.
- **Rewrite** can make the date filter a plain range and turn the `min()` into an anti-join, but without indexes both still scan the table: about 80 to 350 ms.
- **Open** can do both, and gets down to about 2 to 7 ms.
- **Settings** can't change the plan's shape and stays near the baseline.

## Requirements

- Node.js 22.9 or later, and pnpm
- Docker, for the sandbox image and the sandboxes
- A Hatchet engine that accepts sandbox providers, with a tenant API token. On a self-hosted engine, set `SERVER_GRPC_OPERATORS_ENABLED`.
- [brickie](https://github.com/hatchet-dev/brickie), the sandbox provider. It runs the sandboxes as containers on your Docker engine.
- An Anthropic API key

## Run it

```bash
pnpm install
pnpm image                 # builds pgrace-seed:shop: Postgres 17 with the seeded database baked in
cp .env.example .env       # then set HATCHET_CLIENT_TOKEN and ANTHROPIC_API_KEY
```

Start the sandbox provider with the same token, in its own terminal:

```bash
HATCHET_CLIENT_TOKEN=... brickie worker
```

Then start the race worker, and a console:

```bash
pnpm worker                # serves the race tasks
pnpm web                   # the web console on http://localhost:3335
pnpm tui                   # or the terminal console: press n to start a race
```

You can watch a recorded race without Hatchet, Docker or an API key:

```bash
pnpm tui --replay                     # plays recordings/205e0931.jsonl at its real pace
pnpm tui --replay 205e0931 --speed 4
```

## How it works

| Task | File | What it does |
|---|---|---|
| `race-mission` | `src/mission.ts` | Durable. Judges the original query, races the four candidates with `spawnChildren`, ranks their verdicts, and waits for the `race:pick` event. After 10 minutes without a pick, the fastest correct submission wins. One mission runs at a time; the next one queues. |
| `race-candidate` | `src/candidate.ts` | Durable: one agent's loop. Before each model turn it reads the operator's messages from its steering topic, `race-<race>-steer-<k>`. |
| `race-llm-turn` | `src/steps.ts` | One call to Claude. |
| `race-read-inbox` | `src/steps.ts` | Reads the operator's new steering messages. |
| `race-sandbox` | `src/steps.ts` | One call to an agent's sandbox: create, exec or kill. Running each as a child task makes a replay read the stored result instead of running the SQL again. |
| `race-judge` | `src/judge.ts` | Applies a migration in a fresh sandbox, fingerprints the rows, and takes the median of 3 warm runs. One judge runs at a time across the tenant, so timings don't compete for the CPU. |

Everything the race does goes to the stream topic `race-<race>`, in order: statuses, the agents' thinking, every SQL statement and its output, submissions, verdicts and the result. The web console relays it as server-sent events with the stream cursor as the event id, so a reload resumes where it was and a new page replays the race from its first event. Every run of a race carries `race=<race id>` metadata, and the tasks log each step with `ctx.logger`, so the Hatchet dashboard shows what each one did.

The database lives in the `pgrace-seed:shop` image, outside the sandbox workspace (`dataset/`). brickie snapshots the workspace after every call, so a database in it would cost about 10 s per call instead of 0.1 s. The workspace holds only `migration.sql`, which a sandbox restored after a crash replays.

Token guards: tool output is clipped to 4,000 characters, and each agent gets at most 10 turns and 30k output tokens at low effort, except Open, which gets 16 turns and 60k output tokens at medium effort. `RACE_MODEL` overrides the model, `claude-opus-5-5`.

### The crash test

Start a race, kill `pnpm worker` while the agents are working, and start it again. The durable tasks replay their finished steps from the event log, without calling Claude or the sandboxes again, and the race continues.

## The terminal console

`pnpm tui` is a full-screen terminal app built with [Ink](https://github.com/vadimdemedes/ink). The left pane shows the mission: the query and baseline, the race stream as it arrives, the Hatchet task tree, a log-scale chart of each agent's best time, and the verdicts. The right side has one pane per agent sandbox, with its thinking, SQL, psql output, submission and verdict.

```bash
pnpm tui                       # live: press n to start a race
pnpm tui --attach <race id>    # follow a race started elsewhere, such as the web console
pnpm tui --replay [race id]    # play back a recording from recordings/
```

| Key | Action |
|---|---|
| `n` | start a race (restart, in a replay) |
| `1`-`4`, `←` `→` | focus an agent's pane |
| `Tab`, `Shift-Tab` | select a dashboard link: the focused pane's runs and steering topic, then the mission's |
| `o` | open the selected link in the browser |
| `z` | zoom the focused pane |
| `s` | send a message to the focused agent |
| `p` | pick the focused agent as the winner |
| `↑` `↓`, `PgUp` `PgDn`, `G` | scroll the focused pane |
| `[` `]` | replay speed |
| `q` | quit |

Links are also clickable in terminals that support OSC 8 hyperlinks (iTerm2, Ghostty, WezTerm, kitty). Their base URL and tenant come from the token; `HATCHET_DASHBOARD_URL` and `HATCHET_TENANT_ID` override them. Live mode records every race it shows to `recordings/<race id>.jsonl`, which `--replay <race id>` plays back. A replay waits for your pick before it shows the result.

## Files

```
src/
  worker.ts      the worker: registers every race task
  mission.ts     race-mission
  candidate.ts   race-candidate: the agent loop, its tools and its prompt
  judge.ts       race-judge
  steps.ts       race-llm-turn, race-read-inbox, race-sandbox
  pg.ts          the shell and SQL the sandboxes run
  protocol.ts    the query, the strategies, the stream topics and event shapes
  server.ts      the web console (index.html)
  tui/           the terminal console
dataset/         the sandbox image: Postgres 17 seeded with skewed shop data
recordings/      a recorded race for --replay
```
