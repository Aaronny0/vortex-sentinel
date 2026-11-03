# Serveur de Vortex Sentinel — règles d'ingénierie backend

Version 1.0 — 2026-11-03. Ce document fait autorité pour `apps/server` et pour l'émetteur ajouté à Vortex. La conception
fonctionnelle (missions, règles R01 à R17, cycle de vie des incidents) est dans [conception.md](conception.md).

Un SIEM n'a de valeur que si l'on peut croire ce qu'il affiche. Toutes les règles ci-dessous découlent de trois exigences :
**ne rien perdre sans le savoir, ne rien compter deux fois, et pouvoir rejouer n'importe quelle détection à l'identique.**

## 1. Pile

- Bun (runtime), Elysia (HTTP), Zod 4 (toute entrée), PostgreSQL 16 ou plus.
- Accès base par `pg` (node-postgres) et SQL écrit à la main, paramétré. Pas d'ORM : le moteur de corrélation repose sur
  des fenêtres glissantes, des tables partitionnées et des droits par rôle que l'on veut lire et maîtriser en SQL.
- Migrations SQL versionnées (`apps/server/migrations/NNNN_nom.sql`), appliquées dans l'ordre par un script dédié,
  chacune dans une transaction et enregistrée dans `schema_migration`.
- Tests : `bun test`, sur une base jetable créée pour la suite et supprimée à la fin. Jamais sur une base qui contient des
  données.

## 2. Organisation du code

```
apps/server/src/
  config/        lecture et validation (Zod) des variables d'environnement
  db/            pools par rôle, transaction, migrations
  http/          application Elysia, format d'erreur, authentification des opérateurs
  ingest/        signature HMAC, anti-rejeu, validation, enregistrement
  probes/        sondes de disponibilité, certificat, disque
  logs/          lecteur du journal Nginx
  rules/         une règle par fichier (r01-probe-down.ts…), registre des règles
  engine/        planificateur, points de reprise, fenêtres, déduplication
  incidents/     alertes, incidents, cycle de vie, historique
  notify/        notifications email
  common/        horloge, erreurs, journalisation expurgée
```

- Un module expose des fonctions ; il ne lit ni `process.env` ni l'horloge système directement (voir § 6).
- Un fichier fait une chose. Une règle de corrélation tient dans son fichier avec ses tests à côté.

## 3. Base de données

### 3.1 Rôles

| Rôle | Droits | Utilisé par |
|---|---|---|
| `sentinel_owner` | Propriétaire du schéma | Migrations uniquement |
| `sentinel_ingest` | `INSERT` sur `event` et `emitter_status` ; rien d'autre | Ingestion |
| `sentinel_app` | `SELECT` sur `event` ; lecture et écriture sur règles, alertes, incidents, sondes | Moteur, API du tableau de bord |
| `sentinel_purge` | Détachement et suppression des partitions échues | Tâche de rétention |

Aucun rôle applicatif n'a `UPDATE` ni `DELETE` sur `event` : la table est en ajout seul, par construction et pas par
convention. Chaque processus se connecte avec le rôle minimal de sa tâche.

### 3.2 Table `event`

- Partitionnée par mois sur `received_at` ; les partitions des deux mois suivants sont créées à l'avance.
- Clé primaire `(id, received_at)` ; l'identifiant fourni par l'émetteur sert à la déduplication
  (`INSERT … ON CONFLICT DO NOTHING`).
- Colonnes extraites pour les règles et la recherche : `type`, `category`, `outcome`, `occurred_at`, `received_at`,
  `organization_id`, `store_id`, `user_id`, `email_hash`, `ip` (`inet`), `http_status` ; l'événement complet en `jsonb`.
- Index : BRIN sur `received_at` ; B-tree sur `(type, received_at)`, `(email_hash, received_at)`, `(ip, received_at)`,
  `(user_id, received_at)`.
- Rétention : 2 ans, par suppression de partitions entières (aucun `DELETE` ligne à ligne).

### 3.3 Requêtes

