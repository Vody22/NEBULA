# v0.4 — Comptes pilotes et sauvegarde

Objectif : un pilote garde sa progression d'une partie à l'autre, même quand le serveur redémarre. En ligne, il a un compte (pseudo et mot de passe). En solo, sa progression reste dans le navigateur. Le pilotage, le combat, le HUD, l'économie et le multijoueur des versions précédentes ne changent pas.

## Ce que voit le joueur

- **Menu de départ** : deux onglets, « Se connecter » et « Créer un compte ».
  - Pseudo de 3 à 16 caractères : lettres latines (accents compris), chiffres, espaces et `. _ ' -`. Un pseudo est unique sans tenir compte des majuscules : « Kerys » et « kerys » sont le même compte.
  - Mot de passe de 8 à 128 caractères, différent du pseudo, à confirmer à l'inscription.
  - Aucune adresse e-mail n'est demandée. Le formulaire prévient que le mot de passe ne pourra pas être récupéré.
- **Session mémorisée** : après une connexion, le navigateur garde le pilote 30 jours, prolongés à chaque visite. Le menu affiche alors « Pilote : Kerys », le bouton « Jouer en ligne » et un lien « Changer de compte ». Le mot de passe n'est jamais gardé dans le navigateur. « Changer de compte » oublie la session ici et l'annule aussi sur le serveur : sur un ordinateur partagé, personne ne peut la réutiliser.
- **Retour en jeu** : le pilote revient à quai dans la dernière station où il s'est amarré, avec ses crédits, sa soute, son score (éliminations et morts) et l'état de sa coque. Un message l'indique : « Progression chargée : amarré à Station Aurora-7 ». Un nouveau pilote commence en vol près d'Aurora-7, comme avant.
- **Mort** : la cargaison est perdue, pas les crédits, comme en v0.3. Le vaisseau suivant sort intact du hangar.
- **Deuxième fenêtre** : se connecter au même pilote depuis une autre fenêtre reprend la session. La première fenêtre est prévenue et revient au menu.
- **Erreurs** : chaque refus est expliqué sous le formulaire, et le menu reste utilisable. Les cas prévus sont un mauvais mot de passe, un pseudo déjà pris, trop de tentatives et une base de données indisponible (dans ce dernier cas, le solo reste disponible).
- **Solo** : la progression est enregistrée dans ce navigateur, sur cet appareil, séparément du compte en ligne. Effacer les données du site l'efface.

## Ce qui est sauvegardé

| Donnée | Sauvegardée | Remarque |
| --- | --- | --- |
| Crédits | oui | |
| Soute | oui | perdue à la mort, comme en v0.3 |
| Éliminations et morts | oui | |
| Station de retour | oui | la dernière où le pilote s'est amarré |
| Coque | oui | bouclier et énergie sont rechargés à quai |
| Position en vol | non | on revient toujours à quai |
| Stocks des stations | oui | toutes les 5 min quand des pilotes jouent, et à l'arrêt du serveur |

Après un redémarrage, les stocks reprennent là où ils étaient. Ils dérivent ensuite vers leur équilibre pendant le temps où le serveur était arrêté, dans une limite de 24 h, comme si les stations avaient continué à produire et consommer.

## Fonctionnement technique

Le code est dans `src/server/accounts/`, `src/shared/accounts.ts`, `src/shared/save.ts` et `src/client/account.ts`.

- **Base de données** : PostgreSQL sur Neon (plan gratuit, Francfort), via la variable `DATABASE_URL` du serveur Render. Les tables `nf_pilots`, `nf_tokens`, `nf_sector` et `nf_meta` sont créées au démarrage. Un verrou empêche deux serveurs qui démarrent ensemble de le faire en même temps. Sans `DATABASE_URL`, les comptes restent en mémoire et sont perdus au redémarrage. Le serveur l'écrit alors dans son journal, et `/status` indique `"accounts": "memory"` au lieu de `"postgres"`.
- **Mots de passe** : hachés avec scrypt (N = 16384, r = 8, p = 1) et un sel aléatoire. Ils ne sont jamais stockés en clair ni écrits dans le journal. La vérification se fait en temps constant. Un pseudo inconnu demande le même travail qu'un pseudo existant, ce qui empêche de deviner les pseudos pris. Les paramètres sont rangés dans chaque empreinte : on pourra les durcir plus tard, et l'empreinte est alors refaite à la connexion suivante. Le calcul passe par le pool de threads de Node (au plus 2 à la fois), donc la boucle de jeu ne s'arrête pas pendant une connexion.
- **Jeton de connexion** : 32 octets aléatoires. Le serveur n'en garde que l'empreinte SHA-256, de sorte qu'une fuite de la base ne donne accès à aucune session. Il dure 30 jours, prolongés à chaque usage. Un pilote a au plus 10 jetons, un par navigateur. `POST /logout`, avec le jeton pour corps, l'annule (« Changer de compte »).
- **Anti-abus**, en mémoire et par serveur :
  - 20 tentatives par minute et par adresse ;
  - 8 échecs par pseudo en 10 minutes, puis ce pseudo attend (un navigateur qui a gardé son jeton entre quand même) ;
  - 10 comptes par heure et par adresse, 120 par heure pour tout le serveur.
  - L'adresse est lue dans l'en-tête `CF-Connecting-IP`, posé par Cloudflare devant Render. Le client peut remplir lui-même `X-Forwarded-For`, qui ne sert donc qu'en secours.
