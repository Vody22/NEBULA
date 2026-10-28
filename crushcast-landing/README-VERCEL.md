# CRUSHCAST — publication sur Vercel

Ce dossier contient la page de **pré-lancement publique** de CRUSHCAST, et non l'application de rencontre complète.

## Publication Vercel

Branche GitHub : `crushcast-launch`
Dossier racine Vercel : `crushcast-landing`
Framework preset : **Other**
Build command : aucun (site HTML statique)
Output directory : `.`

Attention : si le projet Vercel utilise la branche de production `main` de NEBULA, il publiera le mauvais projet. Dans **Project Settings > Environments > Production > Branch Tracking**, sélectionner `crushcast-launch`. Le projet NEBULA existant doit rester indépendant.

La configuration `vercel.json` de ce dossier fixe le framework statique, le dossier de sortie et des en-têtes de sécurité de base.

## État fonctionnel

- Page de présentation, responsive et sans formulaire collectant des données.
- **Aucun serveur de rencontres, aucune inscription, aucun chat ou paiement** sur ce site statique.
- La vraie application V3 doit être auditée, reliée à une base persistante et protégée avant de pouvoir ouvrir aux utilisateurs.

## Vérification après déploiement

1. Le déploiement doit afficher le statut Ready.
2. L'URL publique doit afficher la page CRUSHCAST et non le site NEBULA.
3. Vérifier sur mobile et desktop, ainsi que les erreurs de console.
4. Ne pas ouvrir un formulaire d'inscription tant que le contrôle de majorité, le signalement, la modération et la protection des données ne sont pas opérationnels.