- Toujours paramétrées. Aucune concaténation de valeur dans une chaîne SQL, y compris pour un nom de partition
  (identifiants validés par expression régulière puis échappés avec `format('%I')`).
- Toute écriture qui touche plusieurs tables est dans une transaction.
- Une requête du moteur porte une borne de temps explicite : jamais de lecture de toute la table.

## 4. Ingestion

```
POST /ingest
X-Sentinel-Timestamp: 1762180335
X-Sentinel-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + corps brut)>
```

Ordre de traitement, chaque étape refusant avant la suivante :

1. Taille du corps ≤ 1 Mo (413).
2. Horodatage à ±300 s de l'horloge de Sentinel (401 `STALE_REQUEST`).
3. Signature recalculée sur le **corps brut**, comparée en temps constant (401 `BAD_SIGNATURE`). Plusieurs secrets
   acceptés pendant une rotation.
4. Validation du lot par `eventBatchSchema` (422, lot entier refusé ; le détail des champs en erreur est renvoyé).
5. Enregistrement en une transaction ; `received_at` posé par Sentinel.
6. Réponse 202 `{ accepted, duplicates }`.

- Une signature déjà vue dans la fenêtre de ±300 s est refusée (anti-rejeu), en plus de la déduplication par identifiant.
- Débit borné par source ; au-delà, 429 avec `Retry-After`.
- Le corps reçu n'est jamais écrit dans les journaux.

## 5. Moteur de corrélation

### 5.1 Contrat d'une règle

```ts
type Rule = {
  id: 'R05';
  version: number;                 // incrémentée à chaque changement de logique ou de seuil par défaut
  kind: 'event' | 'window' | 'sequence';
  severity: Severity;
  window?: Duration;               // fenêtres et séquences
  evaluate(ctx: RuleContext): Promise<Finding[]>;
};

type Finding = {
  key: string;                     // ce qui identifie l'alerte : compte, IP, cible, acteur
  severity: Severity;
  summary: string;                 // phrase factuelle : « 14 échecs de connexion en 6 min »
  evidence: string[];              // identifiants des événements déclencheurs
  observedAt: Date;
};
```

Une règle ne touche ni à la base des alertes ni aux incidents : elle lit des événements et renvoie des constats. Le
moteur s'occupe du reste. Une règle est donc testable seule, avec des événements fabriqués et une horloge fixée.

### 5.2 Le temps

- **`received_at` fait foi** pour les fenêtres : l'horloge de l'émetteur peut dériver, celle de Sentinel est la référence.
  `occurred_at` est affiché et sert à reconstituer la chronologie.
- **Délai de grâce** de 60 s : une fenêtre `[t − durée, t]` n'est évaluée que lorsque `maintenant ≥ t + 60 s`, pour
  laisser arriver les lots en retard.
- Événement arrivé après ce délai : il est enregistré, et réévalué au cycle suivant à partir du point de reprise ;
  l'éventuelle alerte rejoint l'alerte existante grâce à la déduplication.
- Toutes les dates sont en UTC dans le code et en base (`timestamptz`) ; le fuseau n'intervient qu'à l'affichage.

### 5.3 Exactement une alerte par constat

- Chaque règle a un **point de reprise** (`rule_checkpoint`) : la dernière borne évaluée.
- Un cycle d'évaluation prend un **verrou consultatif** PostgreSQL par règle (`pg_try_advisory_xact_lock`) : deux
  instances du moteur ne peuvent pas évaluer la même règle en même temps.
- Dans une **même transaction** : lecture du point de reprise, évaluation, écriture des alertes, avancement du point de
  reprise. Si une étape échoue, rien n'est écrit, et le cycle suivant reprend au même point.
- **Déduplication** : une alerte ouverte est unique par `(rule_id, key)` (index unique partiel sur les alertes
  ouvertes). Un nouveau constat sur la même clé incrémente son compteur, ajoute ses preuves et met à jour
  `last_seen_at`.
- **Fin d'alerte** : une alerte sans nouveau constat pendant sa période de calme (par défaut deux fenêtres) est close ;
  un constat ultérieur en ouvre une nouvelle.

