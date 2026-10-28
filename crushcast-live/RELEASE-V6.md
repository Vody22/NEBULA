# CRUSHCAST V6 — version bêta gratuite

Site principal (après fusion et déploiement) : https://crushcast-gratuit-beta.onrender.com

## Fonctionnalités de cette version

- Inscription et connexion gratuites ; inscription réservée aux 18+ déclarés, avec consentement explicite à la bêta.
- Profil : prénom, ville, bio, centres d'intérêt, intentions, avatar, question/réponse de personnalité.
- Découverte avec filtres par âge, ville et centres d'intérêt, tri par intérêts communs.
- Affichage en cartes à glisser sur mobile (droite : like, gauche : passer), flèches du clavier, boutons accessibles, grille alternative.
- Favoris, likes mutuels, messagerie entre personnes ayant matché, messages non lus.
- Suggestions de conversation, rendez-vous proposés entre matchs, blocage, signalement, désappariement.
- Paramètres de confidentialité, mode pause, partage de profil volontaire, export et suppression des données, changement de mot de passe.
- Thème clair ou sombre, fichier manifest PWA, service worker ne mettant jamais en cache les API, sessions ni conversations.
- Casting vidéo local de 15 secondes, avec aperçu, téléchargement et partage volontaire **sans envoi ni stockage serveur**.
- Vérifications automatisées GitHub : démarrage Node, API d'inscription/rencontres/chat, consentement, contenus statiques.

## Limites de cette bêta (à ne pas dissimuler)

1. **Base de données SQLite locale temporaire sur un service Render gratuit** : les comptes et les messages peuvent être perdus après redémarrage ou redéploiement. Aucun stockage permanent n'est garanti. Une instance PostgreSQL gratuite Render a été créée mais n'est pas encore reliée au serveur ; cette instance gratuite a une date d'expiration déclarée au 27 novembre 2026.
2. L'âge n'est vérifié que par la date de naissance déclarée. **Aucune vérification fiable d'identité / de majorité** n'est opérationnelle.
3. Les signalements sont enregistrés, mais aucun dispositif de modération humaine ni outil d'administration n'est encore opérationnel. Les photos et vidéos utilisateur ne sont **pas publiables** : il faut d'abord sécuriser le stockage et mettre en place la modération.
4. Les e-mails ne sont pas vérifiés et il n'y a pas de service de récupération du mot de passe.
5. Il s'agit d'un **site web installable sur les navigateurs compatibles**, pas d'une application native publiée dans les magasins d'applications.
6. La confidentialité dépend des comportements des utilisateurs et du respect de la réglementation, qui nécessitent un audit et des documents légaux adéquats avant un lancement commercial ou grand public.

Ce projet reste une expérimentation. Il n'a pas de fonction payante. Ne pas utiliser de données personnelles sensibles ni promouvoir la bêta en tant que service de rencontres pleinement sécurisé.

## Notes de sécurité

Le casting est réalisé avec MediaRecorder côté client, sur permission explicite du navigateur, et se termine au plus tard après 15 secondes. Aucun endpoint de publication multimédia n'est exposé.

Le service worker ne met en cache que des fichiers statiques publics et n'intercepte pas les endpoints /api ni les profils /p/. Les réponses API sont no-store et demandent une session HTTP-only.

Les fonctionnalités ajoutées ne résolvent pas les exigences restantes de vérification d'âge, de gouvernance de modération, de maintien de données, de sauvegardes et de conformité RGPD.
