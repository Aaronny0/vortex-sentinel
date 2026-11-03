import type { EventInput } from './event.ts';

/**
 * Exemples de référence, valides par construction. Vortex et Sentinel les font passer tous les deux dans leurs tests :
 * si l'un des schémas change sans l'autre, un test échoue. Données fictives uniquement.
 */
export const exampleEvents = {
  loginFailure: {
    id: '0b7c6f0e-5d1a-4c0e-9a51-3f0f4d7f2a01',
    schemaVersion: 1,
    occurredAt: '2026-11-03T14:32:10.000Z',
    source: 'vortex-api',
    category: 'security',
    type: 'auth.login',
    outcome: 'failure',
    actor: { emailHash: 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' },
    network: { ip: '203.0.113.37', userAgent: 'Mozilla/5.0' },
    http: { method: 'POST', route: '/api/auth/sign-in/email', status: 401, durationMs: 182 },
    attributes: { method: 'password' },
  },
  saleRefund: {
    id: '5e2d8c41-7a3b-4f6e-b1c9-8d0a2e4f6b02',
    schemaVersion: 1,
    occurredAt: '2026-11-03T18:05:44.000+01:00',
    source: 'vortex-api',
    category: 'business',
    type: 'sale.refund',
    outcome: 'success',
    actor: { userId: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b03', membershipId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c04', role: 'cashier' },
    tenant: { organizationId: '21b9a0c8-3d7e-4f61-9a2b-5c4d3e2f1a05', storeId: '7c6b5a49-3827-4615-a4b3-c2d1e0f9a806' },
    business: { operationType: 'sale.refund', reference: 'RET-2026-000042', amount: 45000, currency: 'XOF' },
  },
  probeDown: {
    id: 'c4d3e2f1-a0b9-4c8d-9e7f-6a5b4c3d2e07',
    schemaVersion: 1,
    occurredAt: '2026-11-03T03:10:00.000Z',
    source: 'sentinel-probe',
    category: 'availability',
    type: 'probe.check',
    outcome: 'failure',
    http: { method: 'GET', route: '/api/v1/health', status: 503, durationMs: 41 },
    attributes: { target: 'vortex-api', code: 'DATABASE_UNAVAILABLE' },
  },
} satisfies Record<string, EventInput>;
