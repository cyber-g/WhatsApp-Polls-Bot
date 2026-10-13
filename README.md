# WhatsApp-Polls-Bot
A bot to automatically publish polls on a Whatsapp group on periodic basis


Bot personnel de sondages WhatsApp : un événement fictif par jour, un sondage
la veille à 09 h, heure de Paris. Les dates et titres viennent de Google Sheets.
Le vote se fait directement dans WhatsApp : `oui` / `non`, une seule réponse.

## Deux dépôts


- Ce dépôt contient seulement le bot, sa configuration modèle et sa documentation.
(Il ne construit aucune image et ne contient aucun workflow de déploiement.)
- [Docker-Whatsapp-webjs](https://github.com/cyber-g/Docker-Whatsapp-webjs) construit
l'environnement et publie `drdpham/whatsapp-webjs` sur Docker Hub.
L'image docker utilise `node:24-bookworm-slim`,
`NODE_PATH=/opt/tools/node_modules` et `PUPPETEER_CACHE_DIR=/opt/puppeteer`.
Son point d'entrée attend notre fichier `/app/bot.cjs` et la commande `run`.

## Fonctionnement

Mode de test

```text
Cloud Scheduler (chaque jour à 09 h, Europe/Paris)
    → Cloud Run Job, image drdpham/whatsapp-webjs
        → lit le calendrier Google Sheets privé
        → restaure sa session WhatsApp depuis un bucket privé
        → publie le sondage de demain s'il est actif et non déjà enregistré
        → sauvegarde la session, puis s'arrête
```

Le code est monté depuis un autre bucket, en lecture seule dans `/app`.
Le calendrier de test couvre 365 jours à partir de demain ; il reste ensuite
explicite et modifiable. Une date absente ou `NON` entraîne aucun envoi de sondage.
Le générateur ne remplit pas la feuille automatiquement chaque jour.

Le titre est dans la colonne `Titre` de Sheets, par exemple :

```text
TEST — Événement du {date} : présent ?
```

`{date}` est remplacé par `JJ/MM/AAAA`. Les options `oui` et `non` sont dans
`bot.cjs`. Il n'y a pas de message séparé, ni de collecte des votes dans Sheets.

## Installation et entretien

**Première installation : [INSTALLATION.md](INSTALLATION.md).**
**Reprise après plusieurs mois, incidents et secrets : [EXPLOITATION.md](EXPLOITATION.md).**

| Fichier             | Rôle
| ---                 | ---
| `bot.cjs`           | Tout le traitement, commenté en français
| `bot.test.cjs`      | Tests sans accès Google/WhatsApp
| `config.env.example`| Modèle à copier vers `config.env`, exclu de Git
| `.gitignore`        | Exclusion des données locales et sessions
| `README.md`         | Présentation
| `INSTALLATION.md`   | Installation Google Cloud et tests réels
| `EXPLOITATION.md`   | Maintenance, déblocage et renouvellement des accès

Le bot utilise les fonctions natives de Node pour les dates et les API Google.
Le suffixe `.cjs` permet l'utilisation de `require` et de `NODE_PATH`.

Pour lancer les tests avec un Node local récent et `tar` :

```bash
node --test bot.test.cjs
```

## Limites assumées

Simulation par défaut ; groupe contrôlé par identifiant et nom ; marqueur
anti-doublon avant l'envoi ; verrou de session partagé. Après une erreur, une
intervention peut être nécessaire : pas de rattrapage ni de reprise automatique.
Un envoi incertain n'est pas rejoué aveuglément. Ce n'est pas une garantie
« exactement une fois », ni un service critique avec supervision automatique.

`whatsapp-web.js` est [non officiel](https://wwebjs.dev/) : une mise à jour de
WhatsApp peut casser le bot et le compte peut être restreint. Utiliser un groupe
de test et, de préférence, un compte dédié. La session est sensible ; ne jamais
la publier dans GitHub. La faible charge ne garantit pas la gratuité de Google Cloud.
