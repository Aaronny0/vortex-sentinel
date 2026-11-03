import { randomUUID } from 'node:crypto';
import { eventCatalog, eventInputSchema, SCHEMA_VERSION, type EventInput } from '@sentinel/schema';
import type { Clock } from '../common/clock.ts';

export type ProbeEventType = 'probe.check' | 'tls.certificate' | 'host.disk';

/** Code d'erreur court et sûr à enregistrer : jamais un message libre, qui pourrait contenir une adresse ou un chemin. */
export const safeCode = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : fallback;

/**
 * Événement produit par une sonde, validé par le schéma partagé comme ceux de Vortex : une sonde qui produirait un
 * événement invalide est un défaut du code, signalé tout de suite plutôt qu'enregistré.
 */
export function probeEvent(
  type: ProbeEventType,
  outcome: EventInput['outcome'],
  clock: Clock,
  details: Pick<EventInput, 'http' | 'attributes'>,
): EventInput {
  return eventInputSchema.parse({
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    occurredAt: clock.now().toISOString(),
    source: 'sentinel-probe',
    category: eventCatalog[type],
    type,
    outcome,
    ...details,
  });
}
