import { eventBatchSchema } from '@sentinel/schema';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { Clock } from '../common/clock.ts';
import { AppError } from '../common/errors.ts';
import type { ReplayGuard } from './replay-guard.ts';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature.ts';
import { storeBatch } from './store.ts';

/** Un lot de 500 événements tient largement dans 1 Mo. */
export const MAX_INGEST_BYTES = 1024 * 1024;
const MAX_FIELD_ERRORS = 20;

/** Champ → premier message, borné : un lot malformé ne produit pas une réponse de plusieurs mégaoctets. */
function fieldsOf(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join('.') || 'lot';
    if (!(path in fields)) fields[path] = issue.message;
    if (Object.keys(fields).length >= MAX_FIELD_ERRORS) break;
  }
  return fields;
}

/**
 * POST /ingest. Ordre fixe, chaque étape refuse avant la suivante (docs/backend.md § 4) : taille, horodatage et signature
 * sur le corps brut, rejeu, JSON, schéma (lot entier refusé), enregistrement. Le corps n'est jamais journalisé.
 */
/**
 * Débit maximal accepté par minute, après authentification (un émetteur normal envoie un lot toutes les 5 s) : au-delà,
 * 429 avec Retry-After, et l'émetteur garde ses événements pour plus tard. Protège la base d'un émetteur emballé ou
 * d'un secret volé, sans jamais perdre en silence : chaque lot refusé est réessayé.
 */
export const INGEST_RATE: { batchesPerMinute: number; eventsPerMinute: number } = { batchesPerMinute: 120, eventsPerMinute: 30_000 };

export const ingestPlugin = (deps: { pool: Pool; clock: Clock; secrets: readonly string[]; replayGuard: ReplayGuard; rate?: typeof INGEST_RATE }) => {
  const rate = deps.rate ?? INGEST_RATE;
  let minute = -1;
  let batches = 0;
  let events = 0;
  return new Elysia({ name: 'ingest' }).post(
    '/ingest',
    async ({ request, set }) => {
      const declared = Number(request.headers.get('content-length') ?? 0);
      if (declared > MAX_INGEST_BYTES) throw new AppError(413, 'BODY_TOO_LARGE', 'Le lot est trop volumineux.');
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength > MAX_INGEST_BYTES) throw new AppError(413, 'BODY_TOO_LARGE', 'Le lot est trop volumineux.');

      const now = deps.clock.now();
      const signature = request.headers.get(SIGNATURE_HEADER);
      verifySignature({ secrets: deps.secrets, timestamp: request.headers.get(TIMESTAMP_HEADER), signature, body: raw, now });
      if (!deps.replayGuard.firstSeen(signature!, now)) throw new AppError(401, 'REPLAYED', 'Requête déjà reçue.');
      const current = Math.floor(now.getTime() / 60_000);
      if (current !== minute) [minute, batches, events] = [current, 0, 0];
      if (batches >= rate.batchesPerMinute || events >= rate.eventsPerMinute) {
        set.headers['retry-after'] = String(60 - Math.floor((now.getTime() / 1000) % 60));
        throw new AppError(429, 'RATE_LIMITED', 'Débit trop élevé : réessayez plus tard.');
      }
      batches += 1;

      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch {
        throw new AppError(400, 'INVALID_BODY', 'Le corps de la requête est illisible.');
      }
      const batch = eventBatchSchema.safeParse(json);
      if (!batch.success) throw new AppError(422, 'VALIDATION_FAILED', 'Lot refusé : certains événements sont invalides.', fieldsOf(batch.error.issues));

      events += batch.data.events.length;
      const result = await storeBatch(deps.pool, batch.data.events, now);
      set.status = 202;
      return result;
    },
    { parse: 'none' },
  );
};
