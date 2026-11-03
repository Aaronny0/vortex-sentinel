# Vortex Sentinel

SIEM applicatif de la plateforme SaaS Vortex (gestion commerciale, stock et finances
multi-entreprises).

Objectif : surveiller en continu la sécurité, la disponibilité et le fonctionnement de Vortex afin de détecter les
anomalies et incidents avant qu'ils n'affectent les utilisateurs.

## Chaîne de traitement

```
collecte → normalisation → corrélation → alerte → incident
```

## Missions

1. **Disponibilité** : sondes de santé (API, base de données, proxy), détection des interruptions de service.
2. **Supervision technique** : journaux, erreurs, temps de réponse, comportements anormaux.
3. **Sécurité** : connexions suspectes, force brute, tentatives d'intrusion, refus d'accès.
4. **Anomalies métier** : ventes, stock et finances (annulations, écarts, opérations inhabituelles).
5. **Corrélation et alertes** : règles, seuils, niveaux de gravité.
6. **Gestion des incidents** : centralisation, classement par gravité, historique, suivi jusqu'à la résolution.

## Principes

- Processus et base de données séparés de Vortex : Sentinel doit rester opérationnel quand Vortex tombe.
- Stack : Bun, Elysia, PostgreSQL, Zod.
- Données de test uniquement ; aucune donnée réelle de client.

## Statut

Projet de mémoire de soutenance, en cours de conception.
