# v0.5 — Vaisseaux et améliorations

Objectif : donner un but aux crédits gagnés en minant, en commerçant et en chassant les pirates. Le pilote améliore son vaisseau et peut en acheter un deuxième. Le pilotage, le combat, le HUD, l'économie, les comptes et le multijoueur des versions précédentes ne changent pas.

## Ce que voit le joueur

- **Onglet « Chantier »** dans l'écran de station, à côté du marché :
  - la fiche du vaisseau piloté (coque, bouclier, vitesse, dégâts par tir, soute, rendement de minage), améliorations comprises ;
  - le hangar : les vaisseaux possédés (« Piloter ») et ceux en vente (« Acheter ») ;
  - les six améliorations du vaisseau piloté, avec leur niveau et le prix du suivant.
- Un bouton estompé reste cliquable : la station explique alors le refus (crédits insuffisants, chantier ailleurs, soute trop pleine).
- Sur téléphone, l'onglet tient en paysage comme en portrait.

## Améliorations

Trois niveaux par emplacement. Elles s'installent dans les deux stations.

| Emplacement | Effet par niveau |
| --- | --- |
| Canons | +12 % de dégâts |
| Boucliers | +15 % de bouclier et de recharge |
| Blindage | +15 % de coque |
| Moteurs | +5 % de vitesse et de poussée (boost compris) |
| Soute | +25 % de capacité |
| Rayon de minage | +25 % de rendement |

Prix des niveaux 1, 2 et 3 : 500, 1 400 et 3 200 cr sur le Falcon, 20 % de plus sur le Warden. Un vaisseau entièrement amélioré coûte donc environ 30 000 cr : c'est un objectif de long terme. Ces valeurs sont un premier réglage, à revoir avec les retours de jeu.

Le nouveau blindage et les nouveaux boucliers sont posés intacts : la coque gagne les points ajoutés au lieu de paraître abîmée.

## Vaisseaux

| Vaisseau | Prix | Rôle |
| --- | --- | --- |
| Falcon Mk.II | offert | chasseur polyvalent, le vaisseau de départ |
| Warden | 2 000 cr, au chantier d'Aurora-7 | transporteur : soute de 60 au lieu de 40, plus lent et moins armé |

- On change de vaisseau à quai, dans n'importe quelle station. Chacun garde sa coque et ses améliorations.
- Le changement est refusé si la cargaison ne tient pas dans la soute du vaisseau choisi.
- À la mort, la cargaison est perdue, comme avant. Le vaisseau et ses améliorations reviennent intacts au hangar.

**Limite connue** : le Warden reprend le modèle 3D de l'escorte alliée qui existe depuis la v0.1. Ce n'est pas un nouveau modèle. Des modèles dédiés et d'autres vaisseaux viendront plus tard.

## Fonctionnement technique

- `src/shared/sim/upgrades.ts` : emplacements, prix, offre du chantier, et `statsOf(ship)`, qui donne les caractéristiques effectives (classe × améliorations, mises en cache).
  - Toute la simulation passe par là : physique, boucliers, tirs, minage, collisions et IA.
  - La prédiction du client utilise les mêmes valeurs, d'où un vaisseau amélioré qui vole pareil des deux côtés.
- `Ship.mods` : niveaux d'amélioration du vaisseau. Les PNJ n'en ont aucune.
- **Snapshot** : champ `u`, six chiffres (un par emplacement), absent pour un vaisseau sans amélioration. Coût réseau négligeable.
- **Protocole v5** : `buyShip { ship }`, `useShip { ship }` et `upgrade { slot }`.
  - Ils sont validés deux fois : par `validateClientMessage` (seuls les vaisseaux du chantier, jamais un vaisseau pirate), puis par le serveur (à quai, crédits, chantier, soute).
  - Le message `pilot` porte aussi le vaisseau piloté et la flotte. `capacity` et `hullMax` tiennent compte des améliorations.
  - Comme en v0.3 et v0.4, le site et le serveur Render doivent être mis à jour ensemble (Render suit `main`).
- **Sauvegarde** : `ship` (vaisseau piloté) et `fleet` (améliorations et coque de chaque vaisseau) sont ajoutés.
  - La version reste 1 et le champ `hull` garde la coque du vaisseau piloté. Un serveur v0.4 (retour en arrière d'urgence) relit donc encore les crédits, la soute, le score et la coque. Il perdrait en revanche la flotte en réécrivant la sauvegarde.
  - Une sauvegarde v0.4 (sans flotte) donne un pilote avec un seul Falcon.
  - `validateSave` ne garde que des vaisseaux vendus au chantier et des niveaux entre 0 et 3.
  - La soute est ramenée à la capacité du vaisseau piloté.

## Tests

- `tests/shipyard.test.ts` :
  - effets et prix des améliorations ;
  - effet réel sur la simulation (vitesse, coque) ;
  - snapshot `u` ;
  - achat, refus, changement de vaisseau, soute trop pleine ;
  - sauvegarde et retour du pilote ;
  - validation des messages.
- `tests/persistence.test.ts` : lecture des sauvegardes v0.4, flotte invalide, compatibilité avec un serveur v0.4.
- `tests/network.test.ts` : achat et amélioration par WebSocket ; un autre pilote voit le Warden et ses améliorations ; la flotte survit à un redémarrage du serveur.
- `scripts/ui-check.mjs` : onglet Chantier dans Chromium, amélioration, achat du Warden, décollage à son bord.

Les captures et mesures dans Chromium headless utilisent un rendu logiciel. Elles vérifient la mise en page et le fonctionnement, pas les performances réelles d'une carte graphique.
