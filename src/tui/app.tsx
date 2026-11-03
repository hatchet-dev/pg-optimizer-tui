// The race as a tmux-style TUI: the mission on the left, one pane per agent sandbox on the right.
import { Box, Text, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AXE, BANNER_NARROW_ROWS, BANNER_ROWS, BANNER_W, CAT, HATCHET_BIG, HATCHET_SMALL, QUERY_RACE } from './banner.js';
import { raceTopic, steerTopic } from '../protocol.js';
import { dashboardEnabled, hyperlink, type Link, openInBrowser, pickEventsUrl, raceRunsUrl, runUrl, topicUrl, workersUrl } from './links.js';
import type { ReplaySource, Source } from './source.js';
import { type Entry, initialState, type Lane, note, type RaceState, reduce } from './state.js';

// The palette of the Hatchet intro video: copper, rust and gold for the warm parts, steel and ice blue for the cold
// ones, on a near-black navy.
const BG = '#0a0e14';
const COPPER = '#e07a50';
const GOLD = '#c99550';
const STEEL = '#5b8fd6';
const ICE = '#b8cde6';
const PURPLE = '#a873d6';
const LILAC = '#c9a0e8';
const SAND = '#e8c79a';
const STAR = '#f2c66d';
const TEXT = '#e3e8ee';
const MUTED = '#6c798d';
const DIM = '#2c3748';
const GOOD = '#a8c95a';
const BAD = '#e5534b';
const WARN = '#e8c468';
const BRAND = ICE;
const LANE_COLORS = [COPPER, STEEL, PURPLE, GOLD];
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPEEDS = [1, 2, 4, 8, 16];

// ── formatting ──────────────────────────────────────────────────────────────

export function fmtMs(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return '–';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  return `${Math.round(n / 1000 ** i)} ${units[i]}`;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Hard-wraps text to `width` columns, breaking at spaces when it can. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, '  ').split('\n')) {
    let line = raw.trimEnd();
    if (!line) {
      out.push('');
      continue;
    }
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut < width / 2) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    out.push(line);
  }
  return out;
}

const pad = (text: string, width: number) => (text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length));
const padStart = (text: string, width: number) => (text.length >= width ? text.slice(0, width) : ' '.repeat(width - text.length) + text);

// ── log lines ───────────────────────────────────────────────────────────────

type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean; italic?: boolean; inverse?: boolean };
type Line = Seg[];

/** Wraps `text` under a prefix, keeping at most `max` lines. */
function block(prefix: Seg, text: string, style: Omit<Seg, 'text'>, width: number, max = Infinity): Line[] {
  const indent = ' '.repeat(prefix.text.length);
  let lines = wrap(text, Math.max(8, width - prefix.text.length));
  if (lines.length > max) lines = [...lines.slice(0, max - 1), `… ${lines.length - max + 1} more lines`];
  return lines.map((l, i) => [i === 0 ? prefix : { text: indent }, { text: l, ...style }]);
}

function entryLines(entry: Entry, width: number, color: string): Line[] {
  switch (entry.kind) {
    case 'status': {
      const turn = entry.text.match(/^Turn (\d+)/);
      if (turn) {
        const label = `─ turn ${turn[1]} `;
        return [[{ text: label + '─'.repeat(Math.max(0, width - label.length)), color, dim: true }]];
      }
      return block({ text: '▸ ', color }, entry.text, { color }, width);
    }
    case 'thinking':
      return block({ text: '∴ ', color: MUTED }, entry.text, { color: MUTED, italic: true }, width, 5);
    case 'message':
      return block({ text: '» ', color: TEXT, bold: true }, entry.text, { color: TEXT }, width, 6);
    case 'sql': {
      const tool = entry.migration ? 'apply_migration' : 'run_sql';
      const lines: Line[] = [[{ text: '$ ', color: entry.migration ? PURPLE : WARN, bold: true }, { text: tool, color: entry.migration ? PURPLE : WARN, bold: true }]];
      lines.push(...block({ text: '  ' }, entry.sql.trim(), { color: SAND }, width, 7));
      const output = entry.output
        .split('\n')
        .filter((l) => l.trim() && !/^(BEGIN|ROLLBACK|SET|Timing is on\.|QUERY PLAN|-+|\(\d+ rows?\)|Time: .*|Planning Time: .*|Execution Time: .*)$/.test(l.trim()))
        .join('\n');
      if (entry.exitCode !== 0) {
        lines.push(...block({ text: '✗ ', color: BAD, bold: true }, `exit ${entry.exitCode}  ${output.split('\n').filter((l) => /ERROR|error/.test(l)).join(' ') || output}`, { color: BAD }, width, 3));
      } else {
        lines.push(...block({ text: '│ ', color: MUTED, dim: true }, output, { color: MUTED, dim: true }, width, 4));
        if (entry.ms !== undefined) lines.push([{ text: '⏱ ', color: GOOD }, { text: fmtMs(entry.ms), color: GOOD, bold: true }]);
      }
      return lines;
    }
    case 'steer':
      return block({ text: '✉ operator › ', color: LILAC, bold: true }, entry.text, { color: LILAC, bold: true }, width);
    case 'submit': {
      const lines: Line[] = [[{ text: ' ⇪ SUBMITTED ', color: GOOD, bold: true, inverse: true }]];
      lines.push(...block({ text: '  ' }, entry.submission.notes, { color: TEXT }, width, 4));
      if (entry.submission.migration) lines.push(...block({ text: '  + ', color: GOOD }, entry.submission.migration, { color: GOOD }, width, 5));
      return lines;
    }
    case 'verdict': {
      const v = entry.verdict;
      if (!v.ok) return block({ text: '⚖ ', color: BAD, bold: true }, `judge failed: ${v.error ?? ''}`, { color: BAD }, width, 4);
      const ok = v.matches !== false;
      return [
        [
          { text: '⚖ judged ', color: ok ? GOOD : BAD, bold: true },
          { text: fmtMs(v.medianMs), color: ok ? GOOD : BAD, bold: true },
          { text: `  runs ${v.runsMs.join(' ')} ms`, color: MUTED },
        ],
        [
          { text: '  ' },
          { text: ok ? `✓ ${v.rows} rows match` : `✗ ${v.rows} rows: wrong result`, color: ok ? GOOD : BAD },
          { text: `  indexes ${fmtBytes(v.indexBytes)}`, color: MUTED },
        ],
      ];
    }
    case 'note':
      return block({ text: '· ', color: MUTED }, entry.text, { color: MUTED, italic: true }, width);
    case 'failed':
      return block({ text: '✗ FAILED ', color: BAD, bold: true }, entry.text, { color: BAD }, width, 6);
  }
}

