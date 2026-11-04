import type { Severity } from '../lib/api.ts';
import { severityLabels } from '../lib/labels.ts';

/**
 * Forme de chaque niveau (docs/frontend.md § 3.2) : critique octogone, élevée triangle, moyenne losange, faible cercle,
 * info cercle vide. La forme distingue critique et élevée, proches en teinte.
 */
export function SeverityIcon({ severity, size = 12 }: { severity: Severity; size?: number }) {
  const shape = {
    critical: <path d="M4.1 1h3.8L11 4.1v3.8L7.9 11H4.1L1 7.9V4.1Z" />,
    high: <path d="M6 1.2 11.2 10.6H.8Z" />,
    medium: <path d="M6 .8 11.2 6 6 11.2.8 6Z" />,
    low: <circle cx="6" cy="6" r="4.6" />,
    info: <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />,
  }[severity];
  return (
    <svg className={`severity-icon severity-mark-${severity}`} width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      {shape}
    </svg>
  );
}

/** Badge de gravité : doux par défaut, plein seulement pour ce qui exige une action immédiate. */
export function SeverityBadge({ severity, solid = false }: { severity: Severity; solid?: boolean }) {
  return (
    <span className={`badge severity-${severity}${solid ? ' badge-solid' : ''}`}>
      <SeverityIcon severity={severity} />
      {severityLabels[severity]}
    </span>
  );
}
