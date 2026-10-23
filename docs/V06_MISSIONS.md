# v0.6 — Missions

Objectif : donner des objectifs au pilote en plus du commerce libre. Chaque station propose des contrats de livraison, de minage et de chasse aux pirates. Le pilotage, le combat, le HUD, l'économie, le chantier, les comptes et le multijoueur des versions précédentes ne changent pas.

## Ce que voit le joueur

- **Onglet « Missions »** dans l'écran de station, à côté du marché et du chantier :
  - les contrats en cours (3 au maximum), avec ce qu'il reste à faire et un bouton « Abandonner » ;
  - les contrats proposés par la station, avec leur récompense et un bouton « Accepter ».
- **Suivi en vol** : sous le nom du secteur, en haut à gauche, chaque contrat et son avancement. Sur téléphone et dans une petite fenêtre, seul le nombre de contrats en cours est affiché.
- Chaque étape est annoncée : contrat accepté, minerai réuni, contrat rempli avec la somme gagnée, contrat échoué.

## Les trois types de contrats

| Type | Ce qu'il faut faire | Récompense (premier réglage) |
| --- | --- | --- |
| Livraison | Porter 4 à 10 caisses à l'autre station. Les caisses prennent de la place en soute. | 120 cr + 45 cr par caisse (300 à 570 cr) |
| Minage | Extraire 6 à 15 unités d'un minerai (carbone, régolithe, silicates ou fer-nickel) et les rapporter à la station qui a posé le contrat. | environ 2 fois la valeur du minerai, plus 80 cr (160 à 870 cr) |
| Chasse | Abattre 2 à 5 pirates. | 220 cr par pirate, en plus des primes habituelles |

Règles :

- **Livraison** : payée dès l'amarrage à la station de destination. Si le vaisseau est détruit, les caisses sont perdues et le contrat échoue. Changer de vaisseau n'est possible que si les caisses et la cargaison tiennent dans la soute du nouveau.
- **Minage** : seul le minerai extrait après avoir accepté le contrat compte. Acheter du minerai au marché ne le remplit pas. Le minerai doit être en soute à l'amarrage, sinon la station dit combien il en manque. Si le vaisseau est détruit, le compte repart de zéro, car le minerai est perdu.
- **Chasse** : seuls les pirates comptent, pas les autres pilotes en PvP. Le contrat est payé dès le dernier pirate abattu, sans revenir à quai.
- Un contrat peut être abandonné partout, sans pénalité.

## Les tableaux des stations

- Chaque station propose 4 contrats. Un tableau neuf contient toujours au moins une livraison, un minage et une chasse.
- **En ligne, le tableau est commun à tous les pilotes** : un contrat pris disparaît pour les autres et est remplacé 30 s plus tard.
- Tous les tableaux sont renouvelés toutes les 10 minutes.

## Fonctionnement technique

- `src/shared/missions.ts` : types de contrats, création des offres, textes, et validation des contrats lus dans une sauvegarde (`cleanMissions`).
- `GameServer` :
  - tient les tableaux des stations et la liste des contrats de chaque session ;
  - décide seul de l'acceptation, de la progression et du paiement ;
  - compte les caisses comme de la place prise en soute (`holdSpace`), pour le marché, le minage et le changement de vaisseau ;
  - compte le minerai extrait dans `collectOre` et les pirates abattus dans le traitement des destructions.
- **Protocole v6** :
  - client vers serveur : `mission { op: 'accept' | 'abandon', id }`, validé par `validateClientMessage` ;
  - serveur vers client : `board { station, offers }` à l'amarrage et à chaque changement du tableau ;
  - le message `pilot` porte en plus `missions` et `reserved` (places prises par les caisses).
  - Le site et le serveur Render doivent être mis à jour ensemble (Render suit `main`).
- **Sauvegarde** : le champ `missions` est ajouté, sans changer la version. Les numéros des contrats sont réattribués au chargement.
  - Une sauvegarde v0.5 (sans contrat) se charge normalement.
  - Un serveur v0.5 (retour en arrière d'urgence) lit encore la sauvegarde et ignore les contrats. Les caisses en cours seraient alors perdues, mais les crédits, la soute, la flotte et le score sont gardés.
- Les tableaux ne sont pas sauvegardés : un redémarrage du serveur en crée de nouveaux.

## Tests

- `tests/missions.test.ts` :
  - offres variées et bornées ;
  - tableau commun et remplacement ;
  - limite de 3 contrats et abandon ;
  - livraison payée, soute réservée, échec à la mort ;
  - minage qui ignore le minerai acheté ;
  - chasse payée au dernier pirate ;
  - sauvegarde et nettoyage des contrats ;
  - validation des messages.
- `scripts/ui-check.mjs` : dans Chromium, accepter une livraison à Aurora-7, la voir dans le HUD en vol, se faire payer à Ferro-9.

Les captures et mesures dans Chromium headless utilisent un rendu logiciel. Elles vérifient la mise en page et le fonctionnement, pas les performances réelles d'une carte graphique.
