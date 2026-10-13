# Installation de A à Z

Ce guide installe le bot en partant de l'image Docker. Celle-ci vient de
[drdpham/whatsapp-webjs](https://hub.docker.com/r/drdpham/whatsapp-webjs).

Pour une ancienne installation, lire d'abord [la migration](EXPLOITATION.md#migration)
plutôt que recréer les ressources ou laisser deux plannings actifs.

## 1. Préparer les comptes et le dossier

Il faut un compte Google Cloud avec facturation, un Google Sheets, un compte
WhatsApp et un groupe réservé au test. 

Le plus simple est de travailler dans **Google Cloud Shell** : importer l'archive
avec la fonction d'envoi de fichiers du terminal, puis la décompresser. 

Sinon, un poste avec Docker et [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install) 
convient aussi. Le cas échéant, sur le poste, s'authentifier avec `gcloud auth
login` ; dans Cloud Shell, autoriser le compte déjà connecté. Pas besoin de
credentials ADC ou de `gcloud auth application-default login` pour ce bot.

Dans Google Cloud Console, créer un _projet dédié_, relever son _identifiant_
(pas son nom d'affichage), puis lui associer un compte de facturation.
Créer également une alerte budgétaire dans Billing. Une alerte n'arrête pas les
services : voir les [budgets Google](https://docs.cloud.google.com/billing/docs/how-to/budgets).
Les commandes IAM ci-dessous supposent que ton compte peut administrer ce projet.

Depuis le dossier contenant l'archive (sauter `unzip` si elle est déjà extraite) :

```bash
unzip WhatsApp-Polls-Bot.zip
cd WhatsApp-Polls-Bot
cp config.env.example config.env
chmod 600 config.env
mkdir -p .local
chmod 700 .local
docker version
gcloud version
```

Éditer `config.env` et renseigner `PROJECT_ID`. Laisser pour le moment :

```bash
IMAGE='docker.io/drdpham/whatsapp-webjs:latest'
DRY_RUN='true'
```

`REGION='us-central1'` place les buckets et le job **aux États-Unis**, pour viser
les franchises gratuites de stockage. Choisir `europe-west1` avant la création
pour la Belgique, mais ne pas supposer les mêmes franchises. Le calendrier
reste en heure de Paris dans les deux cas. Il n'y a aucune garantie de facture
nulle : calcul, stockage, opérations et réseau sont à contrôler dans Billing.
Référence : [offre gratuite Google](https://docs.cloud.google.com/free/docs/free-cloud-features).

```bash
source config.env
gcloud config set project "$PROJECT_ID"
```

`source` interprète du Bash : charger uniquement ton propre fichier de confiance.
Après chaque modification du fichier, relancer `source config.env`. Cela ne
met pas automatiquement à jour les paramètres déjà enregistrés dans Google Cloud.

## 2. Récupérer et vérifier l'image existante

```bash
source config.env
docker pull "$IMAGE"

docker image inspect "$IMAGE" \
  --format 'Architecture={{.Architecture}} Entree={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}}'

docker run --rm --entrypoint node "$IMAGE" -e \
  'console.log(process.version); console.log(require("puppeteer").executablePath()); require("whatsapp-web.js"); require("qrcode-terminal");'
```

Attendu : point d'entrée
`["/usr/bin/tini","--","node","/app/bot.cjs"]`, commande `["run"]`, import des
packages réussi et chemin Chrome sous `/opt/puppeteer/`.
Le Dockerfile source est actuellement sur Node 24 ; le numéro affiché
par cette commande décrit l'image effectivement publiée.

Si le pull échoue, vérifier le nom **`drdpham/whatsapp-webjs`**, l'existence du tag
et la visibilité publique. 

### Tester le navigateur puis le bot

Ce test Chrome ne se connecte ni à Google ni à WhatsApp :

```bash
docker run --rm -i --entrypoint /usr/bin/tini \
  "$IMAGE" -- node - <<'JS'
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Image OK</title>');
    console.log(await browser.version(), await page.title());
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS

docker run --rm --entrypoint node \
  -v "$PWD/bot.cjs:/app/bot.cjs:ro" \
  -v "$PWD/bot.test.cjs:/app/bot.test.cjs:ro" \
  "$IMAGE" --test /app/bot.test.cjs
```

Attendu : `Image OK`, puis tous les tests réussis. Aucun package à installer ici :
ils ont été installés pendant la construction dans le dépôt Docker séparé.

Conseillé : conserver la référence exacte de cette image testée.

```bash
docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}'
```

Le résultat ressemble à `drdpham/whatsapp-webjs@sha256:...`. Copier ce résultat
entier dans `IMAGE` dans `config.env`, puis refaire `source config.env`. Un digest
identifie l'image testée ; `latest` peut être remplacé par une publication future.
Il est possible de garder `latest`, mais utiliser la même image pour l'appairage
et le déploiement évite de mélanger deux versions de navigateur.

## 3. Activer les services Google et créer les identités

```bash
source config.env
gcloud services enable \
  run.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com \
  sheets.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  logging.googleapis.com

