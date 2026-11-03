import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_BATCH_EVENTS, eventBatchSchema, eventCatalog, eventInputSchema, exampleEvents } from '../src/index.ts';

const { loginFailure, saleRefund, probeDown } = exampleEvents;

const issuesOf = (value: unknown) => {
  const result = eventInputSchema.safeParse(value);
  assert.equal(result.success, false, 'le schéma aurait dû refuser cet événement');
  return result.error!.issues;
};

describe('événement', () => {
  test('accepte les exemples de référence', () => {
    for (const [name, event] of Object.entries(exampleEvents)) assert.ok(eventInputSchema.safeParse(event).success, name);
  });

  test('chaque type du catalogue a une catégorie connue', () => {
    for (const category of Object.values(eventCatalog)) assert.match(category, /^(availability|technical|security|business)$/);
  });

  test('refuse un type inconnu', () => {
    assert.equal(issuesOf({ ...loginFailure, type: 'auth.hack' })[0]?.path[0], 'type');
  });

  test('refuse une catégorie qui ne correspond pas au type', () => {
    assert.deepEqual(issuesOf({ ...loginFailure, category: 'business' }).map((issue) => issue.path[0]), ['category', 'business']);
  });

  test('refuse un champ inconnu, y compris receivedAt fourni par le producteur', () => {
    issuesOf({ ...loginFailure, receivedAt: loginFailure.occurredAt });
    issuesOf({ ...loginFailure, actor: { ...loginFailure.actor, email: 'a@b.fr' } });
  });

  test("refuse une empreinte d'email qui n'en est pas une", () => {
    issuesOf({ ...loginFailure, actor: { emailHash: 'caissier@boutique.fr' } });
  });

  test('refuse une route avec paramètres de requête', () => {
    issuesOf({ ...probeDown, http: { ...probeDown.http, route: '/api/v1/health?token=abc' } });
  });

  test("refuse une adresse IP invalide", () => {
    issuesOf({ ...loginFailure, network: { ip: '999.1.1.1' } });
  });

  test("refuse un événement métier sans entreprise ou sans opération", () => {
    const { tenant: _tenant, ...withoutTenant } = saleRefund;
    issuesOf(withoutTenant);
    const { business: _business, ...withoutBusiness } = saleRefund;
    issuesOf(withoutBusiness);
  });

  test('refuse un montant non entier', () => {
    issuesOf({ ...saleRefund, business: { ...saleRefund.business, amount: 450.5 } });
  });

  test('refuse une autre version de schéma', () => {
    issuesOf({ ...loginFailure, schemaVersion: 2 });
  });
});

describe('lot', () => {
  const sentAt = '2026-11-03T14:32:15.000Z';

  test('accepte un lot valide', () => {
    assert.ok(eventBatchSchema.safeParse({ sentAt, events: [loginFailure, saleRefund] }).success);
  });

  test('refuse un lot vide ou trop gros', () => {
    assert.equal(eventBatchSchema.safeParse({ sentAt, events: [] }).success, false);
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => loginFailure);
    assert.equal(eventBatchSchema.safeParse({ sentAt, events }).success, false);
  });

  test('refuse tout le lot si un seul événement est invalide', () => {
    assert.equal(eventBatchSchema.safeParse({ sentAt, events: [loginFailure, { ...saleRefund, type: 'inconnu' }] }).success, false);
  });
});
