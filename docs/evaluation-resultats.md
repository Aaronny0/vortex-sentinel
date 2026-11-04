# Résultats de l’évaluation de Sentinel

Produit par `bun run evaluate` (apps/server/evaluation) le 2026-11-04. Données fictives, base jetable, horloge
simulée ; moteur réel évalué toutes les 30 s (10 min pour la semaine normale, 5 min et 1 min pour les scénarios longs).

- **Taux de détection** : 20 règles attendues détectées sur 20 (100 %).
- **Faux positifs** : 0, dont 0 sur une semaine d’activité normale simulée.
- **Délai de détection** : médiane 90 s, maximum 300 s, mesuré entre l’événement qui remplit la condition et le cycle du moteur qui crée l’alerte.

| Scénario | Règles attendues | Détection (gravité, délai) | Faux positifs |
|---|---|---|---|
| S01 · Arrêt de la base de données | R01 | R01 (critique, 0 s) | aucun |
| S02 · Arrêt de l'émetteur de Vortex | R02 | R02 (élevée, 60 s) | aucun |
| S03 · Charge provoquant lenteurs et erreurs | R03, R04 | R03 (moyenne, 90 s), R04 (élevée, 90 s) | aucun |
| S04 · Force brute sur un compte, puis connexion réussie | R05, R07 | R05 (élevée, 90 s), R07 (critique, 90 s) | aucun |
| S05 · Bourrage d'identifiants depuis une adresse | R06 | R06 (élevée, 80 s) | aucun |
| S06 · Nouvelle adresse puis changement d'équipe | R09 | R09 (élevée, 90 s) | aucun |
| S07 · Membre multipliant les remboursements | R10 | R10 (moyenne, 300 s) | aucun |
| S08 · Caissier avec manques de caisse répétés | R11 | R11 (élevée, 120 s) | aucun |
| S09 · Exploration de chemins par un scanner | R14 | R14 (moyenne, 94 s) | aucun |
| S10 · Certificat proche de l'expiration | R15 | R15 (moyenne, 0 s) | aucun |
| S11 · Serveur email injoignable | R16 | R16 (élevée, 90 s) | aucun |
| S12 · Disque presque plein | R17 | R17 (élevée, 0 s) | aucun |
| S14 · Recherche de droits : accès refusés répétés | R08 | R08 (moyenne, 80 s) | aucun |
| S15 · Pertes de stock répétées sur un produit | R12 | R12 (moyenne, 120 s) | aucun |
| S16 · Opération de caisse à une heure inhabituelle | R13 | R13 (faible, 120 s) | aucun |
| S17 · Fonctionnalité en panne, trafic faible | R18 | R18 (élevée, 90 s) | aucun |
| S18 · Administration depuis une adresse inconnue | R19 | R19 (élevée, 90 s) | aucun |
| S19 · Rafale d'actions d'administration sensibles | R20 | R20 (élevée, 90 s) | aucun |
| S13 · Activité normale pendant une semaine | aucune | — | aucun |

## Lecture

- Le délai inclut le délai de grâce de 60 s des règles qui lisent les événements de Vortex (lots en retard de
  l’émetteur) et l’attente du cycle suivant (30 s au plus). Les règles de sondes (R01, R15, R17) n’ont pas de délai de
  grâce.
- Pour un scénario long, le pas du moteur est plus grand que 30 s : le délai mesuré est alors majoré d’autant.
- Faux positif : alerte d’une règle non attendue dans le scénario. La semaine normale mesure le bruit d’une boutique
  ordinaire (connexions quotidiennes, erreurs de saisie occasionnelles, ventes, remboursements isolés, petits écarts).

