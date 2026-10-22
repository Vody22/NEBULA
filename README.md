# NEBULA FRONTIER

MMO spatial 3D dans le navigateur (Three.js + TypeScript + Vite).
Version actuelle : **v0.1, prototype de pilotage et de combat**, jouable en solo avec une architecture prête pour le multijoueur.

![Station Aurora-7](docs/img/station.png)

## Lancer le jeu

```bash
npm install
npm run dev        # http://localhost:5173
```

Options d'URL : `?q=low` (qualité réduite pour les petites configurations), `?name=Pseudo`, `?autostart`.

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
| `Échap` | Pause : reprendre, commandes, options et son |

Toutes les touches se réaffectent dans **Échap → Commandes** (affichage AZERTY ou QWERTY au choix). Les réglages (touches, volume, sensibilité, inversion verticale) sont enregistrés dans le navigateur. Le jeu demande un clavier et une souris : il n'existe pas encore de commandes tactiles.

Le tir consomme l'énergie du condensateur. Elle ne se recharge que 0,6 s après le dernier tir et hors boost ; si elle tombe à zéro, les armes restent hors ligne jusqu'à 30 % (« ARMES EN RECHARGE »).

## Architecture

```
src/
  shared/          Code commun client + futur serveur (aucun DOM, aucun rendu)
    sim/           World (simulation autoritaire à 60 Hz), physique, combat, IA, zone
    net/protocol   Messages client/serveur, snapshots, validation des entrées
  server/          GameServer : sessions, IA, vagues, réapparitions (indépendant du transport)
  client/
    net/           Transport (frontière réseau), LocalTransport, interpolation des snapshots
    render/        Ciel, planètes, astéroïdes, station, vaisseaux, lasers, effets, post-traitement
    hud/ input/ camera/ audio/
tests/             Tests Vitest de la simulation et du serveur
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
npm test            # tests : physique, combat, énergie, vagues, réglages, serveur
npm run build       # build de production
npm run preview &   # puis :
npm run smoke       # lance le jeu dans Chromium headless, pilote, tire et fait des captures
npm run ui-check    # HUD à 3 tailles, menu pause, réaffectation, réglages, tirs F/clic
```

Pour `npm run smoke`, définir `CHROMIUM_PATH` si Chromium n'est pas trouvé automatiquement.

## Feuille de route

- **v0.2 : multijoueur** — serveur Node + WebSocket, plusieurs joueurs dans le même secteur, prédiction côté client et réconciliation.
- Ensuite : persistance (comptes, vaisseaux, crédits), minage, commerce et économie, missions, factions, nouveaux secteurs et sauts, version PC installable.
