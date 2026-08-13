# Piccadilly Booking

Monolite modulare Next.js del sistema proprietario di prenotazione del Risto Pizza Piccadilly. M9-A aggiunge la fondazione audit; M9-B implementa il lifecycle degli account; M9-C rende amministrabili servizi, capacità e cutoff; M9-D aggiunge istanze lazy, disponibilità sale e catalogo tavoli; M9-E configura contatti, contenuti IT/EN e durata dei nuovi link; M9-F aggiunge la consultazione Admin read-only dell'audit. Le tranche M9-A–M9-F sono implementate e hanno superato la revisione tecnica indipendente Work. Il change set M9 è tracciato nella PR #10; deploy e milestone successive sono gestiti separatamente.

## Requisiti locali

- Node.js 20.9 o successivo;
- npm;
- Git;
- Docker Desktop con Docker Compose.

Tutti i dati di sviluppo e staging devono essere fittizi. PostgreSQL è l'unica fonte ufficiale dei dati.

## Installazione e variabili

```bash
npm install
```

Copiare `.env.example` in `.env`. I valori inclusi sono esclusivamente locali e fittizi; `.env` è escluso da Git.

Le variabili locali principali sono:

| Variabile | Valore locale fittizio | Scopo |
| --- | --- | --- |
| `AUTH_RESTAURANT_ID` | UUID deterministico del ristorante demo | Limita il login al ristorante configurato. |
| `AUTH_RATE_LIMIT_SECRET` | stringa locale di almeno 32 caratteri | Anonimizza con HMAC le chiavi del rate limit. Deve essere diversa e segreta fuori dallo sviluppo. |
| `AUTH_TRUST_PROXY` | `false` | Abilita l'uso degli header proxy soltanto dietro un proxy noto e correttamente configurato. |
| `AUTH_DEMO_ADMIN_PASSWORD` | password locale fittizia | Password usata dal seed per l'Admin demo. |
| `AUTH_DEMO_STAFF_PASSWORD` | password locale fittizia | Password usata dal seed per lo Staff demo. |
| `RESERVATION_PRIVACY_POLICY_VERSION` | `local-demo-v1` | Versione tecnica locale e fittizia registrata sulle prenotazioni; non è una policy legale definitiva. |
| `RESERVATION_TERMS_VERSION` | `local-demo-terms-v1` | Versione tecnica locale e fittizia delle condizioni accettate via web. |
| `RESERVATION_IDEMPOTENCY_TTL_HOURS` | `24` | Durata delle chiavi di idempotenza persistenti, limitata dal runtime a 1–168 ore. |
| `PUBLIC_BOOKING_MANAGEMENT_SECRET` | stringa locale di almeno 32 caratteri | Deriva con HMAC i token personali. Deve rimanere stabile per mantenere validi i link e deve essere diversa fuori dallo sviluppo. |
| `PUBLIC_BOOKING_RATE_LIMIT_SECRET` | stringa locale di almeno 32 caratteri | Anonimizza le identità tecniche dei bucket pubblici PostgreSQL. |
| `PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS` | `900` | Finestra condivisa del rate limit pubblico. |
| `PUBLIC_BOOKING_READ_LIMIT` | `60` | Numero massimo di letture per azione e identità nella finestra. |
| `PUBLIC_BOOKING_MUTATION_LIMIT` | `10` | Numero massimo di creazioni/modifiche/cancellazioni per azione e identità nella finestra. |

L'applicazione valida le variabili di autenticazione. Il seed rifiuta sempre gli utenti demo quando `APP_ENV=production` e il runtime rifiuta in produzione il segreto locale presente nell'esempio.

## PostgreSQL e Prisma

Avviare PostgreSQL locale e verificare che sia healthy:

```bash
docker compose up -d postgres
docker compose ps
```

Generare Prisma Client, applicare le migrazioni e inserire i dati fittizi:

```bash
npm run db:generate
npm run db:migrate:deploy
npm run db:seed
```

Le migrazioni sono progressive:

- `20260731120000_create_restaurant_foundation`: ristorante demo;
- `20260802153732_add_authentication_users_sessions_rate_limits`: autenticazione M3;
- `20260803090743_add_operational_configuration`: configurazione operativa M4.
- `20260803141513_add_reservation_core`: nucleo persistente delle prenotazioni M6.
- `20260810090000_add_public_booking_management`: prenotazione pubblica, link personale, audit e rate limit M7.
- `20260810160000_add_authenticated_reservation_audit`: autore, ruolo e metadati dell'override per l'audit autenticato M8.
- `20260812090000_add_admin_audit_foundation`: `AuditEvent`, lifecycle delle date straordinarie e sanificazione minimizzata degli snapshot legacy M9-A.
- `20260812120000_add_user_lifecycle`: flag `mustChangePassword` per il lifecycle account M9-B.
- `20260812160000_add_generic_booking_cutoff_rules`: regole generiche di cutoff pubblico M9-C e vincoli V1 per slot da 15 minuti e finestra da 30 minuti.
- `20260812200000_add_service_instance_room_availability`: istanze servizio minimali, disponibilità per sala e policy del catalogo fisso M9-D, senza backfill.
- `20260813123000_add_public_settings_and_content`: contatti pubblici e sette contenuti editoriali IT/EN M9-E, senza modificare prenotazioni o token.

