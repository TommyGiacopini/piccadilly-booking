# Piccadilly Booking — Runbook staging personale Render (M13)

## 1. Stato e autorità

Questo runbook descrive il contratto M13 e le verifiche locali preparate per lo
staging personale. La Fase A autorizza solo implementazione e validazione
locale. Non autorizza Blueprint sync, provisioning, database Render, secret,
deploy, one-off job, piano a pagamento o test contro un URL remoto.

Qualunque operazione mutativa su Render richiede una futura autorizzazione
Controller esplicita. Il costo previsto del profilo congelato è circa
20,30 USD/mese.

## 2. Inventario congelato

Il file `render.yaml` dichiara:

- workspace Hobby;
- web `piccadilly-booking-m13-61a66b11-web`, `0.5c-512mb`, una istanza;
- worker `piccadilly-booking-m13-61a66b11-worker`, `0.5c-512mb`, una istanza;
- PostgreSQL `piccadilly-booking-m13-61a66b11-db`, `0.1c-256mb`, 1 GB;
- regione Frankfurt;
- branch `main`, preview e auto-deploy disabilitati;
- nessun custom domain, cron, Redis, persistent disk o Docker runtime.

Il contract test richiede cardinalità esatta: `services.length === 2` con un
solo web e un solo worker, nessun altro tipo di servizio, e
`databases.length === 1` con il solo PostgreSQL M13 congelato.

Il Blueprint non contiene token, URL database, password, identificativi di
account personali o secret provider.

## 3. Contratto di validazione Blueprint

Il finding del gate precedente è classificato come **EXTERNAL TOOLING CONTRACT
DRIFT — NON-IMPLEMENTATION DEFECT**. Render CLI `v2.25.0` richiede un workspace,
usa `ownerId`, richiede autenticazione ed esegue validazione semantica e conflict
checking workspace-aware. Questi controlli non appartengono alla Fase A locale.

La Fase A certifica esclusivamente:

- validazione di `render.yaml` contro il JSON Schema ufficiale Render;
- test permanenti del contratto Blueprint congelato;
- review statica dei field e value contro la specifica Render corrente.

Formula canonica:

> Official Render JSON Schema validation PASS; authenticated workspace-aware
> Render semantic validation deferred by contract to FASE C.

La review statica non certifica compatibilità o permessi del workspace,
disponibilità dei piani per l'account, conflict checking o accettazione
semantica del backend Render.

### Validazione futura Fase C

Soltanto dopo Local Final Quality Gate Work, pubblicazione Git, merge,
autorizzazione Controller all'accesso Render e autorizzazione economica separata,
la Fase C eseguirà, prima di qualsiasi create, sync o provisioning:

```text
render blueprints validate render.yaml --workspace <workspace> --output json
```

Il workspace sarà fornito soltanto al processo, senza essere versionato,
hardcoded o richiesto nell'evidence. L'autenticazione sarà configurata in modo
sicuro; nessun token potrà entrare in repository, `.env` repository, Blueprint,
log, evidence o rapporto. Il gate richiederà exit code 0, `valid=true` e review
del plan, della validazione semantica e dei conflitti workspace-aware.

## 4. Contratto di startup

Il web esegue build `npm ci && npm run db:generate && npm run build`. Il
pre-deploy valida l'ambiente, applica `prisma migrate deploy` e avvia il seed.
L'avvio usa `$PORT`, lo valida e binda Next a `0.0.0.0`; `SIGINT` e `SIGTERM`
vengono inoltrati al child e il relativo exit code viene conservato.

Il worker esegue build con typecheck e parte tramite
`npm run notifications:worker:staging`. Non applica migration. Verifica
`APP_ENV=staging`, Render, service type e kill gate provider; attende ogni due
secondi, fino a 120 secondi, che tutte le tredici migration versionate risultino
applicate. La readiness richiede uguaglianza esatta, cardinalità 13 e assenza di
duplicati tra inventario directory e migration concluse con successo: una
migration mancante o inattesa mantiene il worker in attesa. I segnali
interrompono l'attesa e vengono propagati al worker M12.

`APP_ENV`, non `NODE_ENV`, distingue staging e produzione. Render può e deve
usare `NODE_ENV=production` anche nello staging.

## 5. Secret e configurazioni future

Il web richiede valori Render secret-store separati per:

- `STAGING_ACCESS_PASSWORD`;
- `AUTH_DEMO_ADMIN_PASSWORD`;
- `AUTH_DEMO_STAFF_PASSWORD`.

I secret HMAC vengono generati dal Blueprint. Le password non devono comparire
in URL, log, evidence, file `.env`, shell history condivisa o repository. Il
worker riceve soltanto `APP_ENV` e `DATABASE_URL` oltre alle variabili Render
automatiche. Nessuna variabile provider reale è ammessa.

## 6. Seed staging

