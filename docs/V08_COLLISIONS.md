# v0.8 — Collisions physiques

Objectif : tout ce qui est solide dans un secteur se heurte vraiment. Un vaisseau qui fonce dans un mur s'y arrête ou rebondit, il ne le traverse jamais, même au boost. Le choc dépend de la vitesse, de la masse, de l'orientation et de la matière touchée. Il abîme la partie du vaisseau qui a pris le coup. Le serveur décide de tout, comme pour les tirs. Le pilotage, le combat, le HUD, l'économie, les contrats, les comptes, les secteurs et le multijoueur des versions précédentes restent en place.

## Ce que voit le joueur

- **Les murs arrêtent les vaisseaux.** Les murs, le sol et le toit des hangars, la colonne centrale, l'anneau, ses rayons, les panneaux solaires et les radiateurs des stations ont leur forme réelle. Avant la v0.8, une station était une sphère et une rangée de boules, et les murs du hangar ne bloquaient rien.
- **Les astéroïdes ont la forme qu'on voit.** Bosses, creux, cratères, faces plates des rochers fracturés, proportions : la forme de collision est celle du rocher dessiné, et elle tourne avec lui. Avant, c'était une sphère à 85 % du rayon : selon l'endroit, le vaisseau entrait jusqu'à 45 % du rayon dans le rocher visible, ou s'arrêtait jusqu'à 17 % avant de le toucher. La forme de collision s'écarte maintenant du rocher dessiné de 0,1 à 0,4 % du rayon en moyenne, et de 3 % au plus sur le bord de certains cratères.
- **Le choc dépend de la violence.**
  - À 5 m/s, on touche le mur : un petit choc sourd, aucun dégât.
  - À 40 m/s, le vaisseau rebondit. Le bouclier encaisse le coup, la caméra est secouée et des étincelles jaillissent.
  - À 200 m/s contre du métal, le vaisseau est détruit.
  - Les dégâts croissent avec le carré de la variation de vitesse : un choc deux fois plus rapide fait environ quatre fois plus de dégâts.
- **Chaque matière réagit à sa façon.**

  | Matière | Rebond | Glisse | Dureté | Effets et son |
  | --- | --- | --- | --- | --- |
  | Métal des stations | 0,40 | 0,30 | 1,00 | étincelles, choc métallique, raclement |
  | Roche | 0,25 | 0,55 | 0,90 | poussière et gravillons, choc sourd |
  | Roche métallique (fer-nickel) | 0,35 | 0,45 | 1,05 | étincelles et poussière |
  | Glace | 0,15 | 0,08 | 0,65 | éclats de glace, craquement |
  | Coque d'un autre vaisseau | 0,35 | 0,35 | 0,85 | étincelles, choc de tôle |
  | Débris d'épave | 0,30 | 0,40 | 0,60 | tôle froissée |

  Rebond : part de la vitesse rendue. Glisse : frottement d'un choc rasant. Dureté : multiplicateur de dégâts.
- **Les dégâts sont localisés.** Chaque vaisseau est un groupe de sphères ajustées à son modèle (de 10 pour le Warden à 16 pour le Maraudeur). Chaque sphère appartient à une partie : cockpit, structure, aile gauche, aile droite, moteurs.
  - **Cockpit** : la verrière se fissure, puis les systèmes sont perturbés (bouclier et énergie rechargent moins vite, le HUD grésille sous 25 %).
  - **Ailes** : le vaisseau tourne moins vite. Une aile plus abîmée que l'autre le tire en roulis et en lacet de son côté (l'assistance de vol corrige la plus grande partie).
  - **Moteurs** : moins de poussée et de vitesse maximale, plus de boost sous 30 %, et à zéro seulement les propulseurs de manœuvre (30 %).
  - Un choc de face sur le cockpit compte 25 % de plus. Le bouclier, s'il est actif, prend le coup et en disperse un quart.
  - En vol : vue en plan du vaisseau dans le HUD, chaque partie dans la couleur de son état, avec la liste des parties touchées. Alertes « Aile gauche endommagée : stabilité réduite », « Verrière fissurée : systèmes perturbés », « Moteurs hors service »… Fumée et étincelles sur la partie abîmée, moteurs qui toussent.
  - À la station : les parties abîmées sont réparées avec la coque, contre des crédits. Leur état est sauvegardé et suit le vaisseau dans les sauts.
