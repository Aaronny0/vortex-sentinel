import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Codes à usage unique basés sur le temps (RFC 6238) : 6 chiffres, pas de 30 s, HMAC-SHA1, comme les applications courantes. */
export const TOTP = { digits: 6, periodSeconds: 30, /** Pas acceptés de part et d'autre : tolère 30 s de décalage d'horloge. */ drift: 1 } as const;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Secret TOTP invalide.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Secret de 160 bits, en base32 (format attendu par les applications d'authentification). */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP.periodSeconds);

/** Code d'un pas de temps (RFC 4226, troncature dynamique). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP.digits).padStart(TOTP.digits, '0');
}

/**
 * Vérifie un code dans la fenêtre tolérée et renvoie son pas de temps, ou null. Un pas déjà utilisé (`lastStep`) ou
 * antérieur est refusé : un code vu par-dessus l'épaule ne sert pas une seconde fois.
 */
export function verifyTotp(secret: string, code: string, at: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(at);
  for (let delta = -TOTP.drift; delta <= TOTP.drift; delta += 1) {
    const step = current + delta;
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** Lien `otpauth://` lu par les applications d'authentification (affiché aussi en QR code). */
export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`Vortex Sentinel:${account}`)}?secret=${secret}&issuer=${encodeURIComponent('Vortex Sentinel')}&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.periodSeconds}`;
