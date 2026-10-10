/** Real DOM coverage for the current terminal sidebar's injection boundary.
 * All HTTP responses are synthetic. No terminal or model process is started.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

const SIDEPANEL_URL = `file://${path.resolve(import.meta.dir, '../../extension/sidepanel.html')}`;
const CHROMIUM_AVAILABLE = fs.existsSync(chromium.executablePath());
let browser: Browser;

beforeAll(async () => {
  if (CHROMIUM_AVAILABLE) browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

async function loadFixture(page: Page) {
  await page.addInitScript(() => {
    const fixture = window as any;
    fixture.fixtureRequests = [];
    fixture.chrome = {
      runtime: {
        sendMessage: (_request: any, callback?: any) => {
          const payload = { connected: false, port: 34589 };
          if (callback) { setTimeout(() => callback(payload), 0); return; }
          return Promise.resolve(payload);
        },
        lastError: null, onMessage: { addListener() {} },
      },
      tabs: {
        query: (_query: any, callback?: any) => {
          const tabs = [{ id: 1, url: 'https://example.invalid' }];
          if (callback) { setTimeout(() => callback(tabs), 0); return; }
          return Promise.resolve(tabs);
        },
        onActivated: { addListener() {} }, onUpdated: { addListener() {} },
      },
    };
    fixture.EventSource = class { addEventListener() {} close() {} };
    fixture.fetch = async (input: any, options?: any) => {
      const url = String(input);
      fixture.fixtureRequests.push({ url, options });
      if (url.endsWith('/health')) return new Response(JSON.stringify({
        status: 'healthy', token: 'synthetic-fixture-token', mode: 'headed',
        chatEnabled: false, security: { status: 'protected' },
      }), { status: 200 });
      if (url.endsWith('/pty-inject-scan')) return new Response(JSON.stringify({ verdict: 'PASS', reasons: [] }), { status: 200 });
      return new Response('{}', { status: 503 });
    };
  });
  await page.goto(SIDEPANEL_URL);
  await page.waitForSelector('#footer-dot.connected', { timeout: 5000 });
}

async function withFixture(check: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loadFixture(page);
    await check(page);
  } finally { await context.close(); }
}

describe('terminal sidebar security DOM', () => {
  test.skipIf(!CHROMIUM_AVAILABLE)('shows the terminal and does not claim retired chat protection', async () => {
    await withFixture(async page => {
      expect(await page.locator('#tab-terminal').isVisible()).toBe(true);
      expect(await page.locator('#security-shield').isVisible()).toBe(false);
      expect(await page.locator('#tab-chat').count()).toBe(0);
      const requests = await page.evaluate(() => (window as any).fixtureRequests);
      expect(requests.some((r: any) => /sidebar-chat|sidebar-command/.test(r.url))).toBe(false);
    });
  });

  test.skipIf(!CHROMIUM_AVAILABLE)('scans using the connected port and bootstrap token', async () => {
    await withFixture(async page => {
      const verdict = await page.evaluate(async () => (window as any).gstackScanForPTYInject('fixture text', 'fixture'));
      expect(verdict.verdict).toBe('PASS');
      const requests = await page.evaluate(() => (window as any).fixtureRequests);
      const scan = requests.find((r: any) => r.url.endsWith('/pty-inject-scan'));
      expect(scan.url).toBe('http://127.0.0.1:34589/pty-inject-scan');
      expect(scan.options.headers.Authorization).toBe('Bearer synthetic-fixture-token');
      expect(JSON.parse(scan.options.body)).toEqual({ text: 'fixture text', origin: 'fixture' });
      // Reconnection must not keep using a cached token from the old daemon.
      await page.evaluate(async () => {
        (window as any).gstackAuthToken = 'rotated-fixture-token';
        await (window as any).gstackScanForPTYInject('after reconnect', 'fixture');
      });
      const rotated = await page.evaluate(() => (window as any).fixtureRequests.filter((r: any) => r.url.endsWith('/pty-inject-scan')).at(-1));
      expect(rotated.options.headers.Authorization).toBe('Bearer rotated-fixture-token');
      // The health fallback uses the server's current response field.
      await page.evaluate(async () => {
        (window as any).gstackAuthToken = null;
        await (window as any).gstackScanForPTYInject('health fallback', 'fixture');
      });
      const fallback = await page.evaluate(() => (window as any).fixtureRequests.filter((r: any) => r.url.endsWith('/pty-inject-scan')).at(-1));
      expect(fallback.options.headers.Authorization).toBe('Bearer synthetic-fixture-token');
    });
  });

  for (const verdict of ['PASS', 'BLOCK', 'WARN']) {
    test.skipIf(!CHROMIUM_AVAILABLE)(`cleanup respects ${verdict} before terminal injection`, async () => {
      await withFixture(async page => {
        await page.evaluate(verdict => {
          const fixture = window as any;
          fixture.fixtureScans = []; fixture.fixtureInjections = [];
          fixture.gstackScanForPTYInject = async (text: string, origin: string) => {
            fixture.fixtureScans.push({ text, origin });
            return { verdict, reasons: ['synthetic-fixture'] };
          };
          fixture.gstackInjectToTerminal = (text: string) => {
            fixture.fixtureInjections.push(text); return true;
          };
          fixture.confirm = () => false;
        }, verdict);
        await page.locator('#chat-cleanup-btn').click();
        await page.waitForFunction(() => (window as any).fixtureScans.length === 1);
        const result = await page.evaluate(() => ({ scans: (window as any).fixtureScans, injections: (window as any).fixtureInjections }));
        expect(result.scans[0].origin).toBe('cleanup-button');
        expect(result.scans[0].text).toContain('$B cleanup --all');
        expect(result.scans[0].text).toContain('Keep the site');
        expect(result.injections).toHaveLength(verdict === 'PASS' ? 1 : 0);
        if (verdict === 'PASS') expect(result.injections[0]).toBe(result.scans[0].text);
      });
    });
  }
});
