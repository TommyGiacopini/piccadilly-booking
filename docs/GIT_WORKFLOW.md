# Piccadilly Booking — Workflow Git/GitHub

**Stato:** protocollo operativo permanente
**Data:** 10 agosto 2026
**Repository:** `TommyGiacopini/piccadilly-booking`
**Repository locale previsto:** `C:\progetti\piccadilly-booking`

## 1. Obiettivo e autorità

Codex deve poter completare una milestone nel repository locale, verificarla e pubblicarla sul feature branch corretto senza richiedere all'utente di copiare o caricare manualmente i file.

Questo documento aggiorna le precedenti restrizioni assolute su commit e push:

- `git commit` è autorizzato esclusivamente nel gate finale della milestone;
- `git push` è autorizzato esclusivamente dopo il commit finale e verso il feature branch autorizzato;
- non serve un'ulteriore conferma dell'utente quando tutte le condizioni di sicurezza di questo protocollo sono state dimostrate;
- se una condizione non è soddisfatta, commit e push non devono essere eseguiti.

L'autorizzazione non comprende Pull Request, merge, release, deploy, force push o altre operazioni distruttive. Queste operazioni richiedono una richiesta esplicita separata.

## 2. Regola fondamentale

Nessuna milestone incompleta, non testata, parzialmente corretta o con problemi noti deve essere pubblicata su GitHub.

Il push è l'ultimo passaggio della milestone, non un checkpoint intermedio. La possibilità tecnica di creare un commit o eseguire un push non costituisce motivo sufficiente per farlo.

Il flusso ordinario è:

```text
implementazione
→ test
→ audit e review
→ correzioni
→ verifica finale
→ staging controllato
→ commit finale
→ push del feature branch
→ report conclusivo
```

## 3. Modalità operativa

Operare in una modalità adatta ad “Approva per me”:

- minimizzare richieste di autorizzazione non necessarie;
- usare esclusivamente comandi consentiti;
- non ampliare autonomamente lo scope;
- fermarsi prima di operazioni non autorizzate;
- interpretare ogni incertezza significativa a sfavore del push.

Automatizzare il trasferimento non significa automatizzare l'approvazione tecnica: prima si dimostra che la milestone è corretta, poi la si pubblica.

## 4. Pre-flight obbligatorio