gcloud iam service-accounts create wa-runtime --display-name='Bot WhatsApp'
gcloud iam service-accounts create wa-reader --display-name='Lecture calendrier Sheets'
gcloud iam service-accounts create wa-scheduler --display-name='Declenchement du bot'

gcloud iam service-accounts add-iam-policy-binding "$READER" \
  --member="serviceAccount:$RUNTIME" \
  --role='roles/iam.serviceAccountTokenCreator'
```

Ce sont trois _identités_, pas trois services qui tournent en permanence :
`runtime` exécute le bot, `reader` lit la feuille, `scheduler` lance le job.

Le token natif Cloud Run ne porte pas le scope Sheets : `runtime` demande donc
à IAM un token temporaire pour `reader`, avec `spreadsheets.readonly`.

La séparation évite notamment l'auto-délégation.
Référence : [identifiants temporaires IAM](https://docs.cloud.google.com/iam/docs/create-short-lived-credentials-direct).
Les autorisations peuvent mettre un peu de temps à se propager après leur création.

## 4. Préparer le calendrier Google Sheets

Générer 365 événements, en commençant demain à Paris :

```bash
docker run --rm \
  -e TIME_ZONE="$TIME_ZONE" \
  -v "$PWD/bot.cjs:/app/bot.cjs:ro" \
  "$IMAGE" calendar > .local/calendrier.csv

head -n 4 .local/calendrier.csv
```

Le début du CSV contient `Date,Actif,Titre`. Les lignes suivantes suivent ce modèle :

```csv
Date,Actif,Titre
2026-10-15,OUI,TEST — Événement du {date} : présent ?
2026-10-16,OUI,TEST — Événement du {date} : présent ?
2026-10-17,NON,TEST — Événement du {date} : présent ?
```

Ces trois dates ne sont qu'une illustration ; importer le fichier généré, pas cet
exemple figé. Depuis Cloud Shell, télécharger `.local/calendrier.csv` avec la
fonction de téléchargement de fichiers du terminal.

Dans Google Sheets, créer un tableur puis `Fichier → Importer → Importer un fichier`.
Choisir le CSV, séparateur virgule, et `désactiver la conversion des textes en
nombres, dates et formules`. Nommer l'onglet exactement `Evenements`.

La colonne A doit rester du _texte brut `AAAA-MM-JJ`_, pas une valeur _date_ Sheets.
Si l'import l'a convertie, la réimporter sans conversion : changer seulement le
format d'affichage ne répare pas toujours les valeurs sous-jacentes.

Chaque ligne décrit la date de l'événement, pas la date d'envoi. `OUI` l'active ;
`NON` ou la suppression de la ligne l'annule avant publication. La colonne `Titre`
est modifiable ; `{date}` sera remplacé par la date française. Un seul événement
actif par date. Le programme contrôle les trois en-têtes `Date`, `Actif`, `Titre`.

Afficher l'adresse à laquelle partager la feuille :

```bash
printf '%s\n' "$READER"
```

Dans `Partager`, ajouter cette adresse comme `Lecteur`. Ne pas choisir
« toute personne disposant du lien » et ne pas publier la feuille sur le Web.

Renseigner `SPREADSHEET_ID` dans `config.env` avec l'identifiant entre `/d/` et
`/edit` dans l'adresse du tableur, puis refaire `source config.env`.
Ce n'est ni l'adresse complète ni le numéro `gid` de l'onglet.

## 5. Créer les deux buckets privés

```bash
source config.env
gcloud storage buckets create "gs://$CODE_BUCKET" "gs://$STATE_BUCKET" \
  --location="$REGION" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --soft-delete-duration=0

