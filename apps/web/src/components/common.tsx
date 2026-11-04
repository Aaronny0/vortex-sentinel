import { Link, type LinkProps } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import type { IncidentStatus } from '../lib/api.ts';
import { exactDateWithZone, relative } from '../lib/format.ts';
import { ruleNames, statusLabels } from '../lib/labels.ts';

/** Heure relative, avec date exacte, secondes et fuseau en infobulle et pour les lecteurs d'écran. */
export function Timestamp({ value, absolute = false }: { value: string | null | undefined; absolute?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (absolute) return;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [absolute]);
  if (!value) return <span className="muted">—</span>;
  const exact = exactDateWithZone(value);
  return (
    <time dateTime={new Date(value).toISOString()} title={exact} className="timestamp">
      {absolute ? exact : relative(value)}
    </time>
  );
}

/** Identifiant, IP ou empreinte : mono, tronqué au milieu, copiable, valeur complète accessible. */
export function Identifier({ value, keep = 8 }: { value: string; keep?: number }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-4)}` : value;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Presse-papiers refusé : la valeur reste sélectionnable dans l'infobulle.
    }
  };
  return (
    <span className="identifier">
      <span className="mono" title={value} aria-label={value}>
        {short}
      </span>
      <button type="button" className="icon-button" onClick={copy} aria-label={`Copier ${value}`} title="Copier">
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}

export function RuleRef({ id, linked = true }: { id: string; linked?: boolean }) {
  const content = (
    <>
      <span className="mono">{id}</span> <span>{ruleNames[id] ?? 'Règle'}</span>
    </>
  );
  return linked ? (
    <Link to="/rules" hash={id} className="rule-ref">
      {content}
    </Link>
  ) : (
    <span className="rule-ref">{content}</span>
  );
}

/** Tout compteur est un lien vers la liste qu'il résume. */
export function CountLink({ count, label, ...link }: { count: number; label: string } & LinkProps) {
  return (
    <Link {...link} className="count-link" aria-label={`${count} ${label}`}>
      <span className="count">{count}</span>
      <span className="count-label">{label}</span>
    </Link>
  );
}

export function StatusLabel({ status }: { status: IncidentStatus }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
}

export function Card({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {meta && <p className="page-meta">{meta}</p>}
      </div>
      {action}
    </header>
  );
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p className="state state-loading" role="status">
      {label}
    </p>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Une erreur est survenue.';
  return (
    <div className="state state-error" role="alert">
      <p>{message}</p>
      {retry && (
        <button type="button" className="button button-secondary" onClick={retry}>
          Réessayer
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="state state-empty">{children}</p>;
}

export function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5h-.5A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}