La migrazione M4 aggiunge:

- `Room` e la relazione `Restaurant.rooms`;
- `DiningTable` e la relazione `Room.diningTables`;
- `WeeklyServiceSchedule` per giorno, servizio e intervallo slot;
- `RestaurantBookingSettings` in relazione uno-a-uno con il ristorante;
- `SpecialDateOverride` per eccezioni complete, pranzo o cena;
- gli enum `ServiceType`, `DayOfWeek` e `SpecialDateScope`.

La migrazione M6 aggiunge `Reservation`, `ReservationIdempotencyKey` e i soli enum iniziali necessari: origini `STAFF`/`PHONE`, stati `CONFIRMED`/`CANCELLED` e consenso `VERBAL`/`STAFF_RECORDED`. `localDate` usa `DATE`, `arrivalTime` usa `TIME(0)` e gli identificativi usano UUID. Vincoli SQL proteggono coperti positivi, coerenza fra stato e `cancelledAt`, consenso e origine, override e motivo, autore obbligatorio per le origini correnti e scadenza dell'idempotenza. L'indice di capacità copre ristorante, data, servizio, stato e orario.

La migrazione M7 estende origine e consenso con `PUBLIC` e `WEB_CHECKBOX`, aggiunge la durata configurabile del link, il versionamento delle modifiche, condizioni e lingua del consenso, `ReservationManagementToken`, `PublicReservationRateLimit` e `ReservationAuditEvent`. I vincoli impediscono a una prenotazione pubblica di avere un autore Staff o un override e richiedono entrambi i consensi web versionati.

La migrazione M9-A mantiene `ReservationAuditEvent` e aggiunge `AuditEvent` per autenticazione, identità futura e configurazione. Gli snapshot prenotazione legacy vengono trasformati in una whitelist operativa senza modificare prenotazioni, contatti, consensi, token, righe audit o correlation ID. `SpecialDateOverride.archivedAt` sostituisce la cancellazione fisica con archiviazione e ripristino.

La migrazione M9-C trasferisce i cutoff pubblici iniziali del venerdì e sabato sera in `BookingCutoffRule`, verifica il backfill e rimuove i due campi legacy nella stessa migrazione. Il modello ammette una regola per ristorante, giorno e servizio; i vincoli PostgreSQL rendono invarianti gli slot da 15 minuti e la finestra mobile da 30 minuti. La migrazione non modifica prenotazioni o audit esistenti.

La migrazione M9-D verifica il catalogo canonico, assegna `DEFAULT_AVAILABLE` a Sala 1–3 ed `EXPLICIT_ONLY` a Galleria/Terrazzo, quindi crea `ServiceInstance` e `ServiceRoomAvailability`. Non copia orari, capacità o cutoff, non collega né modifica prenotazioni e non materializza servizi in backfill.

La migrazione M9-E crea `RestaurantPublicSettings` e `PublicContent`, con locale e chiavi in allow-list, unicità tenant e vincoli di formato e lunghezza. Non modifica durata, scadenze, hash, prenotazioni, utenti o audit esistenti.

PostgreSQL usa colonne native `TIME(0)` per gli orari del giorno e `DATE` per le date locali. Il codice converte questi valori al bordo Prisma usando esclusivamente campi UTC della rappresentazione JavaScript: non viene associata una data operativa fittizia e una data come `2026-10-25` non slitta a causa della conversione `Europe/Rome`/UTC. I vincoli SQL impediscono intervalli invertiti, slot o capacità non positivi, posti massimi inferiori ai minimi e duplicati di sale, tavoli, regole settimanali o eccezioni.

Il seed è idempotente e mantiene un solo ristorante `Piccadilly Demo`, un Admin e uno Staff fittizi insieme alla configurazione. Le impostazioni, gli orari e le regole di cutoff già esistenti non vengono ripristinati o riattivati. Contatti `example.test` e testi dimostrativi IT/EN vengono creati soltanto se mancanti; valori Admin e durata del link non vengono sovrascritti. Il seed rifiuta sempre le credenziali demo con `APP_ENV=production`.

