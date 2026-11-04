import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amount, bytes, duration, percent, relative } from '../src/lib/format.ts';

test('durées au format de la charte', () => {
  assert.equal(duration(45_000), '45 s');
  assert.equal(duration(14 * 60_000), '14 min');
  assert.equal(duration((2 * 60 + 14) * 60_000), '2 h 14 min');
  assert.equal(duration(3 * 60 * 60_000), '3 h');
  assert.equal(duration((26 * 60) * 60_000), '1 j 2 h');
});

test('relatif, montants, octets, pourcentages', () => {
  const now = Date.parse('2026-11-04T14:00:00Z');
  assert.equal(relative('2026-11-04T13:59:50Z', now), "à l'instant");
  assert.equal(relative('2026-11-04T13:57:00Z', now), 'il y a 3 min');
  assert.equal(amount(45_000, 'XOF'), '45 000 XOF');
  assert.equal(bytes(14_611_447_808), '14 Go');
  assert.equal(percent(12.34), '12,3 %');
});
