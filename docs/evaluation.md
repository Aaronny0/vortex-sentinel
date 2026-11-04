# Évaluation de Vortex Sentinel (chapitre 7 du mémoire)

Ce document décrit la méthode, les mesures et leurs limites. Les chiffres détaillés, régénérés à chaque exécution, sont
dans [evaluation-resultats.md](evaluation-resultats.md).

## 1. Questions évaluées

1. **Détection** : chaque scénario d'incident déclenche-t-il les règles attendues (docs/conception.md § 11) ?
2. **Faux positifs** : une activité normale déclenche-t-elle des alertes injustifiées ?
3. **Délai** : combien de temps entre le moment où la condition est remplie et l'alerte ?
4. **Coût pour Vortex** : combien la capture des événements ajoute-t-elle au temps de réponse de Vortex ?

## 2. Méthode

- **Harnais** : `bun run evaluate` (`apps/server/evaluation`). Chaque scénario s'exécute sur une base PostgreSQL jetable,
  créée puis supprimée ; aucune base contenant des données n'est touchée.
- **Données** : entièrement fictives. Adresses IP de documentation (RFC 5737 : 192.0.2.0/24, 198.51.100.0/24,
  203.0.113.0/24), comptes et entreprises inventés, empreintes d'adresses calculées comme le fait Vortex.
- **Temps simulé** : horloge injectée, avancée par pas. Le moteur de corrélation réel (`runEngineCycle`, les 20 règles)
  est exécuté à chaque pas : 30 s comme en production ; 1, 5 ou 10 minutes pour les scénarios qui couvrent plusieurs
  heures ou une semaine.
- **Arrivée des événements** : un événement de Vortex arrive 5 s après avoir eu lieu (envoi par lots de l'émetteur) ;
  un résultat de sonde arrive immédiatement.
- **Délai mesuré** : entre l'événement qui remplit la condition de la règle (par exemple le 10ᵉ refus pour R05) et le
  cycle du moteur qui crée l'alerte.
- **Faux positif** : alerte d'une règle non attendue dans le scénario. Le scénario S13 simule une semaine ordinaire
  d'une boutique (et 30 jours d'historique) : connexions quotidiennes depuis les adresses habituelles, erreurs de saisie
  occasionnelles, ventes, remboursements isolés, petits écarts de caisse, ajustements de stock positifs, quelques 404.

## 3. Résultats (exécution du 2026-11-04)

| Mesure | Résultat |
|---|---|
| Règles attendues détectées | 20 sur 20 (100 %) |
| Faux positifs | 0, dont 0 sur la semaine normale |
| Délai de détection | médiane 90 s, maximum 300 s (R10, moteur à pas de 5 min dans ce scénario) |
| Surcoût de la capture dans Vortex | ≈ 1 µs par requête réussie, ≈ 3 µs par requête refusée |

Le délai de 90 s se décompose ainsi : 60 s de délai de grâce (le moteur attend les lots en retard de l'émetteur avant
d'évaluer une fenêtre) et 30 s au plus d'attente du cycle suivant. Les règles qui ne lisent que les sondes de Sentinel
(R01, R15, R17) n'ont pas de délai de grâce : 0 s dans la simulation, 30 s au plus en production.

**Coût pour Vortex** : mesuré sur l'application HTTP réelle de Vortex (Elysia, `errorPlugin`, capture Sentinel),
20 000 requêtes par cas après 2 000 de chauffe, envoi vers un Sentinel simulé :

| Requête | Sans capture (moyenne / p99) | Avec capture (moyenne / p99) | Surcoût moyen |
|---|---|---|---|
| Réussie (200) | 3,9 µs / 21,5 µs | 4,9 µs / 22,8 µs | 1,0 µs |
| Refusée (403, événement émis) | 6,9 µs / 30,8 µs | 10,1 µs / 33,2 µs | 3,2 µs |

Une requête de Vortex qui touche la base dure plusieurs millisecondes : le surcoût est inférieur au millième. L'envoi
vers Sentinel se fait hors requête (tampon, lots toutes les 5 s) et ne bloque jamais une réponse.

## 4. Défauts trouvés par l'évaluation et les essais

Trois défauts réels ont été trouvés en testant de bout en bout, corrigés et couverts par un test :

1. **Ordre dans un lot** (R07) : des refus et une connexion réussie envoyés dans le même lot avaient la même heure de
   réception ; la règle exigeait des refus strictement antérieurs et ne voyait pas la compromission. Correction :
   départage par l'heure de l'événement.
2. **Changement d'heure** (R10 à R13) : PostgreSQL comptait « 30 jours » dans le fuseau du serveur ; le passage à
   l'heure d'hiver décalait les fenêtres d'une heure. Correction : sessions en UTC.
3. **Limitation des connexions** : une adresse inconnue partagée aurait permis de bloquer tous les opérateurs avec dix
   essais. Correction : compte par adresse seulement quand elle est connue.

## 5. Limites

- **Simulation** : les scénarios sont construits ; ils prouvent que les règles détectent ce qu'elles décrivent, pas
  qu'elles couvrent toutes les attaques réelles. Les seuils sont des valeurs initiales à calibrer sur des semaines de
  production (le tableau des règles affiche les faux positifs constatés pour ce calibrage).
- **Semaine normale** : un modèle d'activité simple ; une vraie boutique a plus de variance (soldes, inventaires,
  nouveaux employés). Le taux de faux positifs réel reste à mesurer en production.
- **Même machine** : Sentinel et Vortex partagent la machine ; une panne de celle-ci les arrête ensemble. Perspective :
  sonde externe ou seconde machine (docs/conception.md § 3.2).
- **Journal Nginx** : non exploité dans le déploiement actuel (adresse du proxy seulement) ; reporté à la migration.

## 6. Reproduire

```bash
cd apps/server
bun run evaluate          # scénarios, écrit docs/evaluation-resultats.md (≈ 1 min 30)
bun run replay -- --from 2026-11-04T08:00:00Z --to 2026-11-04T18:00:00Z   # rejoue une période réelle, en lecture seule
```
