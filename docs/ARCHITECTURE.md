# Piccadilly Booking — Architettura

**Stato:** approvata per lo sviluppo iniziale
**Data:** 31 luglio 2026
**Ambito:** architettura logica e tecnica; nessuna implementazione

## 1. Fonti e precedenza

`docs/PROJECT_SPEC.md` resta la fonte ufficiale dei requisiti funzionali. Questo documento descrive come realizzarli e integra le decisioni approvate registrate in `docs/DECISIONS.md` e negli ADR.

In caso di conflitto non risolto:

1. non si modifica automaticamente il comportamento approvato;
2. si segnala il conflitto;
3. si registra una nuova decisione prima di implementare.

Le decisioni del 31 luglio 2026 chiariscono alcuni punti ambigui della specifica senza modificare direttamente `PROJECT_SPEC.md`.

## 2. Stile architetturale

Il sistema è un monolite modulare Next.js full-stack in un singolo repository.

Stack vincolante:

- Next.js con App Router;
- runtime Node.js;
- TypeScript in modalità strict;
- PostgreSQL;
- Prisma ORM;
- Zod per la validazione;
- Tailwind CSS;
- npm;
- Docker Compose per PostgreSQL locale;
- Vitest e Playwright per i test;
- GitHub Actions;
- predisposizione per Render.

L'applicazione web, i casi d'uso e gli adattatori infrastrutturali sono distribuiti insieme. Un worker separato potrà essere eseguito dallo stesso repository quando saranno introdotti outbox, retry e promemoria.

Non è previsto un backend Express separato nella prima versione. La logica applicativa deve comunque rimanere indipendente da Next.js, così da poter essere estratta in futuro senza riscrivere il dominio.

## 3. Principi

- PostgreSQL è l'unica fonte ufficiale dei dati.
- PDF ed Excel sono esportazioni non modificabili e non reimportabili come fonte dati.
- Una prenotazione viene salvata prima di qualunque notifica.
- Gli errori di notifiche o esportazioni non invalidano una prenotazione.
- Le cancellazioni sono logiche, mai fisiche.
- Ogni modifica rilevante produce audit.
- Tutti gli input sono validati sul server.
- Sviluppo, staging e produzione non condividono database, dati o segreti.
- Le dipendenze vengono aggiunte solo nella milestone che le richiede.
- Le tabelle vengono implementate progressivamente, anche se il modello logico completo è documentato da subito.

## 4. Vista dei componenti

```text
Browser pubblico                         Browser Staff/Admin
       |                                        |
       +----------------+-----------------------+
                        |
                 Next.js App Router
          pagine, Route Handler, Server Action
                        |
                 Servizi applicativi
                        |
       +----------------+----------------+
       |                |                |
   Dominio          Repository       Adattatori
 prenotazioni        Prisma       export/notifiche
 disponibilità          |                |
 configurazioni      PostgreSQL      outbox/worker
```

### 4.1 Interfaccia pubblica

Comprende:

- pagina di prenotazione in italiano e inglese;
- disponibilità indicativa di date, servizi e slot;
- pagina personale tramite token;
- modifica e cancellazione fino al cutoff;
- consultazione dopo il cutoff e fino alla scadenza;
- messaggi di chiusura e invito a telefonare.

La disponibilità mostrata al client non costituisce una prenotazione temporanea. Il controllo definitivo avviene nella transazione di salvataggio.

### 4.2 Interfaccia Staff

Comprende:

- dashboard del giorno corrente;
- inserimento telefonico rapido;
- modifica e cancellazione;
- override della capacità con motivazione;
- assegnazione manuale di sala e tavoli;
- esportazione PDF ed Excel.

### 4.3 Interfaccia Admin

Comprende tutte le funzioni Staff e inoltre:

- gestione utenti e ruoli;
- giorni, servizi, orari e cutoff;
- aperture e chiusure straordinarie;
- limite di coperti;
- sale e tavoli;
- attivazione di Galleria e Terrazzo;
- contatti e testi pubblici;
- configurazione delle strategie di notifica;
- consultazione dell'audit log.

### 4.4 Servizi applicativi

Coordinano transazioni, autorizzazioni, validazione e audit. Casi d'uso principali:

- `CreateOnlineReservation`;
- `CreatePhoneReservation`;
- `ModifyReservation`;
- `CancelReservation`;
- `AssignReservationTables`;
- `ResolveServiceAvailability`;
- `UpdateRestaurantConfiguration`;
- `GeneratePdfExport`;
- `GenerateExcelExport`;
- `ProcessNotificationOutbox`.

