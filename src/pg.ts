// Shell snippets that drive the Postgres inside a race sandbox. The database lives in the image, outside the workspace:
// brickie snapshots only the workspace, so a call costs about 0.1 s instead of 10 s. The workspace holds only
// `migration.sql`, the candidate's schema and settings changes, so a sandbox restored after a crash can replay them.

export const IMAGE = process.env.RACE_IMAGE ?? 'pgrace-seed:shop';

const ENV = 'export PGDATA=/var/lib/postgresql/race;';
export const PSQL = 'gosu postgres psql -h /tmp -U postgres -X -v ON_ERROR_STOP=1';

/**
 * Starts the server unless this container already runs one. A new container (a fresh sandbox, or one restored after a
 * crash) starts from the image's pristine database, so it replays the workspace's migration first.
 */
export const ENSURE_UP = `${ENV} if ! gosu postgres pg_ctl -D $PGDATA status >/dev/null 2>&1; then
  gosu postgres pg_ctl -D $PGDATA -l /tmp/pg.log -w -o "-c listen_addresses='' -k /tmp" start >/dev/null || exit 70
  if [ -s migration.sql ]; then ${PSQL} -q -f migration.sql >/dev/null || exit 71; fi
fi`;

const DELIMITER = '__RACE_SQL_EOF__';

/** A heredoc that writes `sql` to `path`; the quoted delimiter keeps the shell from expanding anything in it. */
export function writeFile(path: string, sql: string): string {
  if (sql.split('\n').some((line) => line.trim() === DELIMITER)) throw new Error('the SQL contains the heredoc delimiter');
  return `cat > ${path} <<'${DELIMITER}'\n${sql}\n${DELIMITER}`;
}

/** Drops trailing semicolons, so the query can be wrapped in a subquery or EXPLAIN. */
export const bareQuery = (sql: string) => sql.trim().replace(/;+\s*$/, '');

/** Runs `sql` in a read-only transaction that is rolled back, with psql's timing on. */
export function readOnlySql(sql: string, timeout = '60s'): string {
  // a last statement without a semicolon would swallow the ROLLBACK; the terminator goes on its own line in case the
  // SQL ends with a -- comment
  const body = sql.trimEnd().endsWith(';') ? sql : `${sql}\n;`;
  const script = `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${timeout}';\n\\timing on\n${body}\nROLLBACK;`;
  return `${ENSURE_UP}\n${writeFile('/tmp/read.sql', script)}\n${PSQL} -f /tmp/read.sql 2>&1`;
}

/** Runs `sql` and, if it succeeds, appends it to the workspace's `migration.sql`. */
export function migrate(sql: string): string {
  return `${ENSURE_UP}\n${writeFile('/tmp/step.sql', sql)}\n${PSQL} -f /tmp/step.sql 2>&1 && { printf '\\n' >> migration.sql; cat /tmp/step.sql >> migration.sql; }`;
}

/** Statements the settings candidate may run: ALTER SYSTEM, and reloading the configuration. */
export function settingsOnly(sql: string): string | undefined {
  const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  const bad = statements.find((s) => !/^(ALTER\s+SYSTEM\s+(SET|RESET)\b|SELECT\s+pg_reload_conf\(\s*\))/i.test(s));
  return bad ? `only ALTER SYSTEM and SELECT pg_reload_conf() are allowed, not: ${bad.slice(0, 80)}` : undefined;
}

/** The last `Execution Time` an EXPLAIN ANALYZE printed, else the last psql `Time:` line. */
export function measuredMs(output: string): number | undefined {
  const pick = (pattern: RegExp) => {
    const all = [...output.matchAll(pattern)];
    return all.length ? Number(all[all.length - 1][1]) : undefined;
  };
  return pick(/Execution Time: ([\d.]+) ms/g) ?? pick(/^Time: ([\d.]+) ms/gm);
}

// The judge prints one line per measure, prefixed so the plan's own text can't be mistaken for one.
const MARK = 'RACE>';

/**
 * The judge's whole job, in one sandbox call: start a pristine database, apply the migration, fingerprint the rows,
 * time the query, and print its plan. A query slower than 5 s is timed once more, warm, since the noise doesn't matter there. The original query takes
 * about 28 s on a quiet machine but several times that when the Docker VM is short of memory, hence the 300 s timeout.
 */
export function judgeScript(migration: string, query: string, runs: number): string {
  const q = bareQuery(query);
  if (q.includes('$race_q$')) throw new Error('the query contains the judge\'s quote tag');
  const measure = `SET statement_timeout = '300s';
SELECT '${MARK}rows=' || count(*) || ' md5=' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') FROM (${q}) x;
DO $race_do$ DECLARE s timestamptz; first float8; ts float8[] := '{}'; r record; BEGIN
  s := clock_timestamp(); FOR r IN EXECUTE $race_q$ ${q} $race_q$ LOOP END LOOP;
  first := extract(epoch FROM clock_timestamp() - s) * 1000;
  IF first > 5000 THEN s := clock_timestamp(); FOR r IN EXECUTE $race_q$ ${q} $race_q$ LOOP END LOOP;
    ts := ARRAY[extract(epoch FROM clock_timestamp() - s) * 1000]; ELSE
    FOR i IN 1..${runs} LOOP s := clock_timestamp(); FOR r IN EXECUTE $race_q$ ${q} $race_q$ LOOP END LOOP;
      ts := ts || extract(epoch FROM clock_timestamp() - s) * 1000; END LOOP;
  END IF;
  RAISE NOTICE '${MARK}runs=%', array_to_string(ts, ',');
END $race_do$;
SELECT '${MARK}index_bytes=' || coalesce(sum(pg_relation_size(indexrelid)), 0) FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisprimary AND c.relnamespace = 'public'::regnamespace;
\\echo ${MARK}plan
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${q};`;
  return [
    writeFile('migration.sql', migration),
    ENSURE_UP,
    writeFile('/tmp/judge.sql', measure),
    `${PSQL} -tA -f /tmp/judge.sql 2>&1`,
  ].join('\n');
}

export function parseJudge(output: string, exitCode: number): Omit<import('./protocol.js').Verdict, 'matches'> {
  const line = (key: string) => output.match(new RegExp(`${MARK}${key}=([^\\n]*)`))?.[1];
  const rows = line('rows')?.match(/^(\d+) md5=(\w*)/);
  const runsMs = (line('runs') ?? '').split(',').filter(Boolean).map((v) => Math.round(Number(v) * 10) / 10);
  const sorted = [...runsMs].sort((a, b) => a - b);
  const plan = output.split(`${MARK}plan`)[1]?.trim() ?? '';
  const ok = exitCode === 0 && !!rows && runsMs.length > 0;
  return {
    ok,
    error: ok ? undefined : output.trim().split('\n').filter((l) => !l.startsWith(MARK)).slice(-6).join('\n') || `exit code ${exitCode}`,
    rows: rows ? Number(rows[1]) : 0,
    fingerprint: rows?.[2] ?? '',
    medianMs: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
    runsMs,
    plan: plan.slice(0, 6_000),
    indexBytes: Number(line('index_bytes') ?? 0),
  };
}
