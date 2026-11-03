// Links into the Hatchet dashboard. The base URL and tenant come from the client token (its `server_url` and `sub`
// claims), unless HATCHET_DASHBOARD_URL or HATCHET_TENANT_ID say otherwise.
import { spawn } from 'node:child_process';
import { PICK_EVENT } from '../protocol.js';

export type Link = { key: string; label: string; url: string };

function tokenClaims(): { server_url?: string; sub?: string } {
  const token = process.env.HATCHET_CLIENT_TOKEN;
  if (!token) return {};
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}

const claims = tokenClaims();
const base = (process.env.HATCHET_DASHBOARD_URL ?? claims.server_url ?? 'https://cloud.onhatchet.run').replace(/\/$/, '');
const tenant = process.env.HATCHET_TENANT_ID ?? claims.sub;

/** Whether links can be built: without a tenant there is nowhere to point. */
export const dashboardEnabled = !!tenant;

const page = (path: string, params?: Record<string, unknown>) => {
  const query = params
    ? `?${Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(JSON.stringify(v))}`)
        .join('&')}`
    : '';
  return `${base}/tenants/${tenant}${path}${query}`;
};

export const runUrl = (runId: string) => page(`/runs/${runId}`);

/** The run list, filtered to one race by the metadata every race run carries. */
export const raceRunsUrl = (raceId: string) => page('/runs', { 'workflow-runs-main-workflow-runs-filters': { m: [`race:${raceId}`], tw: '1d' } });

/** The streams page has no page per topic yet, so this searches for the topic. */
export const topicUrl = (topic: string) => page('/streams', { 'stream-topics-stream-topics-table': { s: topic } });

export const pickEventsUrl = () => page('/events', { 'events-table': { k: [PICK_EVENT] } });

export const workersUrl = () => page('/workers');

/** An OSC 8 hyperlink: terminals that support it make `label` clickable, the others print the label alone. */
export const hyperlink = (url: string, label: string) => `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;

export function openInBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
}
