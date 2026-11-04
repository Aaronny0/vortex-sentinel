import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Card, Empty, ErrorState, Loading, PageHeader, RuleRef, StatusLabel, Timestamp } from '../components/common.tsx';
import { SeverityBadge, SeverityIcon } from '../components/severity.tsx';
import { api, ApiError, query, type AlertDetail, type IncidentDetail, type IncidentStatus, type IncidentSummary, type SentinelEvent } from '../lib/api.ts';
import { duration, exactDate, exactDateWithZone, zoneLabel } from '../lib/format.ts';
import { categoryLabels, statusLabels, transitionActions } from '../lib/labels.ts';
import { can, useOperator } from '../session.tsx';

export type IncidentSearch = { status?: string; severity?: 'medium' | 'high' | 'critical' };

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'active', label: 'Actifs' },
  { value: 'open', label: 'Ouverts' },
  { value: 'acknowledged', label: 'Pris en charge' },
  { value: 'in_progress', label: 'En cours' },
  { value: 'resolved', label: 'Résolus' },
  { value: 'closed', label: 'Clos' },
  { value: 'false_positive', label: 'Faux positifs' },
  { value: 'all', label: 'Tous' },
];

/** Liste des incidents, et détail à côté sans quitter la liste (écran large) ; sur mobile, le détail prend la page. */
export function IncidentsLayout() {
  const search = useSearch({ strict: false }) as IncidentSearch;
  const params = useParams({ strict: false }) as { id?: string };
  const navigate = useNavigate();
  const status = search.status ?? 'active';
  const incidents = useQuery({
    queryKey: ['incidents', status, search.severity],
    queryFn: () => api<IncidentSummary[]>(`/api/incidents${query({ status, severity: search.severity, limit: 100 })}`),
    refetchInterval: 30_000,
  });
  const setFilter = (next: IncidentSearch) => navigate({ to: params.id ? '/incidents/$id' : '/incidents', params: params.id ? { id: params.id } : {}, search: { ...search, ...next } } as never);

  return (
    <div className={`split${params.id ? ' split-detail' : ''}`}>
      <div className="split-list">
        <PageHeader title="Incidents" meta="Ce qui reste à résoudre, par gravité puis par date d'ouverture." />
        <div className="filters" role="group" aria-label="Filtres">
          <label className="field field-inline">
            <span>Statut</span>
            <select value={status} onChange={(event) => setFilter({ status: event.target.value })}>
              {STATUS_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span>Gravité</span>
            <select value={search.severity ?? ''} onChange={(event) => setFilter({ severity: (event.target.value || undefined) as IncidentSearch['severity'] })}>
              <option value="">Toutes</option>
              <option value="critical">Critique</option>
              <option value="high">Élevée</option>
              <option value="medium">Moyenne</option>
            </select>
          </label>
        </div>
        {incidents.isPending ? (
          <Loading />
        ) : incidents.isError ? (
          <ErrorState error={incidents.error} retry={() => incidents.refetch()} />
        ) : incidents.data.length === 0 ? (
          <Empty>{status === 'active' ? 'Aucun incident ouvert.' : 'Aucun incident pour ces filtres.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Incidents</caption>
              <thead>
                <tr>
                  <th scope="col">Gravité</th>
                  <th scope="col">Référence</th>
                  <th scope="col">Incident</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Assigné</th>
                  <th scope="col">Ouvert</th>
                </tr>
              </thead>
              <tbody>
                {incidents.data.map((incident) => (
                  <tr key={incident.id} className={incident.id === params.id ? 'row-selected' : undefined}>
                    <td>
                      <SeverityBadge severity={incident.severity} />
                    </td>
                    <td className="mono nowrap">{incident.reference}</td>
                    <td className="cell-title">
                      <Link to="/incidents/$id" params={{ id: incident.id }} search={search as never} className="row-link">
                        {incident.title}
                      </Link>
                      <span className="muted">
                        {incident.alerts} alerte{incident.alerts > 1 ? 's' : ''}
                      </span>
                    </td>
                    <td>
                      <StatusLabel status={incident.status} />
                    </td>
                    <td>{incident.assignee ?? <span className="muted">Personne</span>}</td>
                    <td className="nowrap">
                      <Timestamp value={incident.openedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Outlet />
    </div>
  );
}

export function IncidentPlaceholder() {
  return (
    <aside className="split-panel split-placeholder">
      <Empty>Sélectionnez un incident pour voir sa chronologie et le prendre en charge.</Empty>
    </aside>
  );
}

type TimelineItem = { at: string; kind: 'event' | 'history'; key: string; event?: SentinelEvent & { severity?: string }; entry?: IncidentDetail['history'][number] };

export function IncidentDetailPanel() {
  const { id } = useParams({ strict: false }) as { id: string };
  const search = useSearch({ strict: false }) as IncidentSearch;
  const operator = useOperator();
  const analyst = can(operator.role, ['admin', 'analyst']);
  const incident = useQuery({ queryKey: ['incident', id], queryFn: () => api<IncidentDetail>(`/api/incidents/${id}`), refetchInterval: 30_000 });
  // Les preuves (événements) ne sont lisibles que par les analystes et administrateurs ; le serveur le vérifie aussi.
  const evidence = useQueries({
    queries: (analyst ? incident.data?.alerts ?? [] : []).map((alert) => ({
      queryKey: ['alert', alert.id],
      queryFn: () => api<AlertDetail>(`/api/alerts/${alert.id}`),
      staleTime: 60_000,
    })),
  });

  if (incident.isPending) return <aside className="split-panel"><Loading /></aside>;
  if (incident.isError)
    return (
      <aside className="split-panel">
        <ErrorState error={incident.error} retry={() => incident.refetch()} />
      </aside>
    );
  const data = incident.data;
  const end = data.resolvedAt ?? data.closedAt;
  const events = evidence.flatMap((result, index) =>
    (result.data?.events ?? []).map((event) => ({ ...event, severity: data.alerts[index]?.severity, ruleId: data.alerts[index]?.ruleId })),
  );
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()];
  const timeline: TimelineItem[] = [
    ...uniqueEvents.map((event) => ({ at: event.receivedAt, kind: 'event' as const, key: `e${event.id}`, event })),
    ...data.history.map((entry) => ({ at: entry.at, kind: 'history' as const, key: `h${entry.id}`, entry })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const evidenceLoading = evidence.some((result) => result.isPending);
  const evidenceFailed = evidence.some((result) => result.isError);

  return (
    <aside className="split-panel" aria-label={`Incident ${data.reference}`}>
      <Link to="/incidents" search={search as never} className="link back-link">
        Retour à la liste
      </Link>
      <header className="incident-header">
        <div className="incident-badges">
          <SeverityBadge severity={data.severity} solid={data.severity === 'critical' && !end} />
          <StatusLabel status={data.status} />
          <span className="mono">{data.reference}</span>
        </div>
        <h2 className="incident-heading">{data.title}</h2>
        <dl className="facts facts-inline">
          <div>
            <dt>Ouvert</dt>
            <dd>
              <Timestamp value={data.openedAt} absolute />
            </dd>
          </div>
          <div>
            <dt>{end ? 'Durée' : 'Ouvert depuis'}</dt>
            <dd>{duration(new Date(end ?? Date.now()).getTime() - new Date(data.openedAt).getTime())}</dd>
          </div>
          <div>
            <dt>Assigné</dt>
            <dd>{data.assignee ?? 'Personne'}</dd>
          </div>
        </dl>
      </header>

      {analyst && <TransitionActions incident={data} />}

      <Card title={`Alertes liées (${data.alerts.length})`}>
        <ul className="alert-list">
          {data.alerts.map((alert) => (
            <li key={alert.id} className="alert-line alert-line-static">
              <SeverityIcon severity={alert.severity} />
              <RuleRef id={alert.ruleId} />
              {analyst ? (
                <Link to="/alerts/$id" params={{ id: alert.id }} className="alert-summary link">
                  {alert.summary}
                </Link>
              ) : (
                <span className="alert-summary">{alert.summary}</span>
              )}
              <span className="muted nowrap">
                {alert.hits} constat{alert.hits > 1 ? 's' : ''} · {alert.status === 'open' ? 'ouverte' : 'close'}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Chronologie" action={<span className="muted">Heures en {zoneLabel(new Date(data.openedAt))}</span>}>
        {!analyst && <p className="muted note">Les événements détaillés (adresses, comptes) sont réservés aux analystes.</p>}
        {evidenceLoading && <Loading label="Chargement des événements…" />}
        {evidenceFailed && <p className="form-error">Une partie des événements n'a pas pu être chargée.</p>}
        <ol className="timeline">
          {timeline.map((item) => (
            <li key={item.key} className={`timeline-item timeline-${item.kind}`}>
              <time className="timeline-time mono" dateTime={item.at} title={exactDateWithZone(item.at)}>
                {exactDate(item.at)}
              </time>
              <span className="timeline-marker" aria-hidden="true">
                {item.event?.severity ? <SeverityIcon severity={item.event.severity as never} size={10} /> : <span className="timeline-dot" />}
              </span>
              <div className="timeline-body">{item.event ? <TimelineEvent event={item.event} /> : <TimelineHistory entry={item.entry!} />}</div>
            </li>
          ))}
        </ol>
      </Card>

      {analyst && <CommentForm incidentId={data.id} />}
    </aside>
  );
}

function TimelineEvent({ event }: { event: SentinelEvent & { ruleId?: string } }) {
  const http = event.body.http as { method?: string; route?: string; status?: number } | undefined;
  const attributes = (event.body.attributes ?? {}) as Record<string, unknown>;
  return (
    <>
      <span className="timeline-title">
        <span className="mono">{event.type}</span> <span className={`outcome outcome-${event.outcome}`}>{event.outcome === 'failure' ? 'échec' : event.outcome === 'success' ? 'réussite' : 'inconnu'}</span>
      </span>
      <span className="timeline-meta">
        {categoryLabels[event.category] ?? event.category}
        {event.ip && (
          <>
            {' · '}
            <span className="mono">{event.ip}</span>
          </>
        )}
        {event.emailHash && (
          <>
            {' · compte '}
            <span className="mono">{event.emailHash.slice(0, 8)}</span>
          </>
        )}
        {http?.route && (
          <>
            {' · '}
            <span className="mono">
              {http.method} {http.route} {http.status}
            </span>
          </>
        )}
        {typeof attributes.code === 'string' && (
          <>
            {' · '}
            <span className="mono">{attributes.code}</span>
          </>
        )}
      </span>
    </>
  );
}

function TimelineHistory({ entry }: { entry: IncidentDetail['history'][number] }) {
  const who = entry.actor ?? 'Système';
  const text =
    entry.kind === 'transition' && entry.fromStatus && entry.toStatus
      ? `${who} : ${statusLabels[entry.fromStatus]} → ${statusLabels[entry.toStatus]}`
      : entry.kind === 'comment'
        ? `${who} a commenté`
        : entry.kind === 'opened'
          ? 'Incident ouvert'
          : entry.kind === 'severity_raised'
            ? 'Gravité relevée'
            : 'Alerte rattachée';
  return (
    <>
      <span className="timeline-title">{text}</span>
      {entry.comment && <span className="timeline-comment">{entry.comment}</span>}
    </>
  );
}

function TransitionActions({ incident }: { incident: IncidentDetail }) {
  const client = useQueryClient();
  const actions = transitionActions[incident.status];
  const [chosen, setChosen] = useState<(typeof actions)[number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: { to: IncidentStatus; comment?: string }) => api(`/api/incidents/${incident.id}/transitions`, { body: input }),
    onSuccess: async () => {
      setChosen(null);
      setError(null);
      await Promise.all([client.invalidateQueries({ queryKey: ['incident', incident.id] }), client.invalidateQueries({ queryKey: ['incidents'] }), client.invalidateQueries({ queryKey: ['overview'] })]);
    },
    onError: (failure) => setError(failure instanceof ApiError ? (failure.fields?.comment ?? failure.message) : 'Une erreur est survenue.'),
  });
  if (actions.length === 0) return <p className="muted note">Incident {statusLabels[incident.status].toLowerCase()} : aucune action possible.</p>;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen) return;
    const comment = String(new FormData(event.currentTarget).get('comment') ?? '').trim();
    mutation.mutate({ to: chosen.to, ...(comment && { comment }) });
  };

  return (
    <div className="actions">
      {!chosen ? (
        <div className="action-buttons">
          {actions.map((action) => (
            <button
              key={action.to}
              type="button"
              className={`button ${action.primary ? 'button-primary' : 'button-secondary'}`}
              disabled={mutation.isPending}
              onClick={() => (action.needsComment ? setChosen(action) : mutation.mutate({ to: action.to }))}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        <form className="form form-inline-panel" onSubmit={submit}>
          <label className="field">
            <span>{chosen.label} : motif (obligatoire)</span>
            <textarea name="comment" rows={3} minLength={3} maxLength={2000} required autoFocus />
          </label>
          <div className="action-buttons">
            <button type="submit" className="button button-primary" disabled={mutation.isPending}>
              {chosen.label}
            </button>
            <button type="button" className="button button-ghost" onClick={() => setChosen(null)}>
              Annuler
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CommentForm({ incidentId }: { incidentId: string }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (comment: string) => api(`/api/incidents/${incidentId}/comments`, { body: { comment } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['incident', incidentId] }),
    onError: (failure) => setError(failure instanceof ApiError ? (failure.fields?.comment ?? failure.message) : 'Une erreur est survenue.'),
  });
  return (
    <Card title="Ajouter un commentaire">
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const comment = String(new FormData(form).get('comment') ?? '').trim();
          setError(null);
          mutation.mutate(comment, { onSuccess: () => form.reset() });
        }}
      >
        <label className="field">
          <span className="sr-only">Commentaire</span>
          <textarea name="comment" rows={3} minLength={3} maxLength={2000} required placeholder="Constat, action menée, décision." />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button button-secondary" disabled={mutation.isPending}>
          Publier le commentaire
        </button>
      </form>
    </Card>
  );
}