## Configurazione demo M4

Tutti i valori sono locali, esclusivamente fittizi e destinati a sviluppo o staging. Il seed crea le sale in questo ordine:

1. Sala 1;
2. Sala 2;
3. Sala 3;
4. Galleria;
5. Terrazzo.

Ogni sala contiene un solo tavolo dimostrativo, riconoscibile dal prefisso `DEMO-`. I tavoli non descrivono la disposizione reale, non costituiscono una planimetria e non vengono assegnati automaticamente.

In assenza di giorni di chiusura reali approvati nei documenti, il calendario seed abilita in modo chiaramente dimostrativo pranzo e cena in tutti i giorni della settimana:

| Servizio | Orario locale | Slot |
| --- | --- | --- |
| Pranzo | 12:00–14:00 | 15 minuti |
| Cena | 19:00–22:15 | 15 minuti |

Le impostazioni iniziali sono:

- capacità mobile: 30 coperti;
- finestra mobile: 30 minuti, fissa nella prima versione secondo D-003/ADR 003;
- valutazione: slot da 15 minuti;
- modifica/cancellazione pranzo: entro le 10:30 dello stesso giorno;
- modifica/cancellazione cena: entro le 17:30 dello stesso giorno;
- nuova cena online di venerdì e sabato: entro le 17:30 dello stesso giorno;
- timezone operativa: `Europe/Rome`.

Capacità, orari, abilitazione dei servizi e cutoff sono gestiti dall'Admin. Secondo D-021, nella V1 soltanto il limite di coperti è modificabile: slot e finestra sono fissati rispettivamente a 15 e 30 minuti, mostrati come valori informativi e protetti da validazione server e vincoli PostgreSQL. Le date speciali possono chiudere l'intera giornata, soltanto il pranzo o soltanto la cena; un'apertura può avere orari e capacità speciali opzionali. Il seed non inserisce date speciali, perché non sono documentate chiusure reali approvate.

## Motore availability M5

Il modulo `src/modules/availability` calcola una vista riutilizzabile e indipendente da Next.js, React e Prisma. Riceve ristorante, data locale, servizio, coperti richiesti, clock esplicito, canale e un array tipizzato di arrivi già esistenti. Il repository Prisma si limita a leggere PostgreSQL e trasformare la configurazione in tipi applicativi; non contiene regole di disponibilità.

Gli slot sono generati in ordine crescente con estremi inclusivi: `startTime` è il primo slot ed `endTime` è l'ultimo. Con la configurazione demo il pranzo produce 12:00–14:00 inclusi e la cena 19:00–22:15 inclusi, ogni 15 minuti. Configurazioni invertite, intervalli non positivi o un ultimo slot non raggiungibile esattamente vengono classificate come `CONFIGURATION_INVALID`.

La configurazione effettiva segue questa precedenza:

1. eccezione per data e servizio specifico;
2. eccezione `ALL` per la data;
3. regola settimanale;
4. impostazioni generali del ristorante per capacità, finestra e cutoff.

Un'eccezione specifica aperta prevale quindi su una chiusura `ALL`. Orari o capacità opzionali non indicati da un'apertura speciale ereditano rispettivamente dalla regola settimanale e dalle impostazioni del ristorante.

La capacità usa finestre mobili ancorate a ogni slot configurato, mai blocchi fissi. Ogni finestra somma gli arrivi con estremi `[inizio, fine)`: con 30 minuti, la finestra 19:00 include 19:00 e 19:15 ma esclude 19:30. Una richiesta candidata viene aggiunta virtualmente a tutte le finestre che la contengono; lo slot è disponibile soltanto se nessuna supera il limite. La capacità residua di base è il margine minimo fra tutte le finestre interessate.

Tutti i confronti operativi usano la timezone IANA del ristorante, inizialmente `Europe/Rome`, tramite `Intl.DateTimeFormat` e un clock iniettato. Date `YYYY-MM-DD` e orari `HH:mm` restano valori locali e non vengono convertiti in timestamp UTC fittizi; i cambi tra ora solare e legale sono coperti da test deterministici.

Per `PUBLIC`, gli slot trascorsi non sono disponibili e una regola `BookingCutoffRule` attiva chiude le nuove prenotazioni online dello stesso giorno all'orario configurato. Giorno e servizio sono generici; il seed abilita inizialmente venerdì e sabato a cena alle 17:30. Il canale `STAFF` ignora sempre questo cutoff pubblico, ma continua a rispettare chiusure, configurazione e slot trascorsi.

L'anteprima M5 resta consultiva e usa intenzionalmente `arrivals: []`: non salva carichi simulati e non rappresenta disponibilità reale pubblica. La creazione M6 riusa invece lo stesso motore dentro la transazione, dopo aver riletto da PostgreSQL configurazione e prenotazioni confermate.

