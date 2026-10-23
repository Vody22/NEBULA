# v0.3 — Amarrage, minage et commerce

Objectif : donner au joueur une boucle économique simple et lisible, en plus du combat. Il gagne des crédits en minant des astéroïdes, en transportant des marchandises entre deux stations ou en chassant les pirates. Il les dépense en réparations et en marchandises. Tout est décidé par le serveur, comme le combat. Le pilotage, le combat, le HUD de vol et le multijoueur de la v0.2 ne changent pas.

## Boucle de jeu

1. Le joueur apparaît en vol près d'Aurora-7, comme aujourd'hui.
2. Il va miner dans la ceinture : il vise un astéroïde à moins de 300 m et tient la touche de minage. Le minerai remplit sa soute.
3. Il s'amarre à une station. Il entre lentement dans la zone d'amarrage, devant le hangar, puis appuie sur la touche d'amarrage. Le vaisseau est alors à l'abri : il quitte l'espace et ne peut plus être touché.
4. À quai, il vend son minerai, achète des marchandises, répare sa coque, puis décolle.
5. Les deux stations n'achètent ni ne vendent aux mêmes prix : transporter des marchandises de l'une à l'autre rapporte, mais la traversée passe près de la zone des pirates.

## Stations

| Station | Rôle | Vend bon marché | Achète cher |
| --- | --- | --- | --- |
| Aurora-7 (existante) | Plaque tournante de l'Union | Rations, eau, pièces détachées, médicaments | Minerais |
| Dépôt Ferro-9 (nouveau, au bord de la ceinture, ~7 km) | Avant-poste minier | Minerais (production des foreuses automatiques) | Rations, eau, pièces, médicaments |

## Marchandises

| Marchandise | Type | Prix de base | Origine |
| --- | --- | --- | --- |
| Carbone | minerai | 9 cr | astéroïdes carbonés |
| Régolithe | minerai | 6 cr | agglomérats |
| Silicates | minerai | 14 cr | astéroïdes silicatés |
| Fer-nickel | minerai | 24 cr | astéroïdes métalliques |
| Platine | minerai rare | 140 cr | astéroïdes métalliques (rarement) |
| Rations | marchandise | 18 cr | Aurora-7 |
| Eau | marchandise | 12 cr | Aurora-7 |
| Pièces détachées | marchandise | 45 cr | Aurora-7 |
| Médicaments | marchandise | 80 cr | Aurora-7 |

- **Prix dynamiques :** chaque station a un stock et un stock d'équilibre par marchandise. Le prix monte quand le stock baisse et baisse quand il monte, entre 0,5 et 1,6 fois le prix de base. La station vend 8 % au-dessus du prix et achète 8 % en dessous. Vendre une grosse cargaison fait donc baisser le prix ; le stock revient lentement vers l'équilibre (production et consommation de la station).
- **Soute :** capacité par classe (Falcon Mk.II : 40 unités). Les crédits et la cargaison appartiennent à la session du joueur.
- **Mort :** la cargaison est perdue, pas les crédits. Le joueur réapparaît en vol comme aujourd'hui.
- **Réparation :** 2 cr par point de coque, uniquement à quai.

## Minage

- Rayon de minage : 300 m de portée, tiré droit devant depuis le nez. Il fonctionne seulement sous 60 m/s et pas pendant un tir.
- Rendement : environ 0,6 unité par seconde, multiplié par la richesse de l'astéroïde (de 0,6 à 1,5 selon l'astéroïde, toujours la même). La taille ne compte pas.
- Le type de minerai dépend de la famille de l'astéroïde, déjà partagée avec le serveur (variante 0 à 3). Le platine tombe parfois dans les astéroïdes métalliques.
- Les astéroïdes ne s'épuisent pas dans cette version : ce sont des obstacles fixes et partagés. Le rythme est limité par le rendement et la soute.
- Les autres joueurs voient le rayon : l'instantané indique l'astéroïde visé.

## Amarrage

- Zone d'amarrage : sphère autour de l'entrée du hangar (Aurora-7 : 220 m, entrée à z ≈ 334 m ; Ferro-9 : 170 m, hangar tourné vers Aurora-7). Condition : vitesse inférieure à 50 m/s et aucun combat PvP depuis 15 s.
- À quai, le vaisseau est retiré de l'espace et son état est conservé (coque, bouclier, énergie). Au décollage, il réapparaît devant le hangar, nez vers l'extérieur, à 30 m/s.
- Une déconnexion à quai garde le joueur à quai.

## Protocole (version 3)

- `ShipInput.mine` : le minage est une commande tenue, comme le tir.
- Client vers serveur : `dock`, `undock`, `trade { item, qty }` (positif = achat, négatif = vente), `repair`.
- Serveur vers client : `pilot { credits, cargo, capacity, docked, hull, hullMax }` à chaque changement, et `market { station, items }` à quai (prix, stock), une fois par seconde.
- `ShipSnapshot.m` : l'astéroïde miné, absent sinon.
- Un client v0.2 reçoit une erreur de version claire. Le serveur Render et le site doivent être mis à jour ensemble.

## Limites assumées de la v0.3

- Pas de persistance : crédits et cargaison durent tant que le serveur tourne. Un compte persistant demande une base de données (v0.4).
- Pas de largage de cargaison à la mort, pas d'achat de vaisseaux ni d'améliorations (v0.4).
- Les murs du hangar ne sont pas des obstacles physiques ; seule l'entrée sert à s'amarrer.

## Étapes

1. Cœur économique partagé (marchandises, soute, marchés, prix) avec tests unitaires.
2. Amarrage à Aurora-7 : zone, demande, état à quai, écran de station (réparation, marché, décollage), guidage dans le HUD.
3. Minage : simulation, rayon visible, soute dans le HUD.
4. Dépôt Ferro-9 : zone, modèle, marché : la boucle de commerce est complète.
5. Tests de bout en bout (interface, partie, téléphone, multijoueur), commandes tactiles, documentation, publication avec le serveur.

## Journal

- **Étape 1** (commit 279d0fe) : marchandises, soute, marchés et prix partagés ; 10 tests.
- **Étape 2, serveur** (3c57a2e) : amarrage, décollage, réparation, commerce et minage décidés par le serveur, protocole v3.
- **Étapes 2 et 3, client** (b46df6d) : écran de station (crédits, soute, réparation, marché par 1, 10 ou max, décollage), vue du vaisseau sur son aire dans le hangar, guidage d'approche (touche G), jauge de soute, rayon de minage visible pour tous (touche R ou clic droit) avec étincelles et son, infos sous le réticule (minerai, richesse, distance, raison d'un rayon inactif), boutons tactiles MINER et S'AMARRER. Les nouvelles touches ne prennent jamais une touche déjà utilisée par le joueur.
- **Étape 4** : Dépôt Ferro-9 à 7,6 km d'Aurora-7, au bord de la ceinture : modèle procédural (habitat, raffinerie, silos, bras de forage, petit hangar), collisions, astéroïdes écartés autour du dépôt et sur son couloir d'approche, marché déjà prévu côté serveur. L'écran de station rappelle le dernier prix vu à l'autre station.

Vérifié dans Chromium (rendu logiciel, donc sans valeur de performance) : approche et invite d'amarrage, amarrage, achat, vente, refus expliqués, décollage, minage jusqu'à la soute. Non vérifié : le ressenti sur un vrai GPU et sur téléphone, et une partie en ligne sur le serveur Render (il tourne encore en v2).
