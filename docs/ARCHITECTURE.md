# Architecture technique

## Vue d'ensemble

```
 Joueur ──► InputManager ──► ShipInput ──► Transport ──► GameServer ──► World.step() (60 Hz)
                                              ▲                 │
                                              │   snapshots + événements
 Écran ◄── Rendu (Three.js) ◄── SnapshotBuffer ◄────────────────┘
```

## Simulation (`src/shared/sim`)

- `World` : entités (vaisseaux, projectiles, objets libres), pas de temps fixe `TICK_DT = 1/60`, collisions, dégâts bouclier puis coque puis partie touchée, file d'événements (`shot`, `hit`, `impact`, `collision`, `partDamaged`, `bodyHit`, `bodyBroken`, `bodyGone`, `destroyed`, `spawned`).
- `shipPhysics` : fonction pure `(état, entrée, dt) → état`. Assistance de vol = les propulseurs poursuivent une vitesse cible avec une autorité limitée par axe, d'où la dérive en virage. Mode newtonien = accélération pure.
- `AIPilot` : produit un `ShipInput` par tick, exactement comme un joueur. Les PNJ passent donc par les mêmes règles que les humains.
- `zone` : génération déterministe de chaque secteur à partir d'une graine (`buildSector`, `zoneOf`), Aurora et Kepler depuis la v0.7.
- `upgrades` (v0.5) : niveaux d'amélioration par vaisseau (`Ship.mods`), prix, offre du chantier. Toute la simulation lit les caractéristiques par `statsOf(ship)` (classe × améliorations, mises en cache), jamais directement `SHIP_CLASSES`, pour que le serveur et la prédiction du client volent le même vaisseau.

Conventions : mètres, secondes, axe avant = −Z, haut = +Y, droite = +X.

## Physique des collisions (`src/shared/physics`, v0.8)

- `shapes.ts` : le décor en fonctions de distance signée (sphère, boîte, capsule, cylindre, tore, rocher), orientables et tournantes. Une seule fonction répond au contact, à la profondeur, à la normale et au balayage continu (lancer de sphère), si bien qu'un vaisseau rapide ne traverse pas un mur mince.
- `structures.ts` : les formes des stations, aux cotes de leurs modèles 3D. `rocks.ts` : la forme des astéroïdes, la même pour le rendu et pour la physique.
- `hitboxes.ts` : chaque vaisseau est un groupe de sphères, chacune liée à une partie (cockpit, structure, ailes, moteurs), avec sa masse et son inertie. `bodies.ts` : les objets libres (caisses, conteneurs, épaves, rochers).
- `collide.ts` : balayage d'un solide contre le décor ou d'une paire de solides en mouvement relatif, puis impulsion au point de contact (rebond et frottement selon `materials.ts`), qui peut faire tourner le solide.
- `damage.ts` : dégâts au carré de la variation de vitesse, usure de la partie touchée et ses effets en vol, les mêmes sur le serveur et dans la prédiction.
- `World` trouve les paires vaisseau-vaisseau, vaisseau-objet et objet-objet par une grille de hachage des volumes balayés. Les vaisseaux loin de tout pilote n'ont qu'une sphère, et les objets libres loin de tout pilote sont gelés. Détails : [V08_COLLISIONS.md](V08_COLLISIONS.md).

## Serveur (`src/server/GameServer.ts`)

Possède un `World` par secteur (v0.7), les sessions joueurs, les pilotes IA, le directeur des raids pirates de chaque secteur et les réapparitions. Il ne connaît que l'interface `ClientLink { send(msg) }`, ce qui le rend indépendant du transport : la même classe tourne dans la page en solo (`LocalTransport`) et dans Node en ligne.