function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.color} dimColor={s.dim} bold={s.bold} italic={s.italic} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

// ── panes ───────────────────────────────────────────────────────────────────

// Dotted borders, like the frames in the video; the focused pane's dots are heavier.
const DOTS = { topLeft: '·', top: '·', topRight: '·', right: ':', bottomRight: '·', bottom: '·', bottomLeft: '·', left: ':' };
const HEAVY_DOTS = { topLeft: '•', top: '•', topRight: '•', right: '┇', bottomRight: '•', bottom: '•', bottomLeft: '•', left: '┇' };

/** A box whose top border carries a title, the way tmux labels a pane. */
function Frame(props: {
  width: number;
  height: number;
  color: string;
  focused?: boolean;
  title: Seg[];
  right?: Seg[];
  children: React.ReactNode;
}) {
  const { width, height, color, focused } = props;
  const dots = focused ? HEAVY_DOTS : DOTS;
  const corner = [dots.topLeft, dots.topRight];
  const dash = dots.top;
  const titleLen = props.title.reduce((n, s) => n + s.text.length, 0) + 2;
  const rightLen = props.right ? props.right.reduce((n, s) => n + s.text.length, 0) + 2 : 0;
  const fill = Math.max(0, width - 3 - titleLen - rightLen - 1);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={color} bold={focused}>{`${corner[0]}${dash}`}</Text>
        <Text> </Text>
        {props.title.map((s, i) => (
          <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} inverse={s.inverse}>
            {s.text}
          </Text>
        ))}
        <Text> </Text>
        <Text color={color} bold={focused}>{dash.repeat(fill)}</Text>
        {props.right && (
          <>
            <Text> </Text>
            {props.right.map((s, i) => (
              <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
                {s.text}
              </Text>
            ))}
            <Text> </Text>
          </>
        )}
        <Text color={color} bold={focused}>{`${dash}${corner[1]}`}</Text>
      </Text>
      <Box
        borderStyle={dots}
        borderTop={false}
        borderColor={color}
        height={height - 1}
        width={width}
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
      >
        {props.children}
      </Box>
    </Box>
  );
}

function phaseLabel(lane: Lane, spin: string): Seg {
  switch (lane.phase) {
    case 'waiting':
      return { text: '○ waiting', color: MUTED };
    case 'sandbox':
      return { text: `${spin} booting sandbox`, color: WARN };
    case 'thinking':
      return { text: `${spin} turn ${lane.turns} thinking`, color: WARN };
    case 'sql':
      return { text: `${spin} turn ${lane.turns} in sandbox`, color: STEEL };
    case 'judging':
      return { text: `${spin} judging`, color: LILAC };
    case 'failed':
      return { text: '✗ failed', color: BAD, bold: true };
    case 'done':
      return lane.verdict?.ok && lane.verdict.matches !== false
        ? { text: `✓ ${fmtMs(lane.verdict.medianMs)}`, color: GOOD, bold: true }
        : { text: '✗ rejected', color: BAD, bold: true };
  }
}

