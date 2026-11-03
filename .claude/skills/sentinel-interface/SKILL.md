---
name: sentinel-interface
description: Concevoir, coder ou revoir toute interface de Vortex Sentinel (apps/web, tableau de bord, écrans, composants, couleurs, graphiques, textes affichés, captures pour le mémoire). À charger avant la première modification visuelle, même minime.
---

# Interface de Vortex Sentinel

Tu travailles sur la console d'un SIEM utilisée toute la journée par des opérateurs. Le niveau attendu est celui d'un
directeur artistique produit senior : chaque pixel a une raison, rien n'est décoratif.

## Avant d'écrire une ligne

1. Lire `docs/frontend.md` en entier. Il fait autorité ; ce skill n'en est que le mode d'emploi.
2. Identifier l'écran concerné dans `docs/frontend.md` § 7 et la question à laquelle il répond.
3. Lister les composants existants réutilisables (`apps/web/src/components`) avant d'en créer un.

## Règles qui ne se discutent pas

- **Calme par défaut** : un écran sans incident est presque monochrome. La couleur ne sert qu'à la gravité, à l'état
  d'un service et à l'action principale.
- **Identité Vortex** : bleu pétrole (#057176 / #3ebfc6 en sombre), Bricolage Grotesque, Geist, Geist Mono, neutres teintés
  hue 200. Aucune autre couleur de marque.
- **Interdits absolus** : violet, indigo, néon, lueurs, dégradés, verre dépoli, texte en dégradé, emojis, clignotement,
  globes, radars, boucliers décoratifs, esthétique « terminal de hacker ». Liste complète : `docs/frontend.md` § 2.
- **Toute couleur vient d'une variable** du § 3 ; jamais de valeur en dur dans un composant.
- **Jamais la couleur seule** : gravité et état portent un libellé et une forme d'icône.
- **Tout compteur est un lien**, toute alerte montre ses événements, toute date donne son heure exacte et son fuseau.
- **Le navigateur n'est jamais l'autorité** : aucun calcul de gravité, de seuil ou de droit côté client.
- **Écriture** : français sobre et factuel, verbe d'action sur chaque bouton, aucun point d'exclamation.

## Méthode

1. Esquisser l'ordre de lecture de l'écran : état global → à traiter → tendance → détail.
2. Coder avec les variables et composants existants ; traiter les cinq états (chargement, vide, erreur, partiel, normal).
3. Vérifier dans le navigateur, en clair et en sombre, à 375, 768 et 1440 px, au clavier.
4. Dérouler la checklist de `docs/frontend.md` § 13 et rendre compte de ce qui a été vérifié et de ce qui ne l'a pas été.

## Ajouter une couleur, une taille ou un composant de base

Interdit sans accord explicite de l'utilisateur. Si c'est nécessaire, proposer la valeur, sa justification, ses deux
thèmes et ses contrastes calculés, puis mettre à jour `docs/frontend.md` dans le même commit que le code.
