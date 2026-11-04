import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../src/operators/sealed.ts';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from '../src/operators/totp.ts';

// Vecteurs de la RFC 6238 (annexe B), secret ASCII « 12345678901234567890 », 8 chiffres ramenés à 6 (mêmes derniers chiffres).
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  test('codes de référence de la RFC', () => {
    for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']] as const)
      expect(totpCode(rfcSecret, Math.floor(seconds / 30))).toBe(expected);
  });

  test('base32 aller-retour', () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  test('accepte le code courant et un pas de décalage, refuse au-delà et tout code déjà utilisé', () => {
    const secret = generateTotpSecret();
    const at = new Date('2026-11-04T14:00:10Z');
    const step = totpStep(at);
    expect(verifyTotp(secret, totpCode(secret, step), at, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), at, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), at, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), at, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), at, step)).toBeNull();
    expect(verifyTotp(secret, '12345', at, null)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', at, null)).toBeNull();
  });

  test('lien otpauth pour les applications d’authentification', () => {
    expect(otpauthUri('ABCDEFGH', 'awa@ministere.example')).toBe(
      'otpauth://totp/Vortex%20Sentinel%3Aawa%40ministere.example?secret=ABCDEFGH&issuer=Vortex%20Sentinel&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secrets chiffrés', () => {
  test('aller-retour ; une autre clé ou un texte altéré est refusé', () => {
    const key = randomBytes(32);
    const sealed = seal(key, 'JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(unseal(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => unseal(randomBytes(32), sealed)).toThrow();
    expect(() => unseal(key, sealed.slice(0, -2) + 'AA')).toThrow();
  });
});