/** Dashboard links as OSC 8 hyperlinks; the selected one is what o opens. */
function LinkRow({ links, selected, empty }: { links: Link[]; selected?: string; empty: string }) {
  if (!links.length) {
    return (
      <Text color={MUTED} dimColor>
        {`↗ ${empty}`}
      </Text>
    );
  }
  return (
    <Box overflow="hidden">
      {links.map((link) => (
        <Box key={link.key} marginRight={1} flexShrink={0}>
          <Text color={link.key === selected ? BG : ICE} backgroundColor={link.key === selected ? ICE : undefined} underline={link.key !== selected}>
            {hyperlink(link.url, `↗ ${link.label}`)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function AgentPane(props: {
  lane: Lane;
  raceId?: string;
  width: number;
  height: number;
  focused: boolean;
  winner: boolean;
  scroll: number;
  spin: string;
  frame: number;
  links: Link[];
  selected?: string;
}) {
  const { lane, width, height, focused, scroll } = props;
  const color = LANE_COLORS[lane.k];
  const inner = width - 4;
  const lines = useMemo(() => lane.entries.flatMap((e) => entryLines(e, inner, color)), [lane.entries, inner, color]);
  const room = Math.max(1, height - 5);
  const end = Math.max(0, lines.length - scroll);
  const visible = lines.slice(Math.max(0, end - room), end);
  const hidden = lines.length - end;
  const sandbox = props.raceId ? `race-${props.raceId}-c${lane.k}` : `sandbox c${lane.k}`;

  return (
    <Frame
      width={width}
      height={height}
      color={color}
      focused={focused}
      title={[
        { text: ` ${lane.k + 1} `, color, bold: true, inverse: true },
        { text: ` ${lane.label.toUpperCase()}`, color, bold: true },
        ...(props.winner ? [{ text: ' ★ WINNER', color: STAR, bold: true }] : []),
        { text: `  ⧉ ${sandbox}`, color: MUTED },
      ]}
      right={[phaseLabel(lane, props.spin)]}
    >
      <Text wrap="truncate">
        <Text color={MUTED}>{lane.strategy.padEnd(9)}</Text>
        <Text color={MUTED}>turns </Text>
        <Text bold>{lane.turns}</Text>
        <Text color={MUTED}>  tok in </Text>
        <Text bold>{fmtTokens(lane.tokensIn)}</Text>
        <Text color={MUTED}> out </Text>
        <Text bold>{fmtTokens(lane.tokensOut)}</Text>
        <Text color={MUTED}>  exec </Text>
        <Text bold>{lane.execs}</Text>
        <Text color={MUTED}>  best </Text>
        <Text bold color={lane.best !== undefined ? GOOD : undefined}>
          {fmtMs(lane.best)}
        </Text>
        {hidden > 0 && <Text color={WARN}>{`  ↓ ${hidden} newer`}</Text>}
      </Text>
      <LinkRow links={props.links} selected={props.selected} empty={dashboardEnabled ? 'no runs yet' : 'set HATCHET_CLIENT_TOKEN for dashboard links'} />
      {visible.length === 0 && <Text color={MUTED}>{'   waiting for the race to start this agent…'}</Text>}
      {visible.map((line, i) => (
        <LineView key={`${end}-${i}`} line={line} />
      ))}
      <Starfield width={inner} height={room - Math.max(1, visible.length)} frame={props.frame} seed={lane.k + 1} />
    </Frame>
  );
}

const hash = (a: number, b: number, c: number) => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

/** Faint stars that twinkle, filling empty space the way the video's background does. */
function Starfield({ width, height, frame, seed }: { width: number; height: number; frame: number; seed: number }) {
  if (height <= 0) return null;
  const rows: Line[] = [];
  for (let y = 0; y < height; y++) {
    const line: Line = [];
    let gap = '';
    for (let x = 0; x < width; x++) {
      const h = hash(seed, x, y);
      // about one cell in 45 holds a star, and each one goes out briefly on its own beat
      if (h % 45 !== 0 || (frame + (h >>> 8)) % 50 < 4) {
        gap += ' ';
        continue;
      }
      if (gap) line.push({ text: gap });
      gap = '';
      const bright = (h >>> 12) % 7 === 0;
      line.push({ text: ".·:;'"[(h >>> 4) % 5], color: bright ? ICE : (h >>> 16) % 2 ? MUTED : DIM });
    }
    rows.push(line);
  }
  return (
    <>
      {rows.map((line, i) => (
        <LineView key={i} line={line.length ? line : [{ text: ' ' }]} />
      ))}
    </>
  );
}

// ── left column ─────────────────────────────────────────────────────────────

function highlightSql(line: string): Seg[] {
  const keywords = /\b(SELECT|FROM|JOIN|ON|WHERE|AND|ORDER BY|DESC|date_trunc|date|min)\b/g;
  const segs: Seg[] = [];
  let last = 0;
  for (const m of line.matchAll(keywords)) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), color: TEXT });
    segs.push({ text: m[0], color: BRAND, bold: true });
    last = m.index + m[0].length;
  }
  segs.push({ text: line.slice(last), color: TEXT });
  return segs.map((s) => (/'[^']*'/.test(s.text) ? { ...s, color: SAND } : s));
}

/** Splits `row` into runs of one colour each. */
function paint(row: string, color: (ch: string, x: number) => string | undefined): Line {
  const line: Line = [];
  [...row].forEach((ch, x) => {
    const c = color(ch, x);
    const last = line[line.length - 1];
    if (last && last.color === c) last.text += ch;
    else line.push({ text: ch, color: c });
  });
  return line;
}

// the handle is wood, the blade ice with a couple of duller % like the video's, and the edge white
const axeColor = (y: number) => (ch: string, x: number) => {
  if (x < 3) return ch === ':' ? '#8a5e30' : GOLD;
  if (ch === '%') return (x + y * 3) % 11 === 0 ? MUTED : ICE;
  if (ch === '|') return TEXT;
  if (ch === '=') return ICE;
  return MUTED;
};

// the cat: the hatchet it holds in ice and wood, its head pale, its body copper, its legs steel
const catColor = (y: number) => (_ch: string, x: number) => {
  if (y >= 1 && y <= 5 && x <= 12) return x < 4 ? STEEL : ICE;
  if (y >= 2 && y <= 5 && x <= 15) return GOLD;
  return y <= 3 ? '#c5cbd0' : y <= 6 ? COPPER : STEEL;
};

const LETTER_SHADES = [TEXT, '#d3dce6', ICE, '#a3bcd9'];

function Banner(props: { wide: boolean; tiny: boolean; cat: boolean; mode: string; raceId?: string; clock: string; speed?: number; status: string; frame: number }) {
  return (
    <Box paddingX={1}>
      <Box flexDirection="column" width={props.cat ? BANNER_W : undefined} flexShrink={props.cat ? 0 : 1}>
        {props.tiny ? <TypedStatus status={props.status} frame={props.frame} /> : props.wide ? <WideBanner {...props} /> : <NarrowBanner {...props} />}
      </Box>
      {props.cat && (
        <Box flexDirection="column" marginLeft={2} flexShrink={0}>
          {CAT.map((row, i) => (
            <LineView key={i} line={paint(row, catColor(i))} />
          ))}
        </Box>
      )}
    </Box>
  );
}

type BannerProps = { mode: string; raceId?: string; clock: string; speed?: number; status: string; frame: number };

function ModeBadge({ mode, speed }: { mode: string; speed?: number }) {
  return (
    <Text color={BG} backgroundColor={mode === 'live' ? BAD : WARN} bold>
      {mode === 'live' ? ' ● LIVE ' : ` ▶ REPLAY ${speed}× `}
    </Text>
  );
}

/** The status, typed out a few characters a frame behind a blinking block cursor, like the video's captions. */
function TypedStatus({ status, frame }: { status: string; frame: number }) {
  const typed = useRef({ text: status, at: frame });
  if (typed.current.text !== status) typed.current = { text: status, at: frame };
  const shown = Math.max(0, frame - typed.current.at) * 3;
  const cursor = shown < status.length || frame % 8 < 4;
  return (
    <Text wrap="truncate">
      <Text color={/^(Could not|Race failed)/.test(status) ? BAD : TEXT}>{`» ${status.slice(0, shown)}`}</Text>
      <Text color={ICE}>{cursor ? '█' : ' '}</Text>
    </Text>
  );
}

function WideBanner({ mode, raceId, clock, speed, status, frame }: BannerProps) {
  return (
    <Box>
      <Box flexDirection="column" marginRight={2} flexShrink={0}>
        {AXE.map((row, i) => (
          <LineView key={i} line={paint(row, axeColor(i))} />
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        {HATCHET_BIG.map((row, i) => (
          <Text key={i} color={LETTER_SHADES[i]} wrap="truncate">
            {row}
          </Text>
        ))}
        {QUERY_RACE.map((row, i) => (
          <Text key={i} color={[COPPER, '#d86c45', '#c95f3c'][i]} wrap="truncate">
            {row}
          </Text>
        ))}
        <Text wrap="truncate">
          <ModeBadge mode={mode} speed={speed} />
          <Text color={MUTED}> race </Text>
          <Text bold color={TEXT}>
            {raceId ?? '········'}
          </Text>
          <Text color={MUTED}> elapsed </Text>
          <Text bold color={BRAND}>
            {clock}
          </Text>
        </Text>
        <TypedStatus status={status} frame={frame} />
      </Box>
    </Box>
  );
}

function NarrowBanner({ mode, raceId, clock, speed, status, frame }: BannerProps) {
  return (
    <>
      <Box>
        <Box flexDirection="column" marginRight={2} flexShrink={0}>
          {HATCHET_SMALL.map((row, i) => (
            <Text key={i} color={LETTER_SHADES[i]}>
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text wrap="truncate">
            <ModeBadge mode={mode} speed={speed} />
            <Text color={COPPER} bold>
              {' query race'}
            </Text>
          </Text>
          <Text wrap="truncate">
            <Text color={MUTED}>race </Text>
            <Text bold color={TEXT}>
              {raceId ?? '········'}
            </Text>
          </Text>
          <Text wrap="truncate">
            <Text color={MUTED}>elapsed </Text>
            <Text bold color={BRAND}>
              {clock}
            </Text>
          </Text>
        </Box>
      </Box>
      <TypedStatus status={status} frame={frame} />
    </>
  );
}

/** A section of the mission column, headed the way the video titles its frames: "·· NEW APPLICATION ·······". */
function Section({ title, width, color = MUTED, children, grow, right }: { title: string; width: number; color?: string; children: React.ReactNode; grow?: boolean; right?: Seg[] }) {
  return (
    <Box flexDirection="column" width={width} flexGrow={grow ? 1 : 0} flexShrink={grow ? 1 : 0} overflow="hidden">
      <Text wrap="truncate">
        <Text color={color}>{'·· '}</Text>
        <Text color={TEXT} bold>
          {title}
        </Text>
        <Text color={color}>{' ' + '·'.repeat(Math.max(0, width - title.length - 4 - (right ? right.reduce((n, s) => n + s.text.length, 0) + 1 : 0)))}</Text>
        {right?.map((s, i) => (
          <Text key={i} color={s.color} bold={s.bold}>
            {' '}
            {s.text}
          </Text>
        ))}
      </Text>
      <Box flexDirection="column" paddingLeft={1} overflow="hidden" flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function Mission({ state, width, queryLines }: { state: RaceState; width: number; queryLines: number }) {
  const b = state.baseline;
  return (
    <Section title="MISSION" width={width}>
      <Text wrap="truncate" color={TEXT}>
        {state.task ?? 'Press n to start a race.'}
      </Text>
      <Text wrap="truncate">
        <Text color={MUTED}>baseline </Text>
        {state.failed && !b?.ok ? (
          <Text color={BAD} bold>
            {`failed: ${state.failed.replace(/\s+/g, ' ')}`}
          </Text>
        ) : b?.ok ? (
          <>
            <Text color={BAD} bold>
              {fmtMs(b.medianMs)}
            </Text>
            <Text color={MUTED}>{`  ${b.rows} rows  md5 ${b.fingerprint.slice(0, 8)}  `}</Text>
            <Text color={MUTED}>{`full scans of orders: ${Math.max(0, ...[...b.plan.matchAll(/Seq Scan on orders.*loops=(\d+)/g)].map((m) => Number(m[1])))}`}</Text>
          </>
        ) : state.baselineRunning ? (
          <Text color={WARN}>judging the original query in a fresh sandbox…</Text>
        ) : (
          <Text color={MUTED}>–</Text>
        )}
      </Text>
      {(state.query ?? '').split('\n').slice(0, queryLines).map((line, i) => (
        <Text key={i} wrap="truncate">
          <Text color={MUTED}>{String(i + 1).padStart(2)} </Text>
          {highlightSql(line).map((s, j) => (
            <Text key={j} color={s.color} bold={s.bold}>
              {s.text}
            </Text>
          ))}
        </Text>
      ))}
    </Section>
  );
}

const FEED_COLORS: Record<string, string> = {
  thinking: MUTED,
  sql: WARN,
  submit: GOOD,
  verdict: GOOD,
  steer: LILAC,
  result: STAR,
  usage: STEEL,
};

/** The tail of the race topic, newest at the bottom: what every reader of the stream gets, in order. */
function Feed({ state, width, rows }: { state: RaceState; width: number; rows: number }) {
  const items = state.feed.slice(-Math.max(1, rows));
  const t0 = state.startedAt ?? 0;
  return (
    <Box flexDirection="column" justifyContent="flex-end" height={rows} overflow="hidden">
      {items.length === 0 ? (
        <Text color={MUTED} dimColor>
          {'   nothing on the topic yet'}
        </Text>
      ) : (
        items.map((item, i) => (
          <LineView
            key={state.feed.length - items.length + i}
            line={[
              { text: `+${fmtClock(item.at - t0).padStart(5)} `, color: MUTED },
              item.k === undefined ? { text: ' ◆ ', color: BRAND, bold: true } : { text: ` ${item.k + 1} `, color: LANE_COLORS[item.k], bold: true },
              { text: pad(item.type, 9), color: FEED_COLORS[item.type] ?? TEXT },
              { text: pad(item.text, Math.max(0, width - 20)), color: item.type === 'thinking' ? MUTED : TEXT, italic: item.type === 'thinking' },
            ]}
          />
        ))
      )}
    </Box>
  );
}

// ASCII icons in the video's style, for the kinds of task: the mission, a candidate's sandbox, an LLM turn, the judge,
// and the wait for the operator
const ICONS = { mission: '{%}', sandbox: '[%]', llm: '(:)', judge: '<%>', wait: '.:.' };
const icon = (kind: keyof typeof ICONS): Seg[] => {
  const [open, mid, close] = ICONS[kind];
  return [{ text: open, color: STEEL }, { text: mid, color: ICE, bold: true }, { text: close + ' ', color: STEEL }];
};

function TaskTree({ state, spin, clock }: { state: RaceState; spin: string; clock: string }) {
  const node = (done: boolean, running: boolean, label?: string): Seg =>
    done ? { text: label ?? '✓', color: GOOD } : running ? { text: spin, color: WARN } : { text: '○', color: MUTED };
  const started = state.events > 0;
  const raceDone = !!state.result;
  const rows: Seg[][] = [
    [
      ...icon('mission'),
      { text: 'race-mission ', color: BRAND, bold: true },
      { text: 'durable ', color: MUTED },
      { text: state.raceId ?? '', color: TEXT },
      { text: '  ' },
      state.failed ? { text: '✗ failed', color: BAD } : node(raceDone, started, '✓ done'),
      { text: ` ${clock}`, color: MUTED },
    ],
    [
      { text: '├─ ', color: MUTED },
      ...icon('judge'),
      { text: 'race-judge ', color: LILAC },
      { text: 'baseline   ', color: MUTED },
      state.baseline && !state.baseline.ok
        ? { text: '✗ failed', color: BAD }
        : node(!!state.baseline, state.baselineRunning, state.baseline ? `✓ ${fmtMs(state.baseline.medianMs)}` : undefined),
    ],
  ];
  for (const lane of state.lanes) {
    const color = LANE_COLORS[lane.k];
    const llm: Seg[] = [];
    for (let t = 1; t <= lane.turns; t++) llm.push(t <= lane.usageTurns ? { text: '■', color } : { text: spin, color: WARN });
    if (!llm.length) llm.push({ text: '·', color: MUTED });
    const judge = lane.verdict
      ? { text: lane.verdict.ok && lane.verdict.matches !== false ? '✓' : '✗', color: lane.verdict.ok && lane.verdict.matches !== false ? GOOD : BAD }
      : lane.phase === 'judging'
        ? { text: spin, color: WARN }
        : { text: '○', color: MUTED };
    rows.push([
      { text: '├─ ', color: MUTED },
      ...icon('sandbox'),
      lane.phase === 'failed' ? { text: '✗', color: BAD } : node(lane.phase === 'done', lane.phase !== 'waiting', '✓'),
      { text: ' race-candidate ', color },
      { text: pad(lane.label, 8), color, bold: true },
      { text: ' ' },
      ...icon('llm'),
      ...llm,
      { text: ` inbox ${lane.inboxReads} exec ${lane.execs} `, color: MUTED },
      ...icon('judge'),
      judge,
    ]);
  }
  rows.push([
    { text: '└─ ', color: MUTED },
    ...icon('wait'),
    { text: 'waitFor ', color: STEEL },
    { text: 'event race:pick | sleep 10m  ', color: MUTED },
    state.result
      ? { text: `✓ ${state.result.reason}`, color: GOOD }
      : state.waitingForPick
        ? { text: `${spin} waiting for operator`, color: WARN, bold: true }
        : { text: '○', color: MUTED },
  ]);
  return (
    <>
      {rows.map((r, i) => (
        <LineView key={i} line={r} />
      ))}
    </>
  );
}

function RaceChart({ state, width }: { state: RaceState; width: number }) {
  const label = 9;
  const valueW = 9;
  const barW = Math.max(10, width - label - valueW - 4);
  const lo = 0.5;
  const hi = Math.max(40_000, (state.baseline?.medianMs ?? 0) * 1.3);
  const x = (ms: number) => Math.round((Math.log10(Math.max(lo, ms) / lo) / Math.log10(hi / lo)) * barW);
  const baseX = state.baseline?.ok ? Math.min(barW - 1, x(state.baseline.medianMs)) : undefined;
  const ticks = [1, 10, 100, 1000, 10_000];
  let axis = ' '.repeat(barW + 2);
  for (const t of ticks) {
    const s = t >= 1000 ? `${t / 1000}s` : `${t}ms`;
    const at = x(t) + 1;
    if (at + s.length <= axis.length) axis = axis.slice(0, at) + s + axis.slice(at + s.length);
  }
  return (
    <>
      {state.lanes.map((lane) => {
        const judged = lane.verdict?.ok ? lane.verdict.medianMs : undefined;
        const value = judged ?? lane.best;
        const filled = value === undefined ? 0 : Math.max(1, x(value));
        const ch = judged !== undefined ? '█' : '▒';
        const cells: Seg[] = [];
        for (let i = 0; i < barW; i++) {
          if (i < filled) cells.push({ text: ch, color: LANE_COLORS[lane.k], dim: judged === undefined });
          else if (i === baseX) cells.push({ text: '┃', color: BAD });
          else cells.push({ text: '·', color: DIM });
        }
        const bad = lane.verdict && (!lane.verdict.ok || lane.verdict.matches === false);
        return (
          <LineView
            key={lane.k}
            line={[
              { text: pad(lane.label, label), color: LANE_COLORS[lane.k], bold: true },
              { text: '▕', color: MUTED },
              ...cells,
              { text: '▏', color: MUTED },
              { text: padStart(fmtMs(value), valueW), color: bad ? BAD : judged !== undefined ? GOOD : TEXT, bold: judged !== undefined },
            ]}
          />
        );
      })}
      <LineView
        line={[
          { text: ' '.repeat(label - 1), color: MUTED },
          { text: axis, color: MUTED },
        ]}
      />
      <LineView
        line={[
          { text: '█ judged  ▒ best measured  ', color: MUTED },
          { text: '┃', color: BAD },
          { text: ' baseline  log scale, shorter is faster', color: MUTED },
        ]}
      />
    </>
  );
}

function VerdictBoard({ state, focus, width }: { state: RaceState; focus: number; width: number }) {
  const order = state.ranking?.map((r) => r.k) ?? state.lanes.map((l) => l.k);
  const base = state.baseline?.medianMs;
  return (
    <>
      <LineView line={[{ text: pad(' #  agent     judged     speedup    rows        indexes', width), color: MUTED, dim: true }]} />
      {order.map((k, rank) => {
        const lane = state.lanes[k];
        const v = lane.verdict;
        const ok = v?.ok && v.matches !== false;
        const winner = state.result?.k === k;
        return (
          <LineView
            key={k}
            line={[
              { text: winner ? '★' : focus === k ? '›' : ' ', color: winner ? STAR : LANE_COLORS[k], bold: true },
              { text: ` ${state.ranking ? rank + 1 : '·'}  `, color: MUTED },
              { text: pad(lane.label, 9), color: LANE_COLORS[k], bold: true },
              { text: padStart(v ? fmtMs(v.medianMs) : lane.phase === 'judging' ? 'judging' : '–', 9), color: v ? (ok ? GOOD : BAD) : MUTED, bold: !!v },
              { text: padStart(v?.ok && base ? `${Math.round(base / v.medianMs).toLocaleString('en-US')}×` : '', 10), color: TEXT },
              { text: '    ' },
              { text: pad(v ? (v.matches === false ? `✗ ${v.rows} wrong` : `✓ ${v.rows}`) : '', 12), color: ok ? GOOD : BAD },
              { text: v ? fmtBytes(v.indexBytes) : '', color: MUTED },
            ]}
          />
        );
      })}
    </>
  );
}

function ResultLine({ state }: { state: RaceState }) {
  const r = state.result;
  if (r) {
    const lane = state.lanes[r.k];
    return (
      <Box flexDirection="column">
        <LineView
          line={[
            { text: ' ★ WINNER ', color: BG, inverse: true, bold: true },
            { text: ` ${lane.label} `, color: LANE_COLORS[r.k], bold: true },
            { text: `${fmtMs(r.baselineMs)} → ${fmtMs(r.verdict.medianMs)}`, color: GOOD, bold: true },
            { text: `  ${Math.round(r.baselineMs / r.verdict.medianMs).toLocaleString('en-US')}× faster, ${r.reason}`, color: MUTED },
          ]}
        />
        {(r.submission.migration || '').split('\n').filter(Boolean).slice(0, 3).map((l, i) => (
          <LineView key={i} line={[{ text: '  + ', color: GOOD }, { text: l, color: GOOD }]} />
        ))}
      </Box>
    );
  }
  if (state.waitingForPick) {
    return <LineView line={[{ text: ' ▶ PICK A WINNER ', color: WARN, inverse: true, bold: true }, { text: '  focus a lane with 1-4, then press p', color: WARN }]} />;
  }
  return null;
}

// ── app ─────────────────────────────────────────────────────────────────────

type Mode = { kind: 'normal' } | { kind: 'steer'; text: string };

export function App({ source, autoStart }: { source: Source; autoStart: boolean }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, setState] = useState<RaceState>(initialState);
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [scroll, setScroll] = useState([0, 0, 0, 0]);
  const [mode, setMode] = useState<Mode>({ kind: 'normal' });
  const [toast, setToast] = useState<{ text: string; at: number }>();
  const [speed, setSpeed] = useState(source.speed);
  const [running, setRunning] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>();
  const { frame } = useAnimation({ interval: 120 });
  const spin = SPINNER[frame % SPINNER.length];
  const stateRef = useRef(state);
  stateRef.current = state;

  const say = (text: string) => setToast({ text, at: Date.now() });

  const start = () => {
    if (running && !stateRef.current.result && !stateRef.current.failed) return say('A race is running; wait for its result before starting another.');
    setState({ ...initialState(), status: source.mode === 'live' ? 'Starting a race through Hatchet…' : 'Starting the replay' });
    setScroll([0, 0, 0, 0]);
    setRunning(true);
    source
      .start({
        event: (event, at) => setState((s) => reduce(s, event, at)),
        started: (raceId, runId) =>
          setState((s) => ({ ...s, raceId, runId: runId ?? s.runId, status: 'Mission queued: races run one at a time' })),
        info: say,
      })
      .catch((error: unknown) => {
        setRunning(false);
        setState((st) => ({ ...st, status: `Could not start: ${error instanceof Error ? error.message : String(error)}` }));
      });
  };

  useEffect(() => {
    if (autoStart) start();
    return () => source.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quit = () => {
    source.stop();
    exit();
  };

  const raceId = state.raceId;
  const globalLinks: Link[] =
    dashboardEnabled && raceId
      ? [
          ...(state.runId ? [{ key: 'mission', label: 'mission', url: runUrl(state.runId) }] : []),
          ...(state.baselineJudgeRunId ? [{ key: 'baseline', label: 'baseline', url: runUrl(state.baselineJudgeRunId) }] : []),
          { key: 'race-runs', label: 'race runs', url: raceRunsUrl(raceId) },
          { key: 'stream', label: 'stream', url: topicUrl(raceTopic(raceId)) },
          { key: 'events', label: 'pick events', url: pickEventsUrl() },
          { key: 'workers', label: 'workers', url: workersUrl() },
        ]
      : [];
  const laneLinks = (lane: Lane): Link[] =>
    dashboardEnabled && raceId
      ? [
          ...(lane.runId ? [{ key: `c${lane.k}-run`, label: 'candidate', url: runUrl(lane.runId) }] : []),
          ...(lane.llmRun ? [{ key: `c${lane.k}-llm`, label: lane.llmRun.label, url: runUrl(lane.llmRun.runId) }] : []),
          ...(lane.judgeRunId ? [{ key: `c${lane.k}-judge`, label: 'judge', url: runUrl(lane.judgeRunId) }] : []),
          { key: `c${lane.k}-steer`, label: 'steer topic', url: topicUrl(steerTopic(raceId, lane.k)) },
        ]
      : [];
  // Tab walks the focused pane's links, then the mission's; o opens the selected one
  const cyclable = [...laneLinks(state.lanes[focus]), ...globalLinks];
  const selected = cyclable.find((l) => l.key === selectedKey) ?? cyclable[0];
  const focusLane = (k: number) => {
    setFocus(k);
    setSelectedKey(undefined);
  };

  useInput((input, key) => {
    if (mode.kind === 'steer') {
      if (key.escape) setMode({ kind: 'normal' });
      else if (key.return) {
        const text = mode.text.trim();
        setMode({ kind: 'normal' });
        if (text) {
          source.steer(focus, text).then(
            () => source.mode === 'live' && say(`Sent to ${state.lanes[focus].label}; it reads it before its next turn.`),
            (error: unknown) => say(`steer failed: ${error instanceof Error ? error.message : String(error)}`),
          );
          if (source.mode === 'replay') setState((s) => note(s, focus, `not sent (replay): ${text}`));
        }
      } else if (key.backspace || key.delete) setMode({ kind: 'steer', text: mode.text.slice(0, -1) });
      else if (input && !key.ctrl && !key.meta) setMode({ kind: 'steer', text: (mode.text + input).slice(0, 500) });
      return;
    }

    if (input === 'q' || (key.ctrl && input === 'c')) return quit();
    if (input >= '1' && input <= '4') return focusLane(Number(input) - 1);
    if (key.rightArrow) return focusLane((focus + 1) % 4);
    if (key.leftArrow) return focusLane((focus + 3) % 4);
    if (key.tab) {
      if (!cyclable.length) return say(dashboardEnabled ? 'No dashboard links yet.' : 'Dashboard links need HATCHET_CLIENT_TOKEN.');
      const i = selected ? cyclable.indexOf(selected) : -1;
      return setSelectedKey(cyclable[(i + (key.shift ? cyclable.length - 1 : 1) + cyclable.length) % cyclable.length].key);
    }
    if (input === 'o') {
      if (!selected) return say(dashboardEnabled ? 'No dashboard links yet.' : 'Dashboard links need HATCHET_CLIENT_TOKEN.');
      openInBrowser(selected.url);
      return say(`Opened ${selected.label} in the browser.`);
    }
    if (input === 'z') return setZoom((z) => !z);
    if (input === 'n') return start();
    if (input === 's') {
      if (!running || state.lanes[focus].phase === 'done' || state.result) return say('Steer a lane while its agent is still working.');
      return setMode({ kind: 'steer', text: '' });
    }
    if (input === 'p') {
      if (!state.waitingForPick) return say('The pick opens once every agent has a verdict.');
      const lane = state.lanes[focus];
      say(`Picked ${lane.label}.`);
      source.pick(focus, lane, state.baseline?.medianMs ?? 0).catch((error: unknown) => say(`pick failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const by = (n: number) => setScroll((s) => s.map((v, i) => (i === focus ? Math.max(0, v + n) : v)));
    if (key.upArrow) return by(1);
    if (key.downArrow) return by(-1);
    if (key.pageUp) return by(10);
    if (key.pageDown) return by(-10);
    if (input === 'G') return setScroll((s) => s.map((v, i) => (i === focus ? 0 : v)));
    if ((input === ']' || input === '[') && source.setSpeed) {
      const i = SPEEDS.indexOf(speed ?? 1);
      const nextSpeed = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + (input === ']' ? 1 : -1)))];
      source.setSpeed(nextSpeed);
      setSpeed(nextSpeed);
    }
  });

  const now = source.mode === 'replay' ? (source as ReplaySource).now() : Date.now();
  const clock = state.startedAt ? fmtClock((state.finishedAt ?? now) - state.startedAt) : '0:00';

  // the cat sits beside the banner when the terminal still leaves the agent panes about 46 columns each
  const catW = 4 + BANNER_W + 2 + CAT[0].length + 2;
  const cat = columns - catW >= 92 && rows >= 44;
  const leftW = cat ? catW : Math.min(84, Math.max(48, Math.round(columns * 0.37)));
  const rightW = columns - leftW;
  const innerLeft = leftW - 4;
  const showToast = toast && Date.now() - toast.at < 6_000;

  // Ink draws overflowing children over their neighbours, so the left column is sized by hand: the stream gets what
  // the fixed sections leave, and on a short terminal the banner shrinks first, then the query.
  const resultRows = state.result
    ? 1 + Math.min(3, state.result.submission.migration.split('\n').filter(Boolean).length)
    : state.waitingForPick
      ? 1
      : 0;
  const totalQueryLines = (state.query ?? '').split('\n').length || 9;
  const fixed = (banner: number, query: number) => 2 + banner + 3 + query + 2 + 8 + 7 + 6 + resultRows + 1 + 1;
  let wideBanner = innerLeft >= BANNER_W + 2;
  let bannerRows = wideBanner ? BANNER_ROWS : BANNER_NARROW_ROWS;
  if (wideBanner && rows - fixed(bannerRows, totalQueryLines) < 4) {
    wideBanner = false;
    bannerRows = BANNER_NARROW_ROWS;
  }
  // too short even for the small lettering: the banner is just the status line
  const tinyBanner = rows - fixed(bannerRows, 2) < 0;
  if (tinyBanner) bannerRows = 1;
  const queryLines = Math.max(2, Math.min(totalQueryLines, rows - fixed(bannerRows, 0) - 4));
  const feedRows = Math.max(0, rows - fixed(bannerRows, queryLines));

  const panes = zoom ? [focus] : [0, 1, 2, 3];
  const paneW = (i: number) => (zoom ? rightW : i % 2 === 0 ? Math.floor(rightW / 2) : rightW - Math.floor(rightW / 2));
  const paneH = (i: number) => (zoom ? rows : i < 2 ? Math.floor(rows / 2) : rows - Math.floor(rows / 2));

  return (
    <Box width={columns} height={rows}>
      <Frame
        width={leftW}
        height={rows}
        color={STEEL}
        title={[{ text: ' mission control ', color: BRAND, bold: true, inverse: true }]}
        right={[{ text: `${state.events} events`, color: MUTED }]}
      >
        <Banner wide={wideBanner} tiny={tinyBanner} cat={cat && wideBanner} mode={source.mode} raceId={state.raceId} clock={clock} speed={speed} status={state.status} frame={frame} />
        <Mission state={state} width={innerLeft} queryLines={queryLines} />
        <Section title="DASHBOARD" width={innerLeft}>
          <LinkRow links={globalLinks} selected={selected?.key} empty={dashboardEnabled ? 'links appear once a race starts' : 'set HATCHET_CLIENT_TOKEN for dashboard links'} />
        </Section>
        <Section title={`STREAM race-${state.raceId ?? '…'}`} width={innerLeft}>
          <Feed state={state} width={innerLeft - 1} rows={feedRows} />
        </Section>
        <Section title="HATCHET TASKS" width={innerLeft}>
          <TaskTree state={state} spin={spin} clock={clock} />
        </Section>
        <Section title="RACE" width={innerLeft}>
          <RaceChart state={state} width={innerLeft - 1} />
        </Section>
        <Section title="VERDICTS" width={innerLeft}>
          <VerdictBoard state={state} focus={focus} width={innerLeft - 1} />
          <ResultLine state={state} />
        </Section>
        <Box flexDirection="column" flexShrink={0} marginTop={0}>
          {mode.kind === 'steer' ? (
            <Text wrap="truncate">
              <Text color={BG} backgroundColor={LILAC} bold>
                {` steer ${focus + 1} ${state.lanes[focus].label} `}
              </Text>
              <Text color={LILAC}> › </Text>
              <Text>{mode.text.slice(-(innerLeft - 22))}</Text>
              <Text inverse> </Text>
              <Text color={MUTED}> ⏎ send  esc cancel</Text>
            </Text>
          ) : showToast ? (
            <Text wrap="truncate" color={WARN}>
              {'● '}
              {toast.text}
            </Text>
          ) : (
            <Keys mode={source.mode} />
          )}
        </Box>
      </Frame>
      <Box flexDirection="row" flexWrap="wrap" width={rightW} height={rows}>
        {panes.map((k) => (
          <AgentPane
            key={k}
            lane={state.lanes[k]}
            raceId={state.raceId}
            width={paneW(zoom ? 0 : k)}
            height={paneH(zoom ? 0 : k)}
            focused={focus === k}
            winner={state.result?.k === k}
            scroll={scroll[k]}
            spin={spin}
            frame={frame}
            links={laneLinks(state.lanes[k])}
            selected={focus === k ? selected?.key : undefined}
          />
        ))}
      </Box>
    </Box>
  );
}

function Keys({ mode }: { mode: 'live' | 'replay' }) {
  const keys: [string, string][] = [
    ['n', mode === 'live' ? 'new race' : 'restart'],
    ['1-4', 'focus'],
    ['tab', 'link'],
    ['o', 'open'],
    ['z', 'zoom'],
    ['s', 'steer'],
    ['p', 'pick'],
    ['↑↓', 'scroll'],
    ...(mode === 'replay' ? ([['[ ]', 'speed']] as [string, string][]) : []),
    ['q', 'quit'],
  ];
  return (
    <Text wrap="truncate">
      {keys.map(([k, label]) => (
        <Text key={k}>
          <Text color={BG} backgroundColor={BRAND} bold>{` ${k} `}</Text>
          <Text color={MUTED}>{` ${label} `}</Text>
        </Text>
      ))}
    </Text>
  );
}