Il seed è idempotente e non sovrascrive password, ruolo o lifecycle degli utenti
già esistenti. Crea solo `Piccadilly Demo`, timezone `Europe/Rome`, utenti
`demo.admin` e `demo.staff`, contatti `@example.test`/`+390000...`, tavoli
`DEMO-*` e strategia `WHATSAPP_ONLY`. In staging l'URL pubblico deriva da
`RENDER_EXTERNAL_URL`, che deve essere una root HTTPS `*.onrender.com` senza
credenziali, query o fragment.

`APP_ENV=production` blocca sempre il seed, anche con `NODE_ENV` o altre
variabili contraffatte. Su un database staging appena migrato, reservation,
outbox, attempt e simulation receipt devono essere zero.

## 7. Superfici e controlli

- HTTP Basic opera solo con `APP_ENV=staging`;
- `/api/health` e `/robots.txt` sono le sole eccezioni;
- una credenziale assente o errata restituisce 401, `WWW-Authenticate` e
  `Cache-Control: no-store`;
- tutte le superfici mostrano il banner demo;
- staging emette `X-Robots-Tag: noindex, nofollow, noarchive`, metadata coerenti
  e `robots.txt` con `Disallow: /`;
- cookie staging e produzione sono Secure, HttpOnly, SameSite Lax, Path `/` e
  senza Domain;
- con trust proxy l'ultimo valore normalizzato degli header forwarded è
  autorevole;
- health restituisce solo stato servizio, ambiente e disponibilità database.

## 8. Tooling operativo futuro

I comandi sono CLI, non endpoint HTTP. Richiedono `APP_ENV=staging`, `RENDER=true`,
service type allow-listed, tenant demo esatto e database staging. Rifiutano
provider reali e produzione.

`staging:fake-data-scan` enumera globalmente ristoranti, impostazioni pubbliche,
prenotazioni e destinazioni notification. Richiede esattamente il tenant demo e
restituisce solo classi/conteggi sanitizzati; qualunque tenant o dato inatteso
fa fallire il gate senza stampare contatti.

```text
npm run staging:verify-seed
npm run staging:fake-data-scan
npm run staging:fingerprint -- --run-id RUN-YYYYMMDD-UNIQUE --manifest-path <absolute-process-local-pre-manifest>
npm run staging:verify-run -- --run-id RUN-YYYYMMDD-UNIQUE
npm run staging:cleanup-run -- --run-id RUN-YYYYMMDD-UNIQUE --confirm-run-id RUN-YYYYMMDD-UNIQUE --manifest-path <absolute-process-local-pre-manifest>
```

Il primo comando `fingerprint` deve essere eseguito **prima** della suite e crea
con scrittura esclusiva un manifest esterno al repository. Il manifest contiene
solo identità, conteggi e hash, non PII o secret. Copre reservation, assignment e
junction, audit reservation e generici anche con `entityId=null`, management
token, idempotenza, outbox/attempt/receipt, sessioni, login/public rate-limit e
service instance/availability.

Il flusso obbligatorio è: generazione run ID, acquisizione PRE, esecuzione E2E,
logout/teardown, cleanup, verifica `runRowsAfter=0`, calcolo POST e uguaglianza
PRE=POST. Il cleanup usa esclusivamente identità nuove rispetto al PRE, limita
l'ownership al tenant demo e al marker run quando disponibile, cancella in una
singola transazione nell'ordine FK corretto e fallisce su righe nuove non
attribuibili. Seed configuration, demo users, righe PRE non-run, altri run e
altri tenant non sono target.

## 9. Playwright staging futuro

La suite usa `playwright.staging.config.ts`, Chromium, un solo worker, nessun
webServer e nessun retry. Trace e screenshot sono trattenuti solo su failure.
Il processo richiede `STAGING_BASE_URL` HTTPS `*.onrender.com`, credenziali Basic,
Admin/Staff demo e run ID, ma deve essere avviato senza `DATABASE_URL`.

```text
npm run test:e2e:staging
```

La suite sceglie una data `Europe/Rome` a oggi +7, copre Basic gate, banner,
indicizzazione, health, booking pubblico e gestione, login Staff/Admin,
prenotazione telefonica con opt-out, configurazione notifiche, assegnazione,
PDF/Excel, cookie, Origin e viewport 390/820/1440. La Fase A non esegue questo
comando contro Render perché non esiste ancora un URL staging autorizzato.

## 10. Acceptance notifiche futura

In una fase remota autorizzata, un run dedicato deve creare una prenotazione
telefonica fittizia oltre tre ore, con conferma WhatsApp abilitata e strategia
`WHATSAPP_ONLY`. Dopo il worker si verificano outbox `SUCCEEDED`, un solo attempt,
una sola simulation receipt, provider `SIMULATED_WHATSAPP`, provider reference e
zero fallback. Un riavvio del worker non deve creare duplicati. Il run viene poi
rimosso con conferma esatta e fingerprint invariato.

Non esistono failure switch remoti e non sono ammesse comunicazioni WhatsApp,
email o provider reali.

## 11. Separazione dalla produzione

Il database staging non viene promosso. Produzione sarà ricreata su account del
ristorante con database, segreti, dominio, provider e backup nuovi. M14 e M15 non
sono avviate da questo runbook. ADR 004 resta la decisione autorevole sulla
separazione degli ambienti.