gcloud storage buckets add-iam-policy-binding "gs://$CODE_BUCKET" \
  --member="serviceAccount:$RUNTIME" --role='roles/storage.objectViewer'

gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
  --member="serviceAccount:$RUNTIME" --role='roles/storage.objectUser'
```

Le bucket `code` sera monté en lecture seule. Le bot peut modifier son `état`,
mais pas remplacer son propre programme. La prévention d'accès public est activée.

Ici, `--soft-delete-duration=0` évite d'accumuler les anciennes archives de session
à chaque remplacement, mais _désactive la récupération après suppression_.
Ne pas activer non plus le versioning sans prévoir sa rétention. Le code reste
récupérable dans Git ; une session perdue nécessite un nouvel appairage ; la perte
des marqueurs d'envoi fait perdre la protection contre les doublons déjà envoyés.
Référence : [création des buckets](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/create).

## 6. Appairer WhatsApp et sélectionner le groupe

Créer le groupe `TEST bot sondages` avant cette étape, avec des personnes
prévenues. Le compte du bot doit en être membre et autorisé à envoyer des messages.

Depuis un terminal interactif, sur le poste ou dans Cloud Shell :

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/bot.cjs:/app/bot.cjs:ro" \
  -v "$PWD/.local:/secrets" \
  "$IMAGE" pair
```

Sur Android : `WhatsApp → Appareils connectés → Connecter un appareil`, puis
scanner le QR affiché. Le tableau présente les groupes et leurs identifiants.
Copier l'identifiant du groupe de test dans `GROUP_ID` et son nom exact dans
`GROUP_NAME`, dans `config.env`. Conserver les espaces et la casse du nom.

Attendre `session_saved` et le retour normal de la commande. Ne pas interrompre
juste après le scan : il faut fermer Chrome proprement et sauvegarder le profil.
`--user` permet d'écrire l'archive avec ton UID local, même si ce n'est pas 1000.

La liste lit seulement les noms et identifiants des groupes chargés, sans
sérialiser leurs messages et métadonnées via `getChats()`. Cela contourne
l'erreur `r: r` observée avec `whatsapp-web.js` 1.34.7. Cette lecture dépend
d'une interface interne de WhatsApp Web ; un format incompatible provoque une
erreur explicite, pas une liste partielle supposée fiable.

Les groupes dont le nom est vide sont affichés comme `(nom indisponible)`, avec
un avertissement `groups_without_name`. Ils n'empêchent pas de sélectionner les
autres groupes ; le groupe configuré doit toutefois avoir son nom exact et non
vide pour autoriser une publication.

