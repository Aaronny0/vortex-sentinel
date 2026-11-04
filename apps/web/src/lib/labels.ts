import type { IncidentStatus, Role, Severity } from './api.ts';

export const severityLabels: Record<Severity, string> = { critical: 'Critique', high: 'Élevée', medium: 'Moyenne', low: 'Faible', info: 'Info' };
export const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const statusLabels: Record<IncidentStatus, string> = {
  open: 'Ouvert',
  acknowledged: 'Pris en charge',
  in_progress: 'En cours',
  resolved: 'Résolu',
  closed: 'Clos',
  false_positive: 'Faux positif',
};

/** Actions proposées selon le statut ; le serveur valide chaque transition (cycle de vie, § 7.3 de la conception). */
export const transitionActions: Record<IncidentStatus, { to: IncidentStatus; label: string; needsComment: boolean; primary?: boolean }[]> = {
  open: [
    { to: 'acknowledged', label: 'Prendre en charge', needsComment: false, primary: true },
    { to: 'false_positive', label: 'Classer en faux positif', needsComment: true },
  ],
  acknowledged: [
    { to: 'in_progress', label: "Commencer l'analyse", needsComment: false, primary: true },
    { to: 'false_positive', label: 'Classer en faux positif', needsComment: true },
  ],
  in_progress: [
    { to: 'resolved', label: 'Marquer comme résolu', needsComment: true, primary: true },
    { to: 'false_positive', label: 'Classer en faux positif', needsComment: true },
  ],
  resolved: [
    { to: 'closed', label: 'Clore', needsComment: false, primary: true },
    { to: 'in_progress', label: 'Rouvrir', needsComment: true },
  ],
  closed: [],
  false_positive: [],
};

export const roleLabels: Record<Role, string> = { admin: 'Administrateur', analyst: 'Analyste', observer: 'Observateur' };

export const categoryLabels: Record<string, string> = { availability: 'Disponibilité', technical: 'Technique', security: 'Sécurité', business: 'Métier' };

/** Noms courts des règles (docs/conception.md § 6) ; le serveur fournit identifiant, seuils et gravité. */
export const ruleNames: Record<string, string> = {
  R01: 'Service indisponible',
  R02: 'Collecte interrompue',
  R03: 'Route lente',
  R04: "Taux d'erreurs serveur",
  R05: 'Force brute sur un compte',
  R06: "Bourrage d'identifiants",
  R07: 'Connexion après une attaque',
  R08: 'Accès refusés répétés',
  R09: 'Changement sensible, adresse inhabituelle',
  R10: 'Remboursements anormaux',
  R11: 'Écarts de caisse',
  R12: 'Pertes de stock répétées',
  R13: 'Opération hors horaires',
  R14: "Exploration de l'API",
  R15: 'Certificat bientôt expiré',
  R16: 'Emails en échec',
  R17: 'Espace disque',
  R18: 'Fonctionnalité en panne',
  R19: 'Administration, adresse inhabituelle',
  R20: "Rafale d'actions d'administration",
};

export const kindLabels: Record<string, string> = { state: 'État', window: 'Fenêtre', sequence: 'Séquence', event: 'Événement' };

export const thresholdLabels: Record<string, string> = {
  consecutiveFailures: 'échecs consécutifs',
  lookbackSeconds: 'période examinée (s)',
  silenceSeconds: 'silence toléré (s)',
  lookbackHours: 'période examinée (h)',
  lookbackMinutes: 'période examinée (min)',
  p95Ms: 'p95 maximal (ms)',
  consecutiveMinutes: 'minutes consécutives',
  errorPercent: "taux d'erreurs (%)",
  minRequests: 'requêtes minimum',
  windowMinutes: 'fenêtre (min)',
  failures: 'refus',
  accounts: 'comptes distincts',
  accountFailures: 'refus sur le compte',
  ipFailures: "refus depuis l'adresse",
  ipAccounts: "comptes depuis l'adresse",
  burstMinutes: "fenêtre d'attaque (min)",
  followMinutes: 'délai de réussite (min)',
  denials: 'refus',
  historyDays: 'historique (jours)',
  minimum: 'minimum',
  factor: 'multiple de la moyenne',
  gapAmount: "écart maximal (devise)",
  repeatedShortages: 'manques répétés',
  adjustments: 'ajustements',
  minHistory: 'historique minimal',
  rarePercent: "part d'activité (%)",
  responses: 'réponses',
  warningDays: 'alerte (jours)',
  criticalDays: 'critique (jours)',
  warningPercent: 'alerte (% libre)',
  criticalPercent: 'critique (% libre)',
  errors: 'erreurs',
  sessionHours: 'session exclue (h)',
  actions: 'actions sensibles',
};