- **Sessions** : identifiant `p<n>`, liées à un compte pilote en ligne (`PilotProfile.accountId`). Si la connexion tombe, le vaisseau coupe ses moteurs ; la session attend `reconnectGrace` secondes. Le même compte qui revient dans ce délai retrouve son vaisseau et son score, et une deuxième fenêtre reprend la session de la première. Sinon, la session et le vaisseau disparaissent, sans vaisseau fantôme.
- **Progression (v0.4)** : `connect()` reçoit la sauvegarde du pilote (brute, revalidée par `validateSave`) et le place à quai dans sa dernière station. Le serveur signale chaque changement par `onSave` (au plus une fois par tick, `final` quand la session se termine) sans savoir où elle est stockée : base de données en ligne, `localStorage` en solo. `persistAll()` sert à l'arrêt, `exportSector()` et `importSector()` aux stocks des stations, `dropAccount()` à fermer une session reprise par un autre serveur.
- **Entrées** : file par joueur, avec une entrée appliquée par tick. Cette régularité permet au client de rejouer exactement les mêmes pas. Les entrées en retard, dupliquées ou en excès sont ignorées.
- **Règles** : `canDamage` (types partagés) dit qui peut toucher qui. Les PNJ de factions différentes se combattent. Deux joueurs ne se blessent que si tous deux ont activé le PvP. Le PvP ne se coupe ni pendant 15 s après un échange de tirs, ni moins de 5 s après le dernier changement. Une élimination PvP ne rapporte pas de crédits, pour éviter qu'on « farme » entre amis.
- **Chat** : historique des 30 derniers messages, 5 messages par 10 s, répétitions ignorées. Les connexions et déconnexions s'affichent comme messages système.
- **Économie (v0.3)** : chaque session a des crédits (500 au départ) et une soute. Le serveur tient un marché par station (`src/shared/economy`). Amarrage, commerce, réparation et minage sont décidés par lui seul : à quai, le vaisseau quitte le `World` et son état est gardé dans la session. Le minage est une commande tenue (`ShipInput.mine`) ; le `World` accumule la progression sur l'astéroïde visé et le serveur convertit les unités entières en cargaison. Détails : [V03_ECONOMIE.md](V03_ECONOMIE.md).
- **Flotte (v0.5)** : la session garde le vaisseau piloté (`ship`) et la flotte possédée (`fleet` : améliorations et coque de chaque vaisseau). Achat, changement de vaisseau et améliorations se font à quai, validés par le serveur (crédits, chantier d'Aurora-7, soute qui doit tenir dans le nouveau vaisseau). Détails : [V05_VAISSEAUX.md](V05_VAISSEAUX.md).
- **Contrats (v0.6)** : un tableau par station (`boards`), partagé par les pilotes, et la liste des contrats de chaque session. Le serveur décide de l'acceptation, de la progression (minerai extrait, pirates abattus) et du paiement ; les caisses de livraison prennent de la place en soute. Détails : [V06_MISSIONS.md](V06_MISSIONS.md).
- **Raids pirates** : après un raid repoussé, le secteur reste calme 45 à 90 s. La taille d'un raid dépend surtout du nombre de pilotes connectés dans le secteur, dans une limite fixée, et du danger du secteur (Kepler commence un cran plus haut). Un secteur est remis à zéro quand son dernier pilote part.
- **Secteurs (v0.7)** : tous les mondes avancent à chaque tick. Chaque session sait dans quel secteur elle est ; snapshots et événements ne vont qu'aux pilotes du secteur, le chat et la liste des pilotes sont communs. Le saut hyperspatial (`jump`) se charge 6 s puis déplace le vaisseau d'un monde à l'autre. Détails : [V07_SECTEURS.md](V07_SECTEURS.md).

## Serveur Node (`src/server/node`)

- `server.ts` : HTTP (`/health`, `/status`, `POST /logout`, client statique facultatif) et WebSocket `/ws` (bibliothèque `ws`).
  - Contrôle d'origine, taille maximale des messages et débit limité par connexion.
  - Heartbeat pour détecter les connexions mortes.
  - Compression permessage-deflate des gros messages.
  - Boucle à pas fixe de 60 Hz. Les messages d'un client sont regroupés en une trame par snapshot (20 Hz).
  - Un client trop lent saute des snapshots au lieu d'accumuler du retard.
- `main.ts` : configuration par variables d'environnement (voir [DEPLOIEMENT.md](DEPLOIEMENT.md)). À l'arrêt (`SIGTERM`), toute la progression est écrite avant la fermeture des connexions.

## Comptes (`src/server/accounts`, v0.4)

- `AccountService` : inscription, connexion par mot de passe ou par jeton, limites anti-abus, écriture de la progression par lots, génération des pilotes. La progression d'un pilote qui revient avant son écriture lui est rendue depuis la mémoire.
- `passwords.ts` : scrypt (paramètres rangés dans chaque empreinte), jetons de 256 bits stockés sous forme d'empreinte SHA-256.
- `store.ts` : l'interface `AccountStore` et `MemoryStore` (tests, serveur local sans base) ; `PostgresStore.ts` : PostgreSQL (Neon), tables `nf_*` créées et migrées au démarrage.
- Règles partagées avec le menu : `src/shared/accounts.ts` (pseudos, mots de passe) et `src/shared/save.ts` (format et validation des sauvegardes). Détails : [V04_PERSISTANCE.md](V04_PERSISTANCE.md).

## Protocole (`src/shared/net/protocol.ts`, version 8)

- Client → serveur : `hello { version, auth }` (inscription, connexion ou jeton, depuis la v4), `input { seq, input }`, `chat`, `pvp`, `ping`, et depuis la v3 `dock`, `undock`, `trade { item, qty }` (positif = achat, négatif = vente), `repair`, et depuis la v5 `buyShip { ship }`, `useShip { ship }`, `upgrade { slot }`, depuis la v6 `mission { op, id }`, et depuis la v7 `jump { to }` (`null` annule la charge). Chaque message est validé par `validateClientMessage` ; le reste est rejeté et compté.
- Serveur → client : `welcome` (session, graine, reprise), `account` (pseudo et jeton de connexion, depuis la v4), `snapshot` (tous les vaisseaux, dernière entrée appliquée `ackSeq` ; `m` = astéroïde miné ; `u` = niveaux d'amélioration, six chiffres, depuis la v5), `events`, `notice`, `chat`, `chatHistory`, `players`, `pong`, `error` (`code: 'auth'` et une raison pour un refus de connexion), et depuis la v3 `pilot` (crédits, soute, station, coque à quai ; vaisseau piloté et flotte depuis la v5 ; contrats et places réservées depuis la v6) et `board` (contrats proposés par la station, depuis la v6) à chaque changement et `market` (prix et stocks) une fois par seconde à quai. Depuis la v7 : `welcome` et le nouveau message `sector` donnent le secteur et la graine de sa zone, le snapshot porte l'état du réacteur hyperspatial (`jump`), `players` le secteur de chaque pilote, et les événements `jumpOut` et `jumpIn` montrent les sauts des autres. Depuis la v8 : le snapshot porte l'état des parties de chaque vaisseau (`d`), sa rotation libre (`s`) et les objets libres qui ont bougé (`b`, la liste complète `bf` pour un nouveau pilote et toutes les 2 s) ; événements `collision` détaillés (partie, matériau, normale, vitesse, bouclier, autre vaisseau ou objet), `partDamaged`, `bodyHit`, `bodyBroken`, `bodyGone`.
- Un client et un serveur de versions différentes refusent de jouer ensemble avec un message clair : le site et le serveur Render se mettent à jour en même temps.
- Les lasers sont balistiques : un seul événement `shot` (position, vitesse, durée de vie) suffit au client pour les dessiner, sans trafic par tick.

## Client (`src/client`)

- `Transport` : `LocalTransport` (solo, serveur dans la page) ou `WebSocketTransport` (en ligne).
  - Le transport en ligne regroupe les envois en une trame par image.
  - Il mesure la latence par ping.
  - Il se reconnecte avec un délai croissant et reprend la session grâce au jeton de connexion du compte.
- `account.ts` : ce que le navigateur garde (pseudo et jeton de connexion, jamais le mot de passe ; progression solo), protégé contre un stockage plein ou bloqué. En solo, `LocalTransport` écrit la progression au plus toutes les 1,5 s et quand la page se ferme.
  - Il peut simuler de la latence (`?lag=120&jitter=20`).
- `Predictor` : le vaisseau du joueur est simulé tout de suite, avec la même physique et les mêmes collisions que le serveur (décor et objets au repos ; depuis la v8, à l'heure du serveur, pour les rochers qui tournent). À chaque snapshot, on repart de l'état serveur et on rejoue les entrées non encore acquittées. Les petits écarts sont lissés à l'écran au lieu de faire « sauter » le vaisseau.
- `SnapshotBuffer` affiche les autres vaisseaux légèrement dans le passé et interpole entre deux snapshots : 1,5 tick en solo, 110 ms en ligne pour 20 Hz plus la gigue. Les événements sont joués quand l'horloge de rendu atteint leur tick. Les tirs du joueur partent de la position prédite de son vaisseau.
- `audio/` : le son, entièrement procédural (Web Audio). `Game.ts` donne à `GameAudio` l'état de chaque image et les événements de jeu. Le son ne lit que ce que le client affiche déjà, sans rien envoyer au serveur. Détails dans [AUDIO.md](AUDIO.md).
- Le rendu n'a aucun état autoritaire : on peut le remplacer ou le faire tourner dans une application de bureau (Electron ou Tauri) sans toucher à la simulation.

## Limites connues (v0.4)

- Pas de compensation de latence pour les tirs : on vise des cibles affichées environ 100 ms dans le passé. Avec l'indicateur de tir anticipé, l'effet est faible à 20 Hz, mais il est réel au-delà de 150 ms de ping.
- Un processus = tous les secteurs (deux en v0.7), 30 pilotes au total. La progression des pilotes et les stocks des stations survivent à un redémarrage, mais pas les positions en vol, les PNJ ni les raids en cours.
- Pas de récupération de mot de passe (pas d'e-mail) ; limites anti-abus en mémoire, par serveur.
