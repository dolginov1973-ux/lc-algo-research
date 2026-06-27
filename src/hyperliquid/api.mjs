// Thin Hyperliquid public API client. Hyperliquid is a fully on-chain perp DEX: every trader's
// positions and fills are public and verifiable — no fake leaderboards (cf. the 892773161
// centralized-leaderboard farm). Reachable directly (no proxy needed). curl transport so it
// behaves the same locally and in CI.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const INFO = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

async function curlGet(url) {
  const { stdout } = await execFileP('curl', ['-s', '--max-time', '90', url], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}
async function curlPost(url, body) {
  const { stdout } = await execFileP(
    'curl',
    ['-s', '--max-time', '30', '-X', 'POST', url, '-H', 'content-type: application/json', '-d', JSON.stringify(body)],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

export async function leaderboard() {
  return JSON.parse(await curlGet(LEADERBOARD));
}
export async function clearinghouseState(user) {
  return JSON.parse(await curlPost(INFO, { type: 'clearinghouseState', user }));
}
export async function userFills(user) {
  return JSON.parse(await curlPost(INFO, { type: 'userFills', user }));
}
export async function meta() {
  return JSON.parse(await curlPost(INFO, { type: 'meta' }));
}

// Convert a leaderboard row's windowPerformances [[name,{pnl,roi,vlm}],...] to a flat object.
export function perf(row) {
  const m = {};
  for (const [name, v] of row.windowPerformances) {
    m[name] = { pnl: +v.pnl, roi: +v.roi, vlm: +v.vlm };
  }
  return { addr: row.ethAddress, name: row.displayName || '', av: +row.accountValue, ...m };
}
