# CRUSHCAST V9 — Conversations plus pratiques et confidentialité

CRUSHCAST conserve sa promesse de rencontres, likes, matchs et messages **gratuits**.

## Améliorations déployables

- Recherche **locale dans les 100 derniers messages chargés** d'une conversation. Aucun moteur de recherche tiers ni index supplémentaire.
- Affichage des dates et heures dans les bulles de conversation.
- Copier un message via une action explicite.
- Supprimer **ses propres messages uniquement**. Le serveur vérifie l'auteur, le match et l'absence de blocage avant de supprimer. La suppression concerne le stockage et la conversation ; elle ne peut pas effacer les copies ou captures déjà réalisées par l'autre personne.
- Émojis rapides : ils sont insérés dans la zone de saisie mais ne sont jamais envoyés automatiquement.
- Export des données personnelles plus complet, incluant les messages envoyés **et reçus** dans les matchs encore actifs.
- Tests d'intégration vérifiant l'autorisation de suppression, l'interdiction d'effacer un message d'autrui et le contenu de l'export.
- Cache PWA versionné V9 pour diffuser les nouveautés.

## Restrictions toujours présentes

Il s'agit encore d'une **bêta expérimentale**. La base SQLite est stockée temporairement sur Render Free ; les comptes et conversations peuvent disparaître après redémarrage ou déploiement. Le PostgreSQL gratuit précédemment provisionné (expiration le 27 novembre 2026) n'est pas connecté à CRUSHCAST. Il n'existe toujours pas de vérification forte de majorité, de vérification d'e-mail ni de véritable modération humaine. Les castings vidéos restent locaux à l'appareil sans publication automatique.

La suppression de message et le blocage sont des protections partielles, pas un système complet de lutte contre le harcèlement.

Site : https://crushcast-gratuit-beta.onrender.com
Branche dédiée : `crushcast-launch` ; NEBULA `main` inchangée.
