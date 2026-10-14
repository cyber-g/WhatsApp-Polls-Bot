# Exercice Cloud Run : executions independantes anticipees

Le **14 octobre 2026, Europe/Paris**, quatre sondages fixes :

| Publication cible | Declenchement Scheduler | Limite de debut d'envoi |
| --- | --- | --- |
| 12h30 | 12h27 | avant 12h32 |
| 12h32 | 12h29 | avant 12h34 |
| 12h34 | 12h31 | avant 12h36 |
| 12h36 | 12h33 | avant 12h38 |

Chaque execution publie une seule fois `TEST : present ?`, choix `oui` / `non`,
via le mecanisme valide de `poll-example.cjs`. Pas de Sheets, de lecture des
groupes, d'ACK obligatoire ni de retry d'envoi. Le bot actuel n'est pas reecrit.

## Pourquoi anticiper

Lors du test de 11h10-11h18, Scheduler a cree les quatre executions a l'heure.
Seule la premiere a publie. Les autres ont atteint le programme ou `ready`
apres leur limite : `outside_window`. Les restaurations de 11h14 et 11h16
ont pourtant atteint `ready` et sauvegarde la session.

Lors du test de 11h50-11h58, les quatre jobs ont execute l'ancien code cloud,
qui refusait leurs nouveaux horaires avant toute connexion. Pour ce test,
la verification des horaires et des empreintes du code est obligatoire.

Scheduler declenche maintenant trois minutes avant la publication cible.
Un verrou partage protege la session : les conteneurs peuvent demarrer en
parallele, mais **un seul restaure et utilise WhatsApp a la fois**. Les autres
attendent sa fermeture et la sauvegarde, puis lisent l'archive actualisee.
Un client pret en avance attend son heure cible. Un client pret en retard
publie seulement avant le creneau suivant. Aucun envoi ne commence a partir
de 12h38 ; un appel deja commence peut finir apres.

L'avance reduit le risque observe, sans garantir la ponctualite de Cloud Run.
Chaque connexion est independante ; aucun client ne publie plusieurs sondages.
Les logs `scheduledAt` indiquent la cible, pas l'heure reelle de livraison.

## 1. Preparation avant 12h27

Importer la structure actuelle du depot dans Cloud Shell, notamment
`examples/01-poll`, `examples/02-cloud` et `lib`. Les anciens declencheurs
11h10-11h16 et 11h50-11h56 doivent rester suspendus et leurs executions terminees.
Ne pas relancer le profil Docker local ni aucun autre job utilisant cette
session pendant ce test.

**Reutiliser la session cloud actualisee du premier test**, pas l'archive
locale : aucune nouvelle extraction, aucun appairage, aucun remplacement
de session. Les nouveaux creneaux ont de nouveaux marqueurs ; les anciens
marqueurs et logs restent intacts.

```bash
source config.env
EXERCISE_PREFIX='exercises/fixed-20261014'

gcloud storage objects describe \
  "gs://$STATE_BUCKET/$EXERCISE_PREFIX/session.tar.gz"
gcloud storage ls "gs://$STATE_BUCKET/$EXERCISE_PREFIX/"
```

Si `lock.json` apparait, **arreter ici** et analyser les executions precedentes.
Ne pas supprimer un verrou pour forcer ce test. Les logs du premier exercice
montrent une fin normale, mais cette verification protege contre une autre
execution intervenue depuis.

Charger seulement le code et verifier les copies avant de deployer.
Ce bloc refuse un fichier Cloud Shell avec les anciens horaires et s'arrete
si une copie cloud differe :