Prima di modificare il repository eseguire almeno:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
```

Verificare inoltre:

- directory e repository corretti;
- branch feature previsto per la milestone;
- stato della working tree;
- file già modificati o staged;
- modifiche residue da attività precedenti;
- corrispondenza del remote con il repository previsto.

Non sovrascrivere, eliminare o incorporare automaticamente modifiche preesistenti che non appartengono chiaramente al task. Non lavorare direttamente su `main`.

## 5. Implementazione

Implementare esclusivamente lo scope assegnato alla milestone. Durante lo sviluppo è consentito:

- leggere, creare e modificare i file pertinenti;
- eseguire formatter, lint, typecheck, test e build;
- eseguire controlli Prisma e database pertinenti e non distruttivi;
- correggere errori;
- eseguire audit e controllare il diff.

Durante questa fase non effettuare push e non pubblicare versioni parziali come checkpoint remoti.

## 6. Verifica della milestone

Prima di considerare conclusa la milestone eseguire almeno:

```powershell
git status --short
git diff --check
git diff
```

Eseguire inoltre tutti i controlli applicabili, inclusi quando pertinenti:

- test automatici, specifici della feature e di regressione;
- test negativi e casi limite;
- lint, typecheck e build;
- Prisma format, validate e generate;
- stato e applicazione delle migration nell'ambiente appropriato;
- seed e verifica della sua idempotenza;
- controlli PostgreSQL;
- audit sicurezza;
- verifica di API, autorizzazioni e rate limiting;
- verifica di concorrenza e idempotenza;
- controllo della documentazione.

Se un requisito o un bug necessita di un nuovo test di regressione, non limitarsi ai test già esistenti.

## 7. Review finale

Prima del commit riesaminare l'intero diff della milestone e verificare esplicitamente che:

1. tutti i requisiti siano implementati;
2. tutti i criteri di accettazione siano soddisfatti;
3. non esistano errori noti o finding di audit aperti;
4. non siano stati introdotti TODO temporanei o workaround non documentati;
5. non siano presenti segreti, file estranei o modifiche accidentali;
6. migration e seed siano coerenti, quando presenti;
7. i test siano adeguati;
8. la documentazione prevista sia aggiornata;
9. `git diff --check` sia pulito;
10. branch, repository e working tree siano ancora nello stato atteso.

Se emerge un problema rilevante, non procedere al commit o al push. Correggerlo e ripetere le verifiche pertinenti.

## 8. Gate di pubblicazione

Il gate è superato esclusivamente quando possono essere dimostrate tutte le condizioni seguenti:

- implementazione completa;
- test superati;
- review superata;
- audit superato, se previsto;
- diff pulito;
- nessun bloccante conosciuto;
- branch corretto.

Soltanto a questo punto sono autorizzati staging, commit e push finali.

## 9. Staging finale

Prima del commit:

1. ricavare l'elenco esatto dei file appartenenti alla milestone;
2. verificare che non contenga file estranei;
3. eseguire lo staging esplicito di quei file;
4. controllare nuovamente lo staging.

Eseguire almeno:

```powershell
git status --short
git diff --cached --check
git diff --cached
```

Lo staged diff deve corrispondere esattamente alla milestone. Se non corrisponde, non eseguire il commit.

## 10. Commit finale

Il messaggio di commit deve essere descrittivo, conciso, coerente con la milestone e conforme alle convenzioni del repository.

Dopo il commit verificare:

```powershell
git status --short
git rev-parse HEAD
git log -1 --oneline
```

## 11. Push finale

Prima del push verificare nuovamente il branch:

```powershell
git branch --show-current
```

Il push è consentito esclusivamente verso il feature branch corrente e deve essere un normale push non forzato.

Se il remote rifiuta il push, il branch remoto è divergente o emerge una situazione inattesa:

- non usare force push;
- analizzare il problema;
- fermarsi prima di operazioni potenzialmente distruttive.

`main` è protetto a livello procedurale anche se GitHub consentisse tecnicamente un push diretto. Il completamento di una milestone autorizza `feature branch → commit → push`, non `feature branch → merge main`.

## 12. Operazioni consentite

Quando necessarie al task sono consentite:

- ispezione Git con `git status`, `git diff`, `git log`, `git show`, `git branch`, `git rev-parse`, `git ls-files` e `git remote -v`;
- ricerca e lettura con strumenti non distruttivi;
- modifica dei file nello scope;
- formatter, lint, typecheck, test, build e strumenti npm/Node pertinenti;
- controlli Prisma pertinenti;
- controlli Docker non distruttivi;
- interrogazioni del database di sviluppo o test necessarie alla verifica;
- dopo il superamento del gate, `git add` dei file espliciti, `git commit` e `git push origin <feature-branch>`.

## 13. Operazioni vietate senza nuova autorizzazione esplicita

Sono vietati:

```text
git push origin main
git push origin master
git push --force
git push --force-with-lease
git merge
git rebase
git cherry-pick
git reset --hard
git clean -f
git clean -fd
git clean -fdx
git branch -D
git push origin --delete
git tag
git push --tags
```

Sono inoltre vietati senza autorizzazione esplicita separata:

- creazione o merge di Pull Request;
- creazione di release;
- deploy o pubblicazione in produzione;
- cancellazione o reset distruttivo di database;
- `prisma migrate reset`;
- `DROP` di database, schema o tabelle;
- cancellazione massiva di dati;
- eliminazione di file estranei al task;
- modifica o esposizione di segreti e credenziali;
- interventi su altri repository o branch non necessari alla milestone;
- ampliamento arbitrario dello scope.

Non aggirare i divieti usando comandi equivalenti.

## 14. Nessun push in caso di incertezza

Se non è certo che milestone, test, diff, audit, staging e branch siano corretti, non interpretare l'incertezza a favore del push.

La regola è: **incertezza significativa = niente push**.

## 15. Report finale obbligatorio

Dopo un push riuscito fornire almeno:

- milestone o attività completata;
- repository e branch;
- HEAD iniziale e finale;
- hash e messaggio del commit;
- file inclusi;
- test e controlli eseguiti con relativo risultato;
- risultato di `git diff --check`;
- verifiche Prisma o database, quando applicabili;
- audit eseguiti, quando applicabili;
- stato finale della working tree;
- remote del push;
- conferma che non sono stati effettuati merge o deploy;
- elementi che l'utente dovrebbe verificare su GitHub.
