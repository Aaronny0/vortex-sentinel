import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/errors.ts';

export const TIMESTAMP_HEADER = 'x-sentinel-timestamp';
export const SIGNATURE_HEADER = 'x-sentinel-signature';

/** Écart toléré entre l'horloge de l'émetteur et celle de Sentinel, en secondes. */
export const TIMESTAMP_TOLERANCE_S = 300;

const digest = (secret: string, timestamp: string, body: Uint8Array) =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(`${timestamp}.`).update(body).digest();

/** Signature d'un lot, version 1 : HMAC-SHA256(secret, timestamp + "." + corps brut). Utilisée par l'émetteur et les tests. */
export function sign(secret: string, timestamp: string, body: Uint8Array | string): string {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return `v1=${digest(secret, timestamp, bytes).toString('hex')}`;
}

const refuse = (code: string, message: string) => new AppError(401, code, message);

/**
 * Vérifie l'horodatage puis la signature, calculée sur le corps tel que reçu (jamais sur un JSON re-sérialisé).
 * Chaque secret accepté est essayé : deux secrets coexistent pendant une rotation. Comparaison en temps constant.
 */
export function verifySignature(input: {
  secrets: readonly string[];
  timestamp: string | null;
  signature: string | null;
  body: Uint8Array;
  now: Date;
}): void {
  const { secrets, timestamp, signature, body, now } = input;
  if (!timestamp || !/^\d{10}$/.test(timestamp)) throw refuse('MISSING_TIMESTAMP', 'Horodatage absent ou invalide.');
  if (!signature || !/^v1=[0-9a-f]{64}$/.test(signature)) throw refuse('MISSING_SIGNATURE', 'Signature absente ou invalide.');
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (skew > TIMESTAMP_TOLERANCE_S) throw refuse('STALE_REQUEST', 'Horodatage hors de la fenêtre acceptée.');
  const received = Buffer.from(signature.slice(3), 'hex');
  const valid = secrets.some((secret) => timingSafeEqual(digest(secret, timestamp, body), received));
  if (!valid) throw refuse('BAD_SIGNATURE', 'Signature refusée.');
}
