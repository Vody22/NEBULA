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

Possède le `World`, les sessions joueurs, les pilotes IA, le directeur de vagues et les réapparitions. Il ne connaît que l'interface `ClientLink { send(msg) }`, ce qui le rend indépendant du transport.

Les entrées clients sont validées et bornées (`sanitizeInput`), et les paquets en retard ou dupliqués sont ignorés grâce au numéro de séquence.

## Protocole (`src/shared/net/protocol.ts`)

- Client → serveur : `hello`, `input { seq, input }`.
- Serveur → client : `welcome`, `snapshot` (état de tous les vaisseaux + accusé de la dernière entrée), `events`, `notice`.
- Les lasers sont balistiques : un seul événement `shot` (position, vitesse, durée de vie) suffit au client pour les dessiner, sans trafic par tick.

## Client (`src/client`)

- `SnapshotBuffer` affiche le monde légèrement dans le passé (1,5 tick en local) et interpole entre deux snapshots. Les événements sont joués quand l'horloge de rendu atteint leur tick, ce qui garde lasers, impacts et explosions synchronisés avec les vaisseaux.
- Le rendu n'a aucun état autoritaire : on peut le remplacer ou le faire tourner dans une application de bureau (Electron ou Tauri) sans toucher à la simulation.

## Passage au multijoueur (v0.2)

1. `server/main.ts` (Node) : `GameServer` + serveur WebSocket, une `ClientLink` par connexion, envoi des snapshots toutes les 3 ticks (20 Hz).
2. `client/net/WebSocketTransport.ts` qui implémente `Transport`.
3. Prédiction du vaisseau local avec `stepShipPhysics` et réconciliation à partir de `ackSeq`.
4. Encodage binaire des snapshots et filtrage par distance (intérêt) quand le nombre de joueurs augmente.
