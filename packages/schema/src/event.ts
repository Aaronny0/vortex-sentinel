import { z } from 'zod';
import { eventCatalog, eventCategories, eventSources, eventTypes } from './catalog.ts';

export const SCHEMA_VERSION = 1;

/** Taille maximale d'un lot envoyé par l'émetteur. */
export const MAX_BATCH_EVENTS = 500;
const MAX_ATTRIBUTES = 32;

const uuid = (label: string) => z.uuid({ error: `${label} : UUID invalide.` });
const datetime = (label: string) => z.iso.datetime({ offset: true, error: `${label} : date ISO 8601 invalide.` });

const actorSchema = z.strictObject({
  userId: uuid('Utilisateur').optional(),
  membershipId: uuid('Membre').optional(),
  role: z.string().min(1).max(32).optional(),
  adminId: uuid('Administrateur').optional(),
  /** HMAC-SHA256 de l'adresse email : jamais l'adresse en clair. */
  emailHash: z.string().regex(/^[0-9a-f]{64}$/, { error: "Empreinte d'email invalide : 64 caractères hexadécimaux attendus." }).optional(),
});

const tenantSchema = z.strictObject({
  organizationId: uuid('Entreprise'),
  storeId: uuid('Boutique').optional(),
});

const networkSchema = z.strictObject({
  ip: z.union([z.ipv4(), z.ipv6()], { error: 'Adresse IP invalide.' }).optional(),
  userAgent: z.string().max(512).optional(),
});

const httpSchema = z.strictObject({
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], { error: 'Méthode HTTP invalide.' }),
  /** Route normalisée (`/api/v1/commands/:type`) : ni paramètres de requête ni fragment. */
  route: z.string().max(200).regex(/^\/[^?#\s]*$/, { error: 'Route invalide : chemin normalisé sans paramètres attendu.' }),
  status: z.int().min(100).max(599),
  durationMs: z.number().min(0).max(600_000),
});

const businessSchema = z.strictObject({
  operationType: z.string().min(1).max(64),
  reference: z.string().min(1).max(64),
  /** Montant en unités entières de la devise (les montants de Vortex sont des entiers). */
  amount: z.int().optional(),
  quantity: z.int().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, { error: 'Devise invalide : code ISO 4217 attendu.' }).optional(),
});

const attributesSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/, { error: "Nom d'attribut invalide." }),
    z.union([z.string().max(500), z.number(), z.boolean()]),
  )
  .refine((attributes) => Object.keys(attributes).length <= MAX_ATTRIBUTES, { error: `${MAX_ATTRIBUTES} attributs au plus.` });

/** Événement tel que l'envoie un producteur. `receivedAt` est ajouté par Sentinel, jamais accepté du producteur. */
export const eventInputSchema = z
  .strictObject({
    id: uuid('Événement'),
    schemaVersion: z.literal(SCHEMA_VERSION, { error: `Version de schéma non prise en charge : ${SCHEMA_VERSION} attendue.` }),
    occurredAt: datetime('Date de l’événement'),
    source: z.enum(eventSources, { error: 'Source inconnue.' }),
    category: z.enum(eventCategories, { error: 'Catégorie inconnue.' }),
    type: z.enum(eventTypes, { error: "Type d'événement inconnu." }),
    outcome: z.enum(['success', 'failure', 'unknown'], { error: 'Résultat invalide.' }),
    actor: actorSchema.optional(),
    tenant: tenantSchema.optional(),
    network: networkSchema.optional(),
    http: httpSchema.optional(),
    business: businessSchema.optional(),
    attributes: attributesSchema.optional(),
  })
  .refine((event) => eventCatalog[event.type] === event.category, {
    error: 'La catégorie ne correspond pas au type.',
    path: ['category'],
  })
  .refine((event) => event.category !== 'business' || (event.business !== undefined && event.tenant !== undefined), {
    error: "Un événement métier porte l'entreprise et l'opération.",
    path: ['business'],
  });

export type EventInput = z.infer<typeof eventInputSchema>;

/** Événement enregistré : horodaté à la réception, cette date fait foi pour les fenêtres de corrélation. */
export type SentinelEvent = EventInput & { receivedAt: string };

/** Lot envoyé à `POST /ingest`. */
export const eventBatchSchema = z.strictObject({
  sentAt: datetime("Date d'envoi"),
  events: z
    .array(eventInputSchema)
    .min(1, { error: 'Le lot est vide.' })
    .max(MAX_BATCH_EVENTS, { error: `${MAX_BATCH_EVENTS} événements par lot au plus.` }),
});

export type EventBatch = z.infer<typeof eventBatchSchema>;
