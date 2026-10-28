# CRUSHCAST V8 — refonte visuelle et amélioration de l'expérience

## Fonctionnalités V8 réellement implémentées

- Nouvelle page d'accueil éditoriale : palette rose / prune / lilas, hiérarchie typographique, illustration CSS de cartes **fictives clairement identifiées**, nouveau bouton d'inscription et présentation transparente de la bêta.
- Nouvelle interface connectée : menu latéral redessiné, barre de navigation mobile inférieure (Découvrir, Likes, Matchs, Messages, Profil), meilleur contraste, mises en page adaptatives, navigation clavier et prise en compte de `prefers-reduced-motion`.
- Cartes de découverte plus lisibles, grille alternative, adaptation mobile, chat visuellement modernisé.
- Fenêtre de célébration affichée **uniquement lors d'un vrai match réciproque** renvoyé par l'API, avec gestion du clavier et fermeture.
- Nouveau formulaire structuré pour les signalements avec motif et description, sans promesse mensongère de modération active.
- Message d'accueil personnalisé pour encourager l'utilisateur à compléter sa présentation.
- Partage volontaire du lien du site via les fonctions natives ou copie de lien.
- Signalement de perte de connexion, compteur visuel dans la navigation mobile.
- Mise à jour du service worker, invalidation du cache PWA V6, suppression de la dépendance à une feuille de styles Google externe.
- Vérification automatisée de la présence des 106 éléments attendus par le JavaScript, de l'absence de doublons d'identifiants et du maintien des avertissements.
- Tests du serveur/API existants conservés.

## Statut réel

Application gratuite de **bêta expérimentale**, sans paiement nécessaire pour les fonctions de rencontre.

Les fonctionnalités suivantes sont **non réalisées** :
- Stockage permanent et sauvegardes automatiques des données privées. Le service Render Free exécute actuellement une base SQLite sur disque temporaire.
- Connexion à la base PostgreSQL provisionnée sur Render. La base gratuite existante expire le 27 novembre 2026, donc même sa connexion ne résoudrait pas la pérennité des données.
- Vérification fiable d'âge / identité, vérification d'e-mail et récupération du mot de passe.
- Équipe de modération humaine et traitements de signalements réellement opérés.
- Publication publique de vidéos / photos de profils et modération de médias.
- Audit sécurité/RGPD complet et tests visuels manuels multi-navigateurs.

Le casting vidéo reste **local à l'appareil** avec téléchargement ou partage volontaire ; aucun média n'est automatiquement envoyé à CRUSHCAST.

## Déploiement

Branche spécifique CRUSHCAST : `crushcast-launch`.
Site : https://crushcast-gratuit-beta.onrender.com
La branche `main` de NEBULA reste inchangée.

N'encourager des inconnus à entrer de vraies données sensibles qu'une fois le stockage durable, la vérification de majorité, le processus de modération et la conformité juridique en place.