- **Les vaisseaux se heurtent entre eux.** L'impulsion est partagée selon les masses : un chasseur léger percuté par un Maraudeur est projeté, le Maraudeur ralentit à peine. Chacun prend des dégâts selon sa propre variation de vitesse. Un choc décentré fait tourner le vaisseau.
- **Des objets libres** : caisses (1,5 t) et conteneurs (10 t) amarrés près des stations, épaves laissées par les vaisseaux détruits (3 t par morceau), rochers isolés près de Ferro-9 (1,4 à 2,8 m de rayon, environ 30 à 220 t).
  - On les pousse, ils tournent sur eux-mêmes, rebondissent sur les murs et se heurtent entre eux.
  - Les tirs les poussent et les cassent. Un choc violent les casse aussi.
  - Une caisse déplacée revient à sa place quand personne ne regarde (aucun pilote à moins de 400 m) : dès qu'elle a dérivé à plus de 600 m, sinon 5 min après le dernier choc. Une caisse cassée réapparaît 2 min plus tard dans les mêmes conditions. Les épaves disparaissent au bout d'environ 90 s.
- **La caméra et le son suivent la violence.** La caméra est projetée vers ce qu'on a touché et tremble, d'autant plus fort que le choc est violent. Le son change selon la matière et la vitesse, et un choc plus dur sonne plus grave.
- **L'assistance de vol** (`Z`) amortit vite la rotation après un choc. Sans elle, le vaisseau suit la physique pure : il garde sa vitesse et sa rotation.
- **Vue de débogage** `?colliders` (ou `window.__game.setColliderDebug(true)`) : les formes de collision sont dessinées par-dessus le décor. On y voit les murs et les structures par matière, les rochers proches (qui tournent avec leur modèle), les sphères de chaque vaisseau colorées par partie et celles des objets libres.

## Règles (décidées par le serveur)

| Règle | Valeur |
| --- | --- |
| Dégâts d'un choc | 0,02 × dureté × (Δv² − 7²), Δv en m/s ; rien sous 7 m/s de variation de vitesse |
| Choc de face sur le cockpit | × 1,25 |
| Bouclier actif | il prend le coup et en disperse 25 % |
| Usure d'une partie | dégâts ÷ (coque max × réserve de la partie) ; réserves : cockpit 45 %, chaque aile 50 %, moteurs 55 % de la coque |
| Partie « endommagée » | sous 50 % |
| Rebond | le plus faible des deux matériaux ; aucun rebond sous 2 m/s (contact posé) |
| Rotation après un choc | au plus 6 rad/s pour un vaisseau, 10 rad/s pour un objet libre |
| Vaisseaux à plus de 3 km de tout pilote | une seule sphère chacun (niveau de détail physique) |
| Objets libres à plus de 3 km de tout pilote | gelés |
| Objet libre immobile 1 s | endormi : plus aucun calcul tant que rien ne le touche |

## Fonctionnement technique

- **Formes statiques** (`src/shared/physics/shapes.ts`) : sphère, boîte, capsule, cylindre, tore et rocher. Chacune est une fonction de distance signée : la distance d'un point à la surface, négative à l'intérieur, avec la normale. Une forme peut être orientée (`rot`) et tourner sur un axe quelconque (`spin`, `spinAxis`, `spinPhase`). La vitesse de sa surface entre alors dans le choc.
- **Stations** (`src/shared/physics/structures.ts`) : les formes sont posées avec les cotes mêmes des modèles 3D (`Station.ts`, `Outpost.ts`). L'anneau d'habitation ne tourne plus : en tournant, ses rayons balayaient le hangar.
- **Astéroïdes** (`src/shared/physics/rocks.ts`, nouveau) :
  - la forme d'un rocher (relief, cratères, lobes, fractures planes, proportions) est calculée par le même code pour le rendu et pour la physique. Le maillage dessiné est identique au bit près à celui de la v0.7 (vérifié sommet par sommet) ;
  - la physique lit le rayon du rocher dans une table cubique (24 ou 48 échantillons par face, plus fine que le maillage) ;
  - près de la surface, la distance est mesurée jusqu'au point de surface atteint en suivant le gradient (méthode de Newton) ; plus loin, une estimation un peu courte ;
  - le rocher tourne comme il est dessiné (`axe, vitesse × temps + variante`) ;
  - le client dessine les rochers à l'heure de son vaisseau prédit, et la prédiction tient l'horloge du serveur : ce que le vaisseau heurte est là où on le voit ;
  - le rayon de minage s'arrête sur le rocher dessiné.
