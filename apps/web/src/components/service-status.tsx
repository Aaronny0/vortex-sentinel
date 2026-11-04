import type { ProbeState } from '../lib/api.ts';
import { relative } from '../lib/format.ts';

export type ServiceState = 'up' | 'degraded' | 'down' | 'unknown';

const LABELS: Record<ServiceState, string> = { up: 'Opérationnel', degraded: 'Dégradé', down: 'Interrompu', unknown: 'Sans nouvelles' };

/** Au-delà, une cible sans contrôle récent est « sans nouvelles » : on ne sait pas, on ne suppose pas. */
const STALE_MS = 3 * 60_000;

/**
 * État lu dans le dernier contrôle de la sonde, sans seuil côté navigateur : la lenteur et la panne sont décidées par le
 * serveur (R01, R03). L'écran montre seulement ce que la sonde a vu en dernier, ou qu'il n'en sait rien.
 */
export function probeState(probe: ProbeState | undefined, now = Date.now()): ServiceState {
  if (!probe || now - new Date(probe.checkedAt).getTime() > STALE_MS) return 'unknown';
  return probe.outcome === 'success' ? 'up' : 'down';
}

export function ServiceDot({ state }: { state: ServiceState }) {
  return <span className={`service-dot service-${state}`} aria-hidden="true" />;
}

export function ServiceStatus({ name, probe, compact = false }: { name: string; probe: ProbeState | undefined; compact?: boolean }) {
  const state = probeState(probe);
  const label = state === 'unknown' && probe ? `Sans nouvelles depuis ${relative(probe.checkedAt).replace('il y a ', '')}` : LABELS[state];
  if (compact)
    return (
      <span className="service-compact" title={`${name} : ${label}`}>
        <ServiceDot state={state} />
        <span>{name}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  return (
    <div className="service-row">
      <ServiceDot state={state} />
      <span className="service-name">{name}</span>
      <span className={`service-label service-label-${state}`}>{label}</span>
      {probe && (
        <span className="service-meta muted">
          {probe.status ? `HTTP ${probe.status}` : probe.code}
          {probe.durationMs !== null ? ` · ${probe.durationMs} ms` : ''} · {relative(probe.checkedAt)}
        </span>
      )}
    </div>
  );
}
