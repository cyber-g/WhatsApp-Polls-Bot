# Installation du bot quotidien

Publication a **09h00 Europe/Paris** pour l'evenement actif du lendemain.
Cloud Scheduler prepare l'execution a **08h57**. Le code n'autorise aucun
nouvel envoi a partir de **09h15**. Utiliser un groupe de test.
La simulation est le defaut ; le premier envoi quotidien reel reste a valider.

Si les ressources existent deja, ne pas les recreer : suivre
[la migration](EXPLOITATION.md#migration). Un commit ne deploie rien.

## 1. Configuration et image

Dans Cloud Shell ou sur un poste avec Docker et gcloud :

```bash
cp config.env.example config.env
chmod 600 config.env
mkdir -p .local
chmod 700 .local
```

Configurer seulement `PROJECT_ID` et `REGION` a ce stade.
Laisser `SPREADSHEET_ID` et `GROUP_ID` vides : ils seront renseignes
respectivement aux **etapes 3 et 4**, avant le deploiement. Conserver :

```bash
DRY_RUN='true'
TIME_ZONE='Europe/Paris'
LEAD_DAYS='1'
SCHEDULE='57 8 * * *'
JOB='whatsapp-polls-daily'
```

`config.env` est un fichier Bash de confiance, pas un fichier `--env-file`.
Ne jamais y mettre de jeton, cle privee ou session.

```bash
source config.env
gcloud config set project "$PROJECT_ID"
docker pull "$IMAGE"
docker run --rm --entrypoint node "$IMAGE" -e \
  'console.log(process.version); console.log(require("puppeteer").executablePath()); require("whatsapp-web.js"); require("qrcode-terminal");'
docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}'
```

L'image `drdpham/whatsapp-webjs` fournit Node, Chromium et les packages
via `NODE_PATH=/opt/tools/node_modules`. Copier de preference le digest teste
dans `IMAGE`, puis refaire `source config.env`. Ne pas ecraser `NODE_PATH`.
Le depot ne construit aucune image. Configurer la facturation et une alerte
budgetaire ; `us-central1` est aux Etats-Unis, sans garantie de gratuite.

Tests sans connexion externe :

```bash
docker run --rm --entrypoint node \
  -v "$PWD:/app:ro" "$IMAGE" \
  --test /app/bot.test.cjs \
  /app/examples/01-poll/poll-example.test.cjs \
  /app/examples/02-cloud/cloud-poll-exercise.test.cjs
```

## 2. Identites et buckets prives

Pour une nouvelle installation seulement :

```bash
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  storage.googleapis.com sheets.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com logging.googleapis.com
gcloud iam service-accounts create wa-runtime --display-name='Bot WhatsApp'
gcloud iam service-accounts create wa-reader --display-name='Lecture Sheets'
gcloud iam service-accounts create wa-scheduler --display-name='Lancement du bot'
gcloud iam service-accounts add-iam-policy-binding "$READER" \
  --member="serviceAccount:$RUNTIME" --role=roles/iam.serviceAccountTokenCreator
gcloud storage buckets create "gs://$CODE_BUCKET" "gs://$STATE_BUCKET" \
  --location="$REGION" --uniform-bucket-level-access \
  --public-access-prevention --soft-delete-duration=0
gcloud storage buckets add-iam-policy-binding "gs://$CODE_BUCKET" \
  --member="serviceAccount:$RUNTIME" --role=roles/storage.objectViewer
gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
  --member="serviceAccount:$RUNTIME" --role=roles/storage.objectUser
```

`runtime` demande un jeton temporaire IAM pour `reader`, avec le scope
`spreadsheets.readonly`. Aucune cle JSON ni credentials ADC a monter.
La suppression douce des buckets est desactivee : une suppression n'est pas
recuperable. Les preconditions Storage, et non FUSE, protegent l'etat.

## 3. Calendrier Sheets

Creer un tableur prive, onglet **Evenements**, avec :

```csv
Date,Actif,Titre
2026-10-15,OUI,Cours du {date} : present ?
2026-10-16,NON,Cours du {date} : present ?
```

Ces dates sont illustratives. Une ligne decrit la date de l'evenement ;
le sondage est publie la veille. Colonne A : **texte brut AAAA-MM-JJ**,
pas une date Sheets numerique. Desactiver la conversion automatique a l'import.
`OUI` active, `NON` ou une ligne absente annule. Un seul evenement actif par
date ; les dates impossibles et les doublons provoquent une erreur.
`Titre` vide utilise le titre de test par defaut. `{date}` devient `JJ/MM/AAAA`.

Le generateur historique fournit 365 lignes a partir de demain :

```bash
docker run --rm -v "$PWD:/app:ro" "$IMAGE" calendar > .local/calendrier.csv
```

Partager le tableur comme **Lecteur** avec l'adresse `$READER`, sans le rendre
public. Dans l'URL du tableur ouvert depuis Drive :

```text
https://docs.google.com/spreadsheets/d/IDENTIFIANT_DU_TABLEUR/edit...
```

Copier uniquement la partie entre `/d/` et `/edit` dans `config.env` :

```bash
SPREADSHEET_ID='identifiant-copie-depuis-url'
```

Ce n'est ni l'URL complete ni le `gid` de l'onglet. Refaire `source config.env`.

## 4. Session WhatsApp

Pour une session nouvelle seulement, apres arret des autres clients :

```bash
mkdir -p .local/daily
chmod 700 .local/daily
docker run --rm -it \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/app:ro" -v "$PWD/.local/daily:/secrets" \
  "$IMAGE" pair
```

Sur Android : WhatsApp > Appareils connectes > Connecter un appareil.
Scanner le QR, attendre `ready`, puis `session_saved` et la sortie normale.
Le mode `pair` n'envoie rien et ne lit pas les groupes.
Le profil et l'archive sont sensibles ; ne jamais les joindre aux logs.

### Obtenir GROUP_ID

L'identifiant technique n'est pas le nom du groupe, un numero de telephone
ou son lien d'invitation. Le compte appaire doit etre membre du groupe cible.
Apres la fin de `pair`, lancer depuis la racine du depot :

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/app:ro" -v "$PWD/.local/daily:/secrets" \
  "$IMAGE" group-id
```

Cette commande reutilise le profil local de l'etape precedente et ne demande
pas `GROUP_ID`. Si un QR est demande, le scanner comme pour `pair`.
Attendre **`awaiting_group_id`**, puis envoyer exactement **`!groupid`**
depuis Android dans le **groupe cible**, avec le compte du bot ou un participant.
Ne pas l'envoyer en conversation privee. Le programme lit uniquement `from`
ou `to` du message ; il n'appelle ni `getChats()` ni `getChat()`.
Il ne publie aucun message ou sondage. Il affiche par exemple :

```json
{"event":"group_id","GROUP_ID":"123456789@g.us"}
```

Copier l'identifiant complet, suffixe **`@g.us` inclus**, dans `config.env` :

```bash
GROUP_ID='identifiant-complet-copie@g.us'
```

L'exemple ci-dessus n'est pas un identifiant a reutiliser. Verifier le groupe
dans lequel la commande a ete envoyee : le nom du groupe n'est pas controle.
Attendre `session_saved` et la fin normale avant de charger l'archive :
`group-id` ferme Chrome et actualise l'archive apres la lecture.
Sans commande valide en trois minutes, il termine en erreur ; corriger
la cause avant de relancer. `groups`, l'ancien mode de liste, reste retire.
Refaire `source config.env` apres avoir renseigne les deux identifiants.

Ne jamais lancer cette commande sur une ancienne copie locale d'une session
deja utilisee dans le cloud : cette procedure concerne une installation neuve,
avant le premier chargement.

```bash
gcloud storage cp --if-generation-match=0 .local/daily/session.tar.gz \
  "gs://$STATE_BUCKET/session.tar.gz"
```

La precondition refuse de remplacer une session existante.
Pour reutiliser la session cloud validee des exercices, suivre la migration,
**sans recharger l'ancienne archive locale**.

### Remplacer volontairement une session existante

Uniquement apres un **nouvel appairage valide**, termine par `session_saved`
et une sortie normale : suspendre tous les plannings concernes et attendre
la fin des executions et conteneurs utilisant cette session.
La commande suivante **ecrase volontairement l'archive cloud**, sans precondition.
Ne pas l'utiliser avec une ancienne copie locale pour contourner une erreur.

```bash
source config.env
(
  set -euo pipefail
  TRACKER_DIR=$(mktemp -d "$PWD/.local/gcloud-upload-XXXXXX")
  CLOUDSDK_STORAGE_TRACKER_FILES_DIRECTORY="$TRACKER_DIR" \
    gcloud storage cp .local/daily/session.tar.gz \
      "gs://$STATE_BUCKET/session.tar.gz"
)
```

Le dossier de suivi neuf evite de reprendre un ancien transfert ayant conserve
une precondition incompatible (`Resuming upload`, puis erreur 412).
Cette commande ne supprime ni les marqueurs anti-doublon ni les verrous.
Si le remplacement echoue, ne pas reprendre le planning avant investigation.

## 5. Charger et verifier le code

Les trois fichiers sont requis, avec leurs chemins :

```bash
(
  set -euo pipefail
  for file in bot.cjs lib/runtime.cjs lib/poll.cjs; do
    gcloud storage cp "$file" "gs://$CODE_BUCKET/$file"
    local_hash=$(sha256sum "$file" | cut -d ' ' -f1)
    cloud_output=$(gcloud storage cat "gs://$CODE_BUCKET/$file" | sha256sum)
    cloud_hash=$(printf '%s\n' "$cloud_output" | cut -d ' ' -f1)
    test "$local_hash" = "$cloud_hash" || {
      printf 'ERREUR : copie cloud differente pour %s\n' "$file"
      exit 1
    }
    printf 'VERIFIE : %s %s\n' "$file" "$cloud_hash"
  done
)
```

Ne pas continuer sans les trois lignes `VERIFIE`. Suspendre Scheduler et
attendre la fin des executions avant de modifier le code partage.

## 6. Deployer en simulation

```bash
source config.env
gcloud run jobs deploy "$JOB" \
  --region="$REGION" --image="$IMAGE" --service-account="$RUNTIME" \
  --tasks=1 --parallelism=1 --max-retries=0 \
  --cpu=1 --memory=2Gi --task-timeout=20m --args=run \
  --add-volume="name=code,type=cloud-storage,bucket=$CODE_BUCKET,readonly=true" \
  --add-volume-mount="volume=code,mount-path=/app" \
  --set-env-vars="SPREADSHEET_ID=$SPREADSHEET_ID,SHEETS_READER=$READER,STATE_BUCKET=$STATE_BUCKET,GROUP_ID=$GROUP_ID,DRY_RUN=true,TIME_ZONE=Europe/Paris,LEAD_DAYS=1"
gcloud run jobs execute "$JOB" --region="$REGION" --wait
```

Le point d'entree de l'image est Tini puis Node `/app/bot.cjs`.
Pour un Job existant avec un ancien override, utiliser explicitement
`--command=/usr/bin/tini --args="--,node,/app/bot.cjs,run"` lors du deploiement.
Le profil actif reste dans `/tmp`, jamais dans le montage FUSE.

Attendu : `planned`, `dry_run` (ou `no_event` si demain est absent/inactif).
Simulation possible a toute heure : elle valide Sheets et IAM, pas WhatsApp.
Les options du bot ne sont pas une preuve de livraison ; garder le groupe de test.

## 7. Activer le quotidien

Apres simulation reussie, appliquer l'envoi reel :

```bash
gcloud run jobs update "$JOB" --region="$REGION" --update-env-vars=DRY_RUN=false
gcloud run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:$SCHEDULER" --role=roles/run.invoker
gcloud scheduler jobs create http "$JOB" --location="$REGION" \
  --schedule='57 8 * * *' --time-zone=Europe/Paris \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$JOB:run" \
  --http-method=POST --headers='Content-Type=application/json' --message-body='{}' \
  --oauth-service-account-email="$SCHEDULER" \
  --oauth-token-scope='https://www.googleapis.com/auth/cloud-platform' \
  --max-retry-attempts=0 --max-retry-duration=0s
```

Pour un Scheduler existant : `update http` au lieu de `create http`,
puis `resume` apres les verifications. Ne laisser aucun ancien planning actif.
Ne pas lancer un job reel hors 08h57-09h15 : il ignore le creneau sans envoyer.

Verifier le prochain matin : `ready`, eventuellement `waiting_for_slot`,
`poll_send_completed`, `call_completed`, `session_saved`, `done`, et le sondage
visible dans WhatsApp. Un retour sans ID n'est pas une erreur ; aucune livraison
ou lecture n'est garantie par le log. Une seconde execution pour la meme date
repond `already_recorded`, sans renvoyer, meme pour un ancien statut `sent`.

Voir [exploitation](EXPLOITATION.md) pour les logs courts et les incidents.
Scheduler confirme seulement le lancement, pas le succes du traitement.
Un verrou conserve peut bloquer les jours suivants jusqu'a intervention.

References : [jobs planifies](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule),
[API Sheets](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get),
[LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html),
[preconditions GCS](https://docs.cloud.google.com/storage/docs/request-preconditions).
