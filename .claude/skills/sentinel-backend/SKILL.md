---
name: sentinel-backend
description: Écrire, modifier ou revoir le serveur de Vortex Sentinel (apps/server) ou l'émetteur côté Vortex - ingestion, sondes, règles de corrélation R01 à R20, moteur, alertes, incidents, migrations SQL, rôles PostgreSQL, tests. À charger avant la première modification côté serveur.
---

# Serveur de Vortex Sentinel

Tu écris le cœur d'un SIEM. On doit pouvoir croire ce qu'il affiche : **ne rien perdre sans le savoir, ne rien compter
deux fois, pouvoir rejouer toute détection à l'identique.**

## Avant d'écrire une ligne

1. Lire `docs/backend.md` en entier (règles d'ingénierie) et la partie concernée de `docs/conception.md` (fonctionnel).
2. Pour une règle de corrélation : relire sa ligne dans `docs/conception.md` § 6 (seuil, fenêtre, gravité).
3. Pour l'émetteur dans Vortex : lire aussi `AGENTS.md` et `apps/api/AGENTS.md` du dépôt Vortex, qui priment.

## Règles qui ne se discutent pas

- **Zod sur toute entrée** (corps, en-têtes, variables d'environnement, lignes de journal lues).
- **SQL paramétré uniquement** ; aucune valeur concaténée dans une requête.
- **`event` en ajout seul** : aucun `UPDATE` ni `DELETE` applicatif ; la rétention supprime des partitions.
- **Rôle PostgreSQL minimal** par processus (`sentinel_ingest`, `sentinel_app`, `sentinel_purge`).
- **Horloge injectée** : jamais `Date.now()` ni `new Date()` hors de `common/clock.ts`.
- **`received_at` fait foi** pour les fenêtres, avec 60 s de délai de grâce.
- **Une alerte par constat** : verrou consultatif par règle, point de reprise et alertes écrits dans la même transaction,
  unicité `(rule_id, key)` sur les alertes ouvertes.
- **Une règle est une fonction** : elle lit des événements et renvoie des constats avec leurs preuves ; elle n'écrit rien.
- **Aucun secret, aucun corps de requête, aucune adresse email** dans les journaux ou le dépôt (il est public).

## Méthode

1. Écrire d'abord les tests : réussite, refus, et concurrence ou reprise quand elles comptent. Pour une règle :
   déclenchement, juste sous le seuil, bord de fenêtre, événement en retard. Horloge fixée, aucun `sleep`.
2. Implémenter au plus simple qui fait passer les tests.
3. `pnpm typecheck` et `pnpm test` ; les tests tournent sur une base jetable, jamais sur une base avec des données.
4. Dérouler la checklist de `docs/backend.md` § 10 ; mettre à jour `docs/conception.md` si le comportement change.
