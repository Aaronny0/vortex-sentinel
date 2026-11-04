# Interface de Vortex Sentinel — design system et règles frontend

Version 1.0 — 2026-11-03. Ce document fait autorité pour toute interface de Sentinel. Il s'appuie sur le design system de
Vortex (`apps/web/docs/design-system/` du dépôt Vortex), dont il reprend l'identité, et définit ce qui est propre à une
console de surveillance.

## 1. Direction : une salle de contrôle, pas un film de hackers

Sentinel est un outil de travail qu'un opérateur garde ouvert toute la journée. La référence n'est pas l'imagerie
« cybersécurité » (fonds noirs, néons, cartes du monde traversées d'attaques), mais les postes de contrôle où l'erreur coûte
cher : régulation aérienne, surveillance hospitalière, poste de commande d'un réseau électrique. Ce qu'ils ont en commun :

1. **Le calme est l'état normal.** Quand tout va bien, l'écran est presque monochrome : encre sur fond clair, pétrole
   pour les actions. Une couleur vive signifie toujours qu'il y a quelque chose à faire.
2. **La couleur est un signal, jamais une décoration.** Elle est réservée à la gravité, à l'état d'un service et à
   l'action principale. Si tout est coloré, plus rien n'alerte.
3. **Ce qui demande une action se voit en premier.** Ordre de lecture de chaque écran : état global → à traiter →
   tendance → détail.
4. **Chaque chiffre est vérifiable.** Un compteur ouvre la liste qu'il résume ; une alerte montre les événements qui l'ont
   déclenchée ; une date montre son heure exacte et son fuseau.
5. **La densité est une qualité.** Un analyste compare des lignes : tableaux serrés, chiffres alignés, peu de marges
   décoratives. Mais jamais au détriment de la lisibilité ni des cibles tactiles.

Sentinel appartient à la famille Vortex : même bleu pétrole, mêmes polices, mêmes neutres teintés. Un utilisateur qui
passe de l'un à l'autre doit reconnaître le même produit.

## 2. Ce qui est interdit

Ces motifs signalent une interface générée sans intention. Ils sont refusés en revue, quel que soit le contexte.

**Couleurs et matières**
- Violet, indigo, magenta comme couleur de marque ou d'interface ; dégradés violet–bleu, bleu–rose.
- Néon, lueurs (`box-shadow` colorée, `text-shadow`, `filter: drop-shadow` lumineux), contours qui brillent.
- Texte en dégradé, fonds en dégradé, « aurores » ou halos flous en arrière-plan.
- Verre dépoli (`backdrop-filter: blur` sur des cartes), surfaces translucides superposées.
- Vert « Matrix », cyan sur noir, toute esthétique de terminal pour l'interface générale.

**Formes et décor**
- Cartes très arrondies (au-delà de 12 px) avec ombre portée partout ; ombres sur des éléments qui ne flottent pas.
- Icônes dans des pastilles colorées en série, illustrations 3D, mascottes, emojis.
- Boucliers, cadenas et yeux comme décor ; globes et cartes du monde animés ; radars qui tournent.
- Bandeaux « héros », grands titres d'accueil, slogans dans l'application.
- Indicateurs décoratifs : mini-courbes sans axe ni sens, jauges circulaires pour un simple pourcentage.

**Mouvement**
- Clignotement, pulsation permanente, compteurs qui défilent, apparitions en cascade, effets au survol des cartes.

**Ton**
- « Bienvenue ! », « Tout est sous contrôle ✨ », points d'exclamation, anthropomorphisme (« Sentinel veille sur vous »).
- Vocabulaire alarmiste sans fait (« Menace détectée ! » sans dire laquelle).

## 3. Couleurs

### 3.1 Base (reprise de Vortex, sans modification)

| Rôle | Light | Dark | Usage |
|---|---|---|---|
| `--background` | #f8fafa | #081010 | Plan de travail |
| `--foreground` | #09191a | #f0f4f4 | Encre (18:1 sur blanc) |
| `--card` | #ffffff | #10191a | Cartes, tableaux |
| `--muted` | #eef4f4 | #182122 | Surfaces secondaires |
| `--muted-foreground` | #566768 | #9aa8a8 | Texte secondaire (5,9:1 / 7,3:1) |
| `--border` | #dde3e4 | #232e2e | Bordures |
| `--primary` | #057176 | #3ebfc6 | Action principale, lien, focus, sélection |
| `--primary-foreground` | #fafcfc | #051213 | Texte sur primaire |
| `--accent` | #dbf3f4 | #0e3133 | Ligne ou entrée sélectionnée |
| `--success` | #1a763f | #4dbf74 | Service opérationnel, incident résolu |
| `--sidebar` | #eff6f6 | #050c0c | Rail de navigation |

Le pétrole ne signale que l'interaction : bouton principal, lien, focus, élément sélectionné. Une seule surface pétrole
pleine par écran.

### 3.2 Échelle de gravité (propre à Sentinel)

Cinq niveaux, du plus discret au plus urgent. Les niveaux reprennent les sémantiques de Vortex ; seul « élevée » ajoute une
teinte (orange, hue 45), car aucune couleur existante ne se place entre l'ambre et le rouge.

| Niveau | Plein (fond / texte) | Doux (fond / texte) | Point, icône, barre sur fond clair | Dark : plein | Dark : doux |
|---|---|---|---|---|---|
| Critique | #c51e21 / #fcfcfc (5,9) | #feeeec / #9e1618 (7,2) | #c51e21 (5,6) | #f75d59 / #180807 (6,2) | #3f1917 / #feb5ae (9,1) |
| Élevée | #c2410c / #ffffff (5,2) | #ffedd5 / #9a3412 (6,4) | #c2410c (4,9) | #fb923c / #1c0a02 (8,5) | #3b1d0c / #fdba74 (9,1) |
| Moyenne | #e8a127 / #331b06 (7,4) | #fff2d9 / #864900 (6,4) | #a16207 (4,7) | #f2b036 / #231103 (9,6) | #382409 / #f4ca84 (9,6) |
| Faible | #0470a5 / #ffffff (5,4) | #e8f5fe / #025884 (6,9) | #0470a5 (5,2) | #4baeed / #020f19 (7,9) | #08273a / #9bd2fa (9,5) |
| Info | #eef4f4 / #566768 (5,3) | — | #566768 (5,7) | #182122 / #9aa8a8 (6,7) | — |

Les ratios entre parenthèses sont calculés (WCAG 2.x) sur le fond indiqué ; le point sur fond clair est mesuré sur
`--background`. L'ambre plein (#e8a127) n'atteint que 2,2:1 sur blanc : il ne sert jamais seul comme point ou trait, d'où
la colonne dédiée.

Règles :
- **Doux par défaut** (badges dans les listes), **plein seulement pour le niveau qui exige une action immédiate** (bandeau
  d'incident critique, compteur de critiques ouverts).
- **Jamais la couleur seule** : chaque niveau a son libellé et sa forme d'icône (critique : octogone ; élevée : triangle ;
  moyenne : losange ; faible : cercle ; info : cercle vide). Critique et élevée sont proches en teinte (1,1:1 entre eux) :
  la forme et le libellé les distinguent.
- Les variables sont `--severity-{critical,high,medium,low,info}` avec les suffixes `-solid`, `-solid-foreground`,
  `-muted`, `-muted-foreground` et `-mark`.

### 3.3 État des services

| État | Couleur | Libellé |
|---|---|---|
| Opérationnel | `--success` | Opérationnel |
| Dégradé | `--severity-medium-mark` | Dégradé |
| Interrompu | `--severity-critical-mark` | Interrompu |
| Inconnu (pas de donnée récente) | `--muted-foreground` | Sans nouvelles depuis 3 min |

### 3.4 Graphiques

- Série principale en `--primary` ; comparaison (période précédente) en `--muted-foreground`, trait pointillé.
- Une série par niveau de gravité réutilise les couleurs `-mark` ; aucune autre palette.
- Pas de remplissage en dégradé, pas d'ombre, pas de 3D, pas d'animation d'entrée.
- Axe du temps toujours légendé avec son fuseau ; valeurs exactes au survol et dans un tableau accessible.

## 4. Typographie

Mêmes familles que Vortex, servies localement (fichiers et licences OFL repris de `apps/web/public/auth/` de Vortex).

| Rôle | Famille | Taille / interligne | Graisse |
|---|---|---|---|
| Titre d'écran | Bricolage Grotesque | 24 / 30 | 600 |
| Chiffre clé (compteur d'incidents) | Bricolage Grotesque | 32 / 36 | 600 |
| Titre de carte, de section | Geist | 15 / 22 | 600 |
| Corps | Geist | 14 / 20 | 400 |
| Cellule de tableau | Geist | 13 / 18 | 400 |
| Libellé, méta | Geist | 12 / 16 | 500 |
| En-tête de tableau | Geist | 11 / 16, capitales, +0,06em | 600 |
| Identifiant, IP, empreinte, référence, règle | Geist Mono | 12,5 / 18 | 500 |

- Chiffres en `tabular-nums` partout où ils se comparent.
- Geist Mono uniquement pour ce qu'on copie ou compare caractère par caractère, jamais pour du texte courant.
- Pas de capitales espacées ailleurs que dans les en-têtes de tableau et le rail.

## 5. Espacements, formes, élévation

- Grille de 4 px ; échelle 4, 8, 12, 16, 20, 24, 32, 40.
- Gouttières 16 / 24 / 32 px (mobile / tablette / bureau) ; 16 px entre cartes ; contenu jusqu'à 1600 px.
- Rayons : 6 px (badge, puce), 8 px (contrôle), 12 px (carte), 16 px (dialogue).
- Une carte tient par sa bordure ; l'ombre est réservée à ce qui flotte (menu, dialogue, notification).
- Lignes de tableau : 40 px (dense, par défaut pour les événements), 48 px (alertes, incidents).
- Cibles tactiles de 44 px minimum en `pointer: coarse`.

## 6. Structure de l'application

```
┌───────────────────────────────────────────────────────────────────┐
│ Barre d'état : API ● Base ● Web ● Admin ● Collecte ●   2 critiques │  48 px, toujours visible
├──────────┬────────────────────────────────────────────────────────┤
│ Rail     │ En-tête d'écran : titre, période, une action principale│
│          ├────────────────────────────────────────────────────────┤
│ Vue      │                                                        │
│ Incidents│ Contenu                                                │
│ Alertes  │                                                        │
│ Événem.  │                                                        │
│ Disponib.│                                                        │
│ Règles   │                                                        │
│ Admin    │                                                        │
└──────────┴────────────────────────────────────────────────────────┘
```

- **Barre d'état** : état de chaque service surveillé et nombre d'incidents critiques ou élevés ouverts. C'est le seul
  élément présent sur tous les écrans ; elle répond à « est-ce que tout va bien ? » en un regard.
- **Rail** clair, repris de Vortex (entrée active : fond `--accent` et barre de 3 px), repliable à 64 px.
- Le rôle de l'opérateur (administrateur, analyste, observateur) décide des entrées visibles ; le serveur reste l'autorité.

## 7. Écrans

| Écran | Question à laquelle il répond | Contenu, dans l'ordre |
|---|---|---|
| Vue d'ensemble | Faut-il agir maintenant ? | État des services ; incidents ouverts par gravité ; à traiter (non assignés) ; activité des 24 h par catégorie ; dernières alertes |
| Incidents | Que reste-t-il à résoudre ? | Filtres (statut, gravité, assigné, période) ; liste ; détail latéral sans quitter la liste |
| Détail d'incident | Que s'est-il passé, qui s'en occupe ? | En-tête (gravité, statut, assigné, durée) ; actions du cycle de vie ; alertes liées ; chronologie des événements ; historique et commentaires |
| Alertes | Quels signaux ont été levés ? | Liste groupée par règle et clé, compteur de déclenchements, lien vers l'incident |
| Événements | Que dit la donnée brute ? | Recherche et filtres (type, catégorie, acteur, IP, entreprise, période) ; tableau dense ; détail en JSON lisible |
| Disponibilité | Les services répondent-ils ? | Par cible : état, temps de réponse, historique 24 h / 7 j / 30 j, interruptions ; certificat ; disque |
| Règles | Qu'est-ce qui est surveillé et comment ? | Liste des règles, seuils, gravité, activation, faux positifs constatés |
| Administration | Qui a accès ? | Opérateurs et rôles ; journal des actions des opérateurs |

**Chronologie d'un incident** : axe vertical, un événement par ligne (heure exacte, type, acteur, IP en mono), les
événements déclencheurs signalés par le marqueur de gravité. C'est l'écran qu'un jury regardera le plus : il doit raconter
l'incident sans explication orale.

## 8. Composants propres à Sentinel

| Composant | Règle |
|---|---|
| `SeverityBadge` | Icône de forme + libellé ; doux par défaut, `solid` sur demande explicite. |
| `ServiceStatus` | Point + nom + état textuel + date du dernier contrôle. |
| `Timestamp` | Relatif (« il y a 3 min ») avec date exacte, secondes et fuseau en infobulle et pour les lecteurs d'écran ; absolu dans les chronologies et exports. |
| `Identifier` | Geist Mono, tronqué au milieu (`4f2a…9c1d`), bouton copier, valeur complète accessible. |
| `IncidentTimeline` | Voir § 7. |
| `RuleRef` | Identifiant de règle (R05) en mono + nom court ; ouvre la règle. |
| `CountLink` | Tout compteur est un lien vers la liste filtrée correspondante. |

Les composants génériques (bouton, champ, tableau, dialogue, panneau latéral, onglets, menu) suivent la spécification
de Vortex (`05-composants-ui.md`) : mêmes variantes, mêmes états.

## 9. Données et écriture

- Interface en français. Phrases courtes, factuelles, au présent. Un verbe d'action sur chaque bouton : « Prendre en
  charge », « Marquer comme résolu », « Classer en faux positif ».
- Une alerte dit **ce qui s'est passé, où, combien** : « 14 échecs de connexion sur un même compte en 6 min ».
- Dates au format `03/11/2026 14:32:10`, fuseau affiché (`UTC+1`). Durées : `2 h 14 min`.
- Montants avec séparateur de milliers et devise : `45 000 XOF`.
- Aucune donnée sensible au-delà du rôle : l'observateur ne voit ni IP ni identifiant.
- États vides utiles : « Aucun incident ouvert. Dernier incident résolu il y a 3 jours. » plutôt que « Rien à afficher ».

## 10. Mouvement

- 120 à 180 ms, `ease-out`, uniquement pour un changement d'état (ouverture d'un panneau, apparition d'une ligne).
- Nouvelle alerte : la ligne apparaît avec un fond `--accent` qui s'estompe en 2 s, une seule fois. Rien ne clignote.
- Incident critique : bandeau fixe et titre de l'onglet (`(2) Sentinel`), sans animation.
- `prefers-reduced-motion: reduce` supprime toute transition.

## 11. Accessibilité (WCAG 2.2 AA)

- Contrastes : 4,5:1 pour le texte, 3:1 pour les éléments graphiques ; les valeurs du § 3 respectent ces seuils.
- Navigation complète au clavier ; focus visible (`--ring`, halo de 3 px) ; lien d'évitement vers le contenu.
- Nouvelles alertes annoncées par une région `aria-live="polite"`, incidents critiques par `role="alert"`, sans répéter.
- Tableaux avec en-têtes réels ; graphiques doublés d'un tableau de valeurs.
- Les deux thèmes, clair et sombre, sont testés ; le thème suit le système et peut être forcé.

## 12. Pile technique

React 19, Vite, TanStack Router et TanStack Query, comme Vortex. Les données viennent toujours de l'API de Sentinel ; aucun
calcul de gravité, de seuil ou de corrélation dans le navigateur. Rafraîchissement par interrogation (10 s sur la vue
d'ensemble et la barre d'état, 30 s ailleurs), suspendu quand l'onglet est caché.

## 13. Validation avant de livrer un écran

- [ ] L'écran au repos (aucun incident) est presque monochrome.
- [ ] Aucun motif du § 2.
- [ ] Toute couleur vient d'une variable du § 3 ; aucune valeur en dur.
- [ ] Gravité et état ont toujours un libellé et une forme, pas seulement une couleur.
- [ ] Chaque compteur mène à sa liste ; chaque alerte à ses événements.
- [ ] Dates exactes et fuseau accessibles.
- [ ] Cinq états traités : chargement, vide, erreur, données partielles, normal.
- [ ] Clavier, focus, lecteur d'écran, contraste vérifiés en clair et en sombre.
- [ ] 375 px, 768 px, 1440 px sans débordement horizontal.
- [ ] Données de test uniquement dans les captures du mémoire.

## 14. État de la mise en œuvre (2026-11-04)

Réalisé dans `apps/web`, servi par le serveur de Sentinel (`WEB_DIST`) avec une politique de sécurité stricte (CSP sans
ressource extérieure, aucun cadre, aucun référent) :

- connexion en deux temps et activation de la double authentification ;
- barre d'état, rail selon le rôle, thème clair, sombre ou système ;
- vue d'ensemble, incidents (liste et détail côte à côte à partir de 1280 px, chronologie, actions du cycle de vie,
  commentaires), alertes et leurs preuves, recherche d'événements, disponibilité (24 h, 7 j, 30 j), règles,
  administration (opérateurs, journal des actions).

Écarts assumés, à reprendre si besoin :

- **Pas de QR code** à l'activation : la clé est affichée par groupes de 4 et un lien `otpauth://` l'ouvre dans
  l'application. Un QR code demanderait une bibliothèque de plus.
- **État « Dégradé »** d'un service : non affiché, car il supposerait un seuil dans le navigateur ; la lenteur est
  détectée par le serveur (R03) et apparaît comme alerte.
- **Graphiques** : la disponibilité est rendue en 24 tranches colorées doublées d'un tableau des interruptions ;
  l'évolution des erreurs (vue d'ensemble) en 24 barres horaires empilées, erreurs serveur en `--primary` et
  d'interface en `--muted-foreground`, avec échelle, axe légendé de son fuseau, valeur exacte au survol et tableau pour
  les lecteurs d'écran. Chaque total et chaque heure ouvrent les événements correspondants.

**Application installable (PWA)** : `manifest.webmanifest` (nom, icônes 192 et 512 px, icône masquable, couleurs du
§ 3.1), `sw.js` enregistré en production. Le service worker met en cache les seuls fichiers de l'interface et une page
hors ligne (`offline.html`, mêmes couleurs, polices du système) ; il ne touche jamais à `/api`, `/ingest` ni `/health`.
Les icônes reprennent celle de l'onglet (pétrole, coche).

Vérifié dans le navigateur : clair et sombre, 375, 1024, 1280 et 1440 px (aucun défilement horizontal à 375 px),
prise en charge d'un incident réel, journal d'audit. Non vérifié : lecteur d'écran, navigation complète au clavier
écran par écran.
