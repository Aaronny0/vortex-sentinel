export const severities = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof severities)[number];

/** Lecture seule des événements, bornée par la règle à sa fenêtre : jamais de lecture de toute la table. */
export type RuleContext = {
  query<Row extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<Row[]>;
  /** Instant évalué : tout événement reçu après lui est ignoré, ce qui rend l'évaluation rejouable. */
  at: Date;
};

export type Finding = {
  /** Ce qui identifie l'alerte : cible, compte, adresse, chemin. */
  key: string;
  severity: Severity;
  /** Phrase factuelle : « 3 échecs consécutifs de la sonde vortex-api ». */
  summary: string;
  /** Identifiants des événements déclencheurs. */
  evidence: string[];
};

export type Rule = {
  id: string;
  /** Incrémentée à chaque changement de logique ou de seuil par défaut. */
  version: number;
  /** `state` : état le plus récent d'une cible (sondes) ; `window` et `sequence` viendront avec les règles de Vortex. */
  kind: 'event' | 'window' | 'sequence' | 'state';
  /** Gravité habituelle ; un constat peut la préciser (R15, R17). */
  severity: Severity;
  /** Délai laissé aux lots en retard avant d'évaluer un instant. Nul pour les sondes, écrites par Sentinel lui-même. */
  graceMs: number;
  /** Sans nouveau constat pendant cette durée, l'alerte est close ; un constat ultérieur en ouvre une nouvelle. */
  quietMs: number;
  /** Règle de disponibilité : son incident se résout seul quand toutes ses alertes sont closes (service rétabli). */
  autoResolve?: boolean;
  /** Seuils effectifs, conservés avec chaque alerte. */
  thresholds: Record<string, number>;
  evaluate(ctx: RuleContext): Promise<Finding[]>;
};

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
