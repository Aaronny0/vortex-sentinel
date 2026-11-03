# Consignes du dépôt Vortex Sentinel

SIEM applicatif de la plateforme Vortex, réalisé dans le cadre d'un mémoire de soutenance. Conception :
[docs/conception.md](docs/conception.md).

## Organisation

- `apps/server` : ingestion, sondes, moteur de corrélation, alertes et incidents, API du tableau de bord (Bun, Elysia,
  PostgreSQL). Règles : [docs/backend.md](docs/backend.md), skill `sentinel-backend`.
- `apps/web` : tableau de bord (React, Vite). Règles : [docs/frontend.md](docs/frontend.md), skill `sentinel-interface`.
- `packages/schema` : schéma d'événement (`@sentinel/schema`), partagé avec l'émetteur de Vortex.
- `docs/` : conception, règles frontend et backend.

## Règles

- Charger le skill `sentinel-interface` avant toute modification visuelle et `sentinel-backend` avant toute modification
  côté serveur.
- pnpm gère les workspaces ; Bun est le runtime du serveur. `pnpm typecheck` et `pnpm test` avant de clore une tâche.
- **Dépôt public** : aucun secret, aucune donnée réelle (clients, adresses IP, emails), aucun fichier `.env` commité.
- Sentinel n'a aucun accès à la base de Vortex et n'agit jamais sur Vortex.
- Les modifications de Vortex (émetteur) se font dans le dépôt Vortex, sur une branche, selon ses propres consignes.
- Les tests utilisent des bases jetables ; ne jamais réinitialiser une base qui contient des données.
- Aucun changement sur le VPS, aucun déploiement sans demande explicite.
- Messages de commit en français, au format `type(portée): résumé`.
