# CRUSHCAST V7 — likes gratuits et confidentialité

Cette version reste **100 % gratuite pour les utilisateurs** et n'ajoute aucune monétisation.

## Nouveautés réalisées
- **Qui m'a liké ?** : onglet gratuit affichant les profils ayant déjà envoyé un like, tant qu'ils ne sont ni bloqués, ni masqués et que le like n'est pas réciproque.
- Possibilité de liker en retour pour créer immédiatement un match.
- **Centre de confidentialité** : historique personnel des signalements et indication transparente de l'absence actuelle de modération humaine opérationnelle.
- **Déconnexion des autres sessions** depuis le compte, sans déconnecter l'appareil actuel.
- **Revoir les profils passés**, depuis la page de découverte.
- Déduplication des signalements identiques envoyés en moins de 24 heures.
- Tests automatiques ajoutés pour les likes reçus, le passage à un match réciproque, les signalements et les sessions.

## Limites et risques non résolus
1. Le site utilise **SQLite sur un disque temporaire Render Free**. Les comptes, conversations et signalements peuvent être perdus après un redémarrage ou déploiement. Il ne faut pas faire croire à une base durable.
2. Aucun véritable service de modération humaine n'est en place : le bouton Signaler crée seulement un enregistrement. En cas de danger, bloquer la personne et contacter les autorités concernées.
3. La majorité est déclarée, pas vérifiée par un moyen fiable ; l'e-mail n'est pas vérifié.
4. Les vidéos sont exclusivement locales à l'appareil, sans téléversement public non modéré. Les photos de profil réelles ne sont pas supportées.
5. La base PostgreSQL expérimentale déjà provisionnée sur Render n'a pas été reliée au serveur, et sa formule gratuite a une date d'expiration affichée au 27 novembre 2026.
6. Aucun audit RGPD/sécurité externe ni test visuel complet sur tous les navigateurs n'a été effectué.

## Déploiement
Branche de production CRUSHCAST : `crushcast-launch`. Branche principale de NEBULA : `main` inchangée.

Adresse de test : https://crushcast-gratuit-beta.onrender.com