I nomi sono descrittivi e non costituiscono codice già approvato.

## 5. Confini dei moduli

### Reservations

Possiede lo stato della prenotazione e le sue invarianti:

- origine online o telefonica;
- numero di coperti;
- stato confermato o cancellato;
- sala preferita;
- contatti e richieste collegate;
- consensi;
- token pubblico;
- versionamento per evitare aggiornamenti persi.

### Availability

Calcola:

- finestre mobili;
- coperti impegnati;
- disponibilità residua;
- impatto di creazioni e modifiche;
- possibilità o necessità di override.

Non mantiene un contatore client-side come fonte ufficiale.

### Scheduling

Risolve:

- regole settimanali;
- pranzo e cena;
- slot prenotabili;
- cutoff di creazione, modifica e cancellazione;
- aperture e chiusure straordinarie;
- configurazione effettiva di una data.

### Rooms

Gestisce:

- sale disponibili;
- Galleria e Terrazzo per data e servizio;
- tavoli fisici;
- sala preferita e sala definitiva;
- assegnazioni manuali.

Non effettua assegnazione automatica o combinazione automatica dei tavoli.

M10-A mantiene in questo modulo dominio, repository e servizio delle assegnazioni. `ReservationAssignment` è separata dalla prenotazione e possiede una relazione esplicita con i tavoli; `clearedAt` distingue lo stato attivo dalla rimozione logica. La preferenza resta nel dominio Reservations e viene soltanto letta nel contesto Staff/Admin. M10-B espone inoltre un comando interno di clear per reschedule, usabile dentro la transazione Reservations già aperta senza invocare la route e senza incrementare una seconda volta la versione. M10-C estende il read model Dashboard con una lettura tenant-scoped dell'assegnazione attiva e una proiezione SQL fissa della sola espressione `internal_notes IS NOT NULL`, eseguite nello stesso snapshot `REPEATABLE READ`; il testo delle note resta escluso dal percorso lista. Le due letture della disponibilità pranzo/cena restano fisse, il catalogo completo sala/tavoli viene caricato on demand dalla GET M10-A e il componente React non accede a Prisma.

### Identity

Gestisce autenticazione, sessioni, ruoli Admin e Staff, cambio password e autorizzazioni applicative. M9-B separa policy password pura, servizio applicativo transazionale e route/UI: il client non invia `restaurantId`, ruolo dell'attore o dati di audit.

### Audit

Registra eventi append-only con attore, origine, timestamp, entità, azione e valori precedenti/nuovi quando richiesti.

### Exports

Il modulo `exports` separa regole pure di periodo, classificazione, ordinamento e sicurezza delle celle; orchestrazione applicativa; read model Prisma; adapter PDFKit/ExcelJS e loader del font server-side. I generatori ricevono DTO immutabili e non modelli Prisma. Next.js espone route POST Node sottili e la dashboard usa un componente client non autorevole.

Ogni richiesta legge l'intero periodo in una sola transazione `REPEATABLE READ`: rilegge l'attore, deriva il tenant, acquisisce contesto ristorante, sale, prenotazioni `CONFIRMED`, assegnazioni e tavoli con query bounded. Non materializza `ServiceInstance`, non usa lock e non scrive. Il rendering avviene fuori transazione, interamente in memoria; dopo i controlli su righe e byte una breve transazione separata rilegge l'attore e registra l'audit. Soltanto dopo audit SUCCESS il buffer viene restituito.

### Notifications

Definisce interfacce astratte per WhatsApp ed email, outbox, tentativi, retry e strategia di fallback o invio parallelo.

## 6. Regole di dipendenza

- Il dominio non importa Next.js, Prisma, PDF, Excel o SDK esterni.
- I servizi applicativi dipendono da interfacce del dominio.
- Gli adattatori Prisma implementano le interfacce di persistenza.
- Route Handler e Server Action chiamano i servizi applicativi.
- I componenti UI non chiamano Prisma.
- Server Components protetti possono leggere tramite query service autorizzati.
- Le notifiche vengono richieste tramite outbox, non direttamente dai casi d'uso di prenotazione.

## 7. Struttura prevista del repository

