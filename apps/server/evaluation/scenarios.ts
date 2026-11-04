import { createHash, randomUUID } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';

/**
 * Scénarios d'évaluation (docs/conception.md § 11). Données fictives uniquement : adresses de documentation (RFC 5737),
 * comptes et entreprises inventés. Chaque scénario donne ses événements datés par rapport au début de l'attaque (`t0`),
 * l'instant où la condition de la règle est remplie (pour mesurer le délai de détection) et les règles attendues.
 */

export type Timed = { at: number; event: EventInput };
export type Scenario = {
  id: string;
  name: string;
  expected: string[];
  /** Décalage (ms depuis t0) de l'événement qui remplit la condition de chaque règle attendue. */
  conditionMetAt: Record<string, number>;
  /** Durée simulée après t0. */
  durationMs: number;
  /** Pas du moteur (30 s comme en production ; plus long pour la semaine normale). */
  stepMs?: number;
  events(t0: number): Timed[];
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Délai d'un lot de l'émetteur de Vortex (envoi toutes les 5 s). */
const BATCH = 5 * SECOND;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const organizationId = '21b9a0c8-3d7e-4f61-9a2b-5c4d3e2f1a05';
const storeId = '7c6b5a49-3827-4615-a4b3-c2d1e0f9a806';
const members = ['1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c04', '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d06', '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e07'];
let reference = 0;

const make = (at: number, partial: Partial<EventInput> & Pick<EventInput, 'type' | 'category' | 'outcome'>, source: EventInput['source'] = 'vortex-api'): Timed => ({
  at: at + (source === 'vortex-api' ? BATCH : 0),
  event: eventInputSchema.parse({ id: randomUUID(), schemaVersion: 1, occurredAt: new Date(at).toISOString(), source, ...partial }),
});

const probe = (at: number, outcome: 'success' | 'failure', code?: string) =>
  make(at, { type: 'probe.check', category: 'availability', outcome, attributes: { target: 'vortex-api', ...(code && { code }) }, ...(outcome === 'success' && { http: { method: 'GET', route: '/api/v1/health', status: 200, durationMs: 35 } }) }, 'sentinel-probe');
const heartbeat = (at: number) => make(at, { type: 'emitter.heartbeat', category: 'availability', outcome: 'success', attributes: { sent: 1, pending: 0, droppedOverflow: 0, droppedInvalid: 0, rejected: 0 } });
const login = (at: number, outcome: 'success' | 'failure', account: string, ip: string) =>
  make(at, { type: 'auth.login', category: 'security', outcome, actor: { emailHash: hash(account) }, network: { ip, userAgent: 'Mozilla/5.0' }, attributes: { method: 'password', ...(outcome === 'failure' && { code: 'INVALID_EMAIL_OR_PASSWORD' }) } });
const business = (at: number, type: string, member: string, options: { amount?: number; quantity?: number; account?: string; subjectId?: string } = {}) =>
  make(at, {
    type,
    category: 'business',
    outcome: 'success',
    actor: { membershipId: member, role: 'cashier', ...(options.account && { emailHash: hash(options.account) }) },
    tenant: { organizationId, storeId },
    business: { operationType: type, reference: `EVA-2026-${String((reference += 1)).padStart(6, '0')}`, ...(options.amount !== undefined && { amount: options.amount, currency: 'XOF' }), ...(options.quantity !== undefined && { quantity: options.quantity }) },
    ...(options.subjectId && { attributes: { subjectId: options.subjectId } }),
  });
const metrics = (at: number, route: string, p95Ms: number, count: number, serverErrors: number) =>
  make(at, {
    type: 'http.metrics',
    category: 'technical',
    outcome: 'success',
    attributes: { method: 'GET', route, windowStart: new Date(Math.floor(at / MINUTE) * MINUTE - MINUTE).toISOString(), windowSeconds: 60, count, serverErrors, clientErrors: 0, p50Ms: Math.round(p95Ms / 3), p95Ms, maxMs: p95Ms + 200 },
  });
const notFound = (at: number, ip: string) => make(at, { type: 'http.access', category: 'technical', outcome: 'failure', network: { ip }, http: { method: 'GET', route: '/*', status: 404, durationMs: 2 } });
const mailFailed = (at: number) => make(at, { type: 'mail.failed', category: 'availability', outcome: 'failure', attributes: { kind: 'link' } });
const disk = (at: number, freePercent: number) => make(at, { type: 'host.disk', category: 'availability', outcome: 'success', attributes: { path: '/', freePercent, freeBytes: freePercent * 1e9, totalBytes: 100e9 } }, 'sentinel-probe');
const certificate = (at: number, validTo: number) =>
  make(at, { type: 'tls.certificate', category: 'availability', outcome: 'success', attributes: { target: 'vortex.example:443', validTo: new Date(validTo).toISOString(), daysLeft: Math.floor((validTo - at) / DAY), authorized: true } }, 'sentinel-probe');

/** Bruit de fond sain pendant un scénario : sonde qui répond, battements de cœur. */
const background = (t0: number, durationMs: number, options: { probes?: boolean; heartbeats?: boolean } = {}) => {
  const events: Timed[] = [];
  for (let at = t0 - 10 * MINUTE; at <= t0 + durationMs; at += 30 * SECOND) {
    if (options.probes !== false) events.push(probe(at, 'success'));
    if (options.heartbeats !== false) events.push(heartbeat(at));
  }
  return events;
};

export const scenarios: Scenario[] = [
  {
    id: 'S01',
    name: 'Arrêt de la base de données',
    expected: ['R01'],
    conditionMetAt: { R01: 60 * SECOND },
    durationMs: 6 * MINUTE,
    events: (t0) => [
      ...background(t0 - 11 * MINUTE, 11 * MINUTE - 30 * SECOND, { probes: true }),
      ...background(t0, 6 * MINUTE, { probes: false }),
      ...Array.from({ length: 12 }, (_, i) => probe(t0 + i * 30 * SECOND, 'failure', 'DATABASE_UNAVAILABLE')),
    ],
  },
  {
    id: 'S02',
    name: "Arrêt de l'émetteur de Vortex",
    expected: ['R02'],
    conditionMetAt: { R02: 2 * MINUTE },
    durationMs: 6 * MINUTE,
    events: (t0) => [...background(t0 - 10 * MINUTE, 10 * MINUTE - SECOND), ...background(t0, 6 * MINUTE, { heartbeats: false })],
  },
  {
    id: 'S03',
    name: 'Charge provoquant lenteurs et erreurs',
    expected: ['R03', 'R04'],
    conditionMetAt: { R03: 5 * MINUTE, R04: 1 * MINUTE },
    durationMs: 9 * MINUTE,
    events: (t0) => [...background(t0, 9 * MINUTE), ...Array.from({ length: 8 }, (_, i) => metrics(t0 + (i + 1) * MINUTE, '/api/v1/workspace', 2_600, 120, 12))],
  },
  {
    id: 'S04',
    name: 'Force brute sur un compte, puis connexion réussie',
    expected: ['R05', 'R07'],
    conditionMetAt: { R05: 9 * 20 * SECOND, R07: 5 * MINUTE },
    durationMs: 8 * MINUTE,
    events: (t0) => [
      ...background(t0, 8 * MINUTE),
      ...Array.from({ length: 14 }, (_, i) => login(t0 + i * 20 * SECOND, 'failure', 'gerant@boutique.example', '198.51.100.23')),
      login(t0 + 5 * MINUTE, 'success', 'gerant@boutique.example', '198.51.100.23'),
    ],
  },
  {
    id: 'S05',
    name: "Bourrage d'identifiants depuis une adresse",
    expected: ['R06'],
    conditionMetAt: { R06: 19 * 10 * SECOND },
    durationMs: 8 * MINUTE,
    events: (t0) => [...background(t0, 8 * MINUTE), ...Array.from({ length: 30 }, (_, i) => login(t0 + i * 10 * SECOND, 'failure', `client${i % 10}@liste.example`, '203.0.113.66'))],
  },
  {
    id: 'S06',
    name: "Nouvelle adresse puis changement d'équipe",
    expected: ['R09'],
    conditionMetAt: { R09: 12 * MINUTE },
    durationMs: 16 * MINUTE,
    events: (t0) => [
      ...background(t0, 16 * MINUTE),
      ...Array.from({ length: 10 }, (_, day) => login(t0 - (day + 1) * DAY, 'success', 'proprietaire@boutique.example', '203.0.113.10')),
      login(t0 + 2 * MINUTE, 'success', 'proprietaire@boutique.example', '198.51.100.99'),
      business(t0 + 12 * MINUTE, 'team.update', members[0]!, { account: 'proprietaire@boutique.example' }),
    ],
  },
  {
    id: 'S07',
    name: 'Membre multipliant les remboursements',
    expected: ['R10'],
    conditionMetAt: { R10: 1 * HOUR },
    durationMs: 3 * HOUR,
    stepMs: 5 * MINUTE,
    events: (t0) => [
      ...background(t0, 0),
      ...Array.from({ length: 4 }, (_, week) => business(t0 - (week + 1) * 7 * DAY, 'sale.refund', members[1]!, { amount: 15_000 })),
      ...Array.from({ length: 5 }, (_, i) => business(t0 + i * 30 * MINUTE, i % 2 ? 'sale.return' : 'sale.refund', members[1]!, { amount: 25_000 + i * 1_000 })),
    ],
  },
  {
    id: 'S08',
    name: 'Caissier avec manques de caisse répétés',
    expected: ['R11'],
    conditionMetAt: { R11: 10 * MINUTE },
    durationMs: 30 * MINUTE,
    stepMs: MINUTE,
    events: (t0) => [
      ...background(t0, 0),
      business(t0 - 19 * DAY, 'cash.close', members[2]!, { amount: -1_500 }),
      business(t0 - 8 * DAY, 'cash.close', members[2]!, { amount: -2_000 }),
      business(t0 + 10 * MINUTE, 'cash.close', members[2]!, { amount: -3_500 }),
    ],
  },
  {
    id: 'S09',
    name: 'Exploration de chemins par un scanner',
    expected: ['R14'],
    conditionMetAt: { R14: 29 * 4 * SECOND },
    durationMs: 8 * MINUTE,
    events: (t0) => [...background(t0, 8 * MINUTE), ...Array.from({ length: 45 }, (_, i) => notFound(t0 + i * 4 * SECOND, '192.0.2.77'))],
  },
  {
    id: 'S10',
    name: "Certificat proche de l'expiration",
    expected: ['R15'],
    conditionMetAt: { R15: 0 },
    durationMs: 5 * MINUTE,
    events: (t0) => [...background(t0, 5 * MINUTE), certificate(t0, t0 + 10 * DAY)],
  },
  {
    id: 'S11',
    name: 'Serveur email injoignable',
    expected: ['R16'],
    conditionMetAt: { R16: 2 * MINUTE },
    durationMs: 8 * MINUTE,
    events: (t0) => [...background(t0, 8 * MINUTE), ...Array.from({ length: 5 }, (_, i) => mailFailed(t0 + i * MINUTE))],
  },
  {
    id: 'S12',
    name: 'Disque presque plein',
    expected: ['R17'],
    conditionMetAt: { R17: 0 },
    durationMs: 6 * MINUTE,
    events: (t0) => [...background(t0, 6 * MINUTE), disk(t0 - 5 * MINUTE, 41), disk(t0, 9)],
  },
  {
    id: 'S13',
    name: 'Activité normale pendant une semaine',
    expected: [],
    conditionMetAt: {},
    durationMs: 7 * DAY,
    stepMs: 10 * MINUTE,
    events: (t0) => {
      const events: Timed[] = [];
      const staff = ['gerant@boutique.example', 'caisse1@boutique.example', 'caisse2@boutique.example', 'stock@boutique.example'];
      const offices = ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13'];
      // Historique de la boutique sur le mois précédent : mêmes horaires, mêmes adresses (références de R09, R10, R13).
      for (let day = -30; day < 7; day += 1) {
        const morning = t0 + day * DAY + 8 * HOUR;
        staff.forEach((account, index) => events.push(login(morning + index * 7 * MINUTE, 'success', account, offices[index]!)));
        if (day % 3 === 0) events.push(login(morning + 40 * MINUTE, 'failure', staff[1]!, offices[1]!));
        events.push(business(morning + HOUR, 'cash.open', members[1]!, { amount: 50_000 }));
        for (let sale = 0; sale < 12; sale += 1) events.push(business(morning + HOUR + sale * 35 * MINUTE, 'sale.create', members[sale % 2]!, { amount: 60_000 + sale * 5_000, quantity: 1 }));
        if (day % 2 === 0) events.push(business(morning + 5 * HOUR, 'sale.refund', members[day % 3 === 0 ? 0 : 1]!, { amount: 30_000 }));
        events.push(business(morning + 9 * HOUR, 'cash.close', members[1]!, { amount: day === -20 ? -400 : day % 4 === 0 ? 300 : 0 }));
        if (day % 5 === 0) events.push(business(morning + 6 * HOUR, 'stock.adjust', members[2]!, { amount: 25_000, quantity: 1, subjectId: '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f08' }));
        if (day >= 0) {
          for (let hour = 0; hour < 24; hour += 1) {
            const at = t0 + day * DAY + hour * HOUR;
            events.push(probe(at, 'success'), heartbeat(at), disk(at, 41 - day * 0.1));
            if (hour >= 8 && hour < 18) events.push(metrics(at + 30 * MINUTE, '/api/v1/workspace', 320, 90, hour === 12 ? 1 : 0));
          }
          events.push(notFound(t0 + day * DAY + 14 * HOUR, '203.0.113.11'), certificate(t0 + day * DAY + 3 * HOUR, t0 + 75 * DAY));
        }
      }
      return events;
    },
  },
];
