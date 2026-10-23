# Système audio

Objectif : un son qui suit réellement le jeu, et pas une boucle de fond. Tout est synthétisé dans le navigateur (Web Audio API). **Aucun fichier audio n'est utilisé ni référencé.** Le pilotage, le combat, le HUD, le réseau et les performances ne changent pas.

## Ce que le joueur entend

| Système | Ce qui se passe | Relié à |
| --- | --- | --- |
| **Moteur du vaisseau** | 8 couches : vibration de coque, grave, cœur du réacteur, sifflement des pompes, souffle de la tuyère, brûleur du boost, propulseurs de manœuvre, cliquetis de la coque abîmée. Démarrage au décollage et à la réapparition, extinction à l'amarrage et à la destruction. Le moteur s'étouffe en boost quand l'énergie est vide. | poussée, vitesse, boost, translation et rotation demandées, énergie, coque, mode de caméra |
| **Autres vaisseaux** | Les 4 moteurs les plus proches (à moins de 650 m) sont rendus, placés en stéréo. Les autres sont virtuels : aucun nœud audio. | position, poussée et boost de chaque vaisseau |
| **Armes** | Un son de laser par classe (Falcon, Warden, Raider, Marauder). Nos tirs sont entendus « à travers la coque », pleins et centrés. Ceux des autres sont placés en 3D et atténués avec la distance. | événement `shot` du serveur |
| **Impacts** | Bouclier touché, coque touchée (plus lourd quand c'est la nôtre), marqueur de coup au but, collision. | événements `hit` et `collision` |
| **Boucliers et armes** | Effondrement, rétablissement, armes verrouillées faute d'énergie, armes prêtes. | état du vaisseau à chaque image |
| **Explosions** | Trois tailles selon la classe (Raider, Falcon/Warden, Marauder), et la destruction de notre vaisseau. Une explosion proche fait baisser un instant le reste du mixage. | événement `destroyed` |
| **Ambiances** | Espace profond presque silencieux (le système de vie du cockpit, et de rares parasites de la nébuleuse sur les capteurs). Crépitement de micro-débris près des astéroïdes, selon la vitesse. Machinerie et trafic radio près des stations. Hangar réverbérant avec claquements, annonces et radio. Pings de contact quand des hostiles sont à portée des capteurs, plus rapides quand ils approchent. Bip d'alerte de proximité près d'un rocher à vive allure. | distance des stations et des astéroïdes, vitesse, hostiles, amarrage |
| **Musique adaptative** | Générée en direct, jamais en boucle : nappes, basse, arpèges, percussions. 7 ambiances : calme (à quai et au menu), exploration, tension (hostiles à portée), combat, boss (Marauder proche), danger (coque < 30 %), victoire (après un vrai combat), puis retour au calme. Les changements tombent sur la mesure ; un combat démarre sur le temps suivant, avec un accent. Des mesures de silence sont laissées exprès. | hostiles proches et lointains, tirs et dégâts récents, coque, amarrage |
| **Interface** | Clic, onglet, confirmation, refus, notification, verrouillage de cible, message radio, contrat, réparation, amélioration, achat. Les sons de résultat suivent la réponse du serveur, pas le clic. | boutons, réponses du serveur (`pilot`, `notice`, `chat`) |
| **Annonces de bord** | Boucliers faibles, boucliers hors service, boucliers rétablis, coque endommagée, coque critique, énergie insuffisante, armes prêtes, cible détruite, amarrage confirmé, contrat rempli, obstacle à proximité. Chaque annonce a un bip selon son urgence et son texte dans le HUD. Elle peut aussi être lue à voix haute (voir plus bas). | franchissement de seuils, jamais à chaque image |

### La logique du vide

Dans l'espace, le son ne se propage pas. Hors du hangar, tout ce que le pilote entend est donc ce que son vaisseau perçoit et lui restitue :

- **ses propres systèmes**, transmis par la coque ;
- **le rendu de ses capteurs** pour le reste. Un événement lointain est plus faible et plus sourd (sa bande passante se rétrécit), et il se tait au-delà de la portée.
- Une station ou une planète entre le pilote et la source étouffe le son (occlusion).
- **À l'intérieur du hangar**, l'air porte le son : réverbération d'un grand hall métallique, avec une transition progressive à l'amarrage et au décollage.

### Caméras

- Vue proche : on entend davantage le cockpit (grave et vibrations) et moins le souffle extérieur.
- Vue cinématique : un son plus large et plus distant.

## Réglages

Échap → **Options et son** :

- **Volume** général, et **Couper le son** (aussi la touche `M`).
- **Musique**, **Effets** (moteurs, armes, explosions), **Ambiances**, **Interface**, **Annonces et radio** : un curseur pour chaque groupe.
- **Annonces de bord parlées** : désactivé par défaut. Les annonces sont alors lues par la voix de synthèse du navigateur. Sa qualité dépend du système : ce n'est pas une voix de studio.

Les réglages sont enregistrés dans le navigateur. Les anciens réglages se chargent normalement : les nouveaux curseurs prennent alors leur valeur par défaut.

## Comportement du navigateur

- Les navigateurs ne laissent démarrer le son qu'après un geste de l'utilisateur. Le premier clic ou la première touche le débloque, et la musique calme commence dès le menu titre.
- **Pause** (Échap) : le monde se tait, la musique baisse, l'interface reste audible.
- **Onglet caché** : le contexte audio est suspendu (aucun son, aucun calcul), puis repris au retour.
- **Fenêtre au second plan** : volume réduit de moitié.

## Architecture

```
src/client/audio/
  mix.ts          logique pure, testée : bus, niveaux, courbe des capteurs, limiteur de voix,
                  directeur musical, moniteur d'alertes et textes des annonces
  recipes.ts      recettes des sons ponctuels, rendues une fois au démarrage (OfflineAudioContext)
                  en plusieurs variantes, puis normalisées
  AudioEngine.ts  contexte, bus, groupes, limiteur, réverbération, voix ponctuelles en 3D, LoopVoice
  EngineSound.ts  moteur du joueur (couches) et moteurs des autres vaisseaux (virtualisés)
  Ambience.ts     ambiances par environnement
  Music.ts        partition générative programmée en avance
  Announcer.ts    annonces de bord : bip, texte, voix de synthèse ou enregistrement
  Audio.ts        façade utilisée par Game.ts : frame(état) et événements de jeu
```

Chaîne de mixage :

```
sources → bus (musique, moteurs, armes, impacts, explosions, ambiance, interface, voix, radio)
        → groupe (atténuation temporaire · pause) → volume général → limiteur → analyseur → sortie
groupes monde, ambiance et voix ──envoi──→ réverbération du hangar ──→ volume général
```

- Le groupe des effets passe par un compresseur de liaison léger. La sortie a un limiteur de sécurité.
- **Atténuations temporaires** :
  - une explosion proche baisse les autres effets ;
  - notre destruction baisse les effets et la musique ;
  - un coup reçu sur la coque baisse un instant la musique ;
  - une annonce baisse la musique et les ambiances.
- **Voix** : 40 au maximum, avec une limite par catégorie (12 tirs, 10 impacts, 6 explosions…).
  - Un son plus important (proche, ou de notre vaisseau) prend la place du moins important, qui s'éteint en 30 ms.
  - Un son moins important que tous ceux en cours n'est pas joué.
- **Spatialisation** :
  - HRTF (binaural) pour les 6 sources importantes les plus proches, à moins de 350 m ;
  - panoramique stéréo borné à ±75 % pour les autres ;
  - l'atténuation selon la distance est calculée par le jeu (`sensorCurve`).
- **Sans clic** : chaque changement de gain est une rampe, chaque voix volée s'éteint en fondu, et les boucles sont fondues sur elles-mêmes.
- **Sans fuite** : chaque voix se déconnecte à sa fin, et les compteurs `started` et `ended` sont vérifiés par les tests.
- **Sans bloquer le rendu** :
  - les sons sont rendus un par un, en rendant la main entre chacun ;
  - la musique est écrite 0,4 s à l'avance par sa propre minuterie, même quand les images sont lentes.

### Brancher des enregistrements plus tard

`Announcer.ts` contient une table `RECORDED_LINES`, vide aujourd'hui. Pour une annonce enregistrée :

1. placer le fichier dans `public/audio/voice/` ;
2. ajouter son chemin dans la table, par exemple `shieldsLow: 'audio/voice/shields_low.ogg'`.

L'enregistrement remplace alors la voix de synthèse pour cette annonce. Les autres sons peuvent suivre le même principe : une recette remplacée par un fichier décodé dans la même banque.

## Ce qui n'existe pas encore dans le jeu

Ces sons ne sont pas branchés, car le gameplay correspondant n'existe pas encore. Les simuler serait un faux effet.

- **Missiles** : lancement, verrouillage, alerte « missile verrouillé », impact.
- **Armes balistiques** (canons).
- **Hyperpropulsion** et saut : charge, saut, arrivée.
- **Surchauffe** du réacteur : il n'y a pas de chaleur dans la simulation. L'étouffement en boost à énergie vide est le seul état critique du moteur.
- **Surcharge et défaillance** de bouclier au-delà de l'effondrement et du rétablissement actuels.

L'architecture est prête pour eux : une recette dans `recipes.ts`, un appel dans `Audio.ts`, et une ligne dans `ALERT_LINES` pour l'annonce.

## Enregistrements à produire (pour aller plus loin que le procédural)

La synthèse couvre les effets, les ambiances et la musique. Pour un rendu de niveau studio, voici ce qui gagnerait à être enregistré ou composé :

1. **Voix de l'ordinateur de bord** : les 11 annonces actuelles, en français (et en anglais plus tard), par un comédien, en OGG mono 48 kHz.
2. **Bande originale** : des thèmes composés par ambiance (exploration, combat, boss, victoire), en couches séparées (stems) pour garder le mixage adaptatif.
3. **Communications radio** : de vraies répliques du contrôle de station et des pirates. Le bruit radio actuel est volontairement inintelligible.
4. **Foley du hangar** : machines, portes, bras robotisés, en variantes.

## Tests

- `tests/audio-mix.test.ts` (12 tests) :
  - routage et nettoyage des niveaux, et anciens réglages lisibles ;
  - courbe des capteurs ;
  - limiteur de voix (plafond, vol, oubli) ;
  - directeur musical (exploration → tension → combat → victoire → exploration, boss, danger, à quai) ;
  - moniteur d'alertes (seuils, temps de recharge) ;
  - recettes bornées.
- `scripts/audio-check.mjs` : le jeu construit, dans Chromium, 22 contrôles.
  - Démarrage : son muet avant un geste, puis lancé au premier clic ; musique au menu ; banque rendue.
  - Moteur : plus fort avec la poussée ; boost qui monte puis retombe ; vues des caméras.
  - Combat : nos tirs entendus, musique de combat, voix plafonnées, explosion entendue.
  - Station : réverbération du hangar à l'amarrage puis au décollage, clic d'onglet.
  - Navigateur : pause, onglet caché, perte de focus, touche `M`.
  - Session longue (90 s de combats) : voix et nœuds bornés, pas de fuite, pas de saturation, pas d'erreur.
- `audio-lab.html` (serveur de développement `npx vite` uniquement, non publié) : 11 scènes jouées par le vrai moteur sans le rendu 3D.
  - `scripts/audio-lab-export.mjs` les enregistre en WAV et mesure leur crête et leur niveau.

Ces tests mesurent le signal ; ils ne remplacent pas une écoute. Chromium headless utilise une sortie audio virtuelle, et le rendu y est logiciel : les mesures de fluidité ne valent pas pour une vraie carte graphique.