## Nucleo prenotazioni M6

`Reservation` conserva cliente minimale, data locale, servizio, slot, coperti, note, preferenze, allergie dichiarate, consenso versionato, autore, stato e origine. In M6 una nuova prenotazione nasce sempre `CONFIRMED`; `CANCELLED` è presente soltanto per definire correttamente il conteggio futuro e non esistono ancora endpoint di cancellazione. Le prenotazioni annullate non contano verso la capacità, mentre una prenotazione confermata con override continua a contare.

La conferma applica questo protocollo atomico:

1. valida payload e `Idempotency-Key`;
2. apre una transazione PostgreSQL breve;
3. acquisisce il lock di idempotenza;
4. gestisce replay o conflitto della chiave;
5. acquisisce il lock di capacità per ristorante, data e servizio;
6. rilegge configurazione, date speciali e prenotazioni `CONFIRMED` nella stessa transazione;
7. riusa le finestre mobili M5 e inserisce prenotazione e associazione idempotente;
8. effettua il commit.

I lock usano `pg_advisory_xact_lock` e vengono rilasciati automaticamente con commit o rollback. Le due chiavi `int32` derivano dai primi 64 bit dello SHA-256 di una stringa canonica con namespace. Il lock di capacità include `restaurantId`, `localDate` e `serviceType`: ristoranti e servizi distinti non condividono il lock. L'ordine è sempre idempotenza prima di capacità.

L'idempotenza non usa memoria o Redis. La chiave grezza non viene salvata: PostgreSQL conserva SHA-256 della chiave, hash canonico del payload, scadenza e relazione alla prenotazione. Entro il TTL, stessa chiave e stesso payload restituiscono la stessa prenotazione con HTTP 200; stessa chiave con payload differente restituisce HTTP 409. La prima creazione restituisce HTTP 201. Le chiavi scadute hanno un cleanup infrastrutturale testabile.

STAFF e ADMIN possono creare origini `STAFF` e `PHONE`. `PHONE` richiede consenso `VERBAL`; `STAFF` richiede `STAFF_RECORDED`. La versione informativa proviene da `RESERVATION_PRIVACY_POLICY_VERSION` e il timestamp viene fissato dal server. Il cutoff online PUBLIC non si applica, ma servizio chiuso, slot inesistente o trascorso, input invalido e configurazione incoerente restano bloccanti.

M8 applica D-007: STAFF e ADMIN possono richiedere esplicitamente un override della capacità, sempre con motivo non vuoto. L'override è accettato soltanto quando il controllo produce `CAPACITY_EXCEEDED`: non disabilita gli altri controlli, non rende valide sale o slot inesistenti e non modifica il limite configurato.

API tecniche protette:

- `POST /api/staff/reservations`: creazione telefonica JSON same-origin, sessione STAFF/ADMIN e header obbligatorio `Idempotency-Key`;
- `GET /api/staff/reservations/:id`: DTO operativo isolato sul ristorante della sessione;
- `PATCH /api/staff/reservations/:id`: modifica autenticata con versione ottimistica;
- `DELETE /api/staff/reservations/:id`: cancellazione logica autenticata e idempotente;
- `GET /api/staff/availability`: slot e sale attive con carico PostgreSQL reale.

Le risposte usano `Cache-Control: no-store` e non espongono hash, dati auth, query, stack trace o configurazioni interne. La pagina `/dashboard/reservations/new` è esclusivamente telefonica: il client non sceglie origine, metodo di consenso, versione, timestamp o autore. Genera una chiave casuale per ogni tentativo logico e la riusa in caso di retry invariato.

## Flusso pubblico M7

Il cliente apre `/prenota`, sceglie lingua italiana o inglese e consulta slot calcolati con configurazione e prenotazioni `CONFIRMED` lette da PostgreSQL. Le prenotazioni `CANCELLED` sono escluse. Il form richiede dati di contatto, preferenza di sala attiva, privacy e condizioni; le esigenze facoltative restano dati della singola prenotazione e non creano un profilo cliente.

La conferma pubblica riusa il protocollo di lock M6:

1. rate limit PostgreSQL;
2. validazione Zod e `Idempotency-Key` obbligatorio;
3. lock di idempotenza;
4. lock di capacità per ristorante, data e servizio;
5. rilettura di configurazione e carico persistente;
6. creazione atomica di prenotazione `PUBLIC`, consensi `WEB_CHECKBOX`, token, audit e associazione idempotente.

