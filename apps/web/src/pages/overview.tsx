import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Card, CountLink, Empty, ErrorState, Loading, PageHeader, StatusLabel, Timestamp } from '../components/common.tsx';
import { ServiceStatus } from '../components/service-status.tsx';
import { SeverityBadge, SeverityIcon } from '../components/severity.tsx';
import { overviewQuery, targetName } from '../components/shell.tsx';
import { api, type AlertSummary, type IncidentSummary } from '../lib/api.ts';
import { number, percent, relative } from '../lib/format.ts';
import { categoryLabels, ruleNames, severityLabels } from '../lib/labels.ts';
import { can, useOperator } from '../session.tsx';

export function OverviewPage() {
  const operator = useOperator();
  const overview = useQuery(overviewQuery);
  const toHandle = useQuery({ queryKey: ['incidents', 'open'], queryFn: () => api<IncidentSummary[]>('/api/incidents?status=open&limit=6'), refetchInterval: 10_000 });
  const analyst = can(operator.role, ['admin', 'analyst']);
  const alerts = useQuery({ queryKey: ['alerts', 'recent'], queryFn: () => api<AlertSummary[]>('/api/alerts?status=all&limit=8'), refetchInterval: 10_000, enabled: analyst });

  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} retry={() => overview.refetch()} />;
  const data = overview.data;
  const active = (['critical', 'high', 'medium'] as const).map((severity) => ({ severity, count: data.activeIncidents[severity] ?? 0 }));
  const activeTotal = active.reduce((sum, item) => sum + item.count, 0);
  const lagMs = data.engine.lastCycle ? Date.now() - new Date(data.engine.lastCycle).getTime() : null;

  return (
    <>
      <PageHeader title="Vue d'ensemble" meta={<>Mise à jour {relative(data.generatedAt)} · actualisée toutes les 10 s</>} />
      {data.activeIncidents.critical ? (
        <div className="banner banner-critical" role="alert">
          <SeverityIcon severity="critical" />
          <span>
            {data.activeIncidents.critical} incident{data.activeIncidents.critical > 1 ? 's' : ''} critique{data.activeIncidents.critical > 1 ? 's' : ''} ouvert
            {data.activeIncidents.critical > 1 ? 's' : ''}.
          </span>
          <Link to="/incidents" search={{ status: 'active' }} className="banner-link">
            Voir les incidents
          </Link>
        </div>
      ) : null}

      <div className="grid grid-overview">
        <Card title="État des services" action={<Link to="/availability" className="link">Disponibilité</Link>}>
          {data.probes.length === 0 ? (
            <Empty>Aucune sonde de santé configurée (PROBE_TARGETS).</Empty>
          ) : (
            <div className="service-list">
              {data.probes.map((probe) => (
                <ServiceStatus key={probe.target} name={targetName(probe.target)} probe={probe} />
              ))}
            </div>
          )}
          <dl className="facts">
            {data.emitters.map((emitter) => (
              <div key={emitter.source}>
                <dt>Collecte {targetName(emitter.source)}</dt>
                <dd>Dernier battement {relative(emitter.receivedAt)}</dd>
              </div>
            ))}
            {data.disks.map((disk) => (
              <div key={disk.path}>
                <dt>
                  Disque <span className="mono">{disk.path}</span>
                </dt>
                <dd>{percent(disk.freePercent)} libres</dd>
              </div>
            ))}
            <div>
              <dt>Moteur de corrélation</dt>
              <dd>{lagMs === null ? 'Aucun cycle encore' : `Dernier cycle ${relative(data.engine.lastCycle!)}`}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Incidents ouverts">
          {activeTotal === 0 ? (
            <Empty>Aucun incident ouvert.</Empty>
          ) : (
            <div className="counts">
              {active.map(({ severity, count }) => (
                <div key={severity} className={`count-cell${count && severity === 'critical' ? ' count-cell-critical' : ''}`}>
                  <span className={`count-severity severity-text-${severity}`}>
                    <SeverityIcon severity={severity} /> {severityLabels[severity]}
                  </span>
                  <CountLink to="/incidents" search={{ status: 'active', severity }} count={count} label={`incident${count > 1 ? 's' : ''}`} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="À prendre en charge" action={<Link to="/incidents" search={{ status: 'open' }} className="link">Tous</Link>} className="span-2">
          {toHandle.isPending ? (
            <Loading />
          ) : toHandle.isError ? (
            <ErrorState error={toHandle.error} />
          ) : toHandle.data.length === 0 ? (
            <Empty>Aucun incident en attente de prise en charge.</Empty>
          ) : (
            <ul className="incident-list">
              {toHandle.data.map((incident) => (
                <li key={incident.id}>
                  <Link to="/incidents/$id" params={{ id: incident.id }} className="incident-line">
                    <span className="incident-line-meta">
                      <SeverityBadge severity={incident.severity} />
                      <span className="mono">{incident.reference}</span>
                      <StatusLabel status={incident.status} />
                      <span className="muted">
                        ouvert <Timestamp value={incident.openedAt} />
                      </span>
                    </span>
                    <span className="incident-title">{incident.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Activité des 24 dernières heures">
          <table className="table table-compact">
            <caption className="sr-only">Événements reçus par catégorie</caption>
            <thead>
              <tr>
                <th scope="col">Catégorie</th>
                <th scope="col" className="numeric">
                  Événements
                </th>
              </tr>
            </thead>
            <tbody>
              {(['security', 'availability', 'technical', 'business'] as const).map((category) => (
                <tr key={category}>
                  <th scope="row">{categoryLabels[category]}</th>
                  <td className="numeric">
                    {analyst ? (
                      <Link to="/events" search={{ category }} className="link numeric">
                        {number(data.eventsLast24h[category] ?? 0)}
                      </Link>
                    ) : (
                      number(data.eventsLast24h[category] ?? 0)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {analyst && (
          <Card title="Dernières alertes" action={<Link to="/alerts" className="link">Toutes</Link>}>
            {alerts.isPending ? (
              <Loading />
            ) : alerts.isError ? (
              <ErrorState error={alerts.error} />
            ) : alerts.data.length === 0 ? (
              <Empty>Aucune alerte levée.</Empty>
            ) : (
              <ul className="alert-list" aria-live="polite">
                {alerts.data.map((alert) => (
                  <li key={alert.id}>
                    <Link to="/alerts/$id" params={{ id: alert.id }} className="alert-line">
                      <SeverityIcon severity={alert.severity} />
                      <span className="mono" title={ruleNames[alert.ruleId]}>
                        {alert.ruleId}
                      </span>
                      <span className="alert-summary">{alert.summary}</span>
                      <Timestamp value={alert.lastSeenAt} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
