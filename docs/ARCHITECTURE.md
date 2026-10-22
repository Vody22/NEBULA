# Architecture technique

## Vue d'ensemble

```
 Joueur ──► InputManager ──► ShipInput ──► Transport ──► GameServer ──► World.step() (60 Hz)
                                              ▲                 │
                                              │   snapshots + événements
 Écran ◄── Rendu (Three.js) ◄── SnapshotBuffer ◄────────────────┘
```

## Simulation (`src/shared/sim`)

- `World` : entités (vaisseaux, projectiles), pas de temps fixe `TICK_DT = 1/60`, collisions (grille spatiale pour les obstacles statiques), dégâts bouclier puis coque, file d'événements (`shot`, `hit`, `impact`, `collision`, `destroyed`, `spawned`).
- `shipPhysics` : fonction pure `(état, entrée, dt) → état`. Assistance de vol = les propulseurs poursuivent une vitesse cible avec une autorité limitée par axe, d'où la dérive en virage. Mode newtonien = accélération pure.
- `AIPilot` : produit un `ShipInput` par tick, exactement comme un joueur. Les PNJ passent donc par les mêmes règles que les humains.
- `zone` : génération déterministe du secteur à partir d'une graine.

Conventions : mètres, secondes, axe avant = −Z, haut = +Y, droite = +X.

## Serveur (`src/server/GameServer.ts`)

Possède le `World`, les sessions joueurs, les pilotes IA, le directeur de vagues et les réapparitions. Il ne connaît que l'interface `ClientLink { send(msg) }`, ce qui le rend indépendant du transport : la même classe tourne dans la page en solo (`LocalTransport`) et dans Node en ligne.

- **Sessions** : identifiant `p<n>` et jeton secret. Si la connexion tombe, le vaisseau coupe ses moteurs ; la session attend `reconnectGrace` secondes. Avec le même jeton, le joueur retrouve son vaisseau et son score. Sinon, la session et le vaisseau disparaissent, sans vaisseau fantôme.
- **Entrées** : file par joueur, avec une entrée appliquée par tick. Cette régularité permet au client de rejouer exactement les mêmes pas. Les entrées en retard, dupliquées ou en excès sont ignorées.
- **Règles** : `canDamage` (types partagés) dit qui peut toucher qui. Les PNJ de factions différentes se combattent. Deux joueurs ne se blessent que si tous deux ont activé le PvP. Le PvP ne se coupe ni pendant 15 s après un échange de tirs, ni moins de 5 s après le dernier changement. Une élimination PvP ne rapporte pas de crédits, pour éviter qu'on « farme » entre amis.
- **Chat** : historique des 30 derniers messages, 5 messages par 10 s, répétitions ignorées. Les connexions et déconnexions s'affichent comme messages système.
- **Vagues** : leur taille augmente avec le nombre de pilotes connectés, dans une limite fixée. Le secteur est remis à zéro quand le dernier pilote part.

## Serveur Node (`src/server/node`)

- `server.ts` : HTTP (`/health`, `/status`, client statique facultatif) et WebSocket `/ws` (bibliothèque `ws`).
  - Contrôle d'origine, taille maximale des messages et débit limité par connexion.
  - Heartbeat pour détecter les connexions mortes.
  - Compression permessage-deflate des gros messages.
  - Boucle à pas fixe de 60 Hz. Les messages d'un client sont regroupés en une trame par snapshot (20 Hz).
  - Un client trop lent saute des snapshots au lieu d'accumuler du retard.
- `main.ts` : configuration par variables d'environnement (voir [DEPLOIEMENT.md](DEPLOIEMENT.md)).

## Protocole (`src/shared/net/protocol.ts`, version 2)

- Client → serveur : `hello { version, name, token? }`, `input { seq, input }`, `chat`, `pvp`, `ping`. Chaque message est validé par `validateClientMessage` ; le reste est rejeté et compté.
- Serveur → client : `welcome` (session, jeton, graine, reprise), `snapshot` (tous les vaisseaux, dernière entrée appliquée `ackSeq`), `events`, `notice`, `chat`, `chatHistory`, `players`, `pong`, `error`.
- Les lasers sont balistiques : un seul événement `shot` (position, vitesse, durée de vie) suffit au client pour les dessiner, sans trafic par tick.

## Client (`src/client`)

- `Transport` : `LocalTransport` (solo, serveur dans la page) ou `WebSocketTransport` (en ligne).
  - Le transport en ligne regroupe les envois en une trame par image.
  - Il mesure la latence par ping.
  - Il se reconnecte avec un délai croissant et reprend la session grâce au jeton.
  - Il peut simuler de la latence (`?lag=120&jitter=20`).
- `Predictor` : le vaisseau du joueur est simulé tout de suite, avec la même physique et les mêmes collisions que le serveur. À chaque snapshot, on repart de l'état serveur et on rejoue les entrées non encore acquittées. Les petits écarts sont lissés à l'écran au lieu de faire « sauter » le vaisseau.
- `SnapshotBuffer` affiche les autres vaisseaux légèrement dans le passé et interpole entre deux snapshots : 1,5 tick en solo, 110 ms en ligne pour 20 Hz plus la gigue. Les événements sont joués quand l'horloge de rendu atteint leur tick. Les tirs du joueur partent de la position prédite de son vaisseau.
- Le rendu n'a aucun état autoritaire : on peut le remplacer ou le faire tourner dans une application de bureau (Electron ou Tauri) sans toucher à la simulation.

## Limites connues (v0.2)

- Pas de compensation de latence pour les tirs : on vise des cibles affichées environ 100 ms dans le passé. Avec l'indicateur de tir anticipé, l'effet est faible à 20 Hz, mais il est réel au-delà de 150 ms de ping.
- Un processus = un secteur, et l'état vit en mémoire : un redémarrage du serveur remet le secteur à zéro. Comptes et persistance viendront ensuite.
