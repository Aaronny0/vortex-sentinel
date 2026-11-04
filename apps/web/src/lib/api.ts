/** Accès à l'API de Sentinel (même origine, cookie de session httpOnly). Le serveur reste la seule autorité. */

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type Role = 'admin' | 'analyst' | 'observer';
export type IncidentStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed' | 'false_positive';
export type Operator = { id: string; email: string; name: string; role: Role; totpEnabled: boolean };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Sentinel ne répond pas. Vérifiez la connexion.');
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as { code?: string; error?: string; fields?: Record<string, string> } | null;
  if (!response.ok) throw new ApiError(response.status, data?.code ?? 'UNKNOWN', data?.error ?? 'Une erreur est survenue.', data?.fields);
  return data as T;
}

export const query = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export type ProbeState = { target: string; outcome: 'success' | 'failure'; status: number | null; durationMs: number | null; code: string | null; checkedAt: string };
export type Overview = {
  generatedAt: string;
  probes: ProbeState[];
  emitters: { source: string; receivedAt: string; pending: number | null; droppedOverflow: number | null; rejected: number | null }[];
  certificates: { target: string; outcome: string; validTo: string | null; code: string | null; checkedAt: string; daysLeft: number | null }[];
  disks: { path: string; freePercent: number; freeBytes: number; checkedAt: string }[];
  activeIncidents: Partial<Record<Severity, number>>;
  openAlerts: Partial<Record<Severity, number>>;
  engine: { oldestCheckpoint: string | null; lastCycle: string | null };
  eventsLast24h: Partial<Record<'availability' | 'technical' | 'security' | 'business', number>>;
};

export type IncidentSummary = {
  id: string;
  number: number;
  reference: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  assignee: string | null;
  alerts: number;
};

export type AlertSummary = {
  id: string;
  ruleId: string;
  key?: string;
  severity: Severity;
  status: 'open' | 'closed';
  summary: string;
  hits: number;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  incidentId?: string | null;
  incidentNumber?: number | null;
  evidenceCount?: number;
  ruleVersion?: number;
};

export type HistoryEntry = { id: number; at: string; kind: 'opened' | 'alert_linked' | 'severity_raised' | 'transition' | 'comment'; fromStatus: IncidentStatus | null; toStatus: IncidentStatus | null; comment: string | null; actor: string | null };

export type IncidentDetail = IncidentSummary & {
  key?: string;
  closedAt: string | null;
  assigneeId: string | null;
  alerts: AlertSummary[];
  history: HistoryEntry[];
};

export type SentinelEvent = {
  id: string;
  receivedAt: string;
  occurredAt: string;
  source: string;
  category: string;
  type: string;
  outcome: string;
  ip: string | null;
  emailHash: string | null;
  httpStatus: number | null;
  body: Record<string, unknown>;
};

export type AlertDetail = AlertSummary & { thresholds: Record<string, number>; evidence: string[]; events: SentinelEvent[] };

export type RuleSummary = {
  id: string;
  version: number;
  kind: string;
  severity: Severity;
  thresholds: Record<string, number>;
  alerts: number;
  openAlerts: number;
  falsePositives: number;
  lastSeenAt: string | null;
};
