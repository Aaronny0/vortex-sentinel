/** Les quatre familles d'événements, une par mission de surveillance. */
export const eventCategories = ['availability', 'technical', 'security', 'business'] as const;
export type EventCategory = (typeof eventCategories)[number];

/** Producteurs reconnus. Tout autre producteur est refusé à l'ingestion. */
export const eventSources = ['vortex-api', 'vortex-web', 'vortex-nginx', 'sentinel-probe'] as const;
export type EventSource = (typeof eventSources)[number];

/**
 * Commandes métier de Vortex (`commandTypes` de `@vortex/contracts`). Un événement métier porte le type de la commande.
 * Copie volontaire : Sentinel ne dépend pas du code de Vortex ; les exemples partagés vérifient la compatibilité.
 */
export const businessEventTypes = [
  'product.save', 'product.archive', 'stock.entry', 'stock.import', 'stock.adjust', 'stock.transfer',
  'client.save', 'supplier.save', 'client.archive', 'supplier.archive',
  'account.save', 'account.toggle', 'period.lock', 'entry.save', 'entry.post', 'entry.reverse',
  'store.save', 'settings.save', 'team.invite', 'team.update',
  'sale.create', 'sale.return', 'sale.refund', 'trade.create', 'buyback.create', 'purchase.create',
  'payment.create', 'purchase.reverse', 'cash.open', 'cash.close', 'cash.movement', 'expense.create', 'expense.reverse',
  'inventory.confirm', 'inventory.reject',
] as const;

/** Catalogue des types (docs/conception.md § 4) : chaque type appartient à une seule catégorie. */
export const eventCatalog: Readonly<Record<string, EventCategory>> = {
  'probe.check': 'availability',
  'emitter.heartbeat': 'availability',
  'db.unavailable': 'availability',
  'tls.certificate': 'availability',
  'host.disk': 'availability',
  'mail.failed': 'availability',

  'http.metrics': 'technical',
  'http.slow_request': 'technical',
  'http.access': 'technical',
  'app.error': 'technical',
  'ui.error': 'technical',
  'command.effect_failed': 'technical',
  'request.rejected': 'technical',
  'log.entry': 'technical',

  'auth.login': 'security',
  'auth.rate_limited': 'security',
  'auth.password_reset_requested': 'security',
  'auth.password_changed': 'security',
  'auth.otp_sent': 'security',
  'auth.otp_refused': 'security',
  'access.denied': 'security',
  'access.unauthenticated': 'security',
  'access.status_changed': 'security',
  'idempotency.conflict': 'security',

  ...Object.fromEntries(businessEventTypes.map((type) => [type, 'business' as const])),
};

export const eventTypes = Object.keys(eventCatalog) as [string, ...string[]];
