# Vortex Sentinel

SIEM applicatif de la plateforme SaaS Vortex (gestion commerciale, stock et finances multi-entreprises).

Objectif : surveiller en continu la sécurité, la disponibilité et le fonctionnement de Vortex afin de détecter les
anomalies et incidents avant qu'ils n'affectent les utilisateurs.

```
collecte → normalisation → corrélation → alerte → incident
```

## Ce que fait Sentinel

| Mission | Réalisation |
|---|---|
| Disponibilité | Sondes de santé (30 s), certificat TLS (1 jour), disque (5 min) ; R01, R02, R15, R17 |
| Supervision technique | Temps de réponse et erreurs par route et par minute, emails en échec ; R03, R04, R16 |
| Sécurité | Force brute, bourrage d'identifiants, compromission, refus d'accès, exploration de l'API, nouvelle adresse puis changement sensible ; R05 à R09, R14 |
| Anomalies métier | Remboursements, écarts de caisse, pertes de stock, opérations hors horaires ; R10 à R13 |
| Corrélation et alertes | 17 règles rejouables, une alerte par constat, gravités Info à Critique |
| Gestion des incidents | Regroupement, cycle de vie historisé, notifications email, tableau de bord |

Évaluation : 14 détections sur 14 scénarios, 0 faux positif sur une semaine simulée, délai médian 90 s
([docs/evaluation.md](docs/evaluation.md)).

## Organisation

- `packages/schema` : schéma des événements (Zod), copié dans `@vortex/contracts` côté Vortex.
- `apps/server` : ingestion signée, sondes, moteur de corrélation, incidents, opérateurs, API, notifications (Bun,
  Elysia, PostgreSQL).
- `apps/web` : tableau de bord (React, Vite, TanStack), servi par le serveur.
- `docs` : [conception](docs/conception.md), [backend](docs/backend.md), [design system](docs/frontend.md),
  [évaluation](docs/evaluation.md).

L'émetteur qui envoie les événements de Vortex vit dans le dépôt de Vortex (`apps/api/src/sentinel`).

## Démarrer en local

Prérequis : Bun, pnpm, PostgreSQL avec un rôle pouvant créer bases et rôles.

```bash
pnpm install
pnpm --filter @sentinel/server local:setup     # base sentinel, logins, .env (jamais versionné)
pnpm --filter @sentinel/web build              # interface servie par le serveur
pnpm --filter @sentinel/server operator:create -- --email vous@exemple.org --name "Votre nom" --role admin
pnpm --filter @sentinel/server dev             # http://localhost:4100
```

Tests : `pnpm typecheck` et `pnpm test` (bases jetables uniquement).

## Principes

- Processus et base séparés de Vortex : Sentinel reste opérationnel quand Vortex tombe, et ne lit jamais sa base.
- Événements en ajout seul, droits PostgreSQL minimaux par rôle, opérateurs à double authentification.
- Données de test uniquement dans ce dépôt public ; aucun secret versionné.
