import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type Overview } from '../lib/api.ts';
import { roleLabels } from '../lib/labels.ts';
import { readTheme, setTheme, type ThemeChoice } from '../lib/theme.ts';
import { can, useLogout, useOperator } from '../session.tsx';
import { ServiceStatus } from './service-status.tsx';
import { SeverityIcon } from './severity.tsx';

export const overviewQuery = { queryKey: ['overview'], queryFn: () => api<Overview>('/api/overview'), refetchInterval: 10_000 } as const;

/** Noms affichés des cibles de sonde connues ; une cible inconnue garde son nom technique. */
const targetNames: Record<string, string> = { 'vortex-api': 'API', 'vortex-web': 'Web', 'vortex-admin': 'Admin' };
export const targetName = (target: string) => targetNames[target] ?? target;

/** Barre d'état : présente sur tous les écrans, répond à « est-ce que tout va bien ? » en un regard. */
function StatusBar() {
  const { data, isError } = useQuery(overviewQuery);
  const critical = data?.activeIncidents.critical ?? 0;
  const high = data?.activeIncidents.high ?? 0;
  const urgent = critical + high;
  useEffect(() => {
    document.title = critical > 0 ? `(${critical}) Sentinel` : 'Sentinel';
  }, [critical]);
  return (
    <header className="status-bar">
      <Link to="/" className="brand" aria-label="Sentinel, vue d'ensemble">
        <img src="/favicon.svg" alt="" width="22" height="22" />
        <span>Sentinel</span>
      </Link>
      <div className="status-services" aria-label="État des services">
        {isError && <span className="muted">État indisponible</span>}
        {data?.probes.map((probe) => <ServiceStatus key={probe.target} name={targetName(probe.target)} probe={probe} compact />)}
        {data && data.probes.length === 0 && <span className="muted">Aucune sonde configurée</span>}
      </div>
      {data && (
        <Link
          to="/incidents"
          search={{ status: 'active' }}
          className={`status-incidents${critical ? ' status-incidents-critical' : high ? ' status-incidents-high' : ''}`}
          aria-label={`${critical} incidents critiques et ${high} élevés ouverts`}
        >
          {urgent === 0 ? (
            'Aucun incident urgent'
          ) : (
            <>
              {critical > 0 && (
                <span>
                  <SeverityIcon severity="critical" /> {critical} critique{critical > 1 ? 's' : ''}
                </span>
              )}
              {high > 0 && (
                <span>
                  <SeverityIcon severity="high" /> {high} élevé{high > 1 ? 's' : ''}
                </span>
              )}
            </>
          )}
        </Link>
      )}
    </header>
  );
}

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="rail-item" activeProps={{ className: 'rail-item rail-item-active', 'aria-current': 'page' }} activeOptions={{ exact: to === '/' }}>
      {children}
    </Link>
  );
}

function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme());
  return (
    <label className="theme-switch">
      <span>Thème</span>
      <select
        value={choice}
        onChange={(event) => {
          const next = event.target.value as ThemeChoice;
          setChoice(next);
          setTheme(next);
        }}
      >
        <option value="system">Système</option>
        <option value="light">Clair</option>
        <option value="dark">Sombre</option>
      </select>
    </label>
  );
}

export function Shell() {
  const operator = useOperator();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="app">
      <a href="#contenu" className="skip-link">
        Aller au contenu
      </a>
      <StatusBar />
      <div className="app-body">
        <nav className={`rail${open ? ' rail-open' : ''}`} aria-label="Navigation principale">
          <button type="button" className="rail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            Menu
          </button>
          <div className="rail-items">
            <NavItem to="/">Vue d'ensemble</NavItem>
            <NavItem to="/incidents">Incidents</NavItem>
            {can(operator.role, ['admin', 'analyst']) && <NavItem to="/alerts">Alertes</NavItem>}
            {can(operator.role, ['admin', 'analyst']) && <NavItem to="/events">Événements</NavItem>}
            <NavItem to="/availability">Disponibilité</NavItem>
            <NavItem to="/rules">Règles</NavItem>
            {can(operator.role, ['admin']) && <NavItem to="/admin">Administration</NavItem>}
          </div>
          <div className="rail-footer">
            <p className="rail-user">
              <span>{operator.name}</span>
              <span className="muted">{roleLabels[operator.role]}</span>
            </p>
            <ThemeSwitch />
            <button type="button" className="button button-ghost" onClick={logout}>
              Se déconnecter
            </button>
          </div>
        </nav>
        <main id="contenu" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