```text
src/
  app/
    [locale]/
      (public)/
      (staff)/
    api/
  modules/
    reservations/
    availability/
    scheduling/
    rooms/
    identity/
    audit/
    exports/
    notifications/
  server/
    auth/
    db/
    security/
    config/
    logging/
    jobs/
  components/
  i18n/
  shared/
prisma/
  schema.prisma
  migrations/
  seed.ts
tests/
  unit/
  integration/
  concurrency/
  e2e/
  fixtures/
docs/
  adr/
```

Questa è una destinazione architetturale. Le cartelle saranno create solo nelle milestone che le richiedono.

## 8. Modello dati logico

### 8.1 Configurazione e calendario

| Tabella logica | Responsabilità |
|---|---|
| `restaurants` | Identità e timezone del ristorante |
| `restaurant_public_settings` | Telefono, URL canonico HTTPS, email e WhatsApp facoltativi |
| `public_contents` | Sette chiavi editoriali localizzate `IT`/`EN`, uniche per tenant |
| `weekly_service_rules` | Regola ricorrente per giorno della settimana e pranzo/cena |
| `booking_cutoff_rules` | Cutoff delle nuove prenotazioni pubbliche per giorno della settimana e servizio |
| `service_instances` | Configurazione effettiva di uno specifico servizio in una data; riga usata anche per la serializzazione concorrente |
| `rooms` | Sale del ristorante e caratteristiche |
| `service_room_availability` | Sale abilitate per uno specifico servizio, inclusi Galleria e Terrazzo |
| `dining_tables` | Tavoli fisici e sala di appartenenza |

`service_instances` contiene soltanto identità `(restaurantId, localDate, serviceType)`, versione e timestamp. Non è uno snapshot di orari, slot, capacità o cutoff: tali valori sono sempre ricalcolati dalle fonti M9-C secondo le precedenze vigenti.

`BookingCutoffRule` è unica per ristorante, giorno e servizio. M9-D rende `ServiceInstance` unica per ristorante, data e servizio e `ServiceRoomAvailability` unica per istanza e sala, con chiavi tenant composte. Gli stati `VIRTUAL`, `MATERIALIZED` e `HISTORICAL` sono derivati e non persistiti. Letture, preview e no-op non scrivono; la prima prenotazione riuscita o una modifica Admin effettiva materializzano atomicamente tutte le sale. Non esiste `RoomAvailabilityOverride`.

### 8.2 Prenotazioni

| Tabella logica | Responsabilità |
|---|---|
| `reservations` | Identità, servizio, slot, coperti, stato, origine, sala preferita, versione e timestamp |
| `reservation_contacts` | Nome, cognome, telefono ed email facoltativa |
| `reservation_requests` | Esigenze alimentari e logistiche, ricorrenze e note pubbliche |
| `reservation_consents` | Tipo, versione informativa, modalità, data/ora e utente che ha raccolto il consenso |
| `public_access_tokens` | Solo hash del token, scadenza e revoca |
| `reservation_assignments` | Sala definitiva, note interne, autore e timestamp |
| `assignment_tables` | Relazione tra assegnazione e uno o più tavoli |
| `capacity_overrides` | Motivazione, autore, limite e totale risultante |

Per una prenotazione telefonica il consenso registra almeno origine `PHONE`, versione dell'informativa, consenso verbale, data/ora e utente Staff o Admin che l'ha inserita.

### 8.3 Sicurezza, audit e operazioni

| Tabella logica | Responsabilità |
|---|---|
| `users` | Account Staff/Admin, ruolo, stato, hash password e flag di cambio obbligatorio |
| `sessions` | Sessioni revocabili |
| `reservation_audit_events` | Registro specializzato e minimizzato del ciclo prenotazione |
| `audit_events` | Registro generico append-only per autenticazione, identità e configurazione |
| `idempotency_keys` | Protezione dai doppi invii |
| `rate_limit_buckets` | Contatori atomici per il rate limiting pubblico |
| `notification_outbox` | Intenzioni di notifica salvate in modo affidabile |
| `notification_attempts` | Tentativi, errori e identificativi dei provider |

Il modello completo è documentato ora; ogni tabella sarà creata nella milestone in cui diventa necessaria.

M10-A crea `reservation_assignments` e `reservation_assignment_tables`. Esiste una sola riga di assegnazione per prenotazione; la junction usa chiavi composte che legano tenant, assegnazione, sala finale e tavolo della stessa sala. La rimozione valorizza `cleared_at` e non elimina l'entità. Una riattivazione riusa la riga esistente. Non vengono collegate prenotazioni e istanze servizio e non viene eseguito backfill.

