# NEBULA FRONTIER

MMO spatial 3D dans le navigateur (Three.js + TypeScript + Vite).
Version actuelle : **v0.2, multijoueur en ligne** : plusieurs pilotes dans le même secteur, en temps réel, avec un serveur Node.js autoritaire. Le mode solo hors ligne reste disponible.

![Station Aurora-7](docs/img/station.png)

## Lancer le jeu

```bash
npm install
npm run server     # serveur multijoueur sur http://localhost:8080 (sert aussi le client s'il est construit)
npm run dev        # client de développement sur http://localhost:5173 (se connecte au serveur :8080)
```

Pour jouer à plusieurs en local : `npm run build && npm run server`, puis ouvrir http://localhost:8080 dans deux onglets ou sur deux ordinateurs du même réseau (`http://<ip-de-la-machine>:8080`).

Options d'URL :
- `?q=low` : qualité réduite pour les petites configurations.
- `?server=wss://…` : autre serveur.
- `?lag=120&jitter=20` : latence simulée en millisecondes.
- `?autostart` : démarrage direct en solo.

Mise en ligne : voir [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md). Le client reste sur Vercel, et le serveur WebSocket va sur Render, Fly.io ou un VPS.

## Multijoueur (v0.2)

- **Connexion** : choix d'un pseudo, « Jouer en ligne » ou « Solo hors ligne ». Le menu indique si le serveur répond et combien de pilotes sont connectés.
- **Synchronisation** : positions, rotations, vitesses, poussée et boost, tirs, boucliers, coque, dégâts, destructions, réapparitions et PNJ. Tout est calculé par le serveur.
  - Le vaisseau du joueur est prédit localement, puis réconcilié avec le serveur.
  - Les autres vaisseaux sont interpolés.
- **Coopération** : les joueurs combattent ensemble les mêmes pirates. Les vagues grossissent avec le nombre de pilotes.
- **PvP volontaire** (`P`) : deux pilotes ne peuvent s'affronter que si tous deux l'ont activé. Une élimination PvP ne rapporte pas de crédits.
- **Chat du secteur** :
  - `Entrée` pour écrire, `H` pour masquer ou afficher.
  - Historique récent et protection contre le spam.
  - La souris continue de piloter pendant la saisie.
- **Interface** : état de la connexion, nombre de pilotes, latence, pseudo, noms au-dessus des vaisseaux, liste des pilotes (`Tab`), messages d'arrivée et de départ.
- **Déconnexions** : le vaisseau d'un pilote déconnecté coupe ses moteurs, puis disparaît après 20 s. En revenant dans ce délai (même onglet, ou rechargement de la page), on retrouve son vaisseau et son score.

## Contenu de la v0.1

- **Secteur Aurora** : ciel de nébuleuse procédural (cubemap calculée au démarrage, sert aussi de reflets), soleil avec lens flare, géante gazeuse annelée, planète océanique, lune glacée, ceinture de plus de 500 astéroïdes, nuages de poussière.
- **Station Aurora-7** : un kilomètre d'envergure, anneau d'habitation rotatif, épine centrale, hangar d'appontage balisé, panneaux solaires, balises clignotantes, navettes en circulation.
- **Vaisseaux** : Falcon Mk.II (joueur), Warden (escorte alliée), Raider et Marauder (pirates), entièrement modélisés en procédural avec réacteurs animés, feux de navigation et bulle de bouclier qui réagit aux impacts.
- **Pilotage** : physique newtonienne avec assistance de vol (dérive et inertie visibles), mode newtonien pur (`Z`), boost qui consomme l'énergie, translations latérales et verticales, roulis, joystick virtuel à la souris.
- **Combat** : lasers balistiques, boucliers qui se régénèrent après un délai, coque, collisions, indicateur de tir anticipé, verrouillage de cible, vagues de pirates de plus en plus dures, ailiers IA, réapparition à la station, primes en crédits.
- **IA** : poursuite avec visée anticipée imparfaite, manœuvres d'évitement, choix de cible, évitement des obstacles.
- **Effets** : bloom HDR, explosions (boule de feu, étincelles, onde de choc, débris, fumée), traînées, poussière spatiale qui donne la sensation de vitesse, tremblements de caméra, aberration chromatique.
- **HUD** : vitesse, poussée, assistance, boucliers, coque, énergie, radar 3D, marqueurs, cible avec barres de vie, flèche hors écran, notifications.
- **Son** : effets synthétisés en WebAudio (aucun fichier audio).

![Combat](docs/img/combat.png)

