# Phase 1 : publier un sondage simple

Nous sommes repartis du principe `!sendpoll` du fichier officiel
[whatsapp-web.js/example.js](https://github.com/wwebjs/whatsapp-web.js/blob/main/example.js)
car le bot initial rencontrait un probleme de publication du sondage.
L'objectif etait de valider l'envoi seul, sans Sheets ni Cloud Run.

Un client `LocalAuth` reste connecte. Dans le groupe configure, `!sendpoll`
publie `TEST : present ?`, choix `oui` / `non`, une seule reponse.
Le groupe est filtre uniquement par `GROUP_ID` : pas de `getChat()` ni de
controle du nom, car la serialisation echouait avec l'erreur `r`.
Un retour sans identifiant n'est pas considere comme un echec : des sondages
ont ete observes dans WhatsApp avec `responseHasId:false`.
`poll_send_completed` signifie appel termine sans erreur, pas livraison confirmee.

Depuis la racine du depot, dans Cloud Shell :

```bash
source config.env
mkdir -p .local/poll-example
chmod 700 .local/poll-example
docker run --rm -it \
  --entrypoint /usr/bin/tini \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e GROUP_ID="$GROUP_ID" \
  -v "$PWD/examples/01-poll:/app:ro" \
  -v "$PWD/.local/poll-example:/secrets" \
  "$IMAGE" -- node /app/poll-example.cjs
```

Scanner le QR dans Android > WhatsApp > Appareils connectes, attendre `ready`,
puis envoyer `!sendpoll` dans le groupe de test (depuis le compte du bot ou
un participant). Toute personne du groupe peut declencher cette commande.
Les autres messages et groupes sont ignores. Aucun retry automatique.

Arreter avec Ctrl+C et attendre `stopped`. Le profil sensible est conserve
dans `.local/poll-example/profile`. Ne pas le partager, ni l'utiliser dans
deux conteneurs ou simultanement avec sa copie cloud. Les commandes deja
traitees sont memorisees seulement pendant cette execution.

Le mode historique `schedule` a valide quatre publications le **14 octobre
2026, de 10h10 a 10h20 Paris**. Il est maintenant expire, ne publie pas un
autre jour et ignore les commandes manuelles. Le mode manuel reste le defaut.

```bash
node --test examples/01-poll/poll-example.test.cjs
```

**Resultat observe :** envoi manuel, puis quatre sondages programmes visibles
dans WhatsApp avec un client continuellement connecte.
