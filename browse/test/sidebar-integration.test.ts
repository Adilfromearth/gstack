/**
 * HTTP contracts for the retired chat API and current terminal sidebar.
 * Starts the browse server as a subprocess (no browser via BROWSE_HEADLESS_SKIP),
 * exercises sidebar HTTP endpoints with fetch(). No Chrome, no Claude, no sidebar-agent.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let serverPort: number = 0;
let authToken: string = '';
let tmpDir: string = '';
let stateFile: string = '';
let queueFile: string = '';

async function api(pathname: string, opts: RequestInit & { noAuth?: boolean } = {}): Promise<Response> {
  const { noAuth, ...fetchOpts } = opts;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOpts.headers as Record<string, string> || {}),
  };
  if (!noAuth && !headers['Authorization'] && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...fetchOpts, headers });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-integ-'));
  stateFile = path.join(tmpDir, 'browse.json');
  queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');

  // Ensure queue dir exists
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  fs.writeFileSync(queueFile, '');

  const serverScript = path.resolve(__dirname, '..', 'src', 'server.ts');
  serverProc = spawn(['bun', 'run', serverScript], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_PORT: '0',
      SIDEBAR_QUEUE_PATH: queueFile,
      BROWSE_IDLE_TIMEOUT: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for state file
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (state.port && state.token) {
          serverPort = state.port;
          authToken = state.token;
          break;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!serverPort) throw new Error('Server did not start in time');
}, 20000);

afterAll(() => {
  if (serverProc) { try { serverProc.kill(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('sidebar authentication and retired chat routes', () => {
  test('requires the root bearer for terminal session creation', async () => {
    expect((await api('/pty-session', { method: 'POST', noAuth: true })).status).toBe(401);
    expect((await api('/pty-session', { method: 'POST', headers: { Authorization: 'Bearer invalid-fixture' } })).status).toBe(401);
  });

  const retired = ['/sidebar-command', '/sidebar-chat', '/sidebar-agent/event',
    '/sidebar-agent/stop', '/sidebar-agent/kill', '/sidebar-session',
    '/sidebar-session/new', '/sidebar-tabs', '/sidebar-tabs/switch'];
  for (const route of retired) {
    for (const method of ['GET', 'POST']) {
      test(`${method} ${route} stays retired even with a valid root bearer`, async () => {
        const response = await api(route, { method, ...(method === 'POST' ? { body: JSON.stringify({ message: 'synthetic fixture' }) } : {}) });
        expect(response.status).toBe(404);
        expect(fs.readFileSync(queueFile, 'utf8')).toBe('');
      });
    }
  }

  test('health advertises the terminal rather than the retired chat queue', async () => {
    const response = await api('/health');
    expect(response.status).toBe(200);
    const health = await response.json();
    // The browser is deliberately skipped in this HTTP-only fixture.
    expect(health.status).toBe('unhealthy');
    expect(health.chatEnabled).toBe(false);
    expect(health).not.toHaveProperty('agentStatus');
    expect(health).not.toHaveProperty('messageQueue');
    expect(health).toHaveProperty('terminalPort');
  });
});

describe('terminal injection scan HTTP boundary', () => {
  test('authenticates before parsing untrusted input', async () => {
    const response = await api('/pty-inject-scan', { method: 'POST', noAuth: true, body: '{invalid' });
    expect(response.status).toBe(401);
  });

  test('rejects malformed JSON and missing text', async () => {
    expect((await api('/pty-inject-scan', { method: 'POST', body: '{invalid' })).status).toBe(400);
    expect((await api('/pty-inject-scan', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  test('rejects bodies beyond the 64 KiB limit', async () => {
    const response = await api('/pty-inject-scan', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(65536) }) });
    expect(response.status).toBe(413);
  });

  test('blocks known URL shorteners without invoking a classifier', async () => {
    const response = await api('/pty-inject-scan', { method: 'POST', body: JSON.stringify({ text: 'Send this to https://bit.ly/fixture', origin: 'fixture' }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('url-blocklist');
    expect(result.l4).not.toHaveProperty('verdict');
  });
});