- **Écritures** :
  - Le jeu signale chaque changement, au plus une fois par tick.
  - Les changements sont écrits par lots toutes les 5 s, en une seule requête SQL.
  - Un pilote qui part est écrit tout de suite.
  - À l'arrêt du serveur (déploiement), tout est écrit avant la fermeture des connexions. Le pilote qui se reconnecte au nouveau serveur retrouve donc sa progression.
  - Si la base ne répond pas, la progression reste en mémoire et le serveur réessaie avec un délai croissant.
- **Génération** : chaque connexion à un pilote augmente sa « génération » dans la base, et une écriture qui porte une génération plus ancienne est refusée. Pendant un déploiement, deux serveurs tournent quelques secondes en même temps : l'ancien ne peut donc pas écraser la progression enregistrée par le nouveau. Sa session est fermée avec le message « Ce pilote vient de se connecter sur un autre serveur. »
- **Base endormie** : Neon suspend la base après 5 minutes sans activité. La première connexion après une pause prend 1 à 3 s de plus, et le client attend jusqu'à 25 s.
- **Base indisponible au démarrage** : le serveur démarre quand même. Il refuse les connexions en ligne avec un message clair et retente la base en arrière-plan, toutes les 2 s au début puis jusqu'à toutes les 60 s.
- **Données lues** : une sauvegarde lue (base ou navigateur) est toujours revalidée par le serveur de jeu. Les valeurs sont bornées (crédits, soute à la capacité du vaisseau, coque entre 1 et le maximum, station connue), et ce qui n'est pas compris est ignoré.

## Protocole (version 4)

- `hello { version, auth }`, avec `auth` égal à :
  - `{ kind: 'register', name, password }` pour créer un compte ;
  - `{ kind: 'login', name, password }` pour se connecter ;
  - `{ kind: 'token', token }` pour une session mémorisée.
  Un `hello` sans `auth` est refusé.
- Serveur vers client :
  - `account { name, token, expiresAt, isNew }` après une connexion réussie ;
  - `error { code: 'auth', reason, text }` en cas de refus, avec `reason` parmi `credentials`, `taken`, `invalid`, `limited`, `expired` et `unavailable`.
- Un client v3 reçoit une erreur de version claire. Le site et le serveur Render doivent être mis à jour ensemble.

## Quotas du plan gratuit Neon

Chiffres relevés sur [neon.com](https://neon.com/faqs/free-plan-limits-and-quotas) le 23/10/2026 :

- **Stockage** : 1 Go par projet. Un compte occupe environ 1 Ko.
- **Calcul** : 100 CU-heures par mois. La base ne consomme que lorsqu'elle est éveillée, et elle s'endort 5 min après la dernière écriture. À la taille minimale (0,25 CU), cela fait environ 400 heures d'éveil par mois.
- **Si le quota est épuisé** : Neon suspend la base jusqu'au mois suivant. Les connexions en ligne sont alors refusées avec un message, et le solo reste disponible.
- **Suivi** : la consommation se lit dans le tableau de bord Neon. Pour un jeu joué en continu, il faudra soit passer à un plan payant, soit espacer les écritures.

## Limites assumées de la v0.4

- Pas de récupération de mot de passe, faute d'e-mail : un mot de passe oublié oblige à créer un autre pilote. On pourra ajouter un code de secours ou un e-mail facultatif.
- Pas de changement de mot de passe ni de suppression de compte depuis le jeu.
- Les limites anti-abus sont en mémoire : elles repartent à zéro au redémarrage du serveur.
- La progression solo dépend du navigateur et de l'appareil.

## Étapes

1. Sauvegarde partagée (`save.ts`) : format, validation, stocks des stations.
2. Comptes côté serveur : règles des pseudos, mots de passe, jetons, limites, stockage en mémoire et PostgreSQL, écritures par lots, génération.
3. Jeu : retour à quai avec la progression, sauvegarde à chaque changement et au départ, protocole v4.
4. Client : formulaire de connexion et d'inscription, session mémorisée, sauvegarde solo.
5. Tests (unitaires, vraie base PostgreSQL, redémarrage du serveur, navigateurs), documentation, publication avec le serveur.

## Journal

- **Étapes 1 à 5** (branche `v0.4-persistence`) : tout ce qui précède.
  - 124 tests automatiques, dont un redémarrage complet du serveur sans perte de progression et une vraie base PostgreSQL 16 locale.
  - Correctif trouvé en relisant : un pseudo trop long était coupé à l'inscription, puis la connexion le refusait. Il est maintenant refusé dès l'inscription.
  - Le test de charge envoyait encore l'ancien protocole et ne mesurait plus rien depuis la v0.3. Il s'inscrit maintenant comme un joueur et s'arrête si les robots n'entrent pas. Résultat avec 30 robots inscrits : 1,1 ms par tick en moyenne, soit 6,8 % du budget.

Non vérifié avant publication : la vraie base Neon. Son adresse reste dans Render, et l'environnement de développement ne joint pas Render. Après la mise en ligne, `/status` doit afficher `"protocol": 4` et `"accounts": "postgres"`.