### 5.4 Reproductibilité

- Une alerte conserve la **version de la règle** et les **seuils** effectifs au moment du constat.
- `bun run replay --from … --to …` rejoue les règles sur une période passée dans une base jetable et produit la liste des
  constats. Même événements, mêmes versions de règles : mêmes constats. C'est la base des scénarios d'évaluation du
  mémoire.

### 5.5 Références comportementales

Recalculées chaque nuit dans une transaction (`baseline`) : moyennes sur 30 jours par acteur, IP connues par utilisateur,
plages horaires d'activité par boutique. Une règle qui en dépend lit la dernière version complète, jamais un calcul en
cours.

## 6. Horloge, configuration, erreurs, journaux

- **Horloge injectée** : le code reçoit un `Clock` (`now(): Date`). En production, l'horloge système ; dans les tests,
  une horloge que le test avance. Aucun `Date.now()` ni `new Date()` sans argument hors de `common/clock.ts`.
- **Configuration** : variables d'environnement validées au démarrage par Zod ; le processus refuse de démarrer si une
  valeur manque ou est invalide. Aucun secret dans le dépôt (il est public) ; `.env.example` documente chaque variable.
- **Erreurs** : format unique `{ code, error, fields? }`, messages en français, comme Vortex. Les erreurs internes
  renvoient `INTERNAL` sans détail.
- **Journaux** : une ligne par fait, sans secret, sans corps de requête, sans adresse email. Les erreurs PostgreSQL sont
  expurgées avant écriture (valeurs de clés, contenu des lignes).

## 7. Surveiller le surveillant

Sentinel publie sa propre santé, et ses retards sont des incidents comme les autres.

- `GET /health` : base joignable, dernier cycle du moteur, retard d'ingestion.
- Mesures internes : délai entre `received_at` et l'évaluation, durée de chaque cycle par règle, événements refusés par
  motif, abandons signalés par l'émetteur.
- Un cycle de moteur en retard de plus de 2 minutes ouvre une alerte « Moteur de corrélation en retard ».

## 8. Émetteur (dans le dépôt Vortex)

- Ne bloque jamais une requête : la capture ajoute l'événement à un tampon en mémoire et rend la main.
- Tampon borné (10 000) ; au-delà, les plus anciens sont abandonnés et comptés ; le compteur part dans le battement de
  cœur.
- Envoi par lots (5 s ou 200 événements), nouvelles tentatives avec attente exponentielle et aléa (1 s à 60 s).
- Aucune donnée ne quitte Vortex sans passer par le schéma : un événement invalide est abandonné et compté, pas envoyé.
- Le respect des règles de Vortex prime (`AGENTS.md` de Vortex) : RLS, `withActor`, pas de secret dans les journaux.

## 9. Tests

Pour chaque fonctionnalité :

- **réussite** : le cas nominal produit exactement le résultat attendu ;
- **refus** : chaque contrôle refuse ce qu'il doit refuser (signature, horodatage, schéma, droits) ;
- **concurrence et reprise** quand elles comptent : deux moteurs en parallèle ne doublent pas une alerte ; un échec au
  milieu d'un cycle ne fait rien perdre.

Pour chaque règle : au moins un cas qui déclenche, un cas juste sous le seuil qui ne déclenche pas, un cas en bord de
fenêtre, un événement en retard. Les tests fixent l'horloge ; aucun test ne dépend de l'heure réelle ni d'un `sleep`.

## 10. Avant de livrer

- [ ] `pnpm typecheck` et `pnpm test` passent.
- [ ] Toute entrée externe passe par Zod ; toute requête SQL est paramétrée.
- [ ] Aucun accès direct à l'horloge ou à `process.env` hors des modules dédiés.
- [ ] Les droits de chaque rôle PostgreSQL sont testés (un `UPDATE` sur `event` échoue).
- [ ] Aucune donnée réelle, aucun secret, aucun corps de requête dans les journaux ou le dépôt.
- [ ] La conception (`docs/conception.md`) est à jour si le comportement a changé.