## Commandes

Les touches correspondent à des positions physiques : sur un clavier AZERTY, `W/A/S/D` se jouent avec `Z/Q/S/D`, et `Q/E` avec `A/E`. Le menu du jeu affiche automatiquement les bonnes lettres dans Chrome et Edge.

| Touche | Action |
| --- | --- |
| Souris | Piloter (joystick virtuel) |
| Clic gauche / `F` | Tirer |
| `W` / `S`, molette | Poussée + / − |
| `A` / `D` | Translation latérale |
| `Espace` / `C` | Translation verticale |
| `Q` / `E` | Roulis |
| `Maj` | Boost |
| `X` | Couper les gaz |
| `Z` | Assistance de vol on/off |
| `T` | Cible suivante |
| `V` | Caméra (poursuite, proche, cinématique) |
| Flèches | Tangage / lacet au clavier |
| `M` | Couper le son |
| `Entrée` / `H` | Chat : écrire / masquer (en ligne) |
| `P` | PvP on/off (en ligne) |
| `Tab` (maintenir) | Liste des pilotes |
| `Échap` | Pause : reprendre, commandes, options et son |

Toutes les touches se réaffectent dans **Échap → Commandes** (affichage AZERTY ou QWERTY au choix). Les réglages (touches, volume, sensibilité, inversion verticale) sont enregistrés dans le navigateur. Le jeu demande un clavier et une souris : il n'existe pas encore de commandes tactiles.

Le tir consomme l'énergie du condensateur. Elle ne se recharge que 0,6 s après le dernier tir et hors boost ; si elle tombe à zéro, les armes restent hors ligne jusqu'à 30 % (« ARMES EN RECHARGE »).

## Architecture

```
src/
  shared/          Code commun client + futur serveur (aucun DOM, aucun rendu)
    sim/           World (simulation autoritaire à 60 Hz), physique, combat, IA, zone
    net/protocol   Messages client/serveur, snapshots, validation des entrées
  server/          GameServer : sessions, IA, vagues, réapparitions, chat, PvP (indépendant du transport)
    node/          Serveur Node.js : HTTP + WebSocket /ws, configuration par variables d'environnement
  client/
    net/           Transport (frontière réseau), LocalTransport (solo), WebSocketTransport (en ligne), prédiction, interpolation
    ui/            Menu (pseudo, en ligne / solo, pause, commandes, options), chat
    render/        Ciel, planètes, astéroïdes, station, vaisseaux, lasers, effets, post-traitement
    hud/ input/ camera/ audio/
tests/             Tests Vitest : simulation, serveur, réseau (vrais WebSockets), prédiction
scripts/           Tests de bout en bout dans Chromium (WebGL logiciel)
```

Principes, détaillés dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) :

1. **Le serveur fait autorité.** Le client n'envoie que des entrées (`ShipInput`) ; toute la physique, les tirs et les dégâts sont calculés par `World`.
2. **Même code partout.** `src/shared` tourne tel quel dans Node : le futur serveur multijoueur réutilisera `GameServer` derrière un transport WebSocket.
3. **Frontière réseau explicite.** Le client ne parle qu'à une interface `Transport`. Aujourd'hui `LocalTransport` exécute le serveur dans la page ; demain un `WebSocketTransport` le remplacera sans toucher au reste du jeu.
4. **Monde déterministe.** La zone (astéroïdes, planètes, station) est générée à partir d'une graine : le serveur et chaque client construisent exactement le même univers.

## Vérification

```bash
npm run typecheck   # TypeScript strict
npm test            # tests : physique, combat, énergie, vagues, réglages, serveur, réseau, prédiction
npm run build       # build de production
npm run preview &   # puis :
npm run smoke       # lance le jeu dans Chromium headless, pilote, tire et fait des captures
npm run ui-check    # HUD à 3 tailles, menu pause, réaffectation, réglages, tirs F/clic (solo)
node scripts/mp-check.mjs    # 3 navigateurs sur le vrai serveur : synchro, chat, combat commun, PvP, latence, reconnexion
node scripts/load-test.mjs 30 30   # 30 pilotes robots pendant 30 s : coût du tick et bande passante
```

Pour `npm run smoke`, définir `CHROMIUM_PATH` si Chromium n'est pas trouvé automatiquement.

## Feuille de route

- **v0.2 : multijoueur** (cette version).
- Ensuite : persistance (comptes, vaisseaux, crédits), minage, commerce et économie, missions, factions, nouveaux secteurs et sauts, version PC installable.
