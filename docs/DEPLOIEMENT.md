# Déploiement du multijoueur

Le jeu a deux parties :

| Partie | Rôle | Hébergement |
| --- | --- | --- |
| Client (`dist/`) | Pages, 3D, interface | **Vercel** (inchangé) : https://nebula-iota-rust.vercel.app |
| Serveur (`dist-server/server.mjs`) | Simulation autoritaire, WebSocket `/ws` | Un hébergeur de **processus Node permanent** |

Vercel ne peut pas héberger le serveur : ses fonctions sont courtes et sans état, alors que le serveur garde le secteur en mémoire et maintient des connexions WebSocket ouvertes en continu. Il faut donc un service qui fait tourner un processus Node en permanence et qui accepte les WebSockets.

## Option recommandée : Render

Render fournit HTTPS/WSS automatiquement, accepte les WebSockets et lit le fichier [`render.yaml`](../render.yaml) du dépôt.

1. Sur https://dashboard.render.com : **New → Blueprint**, puis choisir le dépôt `Vody22/NEBULA` et la branche (`v0.2-multiplayer` pour tester, `main` une fois fusionnée).
2. Valider : Render construit et lance `nebula-frontier-server`.
3. Noter l'adresse affichée, du type `https://nebula-frontier-server-xxxx.onrender.com`. Vérifier que `https://…/status` répond.
4. Le client hébergé sur Vercel se connecte par défaut au serveur public `wss://nebula-frontier-server.onrender.com/ws` (constante `PUBLIC_SERVER_URL` dans `src/client/net/config.ts`). Pour en utiliser un autre sans toucher au code, définir `VITE_SERVER_URL` dans Vercel (Settings → Environment Variables), puis redéployer.

Offre gratuite : le service s'endort après 15 minutes sans visite et met environ une minute à se réveiller. Le menu affiche alors « Serveur injoignable » ; il suffit de réessayer après quelques secondes. L'offre *Starter* reste allumée en permanence.

Le serveur sert aussi le client : `https://nebula-frontier-server-xxxx.onrender.com` est une deuxième adresse jouable, en ligne d'office, même sans configurer Vercel.

## Variables d'environnement du serveur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | 8080 | Port d'écoute (fourni automatiquement par Render ou Fly) |
| `ALLOWED_ORIGINS` | *(tout)* | Origines autorisées à ouvrir le WebSocket, séparées par des virgules ; `*` est accepté dans un nom (`https://nebula-*.vercel.app`) |
| `MAX_PLAYERS` | 30 | Pilotes par secteur (un processus = un secteur) |
| `SNAPSHOT_EVERY` | 3 | Un snapshot toutes les N ticks de 1/60 s (3 = 20 Hz) |
| `RECONNECT_GRACE` | 20 | Secondes pendant lesquelles un pilote déconnecté peut reprendre sa session |
| `SECTOR_SEED` | 1337 | Graine du secteur |
| `STATIC_DIR` | dist | Dossier du client servi par le même processus |

Voir aussi [`.env.example`](../.env.example).

## Autres hébergeurs

- **Fly.io** : [`fly.toml`](../fly.toml) + [`Dockerfile`](../Dockerfile) (`fly launch --copy-config --no-deploy`, puis `fly deploy`). Une seule machine doit tourner, car le secteur vit en mémoire.
- **Railway, VPS, Docker** : `docker build -t nebula . && docker run -p 8080:8080 -e ALLOWED_ORIGINS=https://nebula-iota-rust.vercel.app nebula`. Sur un VPS, placer un proxy HTTPS (Caddy, Nginx) devant pour obtenir `wss://`.

## Sécurité

- Le serveur fait autorité : le client n'envoie que ses commandes (`input`), un message de chat, le choix PvP et des pings. Dégâts, éliminations, crédits et positions sont calculés par le serveur ; tout autre message est rejeté.
- Chaque message est validé et borné. Un débit limité est appliqué par connexion (150 messages/s), et un client qui envoie trop de messages invalides est déconnecté.
- La taille d'un message entrant est limitée à 16 Ko, et l'origine du navigateur est contrôlée.
- Le chat est assaini : caractères de contrôle supprimés, 200 caractères au maximum, 5 messages par 10 s, répétitions ignorées. Il est affiché comme du texte, jamais comme du HTML.
- Le jeton de reconnexion est aléatoire (144 bits) et conservé uniquement dans l'onglet (`sessionStorage`).
- Pas de comptes ni de mots de passe en v0.2 : un pseudo n'est pas protégé.

## Capacité

Un serveur gère un secteur. Le test de charge (`node scripts/load-test.mjs 30 30`) fait voler et tirer 30 pilotes robots, avec les vagues de pirates.

Résultats mesurés le 22/10/2026, sur la machine de développement :

- Environ 1 ms par tick sur un budget de 16,7 ms.
- Environ 75 Ko/s par joueur, compressés (300 Ko/s sans compression).
- Environ 18 Mbit/s sortants au total pour 30 joueurs.

Ce n'est pas une mesure faite sur l'hébergeur final. Il faut la refaire sur la machine de production avant d'annoncer une capacité.

Pistes pour aller au-delà :

1. Ne plus envoyer à chaque joueur que les vaisseaux proches de lui (filtrage par distance).
2. Encoder les snapshots en binaire, et envoyer le nom et la classe d'un vaisseau une seule fois, à son apparition.
3. Faire tourner plusieurs secteurs (un processus chacun) derrière un annuaire, avec des sauts entre secteurs.
