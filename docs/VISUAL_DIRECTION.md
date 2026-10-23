# NEBULA FRONTIER — Direction artistique « Cinematic Realism »

Document de référence pour l'identité visuelle du jeu, l'audit du rendu actuel et le plan de la refonte graphique **v0.2.5**.

- **Statut :** v1, 22/10/2026.
- **Branche de travail :** `v0.2.5-graphics`, créée à partir de `v0.2-multiplayer`.
- **Règle absolue :** l'ambition graphique ne doit jamais empêcher le jeu de fonctionner. Le pilotage, le HUD, les combats, le réseau et le mode solo passent avant tout effet visuel.

Les captures citées (`before/…`) sont dans [`docs/visual/before/`](visual/before/) (copies JPEG). Elles sont produites par `node scripts/visual-capture.mjs before`, avec les mêmes caméras à chaque passage pour permettre des comparaisons avant/après. Ce sont des rendus logiciels (SwiftShader) : ils montrent l'image, pas les performances.

---

## 1. Intention

Un univers **crédible, immense et habité**.

- **Star Citizen** pour la crédibilité mécanique : chaque objet a l'air fabriqué, entretenu et utilisé.
- **Interstellar et Star Wars** pour l'échelle et la lumière : de grands volumes sombres percés par une source dominante, des silhouettes nettes.
- **No Man's Sky** pour la variété : chaque système a sa palette et son humeur.

Ce sont des références d'ambiance et d'exigence, pas des modèles à copier. Aucun vaisseau, texture, logo ou forme reconnaissable de ces œuvres n'est reproduit.

### Les cinq piliers

| Pilier | Ce que cela veut dire concrètement |
| --- | --- |
| **Échelle** | Un objet d'un kilomètre doit le paraître : détails répétés à plusieurs tailles, feux de position minuscules, brume de profondeur, trafic. |
| **La lumière raconte** | Une étoile dominante par système, des ombres franches et un noir profond. La lumière émise (fenêtres, réacteurs, armes) signale une activité, jamais une décoration. |
| **Matière honnête** | Le métal se comporte comme du métal et la peinture comme de la peinture. L'usure se concentre là où le vaisseau travaille : bords, trappes, tuyères. |
| **Lisibilité d'abord** | Le joueur distingue toujours ami, ennemi, cible et danger. Aucun effet ne masque une cible plus d'une fraction de seconde. |
| **Identité propre** | Un langage de formes et de couleurs reconnaissable, partagé par les vaisseaux, les stations et l'interface. |

---

## 2. Palette officielle

Les couleurs ont un sens. Une couleur hors de son rôle est une erreur.

| Rôle | Nom | Hex | Usage |
| --- | --- | --- | --- |
| Fond | Bleu spatial profond | `#06101c` | Ciel lointain, ombres colorées |
| Fond | Noir bleuté | `#02060b` | Zones sombres de nébuleuse, menus |
| Énergie | Cyan énergétique | `#5fe3ff` | Technologie, boucliers, interface, réacteurs de l'Union |
| Lumière | Blanc stellaire | `#f4f1ea` | Étoiles, éclats, coque claire |
| Structure | Gris titane | `#8d949c` | Coques, stations |
| Industrie | Orange industriel | `#e8792b` | Propulsion lourde, zones de chargement, Marauders |
| Signal | Ambre | `#ffb547` | Fenêtres habitées, avertissements, balisage civil |
| Nébuleuse | Violet nébulaire | `#6b3fa0` | Gaz lointain uniquement, jamais sur une surface éclairée |
| Danger | Rouge d'alerte | `#ff4a3d` | Ennemis, dégâts critiques, alarmes |
| Navigation | Vert doux | `#59e3a2` | Alliés, feux de position tribord, systèmes au vert |

**Règles de dosage**

