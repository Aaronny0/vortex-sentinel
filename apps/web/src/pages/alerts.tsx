import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Card, Empty, ErrorState, Loading, PageHeader, RuleRef, Timestamp } from '../components/common.tsx';
import { EventTable } from '../components/event-table.tsx';
import { SeverityBadge } from '../components/severity.tsx';
import { api, query, type AlertDetail, type AlertSummary } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { ruleNames, thresholdLabels } from '../lib/labels.ts';

export type AlertSearch = { status?: 'open' | 'closed' | 'all'; rule?: string };

export function AlertsPage() {
  const search = useSearch({ strict: false }) as AlertSearch;
  const navigate = useNavigate();
  const status = search.status ?? 'open';
  const alerts = useQuery({
    queryKey: ['alerts', status, search.rule],
    queryFn: () => api<AlertSummary[]>(`/api/alerts${query({ status, rule: search.rule, limit: 100 })}`),
    refetchInterval: 30_000,
  });
  const set = (next: AlertSearch) => navigate({ to: '/alerts', search: { ...search, ...next } } as never);
  return (
    <>
      <PageHeader title="Alertes" meta="Signaux levés par les règles. Une alerte qui dure garde une seule ligne, avec son nombre de constats." />
      <div className="filters" role="group" aria-label="Filtres">
        <label className="field field-inline">
          <span>Statut</span>
          <select value={status} onChange={(event) => set({ status: event.target.value as AlertSearch['status'] })}>
            <option value="open">Ouvertes</option>
            <option value="closed">Closes</option>
            <option value="all">Toutes</option>
          </select>
        </label>
        <label className="field field-inline">
          <span>Règle</span>
          <select value={search.rule ?? ''} onChange={(event) => set({ rule: event.target.value || undefined })}>
            <option value="">Toutes</option>
            {Object.entries(ruleNames).map(([id, name]) => (
              <option key={id} value={id}>
                {id} {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {alerts.isPending ? (
        <Loading />
      ) : alerts.isError ? (
        <ErrorState error={alerts.error} retry={() => alerts.refetch()} />
      ) : alerts.data.length === 0 ? (
        <Empty>{status === 'open' ? 'Aucune alerte ouverte.' : 'Aucune alerte pour ces filtres.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Alertes</caption>
            <thead>
              <tr>
                <th scope="col">Gravité</th>
                <th scope="col">Règle</th>
                <th scope="col">Constat</th>
                <th scope="col" className="numeric">
                  Constats
                </th>
                <th scope="col">Dernier</th>
                <th scope="col">Incident</th>
              </tr>
            </thead>
            <tbody>
              {alerts.data.map((alert) => (
                <tr key={alert.id}>
                  <td>
                    <SeverityBadge severity={alert.severity} />
                  </td>
                  <td className="nowrap">
                    <RuleRef id={alert.ruleId} />
                  </td>
                  <td className="cell-title">
                    <Link to="/alerts/$id" params={{ id: alert.id }} className="row-link">
                      {alert.summary}
                    </Link>
                    <span className="muted">{alert.status === 'open' ? 'Ouverte' : 'Close'}</span>
                  </td>
                  <td className="numeric">{alert.hits}</td>
                  <td className="nowrap">
                    <Timestamp value={alert.lastSeenAt} />
                  </td>
                  <td className="nowrap">
                    {alert.incidentId ? (
                      <Link to="/incidents/$id" params={{ id: alert.incidentId }} className="link mono">
                        INC-{String(alert.incidentNumber).padStart(6, '0')}
                      </Link>
                    ) : (
                      <span className="muted">Aucun</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AlertDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const alert = useQuery({ queryKey: ['alert', id], queryFn: () => api<AlertDetail>(`/api/alerts/${id}`) });
  if (alert.isPending) return <Loading />;
  if (alert.isError) return <ErrorState error={alert.error} retry={() => alert.refetch()} />;
  const data = alert.data;
  return (
    <>
      <Link to="/alerts" className="link back-link">
        Retour aux alertes
      </Link>
      <PageHeader title={data.summary} meta={<RuleRef id={data.ruleId} />} />
      <div className="grid grid-two">
        <Card title="Constat">
          <dl className="facts">
            <div>
              <dt>Gravité</dt>
              <dd>
                <SeverityBadge severity={data.severity} />
              </dd>
            </div>
            <div>
              <dt>Statut</dt>
              <dd>{data.status === 'open' ? 'Ouverte' : 'Close'}</dd>
            </div>
            <div>
              <dt>Premier constat</dt>
              <dd>
                <Timestamp value={data.firstSeenAt} absolute />
              </dd>
            </div>
            <div>
              <dt>Dernier constat</dt>
              <dd>
                <Timestamp value={data.lastSeenAt} absolute />
              </dd>
            </div>
            <div>
              <dt>Durée</dt>
              <dd>{duration(new Date(data.closedAt ?? data.lastSeenAt).getTime() - new Date(data.firstSeenAt).getTime())}</dd>
            </div>
            <div>
              <dt>Constats</dt>
              <dd>{data.hits}</dd>
            </div>
            {data.incidentId && (
              <div>
                <dt>Incident</dt>
                <dd>
                  <Link to="/incidents/$id" params={{ id: data.incidentId }} className="link">
                    Ouvrir l'incident
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </Card>
        <Card title={`Seuils appliqués (version ${data.ruleVersion ?? 1})`}>
          <dl className="facts">
            {Object.entries(data.thresholds).map(([key, value]) => (
              <div key={key}>
                <dt>{thresholdLabels[key] ?? key}</dt>
                <dd className="mono">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
      <Card title={`Événements déclencheurs (${data.events.length}${data.evidence.length > data.events.length ? ` sur ${data.evidence.length}` : ''})`}>
        {data.events.length === 0 ? <Empty>Les événements de cette alerte ne sont plus conservés.</Empty> : <EventTable events={data.events} caption="Événements déclencheurs" />}
      </Card>
    </>
  );
}