I due registri audit restano separati. M9-F li unisce mediante una proiezione applicativa di sola lettura: `UNION ALL` parametrizzata, tenant filter in ciascun ramo, ordinamento globale deterministico e paginazione keyset. Il dettaglio trasforma gli stati con allow-list positive e non espone raw JSON. Ogni evento relativo a una mutazione è scritto nella stessa transazione della mutazione, usa campi a whitelist e non serializza indiscriminatamente modelli Prisma. Gli export, essendo read-only, scrivono invece `AuditEvent` in una transazione breve successiva al rendering e prima della risposta. Riferimenti: ADR 006, D-036 e D-038.

### 8.4 Dati da non inserire direttamente in `reservations`

- password e sessioni;
- token pubblico in chiaro;
- configurazioni e testi pubblici;
- consensi senza versione e provenienza;
- esigenze sensibili e note interne;
- sala definitiva e tavoli;
- cronologia delle modifiche;
- override e relative motivazioni;
- stato delle notifiche;
- file PDF o Excel;
- contatori di capacità derivabili;
- segreti dei provider.

## 9. Capacità e concorrenza

La capacità iniziale è 30 coperti per ogni finestra mobile di 30 minuti, valutata su slot ogni 15 minuti.

Per ogni slot di inizio finestra `w`, il totale è la somma dei coperti delle prenotazioni confermate con arrivo maggiore o uguale a `w` e minore di `w + 30 minuti`.

Esempio:

- la finestra 19:00 comprende gli arrivi 19:00 e 19:15;
- la finestra 19:15 comprende gli arrivi 19:15 e 19:30;
- una prenotazione alle 19:15 incide su entrambe.

Soltanto il limite è configurabile dall'Admin. Nella prima versione intervallo slot e finestra sono invarianti rispettivamente di 15 e 30 minuti: la UI M9-C li mostra come informazioni non editabili e validazione server e vincoli PostgreSQL impediscono valori differenti.

### Protocollo transazionale

1. individuare il servizio concreto;
2. aprire una transazione breve;
3. acquisire un lock sulla riga `service_instances`;
4. rileggere configurazione e prenotazioni confermate;
5. controllare tutte le finestre influenzate;
6. inserire o modificare la prenotazione e l'audit;
7. confermare la transazione;
8. eseguire le attività esterne solo dopo il commit.

Tutte le scritture che cambiano i coperti devono rispettare lo stesso protocollo. Se una modifica sposta la prenotazione fra due servizi, entrambi vengono bloccati in ordine deterministico per ridurre il rischio di deadlock.

Le mutazioni M10-A/M10-B, pur non cambiando la capacità, convergono sull'ordine condiviso: lock di mutazione prenotazione, lock configurazione tenant e lock di capacità della data/servizio. I mutatori Staff/pubblici di prenotazione acquisiscono quindi il lock configurazione dopo quello di prenotazione e prima dei lock capacità. Dentro la transazione `SERIALIZABLE` vengono riletti attore quando previsto, tenant, ruolo, prenotazione, assegnazione, sala e tavoli; versione, mutazione e audit sono atomici. Le mutazioni di configurazione acquisiscono invece il solo lock configurazione prima degli eventuali lock capacità e usano snapshot serializzabile e fingerprint, senza bloccare indiscriminatamente le prenotazioni: non si crea così un ciclo con il lock prenotazione e non vengono materializzate istanze durante letture o preview.

Admin e Staff possono superare il limite solo con azione esplicita e motivazione obbligatoria. L'override non cambia il limite configurato e viene registrato nell'audit.

Una richiesta pubblica senza disponibilità non viene confermata e invita a chiamare il ristorante.

## 10. Calendario e cutoff

Valori iniziali:

| Regola | Pranzo | Cena |
|---|---:|---:|
| Primo slot | 12:00 | 19:00 |
| Ultimo slot | 14:00 | 22:15 |
| Intervallo slot | 15 minuti | 15 minuti |
| Cutoff modifica/cancellazione | 10:30 | 17:30 |

I cutoff di modifica e cancellazione sono configurabili.

Le nuove prenotazioni online dello stesso giorno rispettano la `BookingCutoffRule` attiva per giorno e servizio. Il seed abilita inizialmente venerdì e sabato a cena alle 17:30; l'Admin può configurare qualsiasi combinazione giorno/servizio. Il cutoff pubblico non impedisce inserimenti Staff o telefonici.