- 70 % de l'image dans les noirs bleutés et les gris, 25 % dans les tons de la scène (nébuleuse, planète), 5 % d'accents lumineux.
- La saturation forte est réservée aux sources de lumière et aux signaux. Une surface éclairée par l'étoile reste peu saturée.
- Le violet ne colore jamais les ombres des objets proches. Aujourd'hui, la lumière d'ambiance violette les « lave » (voir l'audit).

### Signatures de faction

| Faction | Formes | Matières | Lumières |
| --- | --- | --- | --- |
| **Union d'Aurora** (Falcon, Warden, station) | Lignes tendues, volumes symétriques, chanfreins à 45°, panneaux réguliers | Deux couleurs : ivoire et bleu (Falcon ivoire à bande marine, Warden bleu ardoise à bande ivoire), verre teinté | Feux réglementaires (rouge bâbord, vert tribord, blanc arrière, feux anticollision) ; réacteurs bleus (Falcon) et bleu-vert (Warden) |
| **Pillards** (Raider, Marauder) | Asymétrie, lames et éperons vers l'avant, pièces récupérées et rapportées, armement boulonné | Coques sombres en plaques dépareillées : rouge sang (Raider) ou acier (Marauder), apprêt, métal nu, rouille ; éperon et marques rouge sang | Ils volent tous feux éteints : petits feux rouges seulement, visières et hublots rouges ; réacteurs orange-rouge |

La simulation n'a que deux camps (`union` et `raiders`) : le Marauder appartient aux pillards et suit donc leur langage, au lieu de la troisième faction envisagée au départ.

---

## 3. Langage des vaisseaux

Un vaisseau est lu à trois distances. Chacune a ses propres exigences :

1. **Au-delà de 2 km :** la silhouette et la couleur des réacteurs suffisent à reconnaître la classe et la faction.
2. **De 200 m à 2 km :** les grandes masses (fuselage, ailes, nacelles) et les feux de position.
3. **À moins de 200 m, et dans le hangar :** les panneaux, les marquages, l'usure, le cockpit, les propulseurs de manœuvre (RCS), les radiateurs et les trains.

### Éléments obligatoires d'un vaisseau « fini »

- Une coque en plusieurs sections de blindage, avec des joints visibles par la géométrie, pas seulement par la texture.
- Une structure porteuse visible aux jonctions (bras de nacelle, longerons).
- Une tuyère principale en trois couches : carénage extérieur, anneau intérieur chaud et cône d'éjection.
- Des RCS aux quatre coins, qui s'allument pendant les manœuvres (le tangage, le lacet et le roulis viennent déjà de la simulation).
- Des radiateurs ou ailettes de refroidissement.
- Une antenne et un capteur.
- Des feux de position (bâbord rouge, tribord vert, blanc à l'arrière) et un feu anticollision clignotant.
- Un cockpit vitré avec un éclairage intérieur faible et une silhouette de siège.
- Des trains d'atterrissage repliés, avec leurs trappes visibles, pour les futurs amarrages.
- Des décalques : nom du modèle, constructeur fictif, numéro de série, flèches d'avertissement.
- Une usure procédurale : bords éclaircis, saleté dans les creux, traces de chaleur autour des tuyères.

### Constructeurs fictifs

Ils servent de base aux marquages et donnent une cohérence industrielle.

- **Aurora Fleetworks** (Union) : Falcon Mk.II, Warden.
- **Kessler Salvage Consortium** (Pillards) : Raider, construit à partir de coques civiles.
- **Ardent Heavy Industries** : Marauder, un cargo lourd militarisé ; ceux des pillards sont des coques volées, réarmées et repeintes.
- Les pillards effacent les immatriculations : leurs décalques disent `NO REGISTRY` et portent l'emblème de la griffe (trois entailles à travers un anneau brisé).

### Falcon Mk.II — le vaisseau emblème

Un chasseur polyvalent de 18 m, élégant et un peu agressif. On doit avoir envie de le piloter.

- **Silhouette :** nez long et effilé, cockpit en « bulle » reculé, ailes en flèche avec un pli. Deux grosses nacelles arrière, plus présentes qu'aujourd'hui, et des dérives canardées. L'empattement et les points d'emport ne changent pas : les canons restent à ±4,6 m, comme dans la simulation.
- **Peinture :** ivoire titane, dos gris anthracite, une bande bleu marine qui court du nez aux dérives, et un numéro de coque `FMK2-0147` sur les dérives.
- **Lumières :** réacteurs bleu-blanc avec des diamants de choc au boost, liseré cyan discret sous le cockpit, feux de position.
- **Lecture de loin :** deux points bleus jumelés (les réacteurs) et une forme en flèche.

---

## 4. Matériaux

Les matériaux suivent le flux PBR de Three.js (`MeshStandardMaterial` et `MeshPhysicalMaterial`).

| Matière | Couleur | Metalness | Roughness | Notes |
| --- | --- | --- | --- | --- |
| Peinture de coque | selon faction | 0,15–0,3 | 0,35–0,55 | Variation de rugosité par panneau (±0,08) |
| Métal nu (structure, tuyère) | `#7d838a` | 0,9–1 | 0,25–0,45 | Brunissement thermique près des tuyères |
| Métal sombre (fonctionnel) | `#2b2f35` | 0,6 | 0,5 | Grilles, prises d'air, radiateurs |
| Verre de cockpit | `#0a1620` | 0 | 0,05 | Clearcoat 1, reflet de l'environnement, légère teinte |
| Émissif (fenêtres, liserés) | ambre ou cyan | — | — | Intensité HDR de 2 à 6. Seuls les émissifs dépassent 1,0 et déclenchent le bloom |
| Roche | gris brun, désaturé | 0–0,1 | 0,85–0,95 | Détail par carte normale triplanaire, pas par couleur de sommet |
| Roche métallique | gris acier | 0,6 | 0,4 | Veines réfléchissantes : de futurs gisements pour le minage |

- **Cartes :** couleur, normale, ORM (occlusion, rugosité, métal) et émissif. Avec un atlas de détails (trim sheet) commun à une faction, un seul jeu de textures peut servir plusieurs vaisseaux.
- **Densité de texels :** environ 256 px/m sur les vaisseaux en Élevé et 128 px/m en Moyen. Le jeu actuel étire une texture de 1024 px sur toute la coque, ce qui produit le « bruit » visible dans `before/02-falcon-hero.jpg`.
- **Réflexions :** l'environnement PMREM précalculé à partir du ciel existe déjà (`Sky.ts`). Il faut le garder, mais avec une intensité calée par matériau.

---

## 5. Lumière et rendu

### Principes

1. **Une étoile, une lumière clé.** Le soleil du système éclaire avec un contraste fort. Le côté à l'ombre d'un objet doit être presque noir.
2. **Ambiance quasi nulle.** L'éclairage d'ambiance actuel (`HemisphereLight` violet à 0,6, plus une lumière de remplissage violette à 0,9) est remplacé par :
   - une réflexion d'environnement faible, qui donne les reflets colorés de la nébuleuse ;
   - un contre-jour léger venu de la nébuleuse.
3. **Exposition contrôlée :** tone mapping ACES (ou AgX après comparaison), avec une exposition fixe par système.
4. **Bloom maîtrisé :** seuil au-dessus de 1,0 en HDR, pour que seuls les émissifs, les réacteurs, les tirs et les explosions brillent. La force est divisée par environ deux par rapport à aujourd'hui.
5. **Effets de caméra mesurés :**
   - l'aberration chromatique n'apparaît que lors des dégâts ;
   - le grain reste à peine perceptible ;
   - le lens flare se limite à l'étoile, sans rangée de cercles ;
   - le vignettage est léger.
6. **Ombres ciblées :**
   - le vaisseau du joueur et les vaisseaux proches portent une ombre (une carte d'ombre serrée autour du joueur) ;
   - la station porte ses propres ombres en Élevé et Ultra ;
   - les anneaux de planète projettent leur ombre dans le shader de la planète (c'est déjà le cas des anneaux).
7. **Profondeur atmosphérique :** une très légère brume additive, teintée par la nébuleuse locale, sur les objets lointains (astéroïdes, station vue de loin). Elle donne l'échelle.

### Niveaux de qualité

Il y a aujourd'hui deux niveaux (`?q=low` et `high`). Il en faut quatre, réglables dans **Options**.

| | Bas | Moyen | Élevé | Ultra |
| --- | --- | --- | --- | --- |
| Résolution interne | 0,7 à 1× | 1× | 1× à 1,5× | 1,5× à 2× |
| Antialiasing | — | — (FXAA prévu) | MSAA 4× | MSAA 4× |
| Post-traitement (bloom, objectif) | non : rendu direct | oui | oui | oui |
| Ombres | non | joueur seulement | joueur + station | ombres 4K, filtrage doux |
| Textures | 512 | 1024 | 2048 | 2048 + détail de près |
| Ciel | cube 512 | 1024 | 1024 | 2048 (+ nuages de premier plan) |
| Particules | 35 % | 70 % | 100 % | 100 % + débris persistants |
| Astéroïdes | LOD bas | LOD standard | LOD élevé | LOD élevé, plus de petits cailloux |

**Cible :** 60 IPS en 1080p sur un PC de jeu intermédiaire au niveau Élevé, et 60 IPS en Moyen sur un portable à carte intégrée récente. Ces deux cibles doivent être mesurées sur du vrai matériel (voir §11).

---

## 6. Espace

### Nébuleuses

Aujourd'hui, un seul bruit marbré rose et cyan couvre tout le ciel avec la même densité. Le résultat est chargé, plat, sans régions sombres (`before/10-nebula-sky.jpg`).

Cible :

- **Trois échelles :**
  - de grandes masses de gaz lentes, sur 60 % du ciel ;
  - des filaments moyens ;
  - des détails fins près des étoiles brillantes.
- **Absorption :** des bandes de poussière sombre devant le gaz lumineux, comme dans les vraies nébuleuses. C'est ce qui crée la profondeur et le mystère.
- **Un cœur lumineux par système,** avec un dégradé chromatique naturel (cyan chaud vers magenta vers ambre) au lieu d'un mélange partout.
- **40 % du ciel en noir bleuté** presque vide, où les étoiles se lisent.
- **Premier plan (Élevé et Ultra) :** quelques nappes de gaz en volume (des sprites épais), traversables, qui donnent la parallaxe en vol.

### Étoiles

- Une couleur par type spectral (bleu-blanc, blanc, jaune, orange, rouge) et une magnitude variable.
- Un scintillement statique de quelques pixels, pas un halo flou.
- L'étoile du système : un disque saturé au blanc, une couronne fine et une seule aigrette discrète.

### Planètes

- **Terminateur net :** le côté nuit est noir, avec seulement les lumières de villes sur les mondes habités. Aujourd'hui, Thalassa est éclairée presque uniformément (`before/09-thalassa-nyx.jpg`).
- **Atmosphère :** une diffusion approchée (Rayleigh) avec un halo fin côté jour, plus large au limbe, et un liseré rougeâtre au terminateur.
- **Nuages :** une sphère séparée, légèrement plus grande, qui projette une ombre douce sur le sol et dérive lentement.
- **Surfaces :** des familles différenciées (océanique, désertique, glacée, volcanique, géante gazeuse à bandes) avec des continents à plusieurs échelles de bruit.
- **Anneaux :** des bandes fines aux densités irrégulières et des divisions nettes. Ils sont éclairés par l'étoile et assombris par l'ombre de la planète. Il faut supprimer le moiré visible dans `before/06-station-wide.jpg`.
- **Échelle :** Kerys (rayon de 14 km à 58 km) occupe aujourd'hui un tiers de l'écran. C'est spectaculaire, mais ça l'écrase. Il faut la reculer ou réduire sa taille apparente, et ajouter de la brume sur ses anneaux, pour qu'elle paraisse loin.

### Astéroïdes

Aujourd'hui, toutes les roches ont la même forme de « papier froissé ». Leur couleur vient des sommets, sans détail, et leurs ombres sont violettes (`before/11-asteroids.jpg`).

Cible :

- **Trois familles :**
  - carbonées (sombres, arrondies) ;
  - silicatées (gris-beige, anguleuses, fracturées) ;
  - métalliques (sombres et brillantes, veinées).
- **Formes :** une base (patatoïde, éclat, agglomérat) déformée, avec des cratères en creux et des arêtes vives sur les gros blocs.
- **Matière :** une carte normale et de rugosité triplanaire partagée, de la poussière dans les creux et une couleur désaturée.
- **Champs :** des zones denses (la ceinture minière) et des zones clairsemées. De petits cailloux instanciés autour du joueur donnent la vitesse.
- **Rendu :** des LOD par distance ; les plus lointains passent en imposteurs instanciés.

---

## 7. Station Aurora-7

La station garde son plan actuel : noyau, anneau habité tournant, épine, hangar, panneaux solaires. Les collisions du serveur (`zone.ts`) ne changent pas.

Aujourd'hui, elle lit comme un jouet lumineux. Les anneaux de néon et le bloom saturent l'image (`before/07-station-close.jpg`). Les blocs sombres sont couverts d'un motif de points bleus qui ressemble à du bruit. Rien ne donne l'échelle.

Cible :

- **Architecture industrielle :**
  - des modules de blindage aux joints visibles ;
  - des poutres en treillis entre les sections ;
  - des passerelles vitrées entre l'anneau et le noyau ;
  - des radiateurs ;
  - des grues ;
  - des conteneurs dans les zones de chargement.
- **Fenêtres :** des rangées régulières de petites fenêtres ambre, en partie éteintes, et regroupées par pont. C'est l'élément qui donne l'échelle humaine.
- **Hangar :**
  - une bouche éclairée de l'intérieur ;
  - un balisage d'approche avec feux séquentiels ;
  - un champ de confinement légèrement visible.
- **Balisage :** des feux anticollision rouges aux extrémités et des feux blancs stroboscopiques au sommet de l'épine.
- **Vie :**
  - l'anneau tourne déjà ;
  - ajouter des navettes et drones de maintenance sur des trajectoires, et du trafic d'approche vers le hangar ;
  - ajouter de petits jets RCS de correction de la station.
- **LOD :** plus de 5 km, une silhouette et des feux ; 1 à 5 km, les modules ; moins d'1 km, les détails, fenêtres et grues.
- **Lumière :** des néons réduits à des bandes fines. L'essentiel de la lumière émise vient des fenêtres et du hangar.

---

## 8. Combat

**Règle :** un effet informe d'abord, impressionne ensuite.

| Effet | Cible visuelle | Contrainte de lisibilité |
| --- | --- | --- |
| **Lasers** | Un trait cœur blanc avec un liseré coloré par faction (cyan pour l'Union, rouge-orange pour les pillards), un flash de bouche, une rémanence de 60 ms | Le trait reste fin à l'écran, quelle que soit la distance |
| **Impact sur bouclier** | Une onde hexagonale locale sur l'ellipsoïde, plus intense quand le bouclier faiblit | L'onde ne couvre jamais toute la coque |
| **Bouclier épuisé** | Une fragmentation de l'ellipsoïde, des étincelles bleues et un son distinct | Il doit être identifiable sans regarder le HUD |
| **Impact sur coque** | Des étincelles orange, des fragments et une fumée brève | — |
| **Explosion** | Un flash bref (80 ms), une boule de feu qui refroidit de l'orange au rouge sombre, des fragments métalliques, une onde de choc annulaire fine et des débris temporaires | Rayon à l'écran limité à environ 35 % de la hauteur ; le flash ne masque pas plus de 150 ms. Aujourd'hui, l'explosion est une boule blanche opaque qui masque tout (`before/05-combat.jpg`) |
| **Réacteurs** | Un jet en couches (cœur blanc, gaine colorée, diamants de choc au boost) dont la longueur dépend de la poussée réelle, et des RCS en manœuvre | Les jets du joueur ne gênent pas la visée |

---

## 9. Interface

Le HUD actuel est fonctionnel et testé à plusieurs tailles (ordinateur, mobile). On le garde, et on l'améliore progressivement :

- **Typographies :** Orbitron uniquement pour les titres et les chiffres. Rajdhani pour le texte. Une taille minimale de 13 px en jeu.
- **Panneaux holographiques :**
  - un fond plus sombre et plus transparent ;
  - un liseré cyan fin ;
  - un léger balayage à l'ouverture ;
  - aucun flou d'arrière-plan coûteux.
- **Ciblage :** des crochets animés au verrouillage, la distance et la vitesse relative, l'état bouclier et coque.
- **Dégâts :** des fissures discrètes aux bords de l'écran quand la coque est critique, au lieu de l'aberration chromatique.
- **Transitions :** des fondus de 150 ms vers les menus, et un menu pause qui floute la scène en Élevé et Ultra seulement.

---

## 10. Exploration (direction pour la suite)

Le secteur Aurora reste le seul secteur en v0.2.5. Les systèmes futurs reprendront le même pipeline, avec un « profil de système » :

| Profil | Étoile | Palette | Humeur |
| --- | --- | --- | --- |
| Aurora (actuel) | Jaune-blanc | Cyan, magenta, ambre | Accueil, activité |
| Ceinture de Varn | Orange | Ocre, rouille, gris | Industrie, minage |
| Binaire de Selis | Bleu + rouge | Ombres colorées doubles | Étrangeté |
| Cimetière d'Ostra | Naine rouge faible | Noir, rouge sombre, épaves | Danger, solitude |
| Voile d'Ithra | Géante bleue cachée | Bleu glacier, blanc | Émerveillement |
| Le Silence | Aucune (nébuleuse obscure) | Noir, rares lueurs vertes | Mystère, vestiges anciens |

Chaque profil fixe : la couleur et l'intensité de l'étoile, la palette et la densité de la nébuleuse, les familles de planètes, la densité d'astéroïdes, l'exposition et les points d'intérêt (épaves, bases abandonnées, structures anciennes).

---

## 11. Assets, outils et licences

### Ce qui est possible depuis l'environnement de développement actuel

- Il n'y a ni Blender ni outil de modélisation interactif. Les modèles sont donc construits **en code** : géométries Three.js assemblées, extrudées et biseautées, puis fusionnées par matériau. Les textures sont **générées** par canvas ou shader et cuites au chargement.
- On peut obtenir ainsi des vaisseaux nettement plus détaillés qu'aujourd'hui, avec de vraies sections, des cartes normales et des décalques. Ce ne seront pas des modèles photoréalistes de niveau production. Le document ne présentera jamais un modèle procédural comme un asset final de ce niveau.
- Le code peut exporter ces modèles en **glTF/GLB** (`GLTFExporter`), ce qui les rend modifiables plus tard dans Blender.

### Pipeline recommandé pour de vrais assets

1. Modélisation dans **Blender** (gratuit), par un artiste ou par toi, avec un atlas de détails (trim sheet) par faction.
2. Export en **glTF 2.0** avec cartes couleur, normale, ORM et émissive.
3. Optimisation avec **gltf-transform** : compression **meshopt**, textures en **KTX2/Basis**, LOD générés.
4. Dépôt dans `public/assets/ships/…`, chargé par `GLTFLoader` avec un repli procédural si le fichier manque.

**Licences :**

- N'utiliser que des sources **CC0** ou explicitement réutilisables : Poly Haven et ambientCG pour les textures, Kenney pour les éléments simples.
- Chaque fichier est inscrit dans `public/assets/CREDITS.md` avec sa source, son auteur et sa licence.
- Aucun asset extrait d'un jeu ou d'un film.
- Aucun lien direct vers un hébergeur externe : les fichiers sont versionnés avec le jeu.

---

## 12. Audit du rendu actuel (v0.2)

Captures de référence : `docs/visual/before/01` à `11`, prises sur la v0.2 (commit `2cb3f37`).

### Les 5 points qui font encore « prototype »

1. **Les vaisseaux sont des assemblages de primitives** (`before/02`, `before/04`).
   - Fuselages tournés, boîtes de « greebles » posées sur la coque, cockpit en ellipsoïde cyan opaque.
   - La texture de panneaux de 1024 px est étirée sur tout le vaisseau et devient un bruit de petits carrés bleus.
   - Pas de carte normale, pas de détails géométriques aux jonctions, pas de RCS, pas de marquages.
   - **C'est la première chose que voit le joueur.**
2. **L'éclairage est plat et violet** (`before/09`, `before/11`).
   - Une lumière d'ambiance violette et une lumière de remplissage violette éclaircissent toutes les ombres.
   - Les planètes n'ont presque pas de côté nuit, les astéroïdes ont des ombres lavande et rien n'a de volume.
   - L'étoile ne domine pas la scène.
3. **Le bloom et les néons saturent l'image** (`before/07`, `before/05`).
   - Les anneaux lumineux de la station et ses liserés produisent de larges halos blancs.
   - L'explosion devient une boule blanche qui couvre la moitié de l'écran et masque la cible.
   - L'aberration chromatique et le grain sont permanents.
4. **Le ciel est uniforme et chargé** (`before/10`).
   - Un même bruit marbré rose et cyan sur tout le ciel, sans zones sombres ni absorption ni hiérarchie.
   - Le cube de 1024 px manque de résolution : il est flou en 1080p.
   - L'image manque de profondeur et de mystère.
5. **Aucun repère d'échelle** (`before/06`, `before/01`).
   - La station d'un kilomètre ressemble à une maquette : pas de fenêtres régulières, de trafic ni de structures fines, et un motif de points bleus partout.
   - La planète Kerys est trop grande et trop nette pour sa distance.
   - Les astéroïdes ont tous la même forme et la même taille apparente.

### Autres constats

- Le jet des réacteurs est un cône additif uniforme, sans couches, sans diamants de choc et sans variation visible avec la poussée.
- Les lasers sont de bons traits fins et lisibles. Il faut les conserver et seulement enrichir l'impact.
- Les anneaux de Kerys présentent un moiré à distance (pas de filtrage des fines bandes).
- **Bon point :** les performances de base sont maîtrisées (navires fusionnés par matériau, astéroïdes instanciés, résolution dynamique). La refonte doit conserver ces acquis.

### Meilleurs rapports qualité / coût

| Amélioration | Gain visuel | Coût GPU | Risque |
| --- | --- | --- | --- |
| Lumière clé dominante, ambiance quasi nulle, exposition | Très fort | Nul | Faible : à régler avec les captures |
| Bloom à seuil HDR, aberration seulement aux dégâts | Fort | Négatif (moins de passes larges) | Faible |
| Nouveau Falcon Mk.II détaillé, avec carte normale et décalques | Très fort | Faible : un vaisseau, un appel de dessin par matériau | Moyen : le travail est long |
| Ciel à trois échelles, avec bandes sombres et cube de 2048 | Fort | Nul en vol (cuit une fois) ; démarrage un peu plus long | Faible |
| Explosion en couches, de taille bornée | Fort pour le combat | Faible (particules existantes) | Faible |
| Fenêtres de la station et suppression des néons | Fort pour l'échelle | Nul | Faible |
| Astéroïdes triplanaires et familles de roches | Moyen | Faible | Faible |
| Atmosphère et terminateur des planètes | Moyen | Faible (un shader) | Faible |
| Ombres du joueur | Moyen | Moyen | Moyen : réglage du biais |

---

## 13. Plan de production v0.2.5

Chaque étape fait l'objet d'un commit séparé sur `v0.2.5-graphics`, avec des captures avant/après. Aucune étape ne touche la simulation, le protocole réseau ou le HUD fonctionnel.

| Étape | Contenu | Livrable | Critère d'acceptation |
| --- | --- | --- | --- |
| **0. Outillage** | Captures de référence (`visual-capture.mjs`), réglages de qualité Bas, Moyen, Élevé et Ultra dans Options, compteur de rendu (appels de dessin, triangles, mémoire GPU) | Captures « before » et menu de qualité | Le niveau Bas est au moins aussi rapide qu'aujourd'hui avec `?q=low` |
| **1. Lumière et post-traitement** | Étoile dominante, ambiance réduite, exposition, bloom à seuil, effets de caméra mesurés | Captures 01 à 11 | Côté nuit noir, HUD lisible, aucune zone blanche brûlée hors émissifs |
| **2. Falcon Mk.II** | Nouveau modèle en code : sections, structure, RCS, radiateurs, cockpit et intérieur, trains repliés, feux, décalques, usure ; cartes normale et ORM générées ; export GLB | Captures 02, 03 et 04 ; fichier GLB | Silhouette reconnaissable à 2 km, détails crédibles en hangar ; budget d'environ 25 000 triangles et 3 matériaux |
| **3. Univers** | Ciel à trois échelles, étoiles spectrales, atmosphère et terminateur, sphère de nuages, anneaux sans moiré, familles d'astéroïdes, brume de profondeur | Captures 06, 08, 09, 10 et 11 | Profondeur visible, zones sombres, plus de violet dans les ombres |
| **4. Aurora-7** | Fenêtres par pont, treillis, passerelles, hangar éclairé, balisage, navettes et drones, LOD | Captures 06 et 07 | Sensation d'échelle d'un kilomètre ; appels de dessin de la station inférieurs ou égaux à ceux d'aujourd'hui |
| **5. Combat** | Lasers enrichis, ondes de bouclier, bouclier épuisé, explosion en couches, réacteurs en couches, RCS | Capture 05 ; séquence de combat | La cible reste visible ; l'explosion est bornée en taille et en durée |
| **6. Cohérence** | Warden, Raider et Marauder harmonisés avec les signatures de faction ; palette appliquée à l'interface | Capture 04 et HUD | Chaque faction est reconnaissable à sa silhouette et à ses couleurs |
| **7. Optimisation** | LOD, réduction de l'overdraw, compression des textures, mesures | Tableau de performances | Cibles du §5 atteintes sur du matériel réel, ou écart documenté |

### Journal de réalisation

- **Étapes 0 et 1 (terminées) :** menu « Qualité graphique » (Automatique, Bas, Moyen, Élevé, Ultra, ou `?q=`), soleil dominant à 4,2 avec contre-jour froid, environnement à 0,55, bloom à seuil 1,05, aberration seulement sous les dégâts. Captures : `screenshots/visual/step1/`.
- **Étape 2 (Falcon Mk.II, validée par William) :** `src/client/render/FalconMk2.ts`, outils `shipKit.ts` et textures `shipTextures.ts`.
  - Coque profilée à chanfreins en quatre sections de blindage, avec de vrais joints au-dessus d'un noyau sombre ; dos anthracite, bande bleu marine, liseré cyan sous le cockpit.
  - Nacelles en deux sections, prise d'air avec soufflante, tuyère en trois couches (pétales, anneau chaud, cône d'éjection), brunissement thermique, radiateurs à ailettes.
  - Cockpit vitré avec arceaux, siège, casque du pilote et deux écrans ; sonde de nez, dôme capteur, antennes.
  - Canons aux points d'emport de la simulation (±4,6 ; −0,6 ; −6,5) avec manchon de refroidissement et frein de bouche.
  - Douze tuyères RCS aux quatre coins, qui s'allument selon la vitesse de rotation envoyée par le serveur (aucun changement de protocole) ; feux de position et feux anticollision clignotants.
  - Trappes de trains repliés, décalques (`FMK2-0147`, `AURORA FLEETWORKS`, `FALCON MK.II`, emblème de l'Union, `NO STEP`, `RESCUE`, chevrons).
  - Textures générées : peinture à 256 px/m environ, carte normale (joints, rivets, trappes), carte ORM (occlusion, rugosité, métal), éclats de peinture sur les bords, traînées de saleté vers l'arrière.
  - Mesures : environ 13 700 triangles et 6 appels de dessin pour la coque (peinture, métal sombre, métal nu, verre, émissifs, décalques), plus les feux. C'est au-dessus de l'objectif de 3 matériaux : les trois derniers sont petits, et les regrouper dans un atlas est prévu à l'étape 7.
  - Le Warden reprenait provisoirement cette coque ; il a sa propre silhouette depuis l'étape 6.
  - Visionneuse `hangar.html` (`?ship=`, `?view=`), captures `scripts/ship-capture.mjs`, export GLB par le bouton « Exporter GLB ».
  - Limite honnête : c'est un modèle procédural détaillé, pas un asset de production modélisé et texturé à la main.
- **Étape 3 (univers, validée par William) :**
  - Ciel : un cœur de nébuleuse lumineux par système, dégradé cyan, magenta puis ambre, masses de gaz sur environ 60 % du ciel, bandes de poussière en absorption. Les étoiles brillantes sont désormais des points nets calculés à chaque image (6 000, couleurs spectrales O à M, magnitudes variées), au lieu d'être cuites floues dans le cube.
  - Planètes : côté nuit noir, lumière rougie au terminateur, lumières de villes sur Thalassa, ombre douce des nuages, assombrissement du limbe des géantes, brume de distance (Kerys 0,26). Anneaux : annelets par bruit avec filtrage par octave (plus de moiré), divisions nettes, face non éclairée plus sombre.
  - Astéroïdes : quatre familles selon la variante déjà partagée avec le serveur (carbonées, agglomérats, silicatées à cassures planes, métalliques veinées), poussière claire dans les creux, relief fin par pixel (désactivé en Bas). Les formes restent entre 0,8 et 1,25 fois le rayon, ce qui reste cohérent avec la sphère de collision.
  - Non fait : déplacer ou réduire Kerys, car sa position et son rayon font partie de la zone partagée avec le serveur ; nappes de gaz de premier plan ; LOD et imposteurs des astéroïdes (étape 7).
- **Correctif fluidité (écrans 120 à 165 Hz) :** le vaisseau du joueur est interpolé entre les deux derniers ticks de simulation (position, rotation et vitesse). La caméra de poursuite garde un retard qui ne dépend plus de la durée des images, et l'horloge suit l'horodatage de `requestAnimationFrame`. Tests : `tests/prediction.test.ts` (144 et 165 Hz) et `tests/camera.test.ts` (images irrégulières, images sautées). Aucun changement serveur ni protocole.
- **Étape 4 (station Aurora-7, validée par William) :** `src/client/render/Station.ts`.
  - Tôlerie à l'échelle (un motif tous les 24 m), fenêtres par ponts : la plupart des ponts sont sombres et seules quelques rangées sont éclairées, ce qui donne l'échelle humaine sans effet guirlande.
  - Modules de l'anneau en coques pressurisées arrondies avec bandes de renfort, blocs machines octogonaux sur la colonne, peinture sombre moins miroir.
  - Hangar dégagé du noyau, avec nervures, plafonnier, deux plateformes d'atterrissage, une baie de contrôle, un cadre renforcé et des contreforts latéraux.
  - Zones cargo à l'échelle des conteneurs (12 m), grues portiques, poutres vers le noyau.
  - Trafic : les navettes d'arrivée passent sous l'anneau au lieu de le traverser.
  - Détails fins masqués au-delà de 5 km. Les collisions de la station (zone partagée avec le serveur) ne changent pas.
  - Captures : `screenshots/visual/step4/` (vues 06, 07, 12 et 13).
  - Limite honnête : c'est une station procédurale plus crédible, pas un modèle de production. Les mesures de triangles et d'appels de dessin sont prévues à l'étape 7.
- **Étape 5 (effets de combat, validée par William) :** `Effects.ts`, `Lasers.ts`, `ShipView.ts`.
  - Lasers : rubans tournés vers la caméra, cœur blanc et halo couleur de faction, tête brillante et queue qui s'efface ; les tirs lointains gardent quelques pixels d'épaisseur. Éclair de bouche en deux couches, et une petite lumière sur la coque pour les tirs du joueur.
  - Bouclier : presque invisible au repos ; un impact n'excite que la zone touchée (point blanc bref, cellules et onde qui s'éloigne), au lieu d'allumer toute la bulle.
  - Coque : chaque impact laisse une marque de métal en fusion posée sur la surface réelle (lancer de rayon sur le maillage), qui passe du blanc à l'orange puis au rouge et s'éteint en 2,6 s. Sous 50 % de coque, jusqu'à quatre feux vacillent sur le vaisseau, en plus de la traînée de fumée.
  - Explosions : éclair aveuglant, boule de feu dense qui refroidit du jaune au rouge, une à quatre explosions secondaires, débris (plaques, morceaux, tubes) dont une partie brûle en laissant des braises et de la fumée, nuage de poussière qui reste plusieurs secondes. Les anneaux d'onde de choc, peu crédibles dans le vide, sont supprimés.
  - Les shaders des effets sont compilés au chargement du secteur, pour éviter un à-coup au premier tir ou à la première destruction.
  - Coût : nombre de particules multiplié par le réglage Qualité (0,35 en Bas). Aucun changement serveur ni protocole.
  - Outil : `scripts/vfx-capture.mjs` (moments figés, identiques à chaque capture). Captures : `screenshots/vfx/before/` et `screenshots/vfx/step5/`.
- **Étape 6 (identité des factions, en revue) :** `src/client/render/FactionShips.ts`, qui réutilise le kit du Falcon (`makeKit` : matériaux partagés, feuilles de texture, atlas de décalques).
  - **Warden** (escorte lourde de l'Union) : fuselage blindé plus épais que le Falcon, en quatre sections ; bloc moteur large à trois tuyères ; ailes courtes avec nacelles de canons et ailettes tombantes ; grande dérive dorsale et deux dérives ventrales inclinées ; petit cockpit blindé, dôme capteur, jupes de blindage. Peinture bleu ardoise à bandes ivoire, les deux couleurs du Falcon inversées.
  - **Raider** (chasseur léger pillard) : fuselage en losange à arête vive, avec des plaques manquantes au-dessus du moteur qui laissent voir les couples ; capot blindé décalé à gauche avec une visière rouge ; lames dentelées en flèche inversée ; un gros moteur et deux propulseurs d'appoint sanglés ; réservoir supplémentaire sous une seule lame, plaque boulonnée sur le nez, dents dorsales, antenne tordue.
  - **Marauder** (canonnière lourde pillarde) : coque massive couverte de plaques soudées, éperon en tête de marteau peint en rouge avec des dents, nacelles de canons sur pylônes, tourelle dorsale à deux tubes, tour de pont avec bandeau de hublots rouges, conteneurs sanglés à l'arrière, tuyaux, pointes, quatre tuyères.
  - Les pillards partagent une peinture de récupération : chaque panneau tire sa couleur (peinture de base, apprêt, métal nu, peinture passée, rouille), avec le rouge sang comme marque commune.
  - Interface : les couleurs du HUD restent fondées sur l'hostilité (un pilote de l'Union peut devenir hostile en PvP) et correspondent déjà aux signaux des factions : hostile orange-rouge comme les pillards, allié vert comme les réacteurs de l'Union, station cyan. Le radar utilise maintenant exactement le même orange que les marqueurs.
  - Les canons finissent exactement sur les points de tir de la simulation. La visionneuse le vérifie maintenant pour chaque classe (`muzzle` dans les statistiques) et `ship-capture.mjs` échoue si un canon s'en écarte de plus de 5 cm.
  - Mesures (coque, hors feux) : Warden 11 900 triangles et 6 appels de dessin ; Raider 8 100 triangles et 5 appels ; Marauder 11 800 triangles et 5 appels. Avant : 13 700, 1 400 et 2 000 triangles.
  - Outil : `scripts/faction-capture.mjs` (les quatre classes en ciel dégagé, un engagement vu de la caméra de poursuite, le même à 400 m, des impacts). Captures : `screenshots/ships/step6/` et `screenshots/factions/step6/`.
  - Limite honnête : ce sont des modèles procéduraux plus aboutis et cohérents entre eux, pas des assets de production modélisés à la main.

### Budgets par image (niveau Élevé)

| Élément | Budget |
| --- | --- |
| Appels de dessin | 300 au maximum en combat chargé (30 vaisseaux, station visible) |
| Triangles | 1,5 million au maximum à l'écran |
| Mémoire des textures | 300 Mo au maximum |
| Post-traitement | 3 ms au maximum sur la carte de référence |

---

## 14. Validation

Chaque évolution est jugée sur cinq critères : qualité visuelle, lisibilité du jeu, performances, stabilité et compatibilité avec le multijoueur.

**Vérifications à chaque étape :**

- `npx tsc --noEmit`, `npx vitest run` et `npm run build` ;
- `scripts/ui-check.mjs`, `scripts/smoke.mjs`, `scripts/mobile-check.mjs` et `scripts/mp-check.mjs` ;
- aucune erreur WebGL ni erreur de shader : le compteur `shaders en erreur` du menu pause reste à 0 ;
- captures avant/après avec `scripts/visual-capture.mjs`, mêmes caméras et même instant ;
- pour les vaisseaux : `scripts/ship-capture.mjs` (dont le contrôle canons / points de tir) et `scripts/faction-capture.mjs`.

**Mesures de performances :** elles ne sont valables que sur du vrai matériel. Le rendu logiciel de l'environnement de développement (SwiftShader, 2 à 30 IPS) ne mesure rien. Chaque mesure indique la carte graphique, le processeur, le navigateur, la résolution, le niveau de qualité et la scène, et le résultat est ajouté à ce document.

**Publication :**

- rien de la branche graphique n'est publié sur le site principal sans validation ;
- la branche ne pousse jamais sur `v0.2-multiplayer`, qui alimente le serveur Render ;
- les aperçus Vercel de la branche servent aux essais.