La prima risposta usa HTTP `201`. Un retry con la stessa chiave e lo stesso payload normalizzato usa HTTP `200`, non crea duplicati e restituisce lo stesso link; la stessa chiave con payload diverso usa HTTP `409`. La retention predefinita delle chiavi è 24 ore ed è configurata da `RESERVATION_IDEMPOTENCY_TTL_HOURS`.

### Token e pagina personale

Il token URL-safe equivale a 32 byte e viene derivato deterministicamente con HMAC-SHA-256 dal secret server-side stabile e dall'UUID interno casuale della prenotazione. PostgreSQL conserva esclusivamente SHA-256 del token: il valore raw non è salvato, registrato nei log o restituito fuori dalla creazione e dal replay idempotente. Questa derivazione permette di ricostruire in sicurezza lo stesso link durante il replay senza cifrare o persistere il token raw.

Il percorso personale è `/p/<token>`. Il link resta consultabile fino alla durata configurata in `RestaurantBookingSettings`, compresa tra 1 e 24 ore e inizialmente fissata a 24 ore dopo l'orario prenotato. Una variazione vale soltanto per i token successivi; al reschedule ogni token esistente conserva la durata originaria rispetto al nuovo orario, anche attraverso i cambi DST. Il cutoff di modifica/cancellazione è distinto: 10:30 per il pranzo e 17:30 per la cena nella configurazione demo. Dopo il cutoff la pagina resta in sola lettura; dopo la scadenza, token inesistenti, revocati e scaduti ricevono la stessa risposta generica.

La modifica acquisisce il lock del token e i lock di capacità della destinazione corrente e nuova in ordine deterministico, esclude la prenotazione corrente dal conteggio, ricontrolla sala/slot/capienza e aggiorna anche la scadenza del link. La cancellazione cambia logicamente lo stato in `CANCELLED`, libera subito i coperti ed è idempotente. Creazione, modifica e cancellazione producono audit atomico con correlation ID e snapshot prima/dopo limitato ai dati operativi modificabili.

Le pagine personali inviano `Cache-Control: no-store`, `Referrer-Policy: no-referrer` e `X-Robots-Tag: noindex, nofollow, noarchive`. Le API non espongono hash, secret, ID interni, stack trace o dettagli Prisma.

### Route pubbliche

- `GET /api/public/availability?date=YYYY-MM-DD&service=LUNCH|DINNER&partySize=N`: disponibilità reale e sale attive;
- `POST /api/public/reservations`: creazione con JSON same-origin e `Idempotency-Key`;
- `GET /api/public/reservations/<token>`: consultazione personale;
- `PATCH /api/public/reservations/<token>`: modifica prima del cutoff;
- `DELETE /api/public/reservations/<token>`: cancellazione logica prima del cutoff.

Availability, creazione, visualizzazione, modifica e cancellazione hanno bucket distinti, atomici e condivisi in PostgreSQL. La chiave del bucket deriva con HMAC da ristorante, azione e indirizzo client normalizzato; l'indirizzo non viene salvato in chiaro. Gli header proxy sono considerati soltanto con `AUTH_TRUST_PROXY=true` dietro un proxy fidato.

## Dashboard e operatività M8

`/dashboard` apre sul giorno corrente nella timezone PostgreSQL del ristorante, inizialmente `Europe/Rome`. Data precedente, successiva e selezione esplicita restano valori locali `YYYY-MM-DD` e non dipendono dalla timezone del browser o del server. Le query sono sempre limitate al `restaurantId` della sessione e ordinate per servizio, orario, creazione e UUID come ultimo criterio stabile.

I filtri server-side supportano servizio, stato e origine. Riepiloghi ed elenco mostrano confermate, coperti, cancellazioni, origini, richieste alimentari e logistiche e prenotazioni da assegnare. In M8 tutte le confermate sono ancora da assegnare: i coperti per sala rappresentano esclusivamente la sala preferita, mai una collocazione definitiva.

La disponibilità residua è calcolata per pranzo, cena e singolo slot riusando il motore delle finestre mobili da 30 minuti e tutte le prenotazioni `CONFIRMED` persistite. Non viene prodotto alcun saldo giornaliero fittizio; le cancellate non incidono.

### Inserimento telefonico

Il modulo rapido acquisisce contatti, data, servizio, slot configurato, persone, sala preferita, esigenze, note e conferma esplicita del consenso verbale. Preferenze ed esigenze usano lo stesso JSON canonico del flusso pubblico; le vecchie stringhe M6 vengono lette come dati legacy senza interrompere la dashboard.

Il server imposta obbligatoriamente origine `PHONE`, metodo `VERBAL`, versione informativa configurata, timestamp e utente della sessione. Il flusso usa gli stessi lock di capacità e idempotenza PostgreSQL del canale pubblico, ma ignora il cutoff delle nuove prenotazioni online. Non invia WhatsApp o email.