La precedenza delle configurazioni è:

1. eccezione per data e servizio;
2. regola settimanale;
3. valore predefinito del ristorante.

Tutti i calcoli operativi usano la timezone configurata del ristorante, inizialmente `Europe/Rome`; i timestamp di audit e integrazione sono conservati in UTC.

## 11. Token e pagina personale

- Il token contiene 32 byte casuali prima della codifica URL-safe.
- Nel database viene salvato soltanto il suo hash.
- Il link consente modifiche e cancellazione fino al cutoff del servizio.
- Dopo il cutoff resta consultabile ma non permette azioni.
- Scade definitivamente 24 ore dopo l'orario prenotato.
- La durata di 24 ore è un valore iniziale configurabile.
- Ogni token conserva la durata applicata alla creazione; una modifica della configurazione vale soltanto per token successivi.
- Se la prenotazione viene spostata, la scadenza viene ricalcolata dal nuovo servizio con la durata originaria, senza rigenerare il token.
- Il token può essere revocato o ruotato.
- La pagina non viene indicizzata e non deve essere memorizzata in cache.

## 11.1 Lifecycle e impatto delle configurazioni

Sale, tavoli, servizi ed eccezioni non vengono eliminati fisicamente: sono disattivati o archiviati. Le sale V1 sono le cinque canoniche, con codice immutabile; i tavoli possono essere creati, aggiornati e disattivati e un cambio sala richiede disattivazione e nuova creazione. Le date straordinarie sono archiviate in modo reversibile e le query operative ignorano le righe archiviate.

M9-C applica il protocollo di anteprima e conferma a impostazioni, servizi e cutoff; M9-D lo estende a disponibilità locale e disattivazione globale delle sale. M10-B integra nello stesso protocollo anche disattivazione tavolo e assegnazioni finali attive pertinenti. I fingerprint includono solo proposta, configurazione interessata e prenotazioni confermate correnti/future rilevanti con versione, collocazione temporale e assegnazione ordinata; `IMPACT_CHANGED` precede materializzazione, mutazione e audit. Il grandfathering conserva preferenze e assegnazioni già registrate, mentre nuovi riferimenti rispettano stato globale, appartenenza del tavolo e disponibilità del servizio. Riferimenti: ADR 007, ADR 009 e ADR 011.

## 11.2 Identità amministrative

Non esiste registrazione pubblica. M9-B genera per creazione e reset una password CSPRNG URL-safe di 24 caratteri, restituita solo nella risposta JSON `no-store` e mantenuta dalla UI esclusivamente fino alla chiusura della visualizzazione. PostgreSQL conserva soltanto Argon2id e `mustChangePassword`; pagine e API operative restano bloccate fino al cambio, salvo cambio password e logout.

Creazione, ruolo, stato, reset e cambio personale rileggono attore e bersaglio nel perimetro del ristorante. Le mutazioni di stato/ruolo acquisiscono un `pg_advisory_xact_lock` stabile derivato da namespace e UUID del ristorante, poi ricontano gli Admin attivi dentro la stessa transazione serializzabile. Revoca sessioni, mutazione e audit a whitelist condividono il commit; un no-op non revoca e non produce audit. Gli utenti sono disattivati, mai eliminati. Riferimento: ADR 008.

## 11.3 Configurazione pubblica e durata dei link

M9-E separa tre mutazioni per contatti, set editoriale completo IT/EN e durata dei nuovi link. Tutte rileggono l'Admin e la configurazione dentro una transazione `SERIALIZABLE`, condividono il lock advisory per ristorante, verificano un fingerprint e salvano audit minimizzato nello stesso commit. Le pagine pubbliche derivano il tenant dalla configurazione server, usano `lang=it|en`, rendering React testuale e nessun interprete HTML/Markdown. Al reschedule la durata del token si ricava dalla vecchia scadenza e dal vecchio istante zonato, senza usare l'impostazione globale corrente. Riferimento: ADR 010.

## 11.4 Consultazione audit

`/admin/audit` e le due API GET rileggono un Admin attivo senza cambio password obbligatorio. La lista proietta `ReservationAuditEvent` e `AuditEvent` su un'intestazione comune, filtra il tenant prima dell'unione e applica nel database periodo locale, sorgente, categoria, azione, esito, attore, entità e correlation ID. Il limite è 25 per default e 100 massimo; il cursore versionato riprende esattamente `createdAt DESC`, ranking sorgente DESC e `id DESC`.