- **Balayage continu** (`src/shared/physics/collide.ts`) : chaque sphère du vaisseau est balayée de sa position précédente à la nouvelle par lancer de sphère (« sphere tracing »). Le pas n'est jamais plus long que la distance à la surface, donc un vaisseau à 470 m/s (7,8 m par tick) ne passe pas à travers un panneau de 3 m.
- **Réponse** : impulsion au point de contact (rebond et frottement selon les matériaux, masse et inertie du vaisseau), qui peut le faire tourner. Puis dégagement s'il reste un recouvrement (une rotation contre un mur, un rocher qui tourne).
- **Corps rigides généralisés** : le même code traite un vaisseau ou un objet libre (`Solid`, `SolidProps` : masse, inertie, sphères, matériau). Une seule grille de hachage (cellules de 80 m) trouve les paires vaisseau-vaisseau, vaisseau-objet et objet-objet. Chaque paire est balayée en mouvement relatif et se partage l'impulsion selon les masses. Rotation sans couple : le moment cinétique est conservé.
- **Dégâts** (`src/shared/physics/damage.ts`) : usure par partie et effets en vol (`flightFactors`), appliqués de la même façon sur le serveur et dans la prédiction.
- **Objets libres** (`src/shared/sim/looseBodies.ts`, `src/shared/physics/bodies.ts`) : création, amarres, épaves, sommeil, gel loin des pilotes, retour des caisses perdues.
- **Réseau** :
  - **protocole v8** : snapshot des vaisseaux avec l'état des parties (`d`, en %, arrondi vers le bas pour que les seuils tombent du même côté que sur le serveur) et la rotation libre (`s`) ;
  - objets libres dans le snapshot (`b` : ceux qui ont bougé ; `bf` : la liste complète, pour un nouveau pilote et toutes les 2 s) ;
  - événements `collision` (partie, matériau, normale, vitesse, bouclier, autre vaisseau ou objet), `partDamaged`, `bodyHit`, `bodyBroken`, `bodyGone` ;
  - le site et le serveur Render doivent être mis à jour ensemble. Un client v0.7 resté en cache reçoit « Version du jeu différente du serveur : rechargez la page ».
- **Autorité** : le client n'envoie que ses commandes. Un message forgé qui prétend fixer la coque ou les parties est ignoré (test). Le client prédit les chocs contre le décor et contre les objets au repos, avec le même code, et le serveur corrige. Les chocs avec les autres vaisseaux et les objets en mouvement viennent du serveur, lissés.
- **Client** :
  - effets par matériau (`Effects.collision`), fumée et étincelles des parties abîmées ;
  - secousse de la caméra sur un ressort amorti (`ChaseCamera.kick`) ;
  - six sons de collision procéduraux ;
  - vue en plan, fissures de la verrière et grésillement du HUD ;
  - objets libres dessinés en instances et interpolés (`BodyViews.ts`) ;
  - vue de débogage (`ColliderDebug.ts`).
  - le coup qui détruit notre vaisseau (choc ou tir) est montré comme le nôtre : secousse, son proche, « Coque détruite — éjection ». Avant, il était montré un dixième de seconde après l'annonce de la perte du vaisseau, et passait pour le coup d'un autre.
