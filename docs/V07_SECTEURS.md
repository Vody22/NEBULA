# v0.7 — Exploration : un deuxième secteur et le saut hyperspatial

Objectif : ouvrir l'univers au-delà d'Aurora. Un deuxième secteur, Kepler, à un saut hyperspatial, avec ses propres stations, son marché, sa ceinture et ses raids. Le pilotage, le combat, le HUD, l'économie, le chantier, les contrats, les comptes et le multijoueur des versions précédentes ne changent pas. Le secteur Aurora est identique à celui de la v0.6, astéroïde par astéroïde.

## Ce que voit le joueur

- **Le secteur Kepler** :
  - une étoile blanc-bleu et une nébuleuse dorée et sarcelle, d'autres étoiles dans le ciel ;
  - trois astres : la géante gazeuse Hespéra et ses anneaux, la planète rocheuse Cendre et sa lune de glace Opale ;
  - la **station Kepler-4**, de la même classe qu'Aurora-7 mais aux couleurs du secteur (plaques plus froides, lignes de signalisation sarcelle) ;
  - le **dépôt Vesta-2**, un dépôt de glace au bord de la ceinture, peint en bleu là où Ferro-9 est ocre ;
  - une ceinture plus dense (600 rochers au lieu de 520), dont deux sur cinq sont métalliques ;
  - des raids pirates un cran plus durs dès le premier.
