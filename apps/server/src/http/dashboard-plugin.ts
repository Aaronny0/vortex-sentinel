import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { Clock } from '../common/clock.ts';
import { AppError } from '../common/errors.ts';
import {
  commentIncident,
  getAlert,
  getIncident,
  listAlerts,
  listAudit,
  listIncidents,
  listRules,
  overview,
  redactForObserver,
  searchEvents,
} from '../dashboard/queries.ts';
import { incidentReference, transitionIncident } from '../incidents/transitions.ts';
import { SESSION, type Operator, type OperatorService, type RequestMeta, type Role } from '../operators/service.ts';

export const SESSION_COOKIE = 'sentinel_session';

type Deps = { pool: Pool; clock: Clock; operators: OperatorService; dashboardOrigin: string };

const readCookie = (request: Request, name: string) =>
  request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

/**
 * API du tableau de bord (`/api/*`). Session par cookie httpOnly, SameSite=Strict, Secure en HTTPS ; toute écriture
 * vérifie aussi l'origine. Droits par rôle (docs/conception.md § 8.1) :
 * - Observateur : état des services, incidents (textes expurgés : ni adresse IP, ni empreinte de compte) et règles ;
 * - Analyste : en plus, alertes, preuves et recherche d'événements (chaque consultation est journalisée), transitions ;
 * - Administrateur : en plus, opérateurs et journal d'audit.
 */
export function dashboardPlugin(deps: Deps) {
  const { pool, clock, operators, dashboardOrigin } = deps;
  const secure = dashboardOrigin.startsWith('https:');
  const cookie = (value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  const metaOf = (request: Request, ip?: string | null): RequestMeta => ({ ip: ip ?? null, userAgent: request.headers.get('user-agent') });

  const checkOrigin = (request: Request) => {
    if (request.method !== 'GET' && request.headers.get('origin') !== dashboardOrigin) throw new AppError(403, 'ORIGIN_REFUSED', 'Origine refusée.');
  };
  const requireOperator = async (request: Request, allowed: readonly Role[] = ['admin', 'analyst', 'observer']): Promise<Operator> => {
    checkOrigin(request);
    const operator = await operators.resolveSession(readCookie(request, SESSION_COOKIE));
    if (!operator) throw new AppError(401, 'UNAUTHENTICATED', 'Connexion requise.');
    if (!allowed.includes(operator.role)) throw new AppError(403, 'FORBIDDEN', "Votre rôle ne permet pas cette action.");
    return operator;
  };
  const ANALYSTS: Role[] = ['admin', 'analyst'];
  const ADMINS: Role[] = ['admin'];

  return new Elysia({ name: 'dashboard', prefix: '/api' })
    .onAfterHandle(({ set }) => {
      set.headers['cache-control'] = 'no-store';
    })
    .derive(({ server, request }) => ({ clientIp: server?.requestIP(request)?.address ?? null }))
    .post('/session/login', async ({ request, body, clientIp }) => {
      checkOrigin(request);
      return operators.startLogin(body, metaOf(request, clientIp));
    })
    .post('/session/verify', async ({ request, body, set, clientIp }) => {
      checkOrigin(request);
      const { token, operator } = await operators.completeLogin(body, metaOf(request, clientIp));
      set.headers['set-cookie'] = cookie(token, SESSION.maxAgeMs / 1000);
      return { operator };
    })
    .get('/session', async ({ request }) => ({ operator: await requireOperator(request) }))
    .post('/session/logout', async ({ request, set, clientIp }) => {
      checkOrigin(request);
      await operators.logout(readCookie(request, SESSION_COOKIE), metaOf(request, clientIp));
      set.headers['set-cookie'] = cookie('', 0);
      set.status = 204;
      return '';
    })
    .get('/overview', async ({ request }) => {
      await requireOperator(request);
      return overview(pool, clock);
    })
    .get('/incidents', async ({ request, query }) => {
      const operator = await requireOperator(request);
      const rows = await listIncidents(pool, query);
      return rows.map((row) => ({ ...row, reference: incidentReference(row.number), title: operator.role === 'observer' ? redactForObserver(row.title) : row.title }));
    })
    .get('/incidents/:id', async ({ request, params }) => {
      const operator = await requireOperator(request);
      const incident = await getIncident(pool, params.id);
      const view = { ...incident, reference: incidentReference(incident.number) };
      if (operator.role !== 'observer') return view;
      return {
        ...view,
        key: undefined,
        title: redactForObserver(view.title),
        alerts: view.alerts.map((alert: { summary: string }) => ({ ...alert, summary: redactForObserver(alert.summary) })),
        history: view.history.map((entry: { comment: string | null }) => ({ ...entry, comment: entry.comment && redactForObserver(entry.comment) })),
      };
    })
    .post('/incidents/:id/transitions', async ({ request, params, body, clientIp }) => {
      const operator = await requireOperator(request, ANALYSTS);
      const input = (body ?? {}) as { to?: unknown; comment?: unknown };
      const incident = await transitionIncident(pool, clock, { incidentId: params.id, to: input.to as never, comment: input.comment as never, actorId: operator.id });
      await operators.audit(operator.id, 'incident.transition', metaOf(request, clientIp), { type: 'incident', id: params.id }, { to: incident.status });
      return { ...incident, reference: incidentReference(incident.number) };
    })
    .post('/incidents/:id/comments', async ({ request, params, body, set, clientIp }) => {
      const operator = await requireOperator(request, ANALYSTS);
      await commentIncident(pool, clock, params.id, operator.id, body);
      await operators.audit(operator.id, 'incident.commented', metaOf(request, clientIp), { type: 'incident', id: params.id });
      set.status = 201;
      return { ok: true };
    })
    .get('/alerts', async ({ request, query }) => {
      await requireOperator(request, ANALYSTS);
      return listAlerts(pool, query);
    })
    .get('/alerts/:id', async ({ request, params, clientIp }) => {
      const operator = await requireOperator(request, ANALYSTS);
      const alert = await getAlert(pool, params.id);
      // Les preuves portent des adresses IP : chaque consultation est journalisée (décision de conservation, § 5).
      await operators.audit(operator.id, 'event.viewed', metaOf(request, clientIp), { type: 'alert', id: params.id }, { events: alert.events.length });
      return alert;
    })
    .get('/events', async ({ request, query, clientIp }) => {
      const operator = await requireOperator(request, ANALYSTS);
      const result = await searchEvents(pool, clock, query);
      await operators.audit(operator.id, 'event.searched', metaOf(request, clientIp), undefined, { filters: query, results: result.events.length });
      return result;
    })
    .get('/rules', async ({ request }) => {
      await requireOperator(request);
      return listRules(pool);
    })
    .get('/operators', async ({ request }) => {
      await requireOperator(request, ADMINS);
      return operators.listOperators();
    })
    .post('/operators', async ({ request, body, set, clientIp }) => {
      const operator = await requireOperator(request, ADMINS);
      set.status = 201;
      return operators.createOperator(body, operator.id, metaOf(request, clientIp));
    })
    .patch('/operators/:id', async ({ request, params, body, clientIp }) => {
      const operator = await requireOperator(request, ADMINS);
      await operators.updateOperator(operator, params.id, body, metaOf(request, clientIp));
      return { ok: true };
    })
    .get('/audit', async ({ request, query }) => {
      await requireOperator(request, ADMINS);
      return listAudit(pool, query);
    });
}