- **Sauvegarde** : nouveau champ facultatif `parts` par vaisseau de la flotte (absent quand tout est intact). Une sauvegarde v0.7 se charge normalement. Un serveur v0.7 (retour en arrière d'urgence) ignore ce champ : les parties sont alors considérées comme réparées.

## Tests

- `tests/collisions.test.ts` : un vaisseau contre le toit du hangar (jamais traversé, rebond sur le métal), pas de traversée d'un panneau de 3 m à 470 m/s, poussée continue contre un mur, rebond selon la matière (fer-nickel, roche, glace), aile qui accroche un rocher (l'aile s'use, le vaisseau tourne), deux vaisseaux de face (quantité de mouvement conservée, pas de traversée, les deux touchés), Raider percuté par un Maraudeur, deux vaisseaux à 470 m/s chacun, 5, 60 et 200 m/s, dégâts au carré de la vitesse, bouclier, cockpit et moteurs touchés, vol sans moteurs et aile cassée, usure par les tirs, assistance de vol, structure qui tourne, tirs dans le hangar, prédiction d'un choc contre un mur identique au serveur, niveau de détail physique, coût de 60 vaisseaux dans la ceinture, dégâts transmis dans le snapshot et message forgé ignoré, parties réparées et sauvegardées.
- `tests/rocks.test.ts` (nouveau) : la forme de collision suit chaque famille de rochers à moins de 0,5 % en moyenne (l'ancienne sphère s'en écartait de plus de 25 %), sphère englobante, point de contact sur la surface dessinée à moins de 30 cm sur un rocher de 60 m, aucune entrée dans un rocher par 12 directions même à 470 m/s, rocher qui tourne et repousse un vaisseau à l'arrêt, tirs arrêtés sur la surface dessinée, prédiction contre un rocher qui tourne identique au serveur (et fausse avec une mauvaise horloge), 60 vaisseaux qui rebondissent dans la ceinture.
- `tests/bodies.test.ts` : placement, inertie, moment cinétique, chasseur contre caisse, conteneur et rocher, caisse cassée à 150 m/s, caisses qui s'entrechoquent et rebondissent sur le hangar, tirs qui poussent et cassent, sommeil, gel, épaves, amarres, réseau (listes complètes puis partielles), prédiction d'une caisse poussée, coût.
- `scripts/collision-check.mjs` (navigateur, rendu logiciel) :
  - en solo : les cinq situations demandées (mur, astéroïde, deux vaisseaux, choc faible puis violent, aile puis cockpit abîmés), une caisse poussée, captures avec et sans la vue de débogage ;
  - en ligne : le vrai serveur et deux navigateurs qui se percutent. Les deux voient exactement les chocs décidés par le serveur, la même coque, la même caisse poussée.
- Scène 13 du laboratoire audio : contact léger, frottements, chocs sur métal, roche, glace, coque et bouclier, crash violent, alertes de parties.

### Résultats du test navigateur (24 octobre 2026)

En solo, chaque choc est mis en scène sur le serveur puis piloté par le vrai client :

| Situation | Mesuré |
| --- | --- |
| Mur du hangar à 40 m/s, puis poussée continue contre lui | heurté nez en avant, jamais à plus de 2 mm dans le mur sur 256 ticks |
| Astéroïde de roche de 41 m | jamais à plus de 1 mm dans le rocher dessiné |
| Astéroïde de fer-nickel de 60 m qui tourne (0,22 rad/s) | jamais à plus de 6 mm dans le rocher dessiné |
| Deux vaisseaux | le Raider est projeté à 30,8 m/s, notre vaisseau ralentit à 20,2 m/s, le bouclier du Raider passe de 80 à 69 |
| 5 m/s contre 200 m/s sur le même mur | aucun dégât à 5 m/s ; à 200 m/s, 1366 de dégâts et vaisseau détruit ; secousse de la caméra 0,13 contre 2,48 |
| Aile gauche contre le mur | aile gauche à 39 %, aile droite à 100 %, le vaisseau part en rotation (0,78 rad/s), alerte et vue en plan |
| Cockpit de face à 40 m/s, bouclier coupé | cockpit à 39 %, le reste intact, 13 fissures sur la verrière |
| Caisse amarrée | projetée de 15 m à 11 m/s, dessinée à 28 cm de sa position serveur |

En ligne, avec le vrai serveur et deux navigateurs (Alpha et Bravo) qui se percutent à 59 m/s de vitesse relative : les deux clients ont reçu exactement les quatre chocs décidés par le serveur (le choc et un contact à 2,6 m/s juste après), affichent les mêmes coques, et leur vaisseau prédit retombe à moins d'un centimètre de la position serveur. Une caisse poussée par Alpha est dessinée par les deux clients à moins d'un centimètre de la position qu'elle avait sur le serveur à leur heure d'affichage (110 ms de retard d'interpolation).

## Limites

- **Pas de déformation des maillages.** Les dégâts se voient par la fumée, les étincelles, les moteurs qui toussent, la verrière fissurée et la vue en plan, pas par une tôle enfoncée ni une aile arrachée.
- **Prédiction partielle.** Le client prédit les chocs contre le décor et les objets au repos. Les chocs avec un autre vaisseau ou un objet en mouvement arrivent du serveur : avec beaucoup de latence, ils se voient avec ce retard puis se lissent.
- **Formes approchées.** Les vaisseaux et les objets libres sont des groupes de sphères : leurs arêtes vives sont arrondies. Sur un rocher, la forme de collision suit le rocher dessiné à 0,4 % près en moyenne, à 3 % près sur certains bords de cratère.
- **Loin des pilotes** (plus de 3 km), les vaisseaux IA n'ont qu'une sphère chacun : le bout d'une aile peut entrer de quelques mètres dans un rocher, là où aucun pilote ne le voit. Les objets libres y sont gelés.
- **Les rochers de la ceinture sont immobiles.** Ils tournent sur eux-mêmes, mais on ne peut ni les pousser ni les casser. Seuls les rochers isolés près de Ferro-9 sont des objets libres.
- **L'anneau d'Aurora-7 ne tourne plus.** La physique sait faire tourner une structure, mais ses rayons traversaient le hangar.
- **La position des objets libres n'est pas sauvegardée.** Après un redémarrage du serveur, caisses et conteneurs reprennent leur place.
- **Les tests navigateur tournent en rendu logiciel** (SwiftShader, quelques images par seconde). Ils vérifient le comportement, pas les performances d'une vraie carte graphique.
