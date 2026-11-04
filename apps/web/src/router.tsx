import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { ErrorState, Loading } from './components/common.tsx';
import { Shell } from './components/shell.tsx';
import { AdminPage } from './pages/admin.tsx';
import { AlertDetailPage, AlertsPage, type AlertSearch } from './pages/alerts.tsx';
import { AvailabilityPage } from './pages/availability.tsx';
import { EventsPage, type EventSearch } from './pages/events.tsx';
import { IncidentDetailPanel, IncidentPlaceholder, IncidentsLayout, type IncidentSearch } from './pages/incidents.tsx';
import { LoginPage } from './pages/login.tsx';
import { OverviewPage } from './pages/overview.tsx';
import { RulesPage } from './pages/rules.tsx';
import { SessionProvider, useSessionQuery } from './session.tsx';

/** Paramètres d'URL : seules des valeurs connues passent ; le serveur revalide de toute façon chaque filtre. */
const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(value as T) ? (value as T) : undefined);
const text = (value: unknown, max = 100) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);

function Root() {
  const session = useSessionQuery();
  if (session.isPending) return <Loading label="Ouverture de la session…" />;
  if (session.isError) return <ErrorState error={session.error} retry={() => session.refetch()} />;
  if (!session.data) return <LoginPage />;
  return (
    <SessionProvider operator={session.data}>
      <Outlet />
    </SessionProvider>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: () => <ErrorState error={new Error('Page introuvable.')} /> });
const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: Shell });

const overviewRoute = createRoute({ getParentRoute: () => shellRoute, path: '/', component: OverviewPage });

const incidentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/incidents',
  component: IncidentsLayout,
  validateSearch: (search: Record<string, unknown>): IncidentSearch => ({
    status: pick(search.status, ['active', 'all', 'open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'false_positive']),
    severity: pick(search.severity, ['medium', 'high', 'critical']),
  }),
});
const incidentsIndexRoute = createRoute({ getParentRoute: () => incidentsRoute, path: '/', component: IncidentPlaceholder });
const incidentRoute = createRoute({ getParentRoute: () => incidentsRoute, path: '$id', component: IncidentDetailPanel });

const alertsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/alerts',
  component: AlertsPage,
  validateSearch: (search: Record<string, unknown>): AlertSearch => ({
    status: pick(search.status, ['open', 'closed', 'all']),
    rule: typeof search.rule === 'string' && /^R\d{2}$/.test(search.rule) ? search.rule : undefined,
  }),
});
const alertRoute = createRoute({ getParentRoute: () => shellRoute, path: '/alerts/$id', component: AlertDetailPage });

const eventsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/events',
  component: EventsPage,
  validateSearch: (search: Record<string, unknown>): EventSearch => ({
    type: text(search.type),
    category: pick(search.category, ['availability', 'technical', 'security', 'business']),
    outcome: pick(search.outcome, ['success', 'failure', 'unknown']),
    ip: text(search.ip, 45),
    account: text(search.account, 64),
    from: text(search.from, 40),
    before: text(search.before, 40),
  }),
});

const availabilityRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/availability',
  component: AvailabilityPage,
  validateSearch: (search: Record<string, unknown>): { days?: 1 | 7 | 30 } => ({ days: pick(String(search.days ?? ''), ['1', '7', '30']) ? (Number(search.days) as 1 | 7 | 30) : undefined }),
});
const rulesRoute = createRoute({ getParentRoute: () => shellRoute, path: '/rules', component: RulesPage });
const adminRoute = createRoute({ getParentRoute: () => shellRoute, path: '/admin', component: AdminPage });

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    overviewRoute,
    incidentsRoute.addChildren([incidentsIndexRoute, incidentRoute]),
    alertsRoute,
    alertRoute,
    eventsRoute,
    availabilityRoute,
    rulesRoute,
    adminRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