- **Le saut** (`J`, ou le bouton **SAUT** sur écran tactile) :
  - sous le nom du secteur, une ligne dit si le saut est possible : « J saut hyperspatial vers Kepler », « à plus de 1,5 km des stations », ou le temps de recharge du réacteur (sur écran tactile, cette ligne est masquée faute de place : le bouton SAUT n'apparaît que quand le saut est possible) ;
  - pendant la charge (6 s), un compte à rebours au centre de l'écran, les bords de l'écran qui se resserrent en bleu, un sifflement qui monte et un bip de plus en plus rapide ;
  - au saut : un éclair blanc-bleu qui couvre le changement de secteur, puis l'arrivée face à la station du secteur, à 2,6 km ;
  - `J` à nouveau pendant la charge l'annule ;
  - les autres pilotes voient un éclair bleu et l'entendent là où un vaisseau part ou arrive.
- **La liste des pilotes** (`Tab`) indique le secteur de chacun. Le chat reste commun à tous les secteurs.

## Règles du saut (décidées par le serveur)

| Règle | Valeur |
| --- | --- |
| Charge | 6 s |
| Distance minimale de toute station du secteur | 1,5 km, pendant toute la charge |
| Énergie | 50 % du condensateur au départ et pendant toute la charge, consommés au saut |
| Combat PvP | pas de saut pendant les 15 s qui suivent un échange de tirs PvP |
| Recharge après une arrivée | 20 s |

- La charge s'annule si l'une de ces conditions cesse d'être remplie : retour près d'une station, énergie sous 50 % (tirer ou booster la vide), combat PvP, destruction du vaisseau. Le pilote est prévenu de la raison.
- Le vaisseau garde sa coque, ses boucliers, sa cargaison et ses contrats. Le saut prend 50 % du condensateur.
- Se déconnecter en vol dans le secteur Kepler ramène le pilote à quai à Kepler-4 à sa prochaine connexion (et à Aurora-7 dans le secteur Aurora), comme avant à la dernière station où il s'était amarré.

## Commerce et contrats entre secteurs

- **Marchés** :
  - Kepler-4 produit des pièces détachées et des médicaments, et paie cher les métaux, le platine surtout ;
  - Vesta-2 a de l'eau et du carbone en abondance, et manque de tout le reste.
  - Les meilleures marges demandent un saut : l'eau de Vesta-2 vers Ferro-9, les médicaments de Kepler-4 vers les dépôts, le minerai et le platine d'Aurora vers Kepler-4.
- **Platine** : 10 % du fer-nickel extrait dans la ceinture de Kepler sort en platine, contre 4 % à Aurora.
- **Livraisons** : environ un contrat de livraison sur trois va vers une station de l'autre secteur. Il est payé 1,8 fois plus, plus 150 cr. Le suivi en vol le signale : « Kepler-4, dans le secteur Kepler (saut hyperspatial) ».
- Les chasses comptent les pirates de tous les secteurs. Les contrats de minage se rapportent à la station qui les a posés.
- Les vaisseaux se vendent toujours au chantier d'Aurora-7 ; les améliorations s'installent dans les quatre stations.

## Fonctionnement technique

- `src/shared/sectors.ts` : les secteurs (`SectorId`), la station de chaque secteur, les noms des stations, les règles du saut, la graine de chaque secteur.
- `src/shared/sim/zone.ts` :
  - `buildSector(id, graine)` côté serveur et `zoneOf(id, graine du secteur)` côté client construisent la même zone ;
  - `buildKepler` décrit le nouveau secteur ;
  - la construction d'Aurora a été découpée en fonctions communes (station, ceinture, dégagement des approches, obstacles), et donne exactement la même zone qu'en v0.6 : 518 astéroïdes, 576 obstacles, mêmes positions (vérifié par un test) ;
  - chaque zone porte en plus sa palette de ciel (`sky`), son point d'arrivée (`jumpPoint`), son danger et sa part de platine.
- `GameServer` :
  - un `World` par secteur, tous avancés à chaque tick (leurs horloges restent égales) ;
  - chaque secteur a ses pilotes IA, son directeur de raids et sa table « vaisseau → session », car les numéros de vaisseaux ne sont uniques que dans un secteur ;
  - chaque session sait dans quel secteur elle est. Snapshots, événements et alertes de raid ne vont qu'aux pilotes du secteur ;
  - le chat, la liste des pilotes, les marchés et les tableaux de contrats sont communs au serveur ;
  - le saut retire le vaisseau d'un monde (événement `jumpOut`), prévient le client (message `sector`), puis le recrée au point d'arrivée de l'autre (`jumpIn`) ;
  - un secteur vidé de ses pilotes perd ses pirates, comme avant le secteur unique ;
  - `server.world` et `server.wave` désignent toujours Aurora, pour les outils et les tests existants.
- **Protocole v7** :
  - client vers serveur : `jump { to }` (`null` annule) ;
  - serveur vers client : `welcome` porte `sector`, nouveau message `sector { sector, zoneSeed }`, le snapshot porte `jump { to, left, cooldown }`, `players` porte le secteur de chaque pilote, événements `jumpOut` et `jumpIn` ;
  - le site et le serveur Render doivent être mis à jour ensemble (Render suit `main`). Un client v0.6 resté en cache reçoit « Version du jeu différente du serveur : rechargez la page ».
- **Client** :
  - au message `sector`, `Game` oublie tout ce qui vient de l'ancien secteur (vaisseaux, tirs, événements, prédiction), affiche l'éclair, puis construit le nouveau secteur à l'image suivante ;
  - l'ancien décor est libéré de la mémoire graphique (`disposeTree`). Le test de saut vérifie qu'elle ne grossit pas au fil des allers-retours ;
  - `Sky.ts` reçoit la palette du secteur, `Station.ts` et `Outpost.ts` sa livrée.
- **Son** : `Hyperdrive.ts` pour la charge, recettes `jump_out` et `jump_in`, annonces « Réacteur hyperspatial en charge » et « Saut terminé ». Ces sons existent parce que le saut existe maintenant dans le jeu.
- **Sauvegarde** : aucun nouveau champ. `station` peut valoir `kepler` ou `vesta`.
  - Une sauvegarde v0.6 se charge normalement, dans le secteur Aurora.
  - Un serveur v0.6 (retour en arrière d'urgence) ne connaît pas ces stations. Il remet le pilote à Aurora-7 et ignore les contrats vers Kepler. Crédits, soute, flotte et score sont gardés. Les stocks de Kepler-4 et Vesta-2 sont ignorés, puis retrouvés au retour de la v0.7.

## Tests

- `tests/sectors.test.ts` (13 tests) :
  - Kepler construit à l'identique, stations et point d'arrivée dégagés, Aurora inchangée ;
  - marchés et routes commerciales ;
  - saut : refus près d'une station, charge, arrivée avec la coque, la soute et les contrats, énergie consommée ;
  - annulations (touche, retour près d'une station, énergie), refus en PvP et pendant la recharge, pas de saut pour un vaisseau détruit ;
  - isolation des secteurs (vaisseaux, tirs), chat et liste des pilotes communs ;
  - raids seulement là où il y a des pilotes, plus durs à Kepler ;
  - amarrage et commerce à Kepler-4, retour à Kepler-4 après un redémarrage ;
  - livraison payée dans l'autre secteur, offres de Kepler vers Aurora ;
  - protocole v7 et sauvegardes.
- `scripts/jump-check.mjs` (navigateur, solo) : indications du HUD, charge, arrivée, écran de station de Kepler-4, retour, mémoire graphique sur trois allers-retours, bouton SAUT sur écran tactile, aucune erreur.
- Scène 12 du laboratoire audio : la charge, le saut, l'arrivée, puis un vaisseau qui arrive à côté.

## Limites

- Deux secteurs, toujours sur le même processus serveur : la limite de 30 pilotes vaut pour l'ensemble.
- Pas encore de carte de la galaxie : avec deux secteurs, `J` mène toujours à l'autre.
- Kepler-4 reprend le modèle d'Aurora-7 et Vesta-2 celui de Ferro-9, avec une autre livrée : de nouveaux modèles viendront plus tard.
