# WhatsApp-Polls-Bot

Bot personnel : publier chaque jour un sondage WhatsApp pour un evenement
du lendemain defini dans Google Sheets. Choix `oui` / `non`, reponse unique.

## Developpement progressif

1. **[Sondage simple](examples/01-poll/README.md)** :
   repartir de l'exemple officiel `!sendpoll`, valider l'envoi manuel puis
   quatre publications avec une connexion continue.
2. **[Exercice Cloud Run](CLOUD-POLL-EXERCISE.md)** :
   valider quatre executions independantes, la restauration et la sauvegarde
   successive de la session, avec demarrage anticipe.
3. **Bot quotidien** : `bot.cjs`, Google Sheets et anti-doublon durable.
   [Installation](INSTALLATION.md) et [exploitation](EXPLOITATION.md).

Les exemples gardent les horaires historiques des tests du 14 octobre 2026 :
ils ne sont pas des planificateurs permanents. Ne laisser qu'un planning actif
pour une meme session et un meme groupe.

## Environnement

Ce depot fournit le code et les guides, pas une image Docker.
[Docker-Whatsapp-webjs](https://github.com/cyber-g/Docker-Whatsapp-webjs)
publie l'image d'outils `drdpham/whatsapp-webjs`, avec Node, Chromium,
`whatsapp-web.js`, Puppeteer et `qrcode-terminal` via `NODE_PATH`.
Un commit ne copie pas le code vers Cloud Shell ou Cloud Storage.

Copier `config.env.example` vers `config.env` et garder ce dernier hors Git.
Les profils, QR et archives WhatsApp sont sensibles, meme dans un bucket prive.
`whatsapp-web.js` est non officiel : une mise a jour WhatsApp peut casser le
fonctionnement ou entrainer une restriction du compte. Utiliser un groupe
de test et de preference un compte dedie. La gratuite de Google Cloud
n'est pas garantie.