Il repository di dettaglio seleziona un singolo record per sorgente, UUID e tenant. La proiezione di dominio converte prima/dopo/metadata in campi etichettati e validati; JSON, valori inattesi e testi liberi non raggiungono il DTO. Nessuna funzione di consultazione apre transazioni di scrittura, modifica eventi o produce audit. Riferimento: ADR 006.

## 12. Flussi principali

### 12.1 Creazione online

1. risoluzione di giorni, servizi, slot e sale;
2. invio con chiave di idempotenza;
3. rate limit e validazione Zod server-side;
4. verifica cutoff;
5. transazione e lock del servizio;
6. verifica delle finestre mobili;
7. creazione di prenotazione, contatti, richieste, consensi, hash token e audit;
8. eventuale evento nell'outbox;
9. commit;
10. restituzione della conferma e del token in chiaro una sola volta.

### 12.2 Inserimento telefonico

1. autenticazione e autorizzazione Staff/Admin;
2. validazione del modulo rapido;
3. origine `PHONE`;
4. registrazione del consenso verbale e della versione informativa;
5. transazione e controllo capacità;
6. eventuale override con motivazione;
7. registrazione dell'utente autore e audit;
8. eventuale programmazione della conferma.

### 12.3 Modifica

1. autorizzazione tramite token o sessione;
2. controllo cutoff e versione della prenotazione;
3. lock prenotazione, configurazione tenant e servizi attuale/nuovo nell'ordine condiviso;
4. ricalcolo della capacità escludendo la prenotazione corrente;
5. clear logico dell'assegnazione attiva soltanto se cambia data, servizio o orario;
6. singolo incremento versione e audit atomici; `UPDATED` precede `UNASSIGNED` e condivide il correlation ID;
7. evento di notifica dopo il commit.

### 12.4 Cancellazione

1. autorizzazione e controllo cutoff;
2. lock prenotazione, configurazione tenant e capacità e cambio stato a `CANCELLED`;
3. conservazione dell'ultima assegnazione senza `UNASSIGNED`;
4. audit atomico della cancellazione;
5. disponibilità dei coperti immediatamente ripristinata dopo il commit;
6. nessuna eliminazione fisica.

### 12.5 Assegnazione

L'assegnazione può avvenire in qualsiasi momento. Le 17:30 sono un riferimento operativo, non un vincolo tecnico. Sala definitiva, tavoli e note interne vengono salvati separatamente dalla preferenza originale e ogni modifica viene registrata.

M10-A, approvata tecnicamente da Work, espone una lettura strettamente read-only e comandi espliciti di assegnazione/riassegnazione/rimozione per Staff e Admin. Le correzioni storiche verificano riferimenti attivi senza ricostruire disponibilità passate; per servizi correnti o futuri una nuova sala deve essere effettivamente disponibile. I posti dei tavoli non bloccano e lo stesso tavolo può essere riutilizzato da prenotazioni diverse.

M10-B integra reschedule, cancellazione e impatto delle configurazioni. Data, servizio o orario modificati rimuovono atomicamente l'assegnazione; gli altri campi la conservano. La cancellazione la conserva come storia ma la esclude dagli impatti. Il motore M9-D conta una prenotazione una sola volta, richiede conferma su assegnazioni future coinvolte e preserva i riferimenti come grandfathered.

M10-C, approvata da Work e merged su `main` con la PR #12, completa la dashboard operativa: preferenza e collocazione finale sono proiezioni distinte, `DA ASSEGNARE` deriva dall'assenza dell'assegnazione attiva, filtri e riepiloghi sono calcolati server-side e le cancellate non entrano nei conteggi operativi. Il pannello usa esclusivamente GET/PUT/DELETE M10-A, mostra min/max posti come informazione, conserva riferimenti grandfathered e, su `VERSION_CONFLICT`, non ripete la scelta umana ma richiede una rilettura esplicita. Con M10-A e M10-B già merged su `main` con la PR #11, M10 è completata e merged; M11 è stata successivamente approvata da Work e squash-merged su `main` con la PR #14. M12 è la milestone successiva e non è ancora iniziata.

### 12.6 Esportazioni

Il PDF presenta nell'ordine:

1. `DA ASSEGNARE`;
2. Sala 1;
3. Sala 2;
4. Sala 3;
5. Galleria;
6. Terrazzo.

