/** Terminal, event-stream and lease identifiers must not grant each
 * other's privileges. Replaces contracts for the retired chat agent.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mintPtySessionToken, validatePtySessionToken, revokePtySessionToken, __resetPtySessions } from '../src/pty-session-cookie';
import { mintSseSessionToken, validateSseSessionToken, __resetSseSessions } from '../src/sse-session-cookie';
import { mintLease, validateLease, __resetLeases } from '../src/pty-session-lease';

beforeEach(() => { __resetPtySessions(); __resetSseSessions(); __resetLeases(); });

describe('sidebar credential privilege separation', () => {
  test('an event-stream credential cannot authenticate a terminal', () => {
    const { token } = mintSseSessionToken();
    expect(validateSseSessionToken(token)).toBe(true);
    expect(validatePtySessionToken(token)).toBe(false);
  });
  test('a terminal credential cannot authenticate an event stream', () => {
    const { token } = mintPtySessionToken();
    expect(validatePtySessionToken(token)).toBe(true);
    expect(validateSseSessionToken(token)).toBe(false);
  });
  test('a public lease identifier is not a terminal credential', () => {
    const { sessionId } = mintLease();
    const { token } = mintPtySessionToken();
    expect(validateLease(sessionId).ok).toBe(true);
    expect(validatePtySessionToken(sessionId)).toBe(false);
    expect(validateLease(token).ok).toBe(false);
    revokePtySessionToken(token);
    expect(validateLease(sessionId).ok).toBe(true);
    expect(validatePtySessionToken(token)).toBe(false);
  });
});
