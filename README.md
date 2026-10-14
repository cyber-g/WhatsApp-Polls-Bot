# WhatsApp-Polls-Bot

Bot personnel : publier chaque jour un sondage WhatsApp pour un evenement
du lendemain defini dans Google Sheets. Choix `oui` / `non`, reponse unique.

## Developpement progressif

1. **[Sondage simple](examples/01-poll/README.md)** :
   repartir de l'exemple officiel `!sendpoll`, valider l'envoi manuel puis
   quatre publications avec une connexion continue.
2. **[Exercice Cloud Run](examples/02-cloud/README.md)** :
   valider quatre executions independantes, la restauration et la sauvegarde
   successive de la session, avec demarrage anticipe.
3. **[Bot quotidien](bot.cjs)** : Google Sheets et anti-doublon durable.
   [Installation](INSTALLATION.md) et [exploitation](EXPLOITATION.md).

Le bot quotidien reprend les mecanismes valides des deux exemples :
declenchement Cloud Scheduler a **08h57 Europe/Paris**, attente de **09h00**,
publication pour l'evenement actif du lendemain. Un client pret en retard
peut envoyer jusqu'a **09h15 exclusivement**. Sinon le creneau est ignore.
Il n'y a ni reprise aveugle ni rattrapage des jours passes.

L'onglet `Evenements` contient `Date`, `Actif`, `Titre` : dates en texte
`AAAA-MM-JJ`, `OUI` pour activer, `{date}` remplace par `JJ/MM/AAAA`.
Une date absente ou inactive ne produit pas de sondage.
Simulation par defaut (`DRY_RUN=true`), controle du groupe par identifiant seul,
pas de lecture du nom ni d'ACK obligatoire. `poll_send_completed` signifie
appel termine sans erreur, pas livraison confirmee. L'anti-doublon reserve
la date avant l'envoi et conserve toute tentative incertaine.

```text
examples/01-poll/   Validation manuelle et connexion continue
examples/02-cloud/  Validation cloud, quatre executions independantes
lib/               Envoi et cycle cloud partages
bot.cjs            Calendrier Sheets et publication quotidienne
bot.test.cjs       Regressions et integration simulee sans Google/WhatsApp
```

```bash
node --test bot.test.cjs examples/01-poll/poll-example.test.cjs examples/02-cloud/cloud-poll-exercise.test.cjs
```

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