Dentro ogni sezione le prenotazioni `CONFIRMED` sono ordinate per momento di creazione e UUID. Assegnazioni assenti o con `clearedAt` valorizzato confluiscono in `DA ASSEGNARE`; riferimenti attivi poi disabilitati o indisponibili restano nella sezione finale per grandfathering. Tutte le sezioni compaiono anche vuote. Il PDF A4 landscape include pranzo e cena, righe e dettagli operativi, wrapping, intestazioni ripetute e pagine numerate.

Excel supporta:

- singola giornata;
- mese, con un foglio per giorno;
- intervallo selezionato, con un foglio per giorno.

`MONTH` include ogni giorno del mese e `RANGE` è inclusivo fino a 31 giorni calendar-based. Ogni foglio `YYYY-MM-DD`, anche vuoto, contiene le 24 colonne M11, intestazione frozen e filtro; date e orari sono celle tipizzate. Tutti i testi controllabili dall'utente attraversano la neutralizzazione formula injection e il workbook non produce formule, hyperlink o external link.

Le due route `/api/staff/exports/pdf` e `/api/staff/exports/excel` applicano sessione Staff/Admin, stato account, cambio password e same-origin prima del JSON strict. PDFKit ed ExcelJS completano il buffer fuori dalla transazione di lettura; i cap sono 2.000/20.000 prenotazioni e 25 MiB. Il servizio scrive audit `EXPORT` SUCCESS/FAILURE con metadata minimizzati in una transazione separata e non restituisce il file se l'audit SUCCESS fallisce. Nessun file temporaneo o permanente viene creato e non esiste un workbook destinato a crescere indefinitamente. Riferimenti: D-038 e ADR 006.

## 13. Notifiche

WhatsApp è il canale principale in produzione. L'email è facoltativa e l'Admin può configurare:

- solo WhatsApp;
- WhatsApp con fallback email in caso di errore;
- WhatsApp ed email in parallelo.

Sviluppo e staging usano esclusivamente provider simulati. La produzione WhatsApp usa esclusivamente API ufficiali Meta. Il gruppo WhatsApp è opzionale; dashboard e notifica a un numero interno non dipendono dal gruppo.

Il pattern outbox garantisce che un errore del provider non perda o annulli la prenotazione. I dettagli sono in `docs/adr/005-notification-outbox.md`.

Canale principale, fallback, invio parallelo, outbox e provider simulati vengono implementati insieme in M12. M9 introduce soltanto i dati di contatto, non strategie o invii.

## 14. Configurazione

Devono essere configurabili e non hardcoded:

- telefono pubblico;
- URL canonico pubblico HTTPS;
- email facoltativa;
- numero WhatsApp facoltativo;
- testi pubblici IT/EN per i casi approvati; etichette, errori tecnici e validazioni restano nel codice i18n e non esiste un archivio HTML libero;
- durata del link personale;
- giorni e servizi;
- orari; l'intervallo slot V1 resta fisso a 15 minuti;
- cutoff;
- limite di coperti;
- sale disponibili;
- strategia delle notifiche.

Segreti e configurazione infrastrutturale restano nelle variabili d'ambiente. Le configurazioni operative modificabili dall'Admin sono salvate in PostgreSQL.

## 15. Ambienti e distribuzione

### Sviluppo locale

- applicazione locale;
- PostgreSQL tramite Docker;
- dati esclusivamente fittizi;
- provider simulati.

### Staging personale

- applicazione e database separati;
- dati esclusivamente fittizi;
- provider simulati obbligatori;
- nessun collegamento al sito ufficiale.

### Produzione

- account intestati al ristorante;
- database nuovo;
- dominio e provider del ristorante;
- backup reali;
- RPO massimo 15 minuti;
- RTO massimo 4 ore.

L'infrastruttura definitiva e le procedure operative saranno implementate in milestone successive. Gli obiettivi RPO/RTO sono documentati da subito in `docs/SECURITY.md`.

## 16. Decisioni architetturali correlate

- `docs/adr/001-modular-nextjs-monolith.md`;
- `docs/adr/002-postgresql-source-of-truth.md`;
- `docs/adr/003-reservation-capacity-concurrency.md`;
- `docs/adr/004-environment-separation.md`;
- `docs/adr/005-notification-outbox.md`.
- `docs/adr/011-manual-room-table-assignment.md`.