### Modifica, cancellazione e audit

STAFF e ADMIN possono modificare prenotazioni confermate `PUBLIC`, `PHONE` o `STAFF`. Il server valida sala e slot, verifica la versione, acquisisce un lock per prenotazione condiviso con il link pubblico e i lock di capacità corrente/destinazione in ordine deterministico, esclude la prenotazione corrente dal conteggio e incrementa la versione soltanto per una modifica effettiva. Un aggiornamento dei soli contatti conserva l'eventuale override di capacità già applicato. Se cambia data, servizio o orario di una prenotazione `PUBLIC`, viene aggiornata nella stessa transazione anche la scadenza del token personale senza rigenerarlo o esporlo.

La cancellazione è logica e idempotente: il primo cambio a `CANCELLED` incrementa la versione, libera i coperti dopo il commit e crea audit; i tentativi successivi non duplicano effetti. Il token pubblico resta consultabile fino alla propria scadenza.

Creazione telefonica, modifica, cancellazione e override salvano l'audit nella stessa transazione. Ogni evento autenticato contiene ristorante, prenotazione, azione, origine operativa, utente, ruolo, correlation ID, timestamp UTC, snapshot minimizzati prima/dopo e metadati dell'override. Per un override vengono registrati anche limite, carico precedente massimo e carico risultante. I log tecnici non includono telefono, email, allergie, note o token.

### Verifica locale M8

Con PostgreSQL healthy:

```bash
docker compose ps
npx.cmd --no-install prisma format
npx.cmd --no-install prisma validate
npx.cmd --no-install prisma generate
npm run db:migrate:deploy
npx.cmd --no-install prisma migrate status
npm run db:seed
npm run db:seed
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run build
```

`npm run test:e2e` usa `@playwright/test`, costruisce l'app, esegue il seed strutturale senza sovrascrivere gli account demo e prepara separatamente i soli account fittizi dedicati `e2e.admin`/`e2e.staff`. Il runner avvia `next start` su `localhost:4000` e gestisce con teardown limitato il processo anche su Windows. Copre accesso anonimo negato, login Staff/Admin, dashboard, filtri, inserimento, modifica, cancellazione, override, lifecycle utenti/password e viewport smartphone, tablet e desktop.

Il seed resta strutturale e idempotente: non crea prenotazioni, token personali, chiavi di idempotenza, eventi audit o bucket di rate limit.

## Account locali fittizi

| Ruolo | Username | Password |
| --- | --- | --- |
| `ADMIN` | `demo.admin` | valore locale di `AUTH_DEMO_ADMIN_PASSWORD` |
| `STAFF` | `demo.staff` | valore locale di `AUTH_DEMO_STAFF_PASSWORD` |

Queste identità non corrispondono a persone reali. Le password di `.env.example` non devono essere usate in staging o produzione. Non esiste registrazione pubblica: la creazione degli account è un'operazione riservata all'Admin in `/admin/users`.

`ADMIN` accede anche alla pagina tecnica `/admin`; `STAFF` può usare l'area protetta ordinaria ma viene respinto dalle pagine e dalle mutazioni di configurazione. I controlli sono eseguiti sul server e ogni aggiornamento è limitato al `restaurantId` della sessione.

## Percorsi M4–M9-F

- `/admin/configuration`: capacità e cut-off;
- `/admin/public-settings`: contatti, contenuti editoriali IT/EN e durata dei nuovi link;
- `/admin/rooms`: data/servizio, disponibilità delle cinque sale, ordine/stato globale e lifecycle dei tavoli;
- `/admin/schedules`: servizi e orari settimanali;
- `/admin/special-dates`: creazione, modifica, archiviazione e ripristino delle eccezioni locali.
- `/admin/availability-preview`: anteprima M5 di slot e capacità con carico persistente vuoto.
- `/admin/audit`: lista unificata, filtri, paginazione keyset e dettaglio minimizzato dell'audit, solo Admin.
- `/dashboard`: dashboard giornaliera Staff/Admin con filtri, riepiloghi, disponibilità e gestione;
- `/dashboard/reservations/new`: inserimento telefonico rapido `PHONE` per STAFF e ADMIN;
- `/dashboard/reservations/<id>/edit`: modifica autenticata con versione ottimistica;
- `/prenota`: prenotazione pubblica responsive in italiano e inglese.
- `/p/<token>`: consultazione e gestione della singola prenotazione pubblica.
- `/admin/users`: gestione utenti riservata agli Admin;
- `/cambia-password`: cambio personale, obbligatorio al primo accesso o volontario.

