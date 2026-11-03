import { describe, expect, test } from 'bun:test';
import { AppError } from '../src/common/errors.ts';
import { createReplayGuard } from '../src/ingest/replay-guard.ts';
import { sign, verifySignature } from '../src/ingest/signature.ts';

const secret = 'a'.repeat(64);
const nextSecret = 'b'.repeat(64);
const now = new Date('2026-11-03T14:32:15Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const body = new TextEncoder().encode('{"sentAt":"2026-11-03T14:32:15Z","events":[]}');

const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return 'OK';
};

const check = (overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  codeOf(() => verifySignature({ secrets: [secret], timestamp, signature: sign(secret, timestamp, body), body, now, ...overrides }));

describe('signature', () => {
  test('accepte une signature correcte', () => {
    expect(check()).toBe('OK');
  });

  test('accepte le nouveau secret pendant une rotation', () => {
    expect(check({ secrets: [secret, nextSecret], signature: sign(nextSecret, timestamp, body) })).toBe('OK');
  });

  test('refuse un autre secret', () => {
    expect(check({ signature: sign(nextSecret, timestamp, body) })).toBe('BAD_SIGNATURE');
  });

  test('refuse un corps modifié après signature', () => {
    expect(check({ body: new TextEncoder().encode('{"sentAt":"2026-11-03T14:32:15Z","events":[1]}') })).toBe('BAD_SIGNATURE');
  });

  test('refuse un horodatage qui ne correspond pas à la signature', () => {
    expect(check({ timestamp: String(Number(timestamp) + 1) })).toBe('BAD_SIGNATURE');
  });

  test('accepte 300 s de décalage, refuse 301', () => {
    for (const [offset, expected] of [[300, 'OK'], [-300, 'OK'], [301, 'STALE_REQUEST'], [-301, 'STALE_REQUEST']] as const) {
      const shifted = String(Number(timestamp) + offset);
      expect(check({ timestamp: shifted, signature: sign(secret, shifted, body) })).toBe(expected);
    }
  });

  test('refuse des en-têtes absents ou malformés', () => {
    expect(check({ timestamp: null })).toBe('MISSING_TIMESTAMP');
    expect(check({ timestamp: '17621803.5' })).toBe('MISSING_TIMESTAMP');
    expect(check({ signature: null })).toBe('MISSING_SIGNATURE');
    expect(check({ signature: `v2=${'0'.repeat(64)}` })).toBe('MISSING_SIGNATURE');
  });
});

describe('anti-rejeu', () => {
  test('refuse une signature déjà vue, puis l’oublie après la fenêtre', () => {
    const guard = createReplayGuard(600_000);
    expect(guard.firstSeen('s1', now)).toBe(true);
    expect(guard.firstSeen('s1', new Date(now.getTime() + 599_000))).toBe(false);
    expect(guard.firstSeen('s2', new Date(now.getTime() + 601_000))).toBe(true);
    expect(guard.firstSeen('s1', new Date(now.getTime() + 601_000))).toBe(true);
  });
});