Si la lecture des groupes échoue après connexion, la session est tout de même
sauvegardée après fermeture de Chrome, mais la commande termine en erreur.
`session_saved` seul ne suffit donc pas : ne pas continuer le déploiement sans
la liste des groupes et une fin normale. Une archive déjà présente peut provenir
d'une ancienne tentative ; sa seule présence ne prouve pas un nouvel appairage.
Voir [le dépannage](EXPLOITATION.md#depannage).

Pour relire les groupes depuis une archive sauvegardée lors de cette tentative,
sans nouveau QR, remplacer `pair` par `groups` dans la commande Docker ci-dessus.
Cette commande restaure puis sauvegarde la même session ; elle n'envoie aucun
sondage et refuse une session expirée au lieu d'afficher un QR.

```bash
ls -lh .local/session.tar.gz
chmod 600 .local/session.tar.gz
source config.env
```

L'archive est un **secret de connexion**, pas une simple configuration. Aucun
identifiant Google ni jeton Docker n'est monté dans le conteneur d'appairage.
La commande `pair` est refusée dans un job Cloud Run et sans terminal interactif.

## 7. Charger le code et la session

```bash
gcloud storage cp bot.cjs "gs://$CODE_BUCKET/bot.cjs"
gcloud storage cp .local/session.tar.gz "gs://$STATE_BUCKET/session.tar.gz"
```

Charger ces fichiers précis, _pas tout le dossier du projet_. Le code est à la
racine du bucket code ; la session à la racine du bucket état.
Ne pas recharger cette archive locale après chaque exécution : le job met à jour
la version cloud. Réutiliser l'ancienne archive pourrait annuler ces mises à jour.

## 8. Déployer Cloud Run en simulation

Vérifier `DRY_RUN='true'` dans `config.env`, puis :

```bash
source config.env
gcloud run jobs deploy "$JOB" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME" \
  --tasks=1 --parallelism=1 --max-retries=0 \
  --cpu=1 --memory=2Gi --task-timeout=10m \
  --args=run \
  --add-volume="name=code,type=cloud-storage,bucket=$CODE_BUCKET,readonly=true" \
  --add-volume-mount="volume=code,mount-path=/app" \
  --set-env-vars="^|^SPREADSHEET_ID=$SPREADSHEET_ID|SHEETS_READER=$READER|STATE_BUCKET=$STATE_BUCKET|GROUP_ID=$GROUP_ID|GROUP_NAME=$GROUP_NAME|DRY_RUN=$DRY_RUN|LEAD_DAYS=$LEAD_DAYS|TIME_ZONE=$TIME_ZONE"
```

Le préfixe `^|^` indique à gcloud d'utiliser `|` comme séparateur, ce qui tolère
les espaces et virgules dans le nom du groupe. Éviter un nom contenant `|`.
`config.env` est un fichier Bash d'administration : ne pas le passer à
`docker --env-file` ou `gcloud --env-vars-file` tel quel.

Ne pas ajouter `--source` : cela lancerait une construction alors que nous
utilisons ton image existante. Ne pas remplacer l'`ENTRYPOINT` de l'image : il lance
Tini puis Node avec notre fichier monté. 

Le montage `code` est pris en charge par Cloud Run : il ne faut installer ni `gcloud` 
ni `FUSE` dans l'image. Le profil actif Chrome, lui, reste dans `/tmp` ; la session
est copiée depuis et vers l'API Storage. FUSE n'a pas le verrouillage POSIX nécessaire
à un profil actif. Voir [volumes Cloud Storage](https://docs.cloud.google.com/run/docs/configuring/jobs/cloud-storage-volume-mounts).

Lancer manuellement la simulation :

```bash
gcloud run jobs execute "$JOB" --region="$REGION" --wait

gcloud logging read \
  "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\"" \
  --project="$PROJECT_ID" --freshness=1d --limit=40 \
  --format='table(timestamp,severity,jsonPayload.event,jsonPayload.date,jsonPayload.status,jsonPayload.message)'
```

Attendu : `planned` puis `dry_run`. Dans `Cloud Run → Jobs → ton job → Exécutions`,
ouvrir les logs permet aussi de voir la question complète dans le champ `question`.
`no_event` indique qu'aucune date active ne correspond à demain : vérifier la feuille.

Cette simulation _teste Sheets et l'identité Google_, mais n'ouvre pas WhatsApp
et ne valide pas encore la session. Une exécution en échec doit être corrigée avant
la suite. Voir [le dépannage](EXPLOITATION.md#depannage).

## 9. Valider une publication réelle et l'anti-doublon

Modifier `config.env` : `DRY_RUN='false'`. Puis appliquer la modification au job :

```bash
source config.env
gcloud run jobs update "$JOB" --region="$REGION" \
  --update-env-vars="DRY_RUN=$DRY_RUN"

gcloud run jobs execute "$JOB" --region="$REGION" --wait
```

Attendu : un sondage natif dans le groupe de test, avec le titre de demain,
les choix `oui` et `non`, et une seule réponse possible. Les logs montrent
`sent`, `session_saved`, puis `done`. `sent` signifie confirmation serveur, pas
preuve que tous les membres ont reçu ou lu le sondage.

Lancer immédiatement une seconde exécution :

```bash
gcloud run jobs execute "$JOB" --region="$REGION" --wait
```

Attendu : `already_recorded` avec `status: sent`, et aucun second sondage.
Un statut `pending` ne prouve pas un envoi : appliquer la procédure d'incident.
Ne pas supprimer un marqueur seulement pour obtenir un nouveau test.

## 10. Activer le déclenchement quotidien

Ne faire cette étape qu'après les validations précédentes : la création du
Scheduler active les futurs déclenchements.

```bash
gcloud run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:$SCHEDULER" --role='roles/run.invoker'

gcloud scheduler jobs create http "$JOB" \
  --location="$REGION" \
  --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$JOB:run" \
  --http-method=POST --headers='Content-Type=application/json' --message-body='{}' \
  --oauth-service-account-email="$SCHEDULER" \
  --oauth-token-scope='https://www.googleapis.com/auth/cloud-platform' \
  --attempt-deadline=180s --max-retry-attempts=0 --max-retry-duration=0s
```

L'appel vise l'API Google, donc utilise `OAuth`. `SCHEDULE='0 9 * * *'`
signifie chaque jour à 09 h dans `TIME_ZONE`. Le bot peut publier un peu après le
créneau de déclenchement, le temps de démarrer et se connecter. Références :
[planification](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule),
[paramètres Scheduler](https://docs.cloud.google.com/sdk/gcloud/reference/scheduler/jobs/create/http).

Pour vérifier la liaison Scheduler → Cloud Run dès maintenant :

```bash
gcloud scheduler jobs run "$JOB" --location="$REGION"
```

Avec le même événement déjà envoyé, le bot doit répondre `already_recorded`.
Un statut réussi de Scheduler confirme l'appel de `lancement`, pas la réussite
finale du bot : contrôler l'exécution Cloud Run et ses logs.

Le lendemain, vérifier une nouvelle publication réelle : cela teste la
restauration de session après un arrêt prolongé. Ensuite, fermer Cloud Shell ou
éteindre le poste n'arrête pas le planning. Ce projet ne programme ni relance
après panne, ni rattrapage, ni notification automatique d'incident.

## 11. Conserver le projet dans GitHub


`config.env` et `.local/` ne doivent jamais apparaître dans les fichiers à commiter.

Conserver une copie privée de `config.env` dans ton gestionnaire de fichiers sûr.

Aucun secret GitHub Actions à créer pour ce dépôt. Un push GitHub ne met à jour
ni le fichier cloud ni l'image ; la maintenance est décrite dans
[EXPLOITATION.md](EXPLOITATION.md).

## Repères de documentation officiels

Pour relire ou vérifier une commande après plusieurs mois :
[Dockerfile d'outils](https://raw.githubusercontent.com/cyber-g/Docker-Whatsapp-webjs/refs/heads/main/Dockerfile),
[`gcloud run jobs deploy`](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy),
[API Sheets](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get),
[sondages natifs](https://docs.wwebjs.dev/Poll.html),
[authentification WhatsApp](https://wwebjs.dev/guide/creating-your-bot/authentication.html).