La lettura tecnica `GET /api/admin/availability-preview?date=YYYY-MM-DD&service=LUNCH|DINNER&partySize=2&channel=PUBLIC|STAFF` resta accessibile esclusivamente ad `ADMIN`. Le API operative `/api/staff/*` sono accessibili a STAFF e ADMIN. Tutti i percorsi sono isolati sul `restaurantId` della sessione, validati sul server e restituiti con `Cache-Control: no-store`.

Un anonimo viene reindirizzato a `/login`; STAFF non può modificare configurazioni amministrative ma gestisce il ciclo operativo delle prenotazioni. Le mutazioni same-origin validano sul server un elenco esplicito di campi e non espongono query, stack trace o dettagli interni.

## Login locale

```bash
npm run dev
```

- applicazione: [http://localhost:4000](http://localhost:4000/);
- login: [http://localhost:4000/login](http://localhost:4000/login);
- dashboard operativa protetta: [http://localhost:4000/dashboard](http://localhost:4000/dashboard);
- nuova prenotazione telefonica: [http://localhost:4000/dashboard/reservations/new](http://localhost:4000/dashboard/reservations/new);
- verifica tecnica ADMIN: [http://localhost:4000/admin](http://localhost:4000/admin);
- configurazione ADMIN: [http://localhost:4000/admin/configuration](http://localhost:4000/admin/configuration);
- sale e tavoli ADMIN: [http://localhost:4000/admin/rooms](http://localhost:4000/admin/rooms);
- orari ADMIN: [http://localhost:4000/admin/schedules](http://localhost:4000/admin/schedules);
- date speciali ADMIN: [http://localhost:4000/admin/special-dates](http://localhost:4000/admin/special-dates);
- anteprima disponibilità ADMIN: [http://localhost:4000/admin/availability-preview](http://localhost:4000/admin/availability-preview);
- audit ADMIN: [http://localhost:4000/admin/audit](http://localhost:4000/admin/audit);
- API anteprima disponibilità ADMIN: [http://localhost:4000/api/admin/availability-preview](http://localhost:4000/api/admin/availability-preview);
- health check: [http://localhost:4000/api/health](http://localhost:4000/api/health).
- prenotazione pubblica: [http://localhost:4000/prenota](http://localhost:4000/prenota).

Il login mantiene compatibilità con gli account M3 (minimo storico 12). Le nuove password personali seguono la policy M9-B da 15 a 128 code point Unicode. Le risposte per username inesistente, password errata e utente disabilitato non rivelano quale controllo sia fallito.

## Password e sessioni

Le password sono memorizzate soltanto come hash Argon2id. La configurazione iniziale usa 19 MiB di memoria, 2 iterazioni e parallelismo 1; prima della produzione i parametri devono essere calibrati sull'infrastruttura definitiva senza scendere sotto questa base.

Ogni login crea una nuova sessione opaca con scadenza assoluta di 8 ore. Il cookie contiene soltanto un UUID e un secret casuale a 256 bit; nel database è salvato esclusivamente l'hash SHA-256 del secret. Il cookie è `HttpOnly`, `SameSite=Lax`, `Path=/`, ad alta priorità e `Secure` in produzione. Non viene usato `localStorage`.

Il logout valorizza `revokedAt`, cancella il cookie e rende inutilizzabile il token precedente. Se un utente viene disabilitato, la validazione respinge la sessione e revoca tutte le sue sessioni ancora aperte. In locale una nuova sessione si crea eseguendo nuovamente il login; per revocare una sessione specifica usare il logout. Per verifiche amministrative sui soli dati fittizi è possibile aprire `npm run db:studio` e valorizzare `revokedAt` senza eliminare utenti o database.

Creazione e reset mostrano una password temporanea casuale di 24 caratteri soltanto nella risposta one-shot `no-store`; il seed non ripristina password, ruolo, stato o flag di account già esistenti. Cambio password, reset, variazione ruolo e disabilitazione revocano tutte le sessioni. Con `mustChangePassword=true` pagine e API operative sono bloccate fino al cambio, tranne cambio password e logout.

Le richieste POST autenticate richiedono un'origine coerente con l'host e il cookie SameSite. I redirect dopo il login sono limitati ai percorsi tecnici autorizzati, inclusa la creazione M6.

## Rate limit del login

I tentativi falliti sono persistiti in PostgreSQL: 5 errori nella finestra di 15 minuti bloccano la chiave per 15 minuti. La chiave combina username normalizzato e indirizzo client, quindi viene salvata solo dopo HMAC e non rivela i valori originali. Le righe scadute sono rimosse durante i tentativi successivi.

Con `AUTH_TRUST_PROXY=false` gli header inoltrati sono ignorati. Impostare `true` soltanto quando l'app è dietro un proxy fidato che sovrascrive `X-Forwarded-For`, `X-Forwarded-Host` e `X-Forwarded-Proto`.

## Fondazione audit M9-A

`AuditEvent` registra login riuscito, credenziali non valide, richieste bloccate dal rate limit, logout riuscito e tutte le mutazioni M4 già presenti. Revoca sessione, modifica configurazione e relativo audit condividono la stessa transazione; un fallimento dell'audit annulla la mutazione e un no-op non produce eventi. Categoria, azione ed esito sono validati dal dominio e tutte le operazioni sono isolate sul ristorante della sessione.

Le configurazioni amministrative possono essere lette soltanto passando un attore server-side `ADMIN`; il servizio deriva `restaurantId` dall'attore. Le query tecniche interne del motore availability restano separate. Le note operative delle date sono rappresentate nell'audit soltanto da un flag di presenza.

Il nuovo snapshot canonico delle prenotazioni è condiviso da flussi pubblici e autenticati. Conserva data, servizio, ora, coperti, stato, origine, versione, codice sala, flag logistici/alimentari e override, ma esclude PII e testi completi di richieste, allergie, intolleranze, ricorrenze e note.

M9-A non implementava pannello o gestione utenti; M9-B li aggiunge. M9-C completa cutoff e impatto per la configurazione operativa. M9-D implementa `ServiceInstance`, disponibilità sale e tavoli senza assegnazione. M9-E aggiunge contatti, contenuti pubblici IT/EN e durata prospettica preservando i token esistenti. M9-F completa la superficie M9 con la consultazione audit; le assegnazioni restano M10.

## Consultazione audit M9-F

`GET /api/admin/audit` unisce in una sola query parametrizzata gli eventi prenotazione e amministrativi. Ogni ramo applica il tenant della sessione prima della `UNION ALL`; l'ordinamento è timestamp, ranking sorgente e UUID discendenti. I filtri sono allow-listed, il periodo usa giorni locali nella timezone del ristorante e la pagina successiva usa un cursore base64url versionato legato al fingerprint dei filtri, senza `OFFSET`.

`GET /api/admin/audit/<source>/<id>` richiede sorgente e UUID validi e ricerca sempre anche il tenant. Prima/dopo/metadata sono proiettati in campi minimizzati per categoria e azione: non vengono restituiti raw JSON, contatti, contenuti pubblici, note, HMAC, token, hash o credenziali, anche se un evento storico contiene chiavi inattese. Pagina e API sono `no-store`, `noindex` e strettamente read-only; la consultazione non genera audit.

## Configurazione operativa M9-C

Le pagine `/admin/configuration` e `/admin/schedules` usano un protocollo a due passi. Il server calcola un'anteprima minimizzata delle sole prenotazioni future confermate, senza identificativi o PII; quando l'impatto è materiale l'Admin deve confermarlo esplicitamente. L'applicazione rilegge attore, configurazione e carico in una transazione `SERIALIZABLE`, acquisisce un lock advisory stabile per ristorante e rifiuta con `IMPACT_CHANGED` se il fingerprint non è più corrente.

L'anteprima distingue servizio disabilitato, prenotazione fuori dai nuovi orari, superamento della nuova capacità e modifica del cutoff di gestione. Le eccezioni attive per data conservano la precedenza sulle regole settimanali e sulla capacità generale. La modifica confermata cambia soltanto la configurazione: nessuna prenotazione viene aggiornata, annullata o eliminata. Mutazione e audit minimizzato sono atomici; un no-op non produce audit.

## Health check

Il percorso pubblico `/api/health` continua a restituire soltanto stato del servizio, ambiente e disponibilità del database. Non espone utenti, sessioni, credenziali o dettagli di autenticazione.

## Comandi di qualità

```bash
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run build
```

La suite Vitest comprende test unitari e test d'integrazione con PostgreSQL reale; non usa SQLite.

## Confini dei checkpoint M9-A/M9-B/M9-C/M9-D/M9-E/M9-F

M9-A implementa fondazione e minimizzazione audit; M9-B lifecycle utenti e password; M9-C servizi/orari, capacità e cutoff; M9-D istanze lazy, sale e tavoli; M9-E contatti, contenuti IT/EN e durata dei link; M9-F consultazione Admin dell'audit. Le istanze hanno stati logici derivati `VIRTUAL`, `MATERIALIZED`, `HISTORICAL`; solo una prenotazione riuscita o una modifica Admin effettiva materializza tutte le righe sala. `DA ASSEGNARE` resta un'opzione virtuale e le assegnazioni appartengono a M10. Restano esclusi notifiche, documenti, deploy, dati reali e tutte le funzioni M10–M12.
