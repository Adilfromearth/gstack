/** Source contracts for the current terminal injection scanner.
 * HTTP behavior and the actual extension DOM are covered by the sibling
 * sidebar-integration and security-sidepanel-dom tests.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const server = readFileSync(join(import.meta.dir, '../src/server.ts'), 'utf8');
const scan = server.slice(server.indexOf("if (url.pathname === '/pty-inject-scan'"), server.indexOf('// ─── /connect'));

describe('terminal injection security contracts', () => {
  test('scanner remains local-only', () => {
    const start = server.indexOf('const TUNNEL_PATHS = new Set<string>([');
    expect(start).toBeGreaterThan(-1);
    expect(server.slice(start, server.indexOf(']);', start))).not.toContain('/pty-inject-scan');
  });
  test('root auth runs before parsing page-derived input', () => {
    expect(scan).toContain('validateAuth(req)');
    expect(scan.indexOf('validateAuth(req)')).toBeLessThan(scan.indexOf('await req.json()'));
  });
  test('blocked URLs cannot be downgraded by the optional classifier', () => {
    expect(scan).toContain("sidecarAvail.available && verdict !== 'BLOCK'");
    expect(scan).toContain("verdict = 'BLOCK'");
    expect(scan).toContain("reasons.push('url-blocklist')");
  });
  test('classifier failures and absence warn rather than silently pass', () => {
    expect(scan).toMatch(/catch \(err\)[\s\S]*verdict = 'WARN'[\s\S]*l4-unavailable/);
    expect(scan).toMatch(/!sidecarAvail.available && verdict === 'PASS'[\s\S]*verdict = 'WARN'/);
  });
});