```bash
(
  set -euo pipefail
  grep -Fx "const SLOTS = ['12:30', '12:32', '12:34', '12:36'];" \
    examples/02-cloud/cloud-poll-exercise.cjs
  for file in examples/02-cloud/cloud-poll-exercise.cjs \
    examples/01-poll/poll-example.cjs lib/runtime.cjs; do
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

Ne pas continuer si ce bloc echoue. Les trois lignes `VERIFIE` sont requises.
Verifier `GROUP_ID` : seul l'identifiant du groupe est controle, pas son nom.
Les API, buckets prives et droits des comptes `$RUNTIME` / `$SCHEDULER`
sont ceux du premier exercice. Les objets du bot actuel restent intacts.

## 2. Deployer avant 12h27

Nouveaux jobs et declencheurs : ne pas reactiver ceux des tests precedents.
Le timeout passe a **6 minutes**, pour permettre l'attente avant publication
et l'attente du verrou. Ce n'est pas une extension des limites d'envoi.

```bash
(
  set -e
  for minute in 30 32 34 36; do
    trigger=$((minute - 3))
    name="wa-fixed-20261014-12$minute"
    gcloud run jobs deploy "$name" \
      --region="$REGION" --image="$IMAGE" --service-account="$RUNTIME" \
      --tasks=1 --parallelism=1 --max-retries=0 \
      --cpu=1 --memory=2Gi --task-timeout=360s \
      --command=/usr/bin/tini \
      --args="--,node,/app/examples/02-cloud/cloud-poll-exercise.cjs" \
      --add-volume="name=code,type=cloud-storage,bucket=$CODE_BUCKET,readonly=true" \
      --add-volume-mount="volume=code,mount-path=/app" \
      --set-env-vars="STATE_BUCKET=$STATE_BUCKET,GROUP_ID=$GROUP_ID,FIXED_POLL_SLOT=12:$minute"

    gcloud run jobs add-iam-policy-binding "$name" --region="$REGION" \
      --member="serviceAccount:$SCHEDULER" --role=roles/run.invoker

    gcloud scheduler jobs create http "$name" --location="$REGION" \
      --schedule="$trigger 12 14 10 *" --time-zone=Europe/Paris \
      --uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$name:run" \
      --http-method=POST --headers='Content-Type=application/json' \
      --message-body='{}' --oauth-service-account-email="$SCHEDULER" \
      --oauth-token-scope='https://www.googleapis.com/auth/cloud-platform' \
      --max-retry-attempts=0 --max-retry-duration=0s
  done
)
```

Une planification creee apres son heure ne rattrape pas le declenchement.
Ne pas lancer manuellement les jobs pour compenser.

## 3. Lire les resultats

Les logs n'apparaissent pas automatiquement dans le terminal de deploiement.
Vue courte : uniquement les fins d'envoi, sauvegardes, fins d'execution,
creneaux ignores et erreurs applicatives. Le filtre elimine les logs
d'infrastructure (notamment GCSFuse), et `csv` produit une ligne par evenement :

```bash
gcloud logging read \
  'resource.type="cloud_run_job"
   AND resource.labels.job_name=~"^wa-fixed-20261014-12(30|32|34|36)$"
   AND timestamp>="2026-10-14T10:27:00Z"
   AND timestamp<="2026-10-14T10:41:00Z"
   AND jsonPayload.event=("poll_send_completed" OR "session_saved" OR "done" OR "slot_skipped" OR "error" OR "exercise_blocked")' \
  --project="$PROJECT_ID" --order=asc --limit=100 \
  --format='csv(timestamp,resource.labels.job_name,jsonPayload.event,jsonPayload.slot,jsonPayload.reason,jsonPayload.message)'
```

Une reussite normale donne 12 lignes : trois par job. Pour les etapes
de connexion et d'attente, remplacer la derniere condition du filtre par
`AND jsonPayload.event:*`. Ce filtre reste applicatif ; il ne montre pas
les erreurs de plateforme ni les arrets forces. Si un job n'a pas de fin,
consulter aussi son etat d'execution et ses logs sans ce filtre.

Evenements : `execution_started`, eventuellement `waiting_for_session`,
`session_locked`, `ready`, eventuellement `waiting_for_slot`,
`poll_send_completed`, `session_saved`, `done`.

`responseHasId:false` n'est pas une erreur : verifier les quatre sondages
visuellement dans WhatsApp. Une execution verte ne prouve pas une publication :
un creneau expire est signale par `slot_skipped`.

La reservation atomique avant envoi reste durable. Une erreur incertaine
conserve le marqueur `pending` et le verrou. Les executions suivantes attendent
le verrou jusqu'a leur limite puis echouent explicitement, sans supprimer ni
voler le verrou. L'attente du verrou n'est pas une nouvelle tentative d'envoi.
Une erreur de permission ou de reseau n'est pas assimilee a un verrou occupe.
Ce mecanisme ne garantit pas exactement-une-fois.

## 4. Apres 12h38

Suspendre ces nouveaux cron annuels (la garde de date interdit aussi les envois
un autre jour) :

```bash
for minute in 30 32 34 36; do
  gcloud scheduler jobs pause "wa-fixed-20261014-12$minute" --location="$REGION"
done
```

Les jobs s'arretent seuls. Conserver la session cloud, les marqueurs et les logs.
Ne pas recharger d'ancienne archive ni supprimer de verrou sans investigation.

Tests locaux sans Google/WhatsApp :

```bash
node --test examples/02-cloud/cloud-poll-exercise.test.cjs examples/01-poll/poll-example.test.cjs
```

**Resultat observe le 14 octobre 2026 :** quatre sondages visibles dans WhatsApp
et quatre sequences `ready`, `waiting_for_slot`, `poll_send_completed`,
`session_saved`, `done`. Cet exercice est historique et sa fenetre est expiree.
