import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Card, Empty, ErrorState, Loading, PageHeader, Timestamp } from '../components/common.tsx';
import { ServiceStatus } from '../components/service-status.tsx';
import { overviewQuery, targetName } from '../components/shell.tsx';
import { api } from '../lib/api.ts';
import { bytes, duration, exactDate, percent, zoneLabel } from '../lib/format.ts';

type Availability = {
  from: string;
  to: string;
  bucketMinutes: number;
  targets: { target: string; checks: number; failures: number; p95Ms: number | null; avgMs: number | null; availabilityPercent: number | null; buckets: { start: string; checks: number; failures: number }[] }[];
  outages: { target: string; startedAt: string; lastFailureAt: string; failures: number; code: string | null }[];
};

const PERIODS = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 jours' },
  { days: 30, label: '30 jours' },
] as const;

/** Une tranche : sans contrôle, tous réussis, ou avec des échecs. Le tableau qui suit donne les valeurs exactes. */
function Bucket({ bucket, minutes }: { bucket: Availability['targets'][number]['buckets'][number]; minutes: number }) {
  const state = bucket.checks === 0 ? 'none' : bucket.failures === 0 ? 'up' : bucket.failures === bucket.checks ? 'down' : 'partial';
  const label = `${exactDate(bucket.start)} (${duration(minutes * 60_000)}) : ${bucket.checks === 0 ? 'aucun contrôle' : `${bucket.failures} échec${bucket.failures > 1 ? 's' : ''} sur ${bucket.checks}`}`;
  return <span className={`bucket bucket-${state}`} title={label} />;
}

export function AvailabilityPage() {
  const search = useSearch({ strict: false }) as { days?: number };
  const navigate = useNavigate();
  const days = search.days ?? 1;
  const overview = useQuery(overviewQuery);
  const history = useQuery({ queryKey: ['availability', days], queryFn: () => api<Availability>(`/api/availability?days=${days}`), refetchInterval: 30_000 });

  return (
    <>
      <PageHeader
        title="Disponibilité"
        meta="Ce que voient les sondes de Sentinel : santé de Vortex toutes les 30 s, certificat chaque jour, disque toutes les 5 min."
        action={
          <div className="segmented" role="group" aria-label="Période">
            {PERIODS.map((period) => (
              <button key={period.days} type="button" aria-pressed={days === period.days} className="segmented-item" onClick={() => navigate({ to: '/availability', search: { days: period.days } } as never)}>
                {period.label}
              </button>
            ))}
          </div>
        }
      />
      {history.isPending ? (
        <Loading />
      ) : history.isError ? (
        <ErrorState error={history.error} retry={() => history.refetch()} />
      ) : history.data.targets.length === 0 ? (
        <Empty>Aucun contrôle sur la période. Vérifiez la configuration des sondes (PROBE_TARGETS).</Empty>
      ) : (
        <div className="stack">
          {history.data.targets.map((target) => (
            <Card key={target.target} title={targetName(target.target)} action={<span className="mono muted">{target.target}</span>}>
              <ServiceStatus name="Dernier contrôle" probe={overview.data?.probes.find((probe) => probe.target === target.target)} />
              <div className="buckets" aria-hidden="true">
                {target.buckets.map((bucket) => (
                  <Bucket key={bucket.start} bucket={bucket} minutes={history.data.bucketMinutes} />
                ))}
              </div>
              <p className="buckets-axis muted">
                <span>{exactDate(history.data.from)}</span>
                <span>Heures en {zoneLabel(new Date(history.data.to))}</span>
                <span>{exactDate(history.data.to)}</span>
              </p>
              <dl className="facts facts-inline">
                <div>
                  <dt>Disponibilité</dt>
                  <dd>{target.availabilityPercent === null ? '—' : percent(target.availabilityPercent)}</dd>
                </div>
                <div>
                  <dt>Contrôles</dt>
                  <dd>
                    {target.checks} dont {target.failures} en échec
                  </dd>
                </div>
                <div>
                  <dt>Temps de réponse</dt>
                  <dd>{target.avgMs === null ? '—' : `${target.avgMs} ms en moyenne, ${target.p95Ms} ms au 95ᵉ centile`}</dd>
                </div>
              </dl>
            </Card>
          ))}
          <Card title="Interruptions">
            {history.data.outages.length === 0 ? (
              <Empty>Aucune interruption sur la période.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Interruptions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Cible</th>
                      <th scope="col">Début</th>
                      <th scope="col">Dernier échec</th>
                      <th scope="col">Durée</th>
                      <th scope="col" className="numeric">
                        Échecs
                      </th>
                      <th scope="col">Dernier code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.outages.map((outage) => (
                      <tr key={`${outage.target}-${outage.startedAt}`}>
                        <td>{targetName(outage.target)}</td>
                        <td className="nowrap">
                          <Timestamp value={outage.startedAt} absolute />
                        </td>
                        <td className="nowrap">
                          <Timestamp value={outage.lastFailureAt} absolute />
                        </td>
                        <td>{duration(new Date(outage.lastFailureAt).getTime() - new Date(outage.startedAt).getTime())}</td>
                        <td className="numeric">{outage.failures}</td>
                        <td className="mono">{outage.code ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      {overview.data && (
        <div className="grid grid-two">
          <Card title="Certificats">
            {overview.data.certificates.length === 0 ? (
              <Empty>Aucun certificat surveillé (TLS_TARGETS, en production).</Empty>
            ) : (
              <dl className="facts">
                {overview.data.certificates.map((certificate) => (
                  <div key={certificate.target}>
                    <dt className="mono">{certificate.target}</dt>
                    <dd>
                      {certificate.daysLeft === null
                        ? `Illisible (${certificate.code ?? 'erreur'})`
                        : certificate.daysLeft < 0
                          ? 'Expiré'
                          : `Expire dans ${certificate.daysLeft} jour${certificate.daysLeft > 1 ? 's' : ''}`}{' '}
                      · contrôlé <Timestamp value={certificate.checkedAt} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
          <Card title="Disques">
            {overview.data.disks.length === 0 ? (
              <Empty>Aucune mesure récente.</Empty>
            ) : (
              <dl className="facts">
                {overview.data.disks.map((disk) => (
                  <div key={disk.path}>
                    <dt className="mono">{disk.path}</dt>
                    <dd>
                      {percent(disk.freePercent)} libres ({bytes(disk.freeBytes)}) · mesuré <Timestamp value={disk.checkedAt} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
