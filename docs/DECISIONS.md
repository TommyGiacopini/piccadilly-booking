# Piccadilly Booking — Registro delle decisioni

**Stato:** approvato
**Data:** 31 luglio 2026

## 1. Scopo e autorità

`docs/PROJECT_SPEC.md` resta la fonte ufficiale dei requisiti funzionali. Questo registro conserva le decisioni approvate che precisano l'implementazione o risolvono ambiguità senza modificare direttamente la specifica.

Ogni nuova decisione architetturale significativa deve essere aggiunta qui e, quando opportuno, accompagnata da un ADR.

## 2. Decisioni approvate e vincolanti

### D-046 — T06-A: NI autonome, NC compatibili ed esclusione NI dagli export

Il mandato Controller del 14 ottobre 2026 congela T06-A e autorizza soltanto implementazione locale. `Reservation.notes` rimane NC condivisa con il cliente, modificabile tramite i flussi Public/management/PHONE/Staff canonici, senza provenance o attribuzione automatica della paternità. NI usa una sola colonna nullable `privateNotes`, massimo 1000 code point, vuoto→null, testo semplice senza storico, indipendente dalla sala e preservato da reschedule/cancellazione.

Staff/Admin possono editare CONFIRMED anche storiche e senza assegnazione; CANCELLED è read-only. PUT strict version/privateNotes, auth/tenant/status prima del no-op, stale identical no-op senza side effect, cambi reali con singola versione e audit PRIVATE_NOTES_UPDATED atomico e minimizzato. Snapshot soltanto presenza/versione, nessun testo/estratto/hash/PII. Legacy internalNotes non copiate o promosse e consultabili separatamente active/cleared; T04 resta canonico.

La policy Owner supera l'inclusione NI storica D-038: nessuna NI in PDF/Excel o proiezione export. Le 24 colonne Excel rimangono invariate con W vuota; NC e altri dati operativi sono preservati, senza redesign. Migration16 additiva senza backfill, preservando migration1–15 e FK. Estensioni Controller esplicite: runner/test per latest16 esatto, tre conteggi test storici e planner con proiezione positiva dopo failure runtime NI; perimetro di 43 path.

T05 è CLOSED con PR #28. T06-B/C/D non avviate; zero staging, commit, push, PR, merge, deploy, DB persistente, Render o Asporti. Implementazione e gate restano locali; serve Work Final QG indipendente prima di eventuale mandato Git.

### D-001 — Architettura

Il sistema è un monolite modulare Next.js full-stack, con App Router, runtime Node.js, TypeScript strict, PostgreSQL, Prisma e Zod. Il repository è unico.

Riferimento: `docs/adr/001-modular-nextjs-monolith.md`.

### D-002 — Fonte ufficiale dei dati

PostgreSQL e la dashboard costituiscono l'archivio completo. PDF ed Excel sono esclusivamente esportazioni e non possono diventare fonti dati o canali di modifica.

Riferimento: `docs/adr/002-postgresql-source-of-truth.md`.

### D-003 — Capacità

Il limite iniziale è 30 coperti in ogni finestra mobile di 30 minuti. Le finestre sono valutate su slot ogni 15 minuti.

Il numero massimo di coperti è configurabile dall'Admin. Tipo e durata della finestra restano fissi nella prima versione.

Riferimento: `docs/adr/003-reservation-capacity-concurrency.md`.

### D-004 — Cutoff modifica e cancellazione

Valori iniziali:

- pranzo: 10:30 del giorno della prenotazione;
- cena: 17:30 del giorno della prenotazione.

Entrambi sono configurabili dall'Admin.

### D-005 — Cutoff nuove prenotazioni del weekend

Il venerdì e il sabato le nuove prenotazioni online per la cena chiudono inizialmente alle 17:30. Giorni, servizio e orario della regola sono configurabili tramite una `BookingCutoffRule` generica per ristorante, giorno e servizio. Il cutoff non impedisce inserimenti Staff o telefonici. Decisione implementata da M9-C.

### D-006 — Link personale

Il link:

- permette modifica e cancellazione fino al cutoff;
- resta consultabile in sola lettura dopo il cutoff;
- scade 24 ore dopo l'orario prenotato;
- usa un token casuale di 32 byte;
- salva nel database soltanto l'hash;
- ha durata configurabile.

### D-007 — Override capacità

Admin e Staff possono effettuare override. Sono sempre richiesti un comando esplicito e una motivazione. L'evento entra nell'audit log e non cambia il limite configurato.

### D-008 — Richiesta pubblica non disponibile

La prenotazione pubblica che supera la disponibilità non viene confermata. Il cliente viene invitato a chiamare il ristorante. Lo staff può inserirla manualmente con override.

### D-009 — Prenotazioni telefoniche e consenso

Ogni prenotazione telefonica registra:

- origine `PHONE`;
- versione dell'informativa;
- consenso verbale;
- data e ora;
- utente Staff o Admin che l'ha inserita.

### D-010 — Assegnazione tavolo

L'assegnazione può essere effettuata in qualsiasi momento. Le 17:30 sono un riferimento operativo, non un vincolo tecnico.

### D-011 — Ordinamento PDF

Ordine delle sezioni:

1. `DA ASSEGNARE`;
2. Sala 1;
3. Sala 2;
4. Sala 3;
5. Galleria;
6. Terrazzo.

Dentro ogni sezione le prenotazioni sono ordinate per momento di creazione.

### D-012 — Configurazione e assenza di hardcoding

Telefono, dominio, email, numero WhatsApp, testi pubblici e durata del link sono configurabili. Lo stesso principio vale per gli altri valori operativi indicati nella specifica.

### D-013 — Strategia email

L'email è facoltativa. In produzione WhatsApp è il canale principale. L'Admin può configurare:

- fallback email in caso di errore WhatsApp;
- invio WhatsApp ed email in parallelo;
- nessun invio email.

### D-014 — Esportazione Excel

Excel viene generato:

- per singola giornata;
- per mese, con un foglio per giorno;
- per intervallo selezionato, con un foglio per giorno.

Non esiste un workbook permanente e crescente.

### D-015 — Obiettivi di continuità

La produzione deve essere progettata per:

- RPO massimo 15 minuti;
- RTO massimo 4 ore.

Gli obiettivi vengono documentati ora; infrastruttura e procedure definitive saranno implementate nelle milestone di produzione.

### D-016 — Gruppo WhatsApp

Il gruppo interno resta opzionale e può essere usato soltanto con API ufficiali. Dashboard e notifica a un numero interno devono funzionare indipendentemente dal gruppo.

### D-017 — Implementazione progressiva del modello dati

Il modello dati completo viene documentato fin dall'inizio. Le tabelle vengono create soltanto nelle milestone in cui servono.

### D-018 — Introduzione progressiva delle dipendenze

Ogni dipendenza viene aggiunta soltanto quando la milestone corrente ne richiede concretamente l'uso.

### D-019 — Separazione degli ambienti

Locale, staging personale e produzione hanno dati, database, segreti e provider separati. Locale e staging usano esclusivamente dati fittizi e provider simulati. La produzione viene ricreata su account intestati al ristorante.

Riferimento: `docs/adr/004-environment-separation.md`.

### D-020 — Outbox delle notifiche

Le notifiche vengono richieste tramite transactional outbox e inviate dopo il commit della prenotazione. Gli adattatori simulati e reali condividono le stesse interfacce.

Riferimento: `docs/adr/005-notification-outbox.md`.

### D-021 — Slot e finestra di capacità V1

Nella prima versione l'intervallo degli slot è fisso a 15 minuti e la finestra mobile è fissa a 30 minuti. Soltanto il limite di coperti è modificabile dall'Admin. La UI mostra 15 e 30 minuti come dati informativi; validazione server e vincoli PostgreSQL rifiutano valori diversi. Decisione implementata da M9-C.

Riferimento: `docs/adr/003-reservation-capacity-concurrency.md`.

### D-022 — Creazione e reset degli utenti

Non esiste registrazione pubblica. Creazione e reset generano sul server una password temporanea CSPRNG URL-safe di 24 caratteri, mostrata all'Admin una sola volta e mai inviata da email o WhatsApp; PostgreSQL conserva soltanto l'hash Argon2id e `mustChangePassword`. Finché la password non viene cambiata, le funzioni operative sono bloccate. Reset e cambio password revocano tutte le sessioni; dopo il cambio è richiesta una nuova autenticazione. La password esistente non è leggibile. Decisione implementata da M9-B.

Riferimento: `docs/adr/008-identity-temporary-password-last-admin.md`.

### D-023 — Protezione degli Admin

Per ogni ristorante deve esistere almeno un Admin attivo. Un Admin non può disabilitare il proprio account né retrocedere se stesso a Staff; l'ultimo Admin attivo non può essere disabilitato o retrocesso. Gli utenti non vengono eliminati fisicamente. M9-B implementa il controllo con lock advisory transazionale PostgreSQL stabile per ristorante, rilettura e conteggio nello stesso commit serializzabile.

Riferimento: `docs/adr/008-identity-temporary-password-last-admin.md`.

### D-024 — Durata originaria del link personale

Una modifica della durata vale soltanto per i token creati successivamente. Ogni token conserva la durata applicata alla creazione. Se una prenotazione viene spostata, la scadenza viene ricalcolata rispetto al nuovo servizio usando la durata originaria, senza consultare la configurazione corrente e senza rigenerare il token. La modifica non è implementata in M9-A.

### D-025 — Anteprima e conferma dell'impatto

Una modifica di configurazione che coinvolge prenotazioni future richiede: anteprima server-side senza PII; conteggio e classificazione; conferma esplicita dell'Admin; ricalcolo dentro la transazione; errore `IMPACT_CHANGED` se lo stato è mutato; applicazione senza modificare o cancellare prenotazioni; audit di impatto e conferma. L'impatto è un avviso confermabile, non un blocco definitivo. M9-C implementa il protocollo per impostazioni di prenotazione, servizi settimanali e cutoff pubblici; sale, tavoli e `ServiceInstance` restano successivi.

Riferimento: `docs/adr/007-configuration-lifecycle-impact.md`.

### D-026 — Grandfathering delle prenotazioni

Una configurazione successiva non invalida retroattivamente prenotazioni confermate e non le modifica o cancella automaticamente. Valori invariati possono essere conservati anche se sala o servizio diventano inattivi; modifiche a contatti, note o richieste restano consentite. Nuova data, servizio, ora o sala devono rispettare la configurazione corrente. Una riduzione dei coperti sullo stesso servizio resta consentita; un aumento ricontrolla capacità e regole correnti.

Riferimento: `docs/adr/007-configuration-lifecycle-impact.md`.

### D-027 — Lifecycle di sale, tavoli, servizi ed eccezioni

Le sale canoniche V1 sono Sala 1, Sala 2, Sala 3, Galleria e Terrazzo; il codice è immutabile e non si creano o eliminano sale arbitrarie. L'Admin ne modifica soltanto stato e ordine. I tavoli possono essere creati, aggiornati e disattivati, mai eliminati fisicamente; il cambio sala richiede disattivazione e nuova creazione. Servizi, eccezioni, sale e tavoli sono disattivati o archiviati. In M9-A la rimozione già esistente delle date straordinarie diventa archiviazione reversibile.

Riferimento: `docs/adr/007-configuration-lifecycle-impact.md`.

### D-028 — ServiceInstance e disponibilità sale

La fase successiva userà `ServiceInstance`, unica per ristorante, data e servizio, e `ServiceRoomAvailability`, collegata al servizio e alla sala, con materializzazione progressiva. Galleria e Terrazzo saranno configurabili per data e servizio. Non verrà introdotta una tabella parallela `RoomAvailabilityOverride`. Il ricalcolo delle istanze future richiederà anteprima, conferma e audit; le prenotazioni esistenti resteranno confermate. Questi modelli non sono implementati in M9-A.

Riferimento: `docs/adr/009-service-instance-room-availability.md`.

### D-029 — Contatti e testi pubblici configurabili

La configurazione futura comprende telefono, email pubblica facoltativa, dominio, numero WhatsApp e i testi pubblici IT/EN approvati per introduzione, preferenza sala, cutoff, indisponibilità, conferma e sola lettura del link. Etichette, errori tecnici e validazioni restano nel codice i18n; non esiste un archivio libero di HTML o chiavi arbitrarie. I modelli non sono implementati in M9-A.

### D-030 — Confine delle notifiche

Canale principale, fallback, invio parallelo, outbox e provider simulati appartengono interamente a M12. M9 gestirà soltanto i dati di contatto e non strategie o invii.

### D-031 — Architettura dell'audit

`ReservationAuditEvent` resta il registro specializzato delle prenotazioni; `AuditEvent` registra autenticazione, identità e configurazione. I flussi saranno uniti soltanto da una proiezione applicativa di lettura, senza unificazione distruttiva. L'audit è append-only nell'applicazione, scritto nella stessa transazione della mutazione e costruito con snapshot a whitelist, mai serializzando interi modelli Prisma. La consultazione futura è riservata esclusivamente agli Admin.

Riferimento: `docs/adr/006-audit-architecture-minimization.md`.

### D-032 — ServiceInstance e materializzazione lazy

Il modello approvato è `ServiceInstance`, unica per ristorante, data locale e servizio, con `ServiceRoomAvailability` come sola fonte persistente della disponibilità delle sale per l'istanza. Non esistono snapshot di orari, capacità, cutoff o stato aperto/chiuso e non viene introdotta `RoomAvailabilityOverride`. Gli stati `VIRTUAL`, `MATERIALIZED` e `HISTORICAL` sono derivati e non persistiti.

La materializzazione è esclusivamente lazy, idempotente e concorrente-safe: avviene nella stessa transazione della prima prenotazione creata con successo oppure della prima modifica amministrativa effettiva alla disponibilità delle sale. GET, preview, no-op e job non materializzano; non esistono backfill indiscriminati o orizzonti futuri. Le prenotazioni restano collegate soltanto a data e servizio. Le istanze storiche sono conservate e read-only.

Riferimento: `docs/adr/009-service-instance-room-availability.md`.

### D-033 — Catalogo fisso e policy di disponibilità delle sale

Il catalogo V1 contiene esclusivamente Sala 1, Sala 2, Sala 3, Galleria e Terrazzo. `DA ASSEGNARE` è una categoria virtuale e non una sala persistita. L'Admin può modificare soltanto stato e ordine; non può creare, rinominare, eliminare o cambiare il codice delle sale.

Ogni sala possiede una policy persistita e non modificabile dall'Admin: Sala 1, Sala 2 e Sala 3 sono `DEFAULT_AVAILABLE`; Galleria e Terrazzo sono `EXPLICIT_ONLY`. In assenza di istanza le prime sono disponibili e le seconde indisponibili. Con un'istanza, `ServiceRoomAvailability` determina il valore locale; una sala globalmente inattiva resta sempre indisponibile. Il runtime usa la policy, mai confronti su nome o codice.

Riferimenti: `docs/adr/007-configuration-lifecycle-impact.md` e `docs/adr/009-service-instance-room-availability.md`.

### D-034 — Durata originaria del link personale

La durata iniziale del link personale è 24 ore dopo l'orario prenotato ed è configurabile dall'Admin come numero intero da 1 a 24 ore. La modifica è esclusivamente prospettica: non aggiorna, rigenera o revoca token esistenti e non modifica hash, prenotazioni o audit storici.

Ogni token conserva implicitamente la durata applicata alla creazione. Se la prenotazione viene spostata, il sistema ricava tale durata come differenza esatta tra la scadenza di consultazione e il precedente istante del servizio nella timezone del ristorante, la valida come numero intero da 1 a 24 ore e la applica al nuovo istante. Uno stato legacy incoerente causa rollback sicuro. La semantica vale anche nei passaggi di ora legale `Europe/Rome`; token e hash non entrano nell'audit.

Riferimento: `docs/adr/010-public-settings-content-management-link-duration.md`.

### D-035 — Configurazione e contenuti pubblici

L'Admin configura telefono pubblico, URL HTTPS canonico di prenotazione, email pubblica facoltativa, numero WhatsApp facoltativo e un set completo di contenuti editoriali italiani e inglesi. Le sole chiavi ammesse sono `BOOKING_PAGE_TITLE`, `BOOKING_PAGE_INTRO`, `UNAVAILABLE_MESSAGE`, `CONTACT_PROMPT`, `CONFIRMATION_MESSAGE`, `MANAGEMENT_PAGE_TITLE` e `MANAGEMENT_PAGE_INTRO`; etichette, pulsanti, errori e testi tecnici restano traduzioni applicative versionate nel codice.

I contenuti sono testo semplice, non HTML o Markdown eseguibile. Telefono e WhatsApp sono soltanto contatti: M9-E non introduce provider, API Meta, template, analytics, email, messaggi o invii automatici. Configurazione, contenuti e durata sono salvati con mutazioni Admin separate, transazionali e auditate tramite snapshot minimizzati.

Riferimento: `docs/adr/010-public-settings-content-management-link-duration.md`.

### D-036 — Proiezione unificata dell'audit

`ReservationAuditEvent` e `AuditEvent` restano tabelle distinte e non vengono copiati, duplicati o riscritti. M9-F li unisce esclusivamente in lettura con un contratto applicativo comune minimizzato; ogni ramo della query filtra il `restaurantId` prima della `UNION ALL`.

L'ordinamento globale è `createdAt DESC`, ranking stabile della sorgente (`ADMINISTRATIVE` prima di `RESERVATION`) e `id DESC`. La paginazione è keyset con cursore opaco, versionato e legato tramite fingerprint ai filtri correnti. Lista e dettaglio sono riservati all'Admin, applicano allow-list positive anche a eventi legacy o corrotti e non generano nuovi eventi audit. La retention resta una decisione futura separata.

Riferimento: `docs/adr/006-audit-architecture-minimization.md`.

### D-037 — Fondazione dell'assegnazione manuale di sala e tavoli

M10 è suddivisa in tre tranche. M10-A introduce fondazione dati, dominio, repository, servizio applicativo, API Staff/Admin e test; M10-B integra il lifecycle di reschedule e cancellazione e l'impatto delle disattivazioni; entrambe sono merged su `main` con la PR #11. M10-C implementa la UI operativa, è approvata da Work ed è merged su `main` con la PR #12. Con il merge di M10-C, M10 è completata e merged su `main`; M11 è stata successivamente approvata da Work e squash-merged su `main` con la PR #14. M12 è stata successivamente approvata da Work e squash-merged su `main` con la PR #16. M13 FASE A è merged con la PR #18; la riconciliazione post-corrective è locale e FASE C resta sospesa.

Le decisioni vincolanti approvate sono formalizzate come segue:

- **M10-01 — stato dell'assegnazione:** una sola entità persistente per prenotazione, stato attivo derivato da `clearedAt IS NULL`, sala finale e almeno un tavolo distinto della stessa sala, rimozione esplicita e nessun backfill;
- **M10-02 — posti dei tavoli:** `minimumSeats` e `maximumSeats` sono soltanto informazioni operative e non bloccano la scelta manuale;
- **M10-03 — riutilizzo dello stesso tavolo:** è ammesso tra prenotazioni dello stesso servizio e non vengono introdotti durata, occupazione o collision detection;
- **M10-04 — reschedule e cancellazione:** una modifica effettiva di data, servizio o orario rimuove atomicamente l'assegnazione attiva, mentre persone, preferenza, contatti, esigenze e note la conservano; la cancellazione conserva storicamente l'ultima assegnazione e la esclude dagli impatti operativi;
- **M10-05 — prenotazioni storiche:** Staff e Admin possono correggerle senza cutoff, usando riferimenti attivi e coerenti ma senza ricostruire disponibilità passate o materializzare istanze;
- **M10-06 — grandfathering:** riferimenti esistenti poi inattivi o indisponibili restano visibili e conservabili; ogni riferimento nuovo deve essere attivo e l'analisi d'impatto delle disattivazioni usa preview, conferma esplicita, fingerprint, ricalcolo transazionale e audit senza modificare le assegnazioni esistenti.

Ogni prenotazione possiede al massimo una `ReservationAssignment` persistente. L'assegnazione logica corrente esiste solo quando `clearedAt` è nullo, richiede una sala finale e da uno a venti tavoli distinti appartenenti alla stessa sala. `DA ASSEGNARE` resta derivato dall'assenza di assegnazione attiva. La rimozione è un comando esplicito e logico; una riattivazione riusa la stessa entità e ne sovrascrive lo stato corrente, preservando l'autore iniziale. Non viene eseguito alcun backfill.

I posti minimi e massimi dei tavoli sono dati operativi informativi e non bloccano l'assegnazione. Lo stesso tavolo può essere assegnato a più prenotazioni dello stesso servizio: non esistono ancora durata, occupazione, vincoli temporali o collision detection. Gli ID tavolo sono trattati come insieme e ordinati deterministicamente. Le note interne sono facoltative, non pubbliche, limitate a 1.000 code point e nell'audit compare soltanto il flag di presenza.

Staff e Admin attivi, non disabilitati e senza cambio password obbligatorio possono assegnare, riassegnare e rimuovere. Il tenant, il ruolo, l'attore e il correlation ID derivano esclusivamente dal server e vengono riletti nella transazione. Le mutazioni usano `SERIALIZABLE`, retry, lock nell'ordine prenotazione, configurazione tenant e capacità, versione ottimistica, incremento della `Reservation.version` solo per cambi effettivi e `ReservationAuditEvent` atomico con azioni `ASSIGNED`, `REASSIGNED` e `UNASSIGNED`. I no-op non cambiano versione, timestamp o audit.

Solo prenotazioni confermate ricevono nuove assegnazioni; le cancellate vengono rifiutate. Per servizi correnti o futuri ogni nuovo riferimento deve essere attivo e la sala deve essere effettivamente disponibile. Per prenotazioni storiche sala e tavoli devono essere attivi e coerenti, senza ricostruire disponibilità non versionata e senza materializzare `ServiceInstance`. Riferimenti già assegnati restano visibili e possono essere conservati anche se poi inattivi o indisponibili; ogni riferimento introdotto successivamente deve essere attivo.

M10-B rimuove atomicamente l'assegnazione quando cambiano data, servizio o orario, con un solo incremento della versione della prenotazione e un audit `UNASSIGNED` nella stessa transazione e con lo stesso correlation ID dell'aggiornamento. La conserva per modifiche a persone, preferenza, contatti, esigenze e note e conserva storicamente l'ultima assegnazione alla cancellazione, senza esporla al cliente.

Disattivazioni di sale o tavoli e indisponibilità per data/servizio riusano il protocollo M9-D: la preview minimizzata conteggia una sola volta le prenotazioni confermate correnti o future con assegnazione attiva pertinente, richiede conferma quando esiste impatto e usa un fingerprint opaco ricalcolato nella transazione. Un fingerprint obsoleto produce `IMPACT_CHANGED` senza mutazione o audit. L'applicazione della configurazione preserva assegnazioni, tavoli, note e `clearedAt` secondo grandfathering. M10-C presenta questi riferimenti senza perderli, usa un read model tenant-scoped senza N+1 per prenotazione e delega ogni mutazione alle API M10-A con versione ottimistica.

Riferimento: `docs/adr/011-manual-room-table-assignment.md`.

### D-038 — Esportazioni operative PDF ed Excel M11

M11 genera proiezioni read-only on demand da PostgreSQL e non persiste file. PDFKit `0.19.1` produce PDF A4 landscape per un solo giorno; ExcelJS `4.4.0` produce workbook `DAY`, `MONTH` o `RANGE` con un foglio cronologico per ogni giorno calendario richiesto, inclusi quelli vuoti. Il range massimo è di 31 giorni inclusivi, calcolati per calendario; i limiti sono 2.000 prenotazioni PDF, 20.000 prenotazioni Excel e 25 MiB per ciascun buffer. Non esistono workbook permanente, import, CSV, job o coda di generazione.

Un read model dedicato apre una singola transazione `REPEATABLE READ`, rilegge Staff/Admin e tenant, acquisisce ristorante, sale, prenotazioni `CONFIRMED`, assegnazioni attive e tavoli dell'intero periodo con query bounded. La classificazione è `DA ASSEGNARE`, Sala 1, Sala 2, Sala 3, Galleria, Terrazzo; assegnazioni rimosse sono non assegnate, mentre riferimenti attivi grandfathered restano esportabili. La lettura non materializza `ServiceInstance`, non usa lock e non scrive. PDFKit/ExcelJS renderizzano solo dopo la chiusura della transazione.

Il buffer completo viene validato prima della risposta. L'audit `EXPORT` è scritto in una breve transazione successiva, dopo aver riletto l'attore: `PDF_EXPORT_REQUESTED` o `EXCEL_EXPORT_REQUESTED`, outcome `SUCCESS` o `FAILURE`, entità e stati nulli, metadata esclusivamente allow-listed. Un errore dell'audit SUCCESS elimina l'esito applicativo e nessun file viene restituito; un fallimento di generazione tenta un solo audit FAILURE. Questa è un'eccezione deliberata alla regola di atomicità mutazione/audit: l'export non modifica stato di business e l'evento registra la richiesta completata o fallita.

Le route POST Node.js sono riservate a Staff/Admin attivi, same-origin e senza cambio password obbligatorio; accettano JSON strict che non include tenant, attore, ruolo, correlation ID o filename. I file usano `private, no-store`, `nosniff`, lunghezza e nome ASCII deterministico. Noto Sans è incorporato da un asset server-side del repository ufficiale `google/fonts` al commit vincolato. L'Excel contiene esattamente 24 colonne, celle temporali tipizzate e neutralizzazione preventiva della formula injection; non contiene formule, hyperlink, collegamenti esterni, macro o celle unite.

La proiezione M9-F include categoria `EXPORT` e le due azioni con outcome SUCCESS/FAILURE, preserva il tenant filter e mostra soltanto i metadata autorizzati. PDF ed Excel includono i dati operativi espressamente previsti, comprese le note interne per Staff/Admin, ma escludono email, identificativi, token, hash, consensi, override e dati audit.

### D-039 — Outbox e provider simulati M12

M12 introduce un transactional outbox in cui ogni riga rappresenta una delivery leg per canale. Reservation, audit, supersede/cancel e pianificazione condividono la transazione `SERIALIZABLE`; la persistenza outbox fallita annulla la mutazione, mentre ogni fallimento provider successivo al commit lascia invariato lo stato business. I sei mutation path usano un correlation ID generato server-side prima della transazione.

La garanzia è intent durevole atomico, processing tecnico at-least-once ed exactly-once logico per leg tramite chiave SHA-256 e receipt simulata persistente. Un replay con la stessa chiave e lo stesso hash restituisce la medesima provider reference; un hash differente produce `IDEMPOTENCY_CONFLICT`. M12 non promette exactly-once fisico.

Il worker usa batch globale 25, massimo 5 leg per tenant, lease di due minuti e `FOR UPDATE SKIP LOCKED` in transazioni brevi. Prima del claim uno sweep concorrente e idempotente terminalizza al massimo 100 leg `PENDING` scadute, senza attempt o fallback. Provider e renderer operano fuori transazione; fino a cinque leg vengono processate contemporaneamente. Ogni call riceve un `AbortSignal` server-side e una deadline iniettabile esatta di 30 secondi, usata anche per rendere bounded lo shutdown senza avviare task queued. Gli attempt sono append-oriented; lease scadute abbandonano l'attempt incompleto e requeue/cancel sono condizionati dal lease token. I retry V1 sono 1, 5 e 15 minuti dal completamento reale della call, massimo quattro attempt, senza jitter; completion o retry uguale o oltre expiry terminalizza con `EXPIRED`.

La strategia persistita per ristorante viene copiata su ogni leg: WhatsApp soltanto, WhatsApp con fallback email, oppure parallelo. Il fallback nasce atomicamente con la terminalizzazione del primary; le leg parallele sono indipendenti. Il flag telefonico sopprime soltanto la confirmation WhatsApp iniziale e partecipa all'idempotenza della richiesta. Il reminder a esattamente tre ore è incluso, a meno di tre ore è escluso.

M12 include soltanto provider simulati deterministici, senza rete, SDK, segreti o selezione reale. Payload, failure e warning dashboard sono minimizzati. Non esiste un job di retention: la relativa policy è un gate obbligatorio prima di M14/produzione. Riferimento: ADR 005.

### D-040 — Contratto dello staging personale M13

M13 FASE A è merged con la PR #18. La riconciliazione locale sulla baseline
post-PR #19/#20/#21 conserva un Render Blueprint versionato con un servizio web
Node, un background worker Node separato e un PostgreSQL dedicato, tutti in
regione Frankfurt. I nomi stabili sono `piccadilly-booking-m13-staging-web`,
`piccadilly-booking-m13-staging-worker` e
`piccadilly-booking-m13-staging-db`; non contengono SHA. Il profilo congelato è
Hobby workspace, web e worker `0.5c-512mb`, database `0.1c-256mb`, storage 1 GB,
una sola istanza per servizio, preview e auto-deploy disabilitati. La cifra di
20,30 USD/mese è una stima storica, non un prezzo corrente o un'autorizzazione:
**RENDER COST CHECKPOINT — REFRESH REQUIRED BEFORE ANY RESOURCE CREATION**.

`APP_ENV` è il confine applicativo canonico: `staging` resta staging anche quando
Render imposta `NODE_ENV=production`; `APP_ENV=production` vieta sempre il seed
demo. Il web valida fail-fast l'ambiente Render, il proxy fidato, l'URL HTTPS
`*.onrender.com`, le configurazioni applicative e i secret obbligatori. Il
pre-deploy applica le quattordici migration versionate e poi il seed fittizio. Il
worker non esegue migration: attende per massimo 120 secondi che tutte le
quattordici migration risultino applicate, quindi avvia il CLI corrente. Il runtime
PR #21 mantiene classificazione transient/fatal, backoff `1/2/5/10/30`, log
strutturati sanitizzati e lifecycle di loop separato dai retry delivery M12.

Lo staging è protetto con HTTP Basic, esclusi soltanto health e robots, espone
un banner demo, `noindex/nofollow/noarchive` globale e cookie di sessione
`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, senza `Domain`. Gli header
forwarded usano l'ultimo valore, cioè l'hop più vicino al proxy fidato. Health
verifica PostgreSQL senza esporre URL, stack o dettagli migration.

Seed, test e tooling accettano esclusivamente il tenant demo, contatti fittizi,
email `@example.test`, telefoni `+390000...` e provider simulati. Le operazioni
di verifica, fingerprint e cleanup sono CLI senza endpoint HTTP, rifiutano la
produzione e limitano il cleanup al run ID confermato, preservando un
fingerprint delle righe non appartenenti al run. La suite Playwright remota non
riceve `DATABASE_URL`.

Il normale `npm test` usa il runner PostgreSQL isolato PR #21 e abilita nel
child environment controllato i test PostgreSQL M13, senza ereditare autorità
dal relativo flag host. M13 non modifica schema o migration, non aggiunge dipendenze, non introduce
provider reali, Redis, cron, disk persistenti, dominio custom o GitHub Actions.
Le attività Render mutative richiedono una successiva autorizzazione Controller.
ADR 004 resta invariato e autorevole per la separazione degli ambienti.

Il Blueprint Validation Re-Gate classifica il requisito precedente come
**EXTERNAL TOOLING CONTRACT DRIFT — NON-IMPLEMENTATION DEFECT**. In Fase A il
contratto di validazione comprende soltanto JSON Schema ufficiale Render, test
permanenti del Blueprint e review statica della specifica corrente. La formula
canonica è: “Official Render JSON Schema validation PASS; authenticated
workspace-aware Render semantic validation deferred by contract to FASE C.”

Solo in Fase C, dopo Quality Gate locale, pubblicazione Git, merge e separate
autorizzazioni Controller all'accesso/autenticazione Render e al costo/provisioning, il CLI eseguirà la
validazione autenticata con workspace process-local, exit code 0, `valid=true`,
ispezione del plan, semantic validation e conflict checking prima di qualunque
creazione o sincronizzazione. Workspace ID e token non sono versionati,
hardcoded o inclusi nelle evidence.

La riconciliazione locale non crea risorse, non esegue test remoti e non completa
M13. FASE C resta sospesa e non iniziata fino ai successivi gate Controller.

### D-041 — Lifecycle di arrivo della prenotazione T03

L'arrivo appartiene all'intera prenotazione ed è persistito come `Reservation.arrivedAt` nullable in UTC. `ATTESO` e `ARRIVO NON REGISTRATO` sono derivazioni UI dipendenti dal contesto temporale, non stati o enum del database; `ReservationStatus` resta indipendente e la cancellazione non rimuove un arrivo registrato. La migration additiva #14 non usa default, backfill o indice.

Staff e Admin usano un unico comando desired-state reversibile. Un no-op precede il controllo versione e non modifica versione, `updatedAt` o audit; un cambio reale richiede la versione corrente, incrementa una sola volta e registra atomicamente `ARRIVAL_RECORDED` o `ARRIVAL_REVERTED`. La transazione `SERIALIZABLE` usa il solo lock advisory della prenotazione e rilegge prenotazione e attore tenant-scoped: non acquisisce lock capacità/configurazione, non cambia disponibilità e non genera notifiche.

Gli snapshot audit contengono esclusivamente il booleano registrato e il timestamp arrival nullable. Il dato è Staff-only, non entra nei contratti pubblici e nella Staff Agenda alimenta riepiloghi dei soli coperti confermati. Timestamp dettagliato, filtri/ordinamenti arrival, arrivi parziali e logiche no-show restano fuori da T03.

### D-042 — Owner Change v2: composizione del gruppo e richiesta Sala con i Giochi

`partySize` resta il totale coperti; `childrenCount` nullable e `gameRoomPreference` nullable sono la sola nuova source of truth. Unknown non equivale a zero. Public nuova deve dichiarare composizione; PHONE può registrare Non specificato. Un legacy unknown può essere conservato per modifiche estranee, non per un cambio totale; una composizione nota non viene degradata implicitamente.

La sala fisica non è più una scelta cliente nei nuovi flussi Public/PHONE/edit/management. Le preferenze storiche restano leggibili e non diventano assignment. Il booleano `preferences.children` rimane solo compatibilità derivata dal conteggio noto oppure legacy non autorevole. Il client non invia due verità. Preferenza giochi non garantita, priorità best-effort per ordine prenotazione, nessuna auto-assegnazione o capacità Sala 3.

Migration #15 senza default, indice o backfill. No-op comprende entrambi i campi; audit minimizzato non aggiunge PII/action. I nuovi hash includono i campi. Parser della forma precedente sono replay-only di record non scaduti e corrispondenti: nessuna nuova prenotazione legacy e nessuna riscrittura degli hash persistenti.

Foundation A precede T04 revised/T05. Non integra il T04 parziale; assignment/arrival/collision/capacità/notifiche conservano i contratti già approvati.

### D-043 — Foundation A: storage degli envelope e limiti degli input

`Reservation.preferences` e `Reservation.allergies` contengono rappresentazioni
JSON interne: migration Foundation #15 le converte a PostgreSQL `TEXT`, senza
backfill o modifica dei valori. `notes` resta `VARCHAR(1000)`. Migration 1–14
non cambiano; non viene creata migration16 e il DB persistente resta schema14
durante l'implementazione locale.

I limiti raw/user-facing restano invariati: preferenze legacy 1000, allergie e
intolleranze 300 ciascuna, note 1000, ricorrenza 200 e sala legacy 80. Il limite
raw 1000 non si applica al risultato interno di JSON.stringify: envelope ed
escaping possono espandere input individualmente bounded. Lo schema raw resta
distinto dal validator interno lossless; nessuna request accetta legacyText.

Gli update Staff/management preservano preferenze e allergie storiche dal valore
persistito letto nella transazione. Uno stato equivalente conserva la stringa
originale byte-identica e non genera versione, timestamp o audit; una modifica
reale conserva il testo storico nel solo envelope storage. Le nuove create non
inventano legacyText. Hash idempotency, audit minimizzato, esposizione Public,
notifiche, export, assignment e arrival non cambiano.

### D-044 — T04 Revised: assegnazione di sola sala sulla Foundation A

Il contratto corrente estende D-037/M10 alla sala obbligatoria con zero–venti tavoli distinti. Room-only è assegnata, contribuisce ai coperti della sala finale e mostra tavoli DA ASSEGNARE neutro. Assignment assente/cleared resta non assegnata. Il cambio sala esplicito resetta visibilmente i tavoli senza cancellare note; rimuovere tutti i tavoli è locale e il PUT conserva la sala, mentre DELETE rimuove logicamente l'assegnazione. La riattivazione riusa entità e autore iniziale.

Auth, tenant e CONFIRMED precedono ogni no-op. Equality comprende sala, table set e note e precede versione/nuovi riferimenti: stale identical no-op non modifica versione, timestamp o audit. Due desired identici concorrenti convergono con una sola mutation/audit/version+1; differenti hanno un vincitore e VERSION_CONFLICT. Lock, SERIALIZABLE e retry canonici restano invariati. Audit minimizzato è atomico e ammette tableIds=[]/tableCount=0.

Richiesta giochi Foundation, composizione nullable unknown e preferenza storica di sala sono distinte dall'assegnazione operativa. Raw legacy, arrival T03 e tutti i flussi Foundation restano preservati. Schema e migration 1–15 invariati: nessuna migration16, nuova route, DTO parallelo, collision detection, policy T05, notifica o Render. Riferimento: ADR 011, estensione corrente T04 Revised. Implementazione locale soggetta a gate funzionali e Work Final QG; nessuna autorizzazione alla pubblicazione Git.

### D-045 — T05: label operative e compatibilità delle aree legacy

Approvate dal Controller T05-P01–P05 il 9 ottobre 2026: Sala 1/Sala 2/Sala 3 — Giochi sono label operative Staff/Admin dei code immutati; Galleria/Terrazzo mostrano Area legacy neutra, non retired o history-only. Un solo helper puro deriva label/categoria grafica dai code, con fallback name raw completo. Nessuna categoria entra in eligibility, persistenza, DTO/API, seed/default, audit storico o preferenza storica cliente.

M9 rimane autorevole: servizio aperto, sala attiva globalmente e configurazione per data/servizio; DEFAULT_AVAILABLE/EXPLICIT_ONLY immutati. Legacy disponibili sono assegnabili; grandfathering preserva riferimenti correnti, nuovi riferimenti validati. Ordine displayOrder/code preservato, senza raggruppamento fisso. Admin distingue globale/configurata/effettiva e chiarisce local storico read-only vs globale attuale. GET/preview/no-op non materializzano.

Richiesta giochi non garantita e composizione unknown restano indipendenti dall'assegnazione. Label-only non cambia roomId, tavoli, note, versione, timestamp, audit o composizione. Foundation A, T03 e T04 sono CLOSED e preservati. Schema15 sufficiente, migration16 esclusa. Public, export, collision detection, T06+, Render e Asporti fuori scope.

Autorizzazione limitata a 14 path e implementazione locale con database temporanei isolati; nessuna staging/commit/push/PR/merge. Work Final QG e autorizzazione Git sono gate separati. Riferimento ADR 007, addendum T05.

## 3. Decisioni reversibili

Le seguenti scelte possono cambiare senza alterare il dominio, purché il cambiamento venga testato e documentato:

- libreria concreta per autenticazione e sessioni;
- libreria Argon2id concreta;
- libreria i18n oppure dizionari interni;
- provider email;
- modalità concreta di esecuzione del worker;
- hosting, mantenendo la riproducibilità;
- implementazione del rate limiting con PostgreSQL o, in futuro, servizio dedicato;
- libreria dei componenti UI;
- strategia di osservabilità;
- durata e politica di retry delle notifiche;

Le scelte reversibili non autorizzano l'aggiunta anticipata di dipendenze.

## 4. Funzionalità rimandate

- WhatsApp reale fino alle milestone finali;
- gruppo WhatsApp interno;
- assegnazione automatica dei tavoli;
- combinazione automatica dei tavoli;
- previsione meteo automatica;
- account cliente;
- CRM;
- pagamenti;
- importazione Excel;
- archivio basato su file;
- multi-ristorante;
- microservizi;
- analytics avanzate.

## 5. Punti ancora da definire

Questi punti non bloccano la documentazione corrente, ma devono essere decisi prima della relativa milestone:

- testo e versioni iniziali di privacy e condizioni;
- politica di conservazione dei dati personali e dell'audit;
- provider email di produzione;
- fattibilità ufficiale del gruppo WhatsApp al momento dell'integrazione;
- librerie concrete e versioni da installare in ciascuna milestone;
- provider e procedure definitive di backup coerenti con RPO/RTO;
- RPO/RTO specifici dei singoli componenti esterni;
- criteri di retention o revoca per token scaduti e record tecnici di rate limiting.

## 6. Modifica delle decisioni

Una decisione vincolante cambia soltanto tramite:

1. richiesta esplicita;
2. analisi dell'impatto;
3. aggiornamento di questo registro;
4. aggiornamento dell'ADR pertinente;
5. eventuale aggiornamento autorizzato di `PROJECT_SPEC.md`.

## 2026-10-16 — T06-B final design freeze, CB01–CB07 e SQ01–SQ06

Il mandato iniziale ratificava46 path esatti (29 modificati,17 aggiunti). Il Controller ha poi approvato l'estensione a48 path (31 modificati,17 aggiunti,0 eliminati), aggiungendo esclusivamente `tests/e2e/t04-room-only-assignment.spec.ts` e `tests/e2e/t05-room-policy.spec.ts` per tre assertion di presentazione. Coperti, numero effettivo di bambini, distinzione sconosciuto/zero e tutte le prove DB, Arrival, Assignment, versioning, audit e concorrenza restano vincolanti; il mapping OLD→NEW è nelle evidence. Una successiva decisione approva49 path (32 modificati,17 aggiunti,0 eliminati), aggiungendo soltanto `src/server/auth/session-token.test.ts` per garantire che il secret del test negativo sia sempre diverso dall'originale. Restano tutte le assertion di sicurezza e nessun codice auth, token, policy, runner, timeout o retry è modificato. Sono autorizzati soltanto implementazione locale isolata, clean install canonica, PostgreSQL temporaneo, regressioni complete ed evidence portabile. I376 file baseline fuori scope, manifest, schema16, migration1–16, runner e writer canonici sono protetti. Non sono autorizzati staging, commit, push, PR, merge, deploy, operazioni persistenti o T06-C/D.

È adottato un root client host volatile per superare il limite di lifetime del solo DashboardLayout. Link.onNavigate e beforeunload sono strumenti parziali: Back/Forward non sono falsamente bloccati, la history non viene compensata e le API interne Next non vengono modificate. L’autorizzazione live e il recupero esplicito separano conservazione da visualizzazione.

Durante PENDING payload completo, versione e identità del tentativo sono acquisiti prima del busy lock sincrono e della disabilitazione dei campi. Gli ACK non possono modificare un record ricreato o una sessione diversa.409 non è assunto sempre VERSION_CONFLICT; nessuna interpretazione di messaggi testuali come codici strutturati. Il confronto con dati canonici resta separato dalla bozza.

L’unica estensione auth ammessa è POST /api/auth/draft-context. Il callback login aggiuntivo ammette soltanto il dettaglio con UUID valido, senza wildcard, query o sottopercorsi. Le policy origin/proxy/CSRF/sessione/rate-limit e i callback esistenti restano protetti.

Il Work Final Quality Gate rimane indipendente: test e build locali non costituiscono approvazione autonoma della qualità, della sicurezza globale o del deployment. Le riserve T06-SEC R1–R4 restano documentate e non sono cancellate da T06-B.

## 2026-10-18 — F01-TOCTOU-01 e decisione D01

Il Controller autorizza soltanto remediation locale in11 path nominati, su scope cumulativo52 esatti (35 modificati,17 aggiunti,0 eliminati),425 record e373 file baseline protetti. Le sole tre aggiunte allo scope49 sono i Route Handler PHONE POST, Staff PATCH UPDATE e NI PUT. F02–F04 restano chiusi; auth core, business writer, manifest, schema/migration1–16, runner e configurazioni restano invariati. Nessuna nuova API o migration.

È ratificato il confronto server della sessione proprietaria del draft con la sessione autenticata nella stessa richiesta HTTP. Actor e HMAC derivano da un'unica autenticazione canonica; nessuna seconda lettura indipendente. Il binding è un vincolo aggiuntivo di uguaglianza, non una credenziale. La proof client resta utile ma non chiude da sola l'interleaving cookie A/B. I test devono distinguere CLIENT_NO_DISPATCH, SERVER_REJECTED_BEFORE_WRITER, AUTHORIZED_MUTATION e LEGACY_COMPATIBLE_MUTATION.

D01 consente compatibilità legacy senza header, condizionata all'obbligo verificato dei tre submit T06-B di inviare sempre il binding originale, senza fallback. Il server non dispone di discriminatore autorevole per tutti i client headerless: non si dichiara protezione universale della loro provenienza. Il futuro Work Security QG deve valutare espressamente questo limite. Sono preservati idempotenza PHONE, no-op NI anche stale,409, auth/revoca/password-change/Origin e tutte le policy canoniche. Request già autenticata A può completare dopo login B; nessuna promessa di cancellazione automatica o revoca transazionale concorrente. Pubblicazione, merge, deploy, DB persistente e T06-C/D rimangono vietati.

## 2026-10-19 — T06-C room assignment workspace
Il Controller approva32 path (22M/10A/0D),435 record finali attesi e403 file baseline protetti; implementazione locale, PostgreSQL temporaneo e QG. Nessuna pubblicazione Git, deploy o T06-D.

Nuovo endpoint mirato, dati legacy preservati e blocco conservativo anche su cleared con link; nessun retry che ricada sul PUT legacy. Undo personale revocato dall'Owner. Ordinamento assegnazione audit-derived con unknown esplicito, nessuna migration17.

Cinque estensioni rispetto al candidato27: host/type/test per kind ROOM, request-security e relativo test soltanto per il callback esatto /dashboard/assign-room. Nessun nuovo secret o dipendenza; T06-B non viene riprogettata. Il nuovo endpoint richiede binding obbligatorio e non adotta D01 headerless. Le API legacy preservano i contratti esistenti.

Il ritiro dei controlli tavoli/note/clear dalla UI ordinaria richiede mapping OLD→NEW nei test: scritture deliberate sulle API legacy e prove DB conservate; UI room-only verifica readonly, blocchi, conferme e focus. Nessuna copertura di dominio eliminata.

## 2026-10-20 — T06-D navigazione e hub Admin

Controller: design approvato e implementazione locale autorizzata su13 path (11M/2A/0D),437 file finali attesi,424 file baseline protetti. Baseline main4b1576cc3f93d57dc603cf0c38a911f7c8226ca8, tree e0525944f8da8d59d8f2e7a3ea7af15096dee210, schema16. Nessuna pubblicazione, merge, deploy, operazione persistente o T07.

Un'unica sorgente di metadata alimenta quattro gruppi; Admin rimane accesso all'hub. Gruppi sempre aperti, nessuna nuova preferenza persistita. L'etichetta breve PHONE resta «Nuova prenotazione». ConfigurationShell elimina la duplicazione della navigazione e passa attraverso il guard esistente. Nessun nuovo controller o backend.

Due estensioni del candidato11 riguardano esclusivamente locator/assertion di presentazione in t01-auth-return-to.spec.ts e t06-draft-lifecycle.spec.ts: «Configurazioni» diventa «Impostazioni operative» sulla stessa route e il locator viene circoscritto alla navigazione principale. ReturnTo, dinieghi, campi, history e sicurezza restano invariati. Il cambio di active state da Admin generico alla foglia specifica conserva e rende più precisa la verifica. Il vecchio heading «Area tecnica ADMIN» è sostituito dall'hub con nove destinazioni.

Le riserve D01 headerless storico, BFCache senza attivazione reale certificata, T06-SEC R1–R4, WASM, Linux ed ESLint restano documentate. Nessuna nuova accettazione del rischio o approvazione deployment deriva da T06-D.

## T08 — Decisioni Controller congelate, 23 ottobre 2026
Alternativa A approvata: progressione locale nella stessa pagina con tre sezioni; copy IT/EN del mandato, sette chiavi M9 invariate. Note sempre accessibili anche anticipatamente, senza bypass della disponibilità o dei consensi. Management B approvato: sola correzione OBS01 e fencing delle letture, con layout e contratti PATCH/DELETE preservati.
Tentativo incerto conservato integralmente per retry; avviso prima di edit esplicito, nessun invio automatico con chiave nuova. T07 chiuso per equivalenza; T07_COV01/T07_COV02 restano limiti di copertura separati, esclusi da questa implementazione. Scope T08:12 path,8 modificati/4 aggiunti,441 record finali e429 baseline protetti. Autorizzazione locale senza staging/commit/push/PR/merge/deploy o database persistente.

## T09 — Ratifica Controller D01–D10 (29 ottobre 2026)

Il contratto finale approva preview immediatamente operativa e download M11 separati (D01); data iniziale Agenda e servizio esplicito (D02); gruppi per sala effettiva con sort interno, superando la proposta globale iniziale (D03); Galleria/Terrazzo come filtri legacy pertinenti senza riclassificazione (D04). Letture fresche distinte, timestamp e nessuna promessa di snapshot temporale condiviso (D05).

Nuovo POST preview V2 strict soltanto DAY/LUNCH/DINNER, senza modificare le route PDF/Excel M11 (D06). Auth request-scoped, proof fresca, binding obbligatorio, Origin e privacy positive, nessuna modifica ad auth core/root host (D07). Body2048 byte reali, bounds prima dell'enumerazione, cap+1 e controllo pre-render, soglie2.000/20.000/25MiB/31giorni invariate (D08). Preview senza eventi di generazione file, audit download preservato (D09). Composizione autorevole, unknown distinto da0, NC autorizzate e NI/telefono/email fuori dalla preview (D10).

Scope locale ratificato23 path,17M/6A/0D,447 file previsti e424 baseline protetti. Nessuna pubblicazione Git o deploy. Il dettaglio dei documenti futuri rimane distinto: PDF portrait B/N e campo penna in T10; Agenda Excel è direzione progettuale T11,24 campi storici/Wvuota preservati e campi aggiuntivi solo con successiva ratifica. Nessun nuovo rischio viene accettato per produzione e nessuna advisory è dichiarata risolta da T09.


## T10 — Final design freeze Controller CLASSIC, 30 ottobre 2026

T10-C01 endpoint PDF V2 dedicato; C02 telefono strutturato escluso; C03 Tavolo sempre completamente vuota e scrivibile (supera la proposta Codex B); C04 A4 portrait B/N e margini 12 mm; C05 gruppi T09; C06 metadata audit canonici; C07 solo Pagina N; C08 italiano; C09 profilo PDF richiesto; C10 NC autorizzate integrali; C11 scope 20 path verificato.

Scope: 7 Modified, 13 Added, 0 Deleted; 460 file finali previsti e 440 baseline protetti. Baseline main2242cef809f41529906b7a03ab81db7305c4691b, tree4ba31d2a507786ef270a500b02e292f5c463e939, freeze4ebf3d4a76f753516e48d4d4e1285cfe5a0c33b907cafbb7d1911fcaae31d790, schema16. C03 è realizzabile nello scope eliminando i riferimenti digitali dalla proiezione PDF e lasciando il reader T09 invariato.

Nuovo worktree/branch isolato, lockfile install e PostgreSQL temporaneo autorizzati; nessuna modifica alle copie storiche, al DB persistente, a schema/migration, package/lock, auth core, root host, writer, planner/outbox, runner, infrastruttura o renderer M11. Audit PDF_EXPORT_REQUESTED con allow-list attuale: non aggiunge versione/filtri ai metadata.

WORK3 Final QG è indipendente e necessario. T10 non CLOSED. Nessuno staging Git, commit, push, PR, merge o deploy autorizzato. T11 non avviata; M13 sospesa. Riferimento ADR 012.

## T11 — Operational Excel V2, ratifica Controller CLASSIC

C01 endpoint dedicato; C02 singolo Agenda; C03 DAY soltanto; C04 quattordici colonne con preferenza storica; C05 nessun telefono strutturato; C06 nessun riferimento digitale ai tavoli; C07 conteggi numerici nullable con composizione esplicita; C08 righe continue filtrabili; C09 creazione locale ristorante e testi lossless; C10 audit canonico; C11 cap20.000/25MiB e streaming interno; C12 esatti20 path.

Le modifiche Controller sostituiscono Tavoli digitali con Preferenza sala (storica) e UTC visibile con wall-clock del ristorante. Nessuna nuova query; preferredRoom T09 già disponibile. Il limite audit senza distinzione V1/V2 o filtri è accettato: nessuna nuova metadata. Il limite della visualizzazione nativa Excel non autorizza alterazione del valore. Sanitizer M11 preservato; nuova policy dedicata ed errori espliciti per dati non rappresentabili. ADR013.

Baseline main bfaf612a4a0a73c0a6fd8dc5960c48bda8576cd6, tree422546a81cc4fbc2c94aeac3c2e652dc1393fc9b, freeze e735f6e30f7012abf3c67f08ef0fc441f8132565f7cc90fd63849bf8d828ce30,460 file/16 migration. Scope7M/13A/0D,473 finali,453 protetti. Solo implementazione locale, WORK3 indipendente obbligatorio.


## M13 P0 — Local Readiness, decisione Controller CLASSIC del 2 novembre 2026

Baseline canonica `6330536bfa9341b1586f563e9cc92fe60ae799a2`, tree `92e98e0396ec01538e9feed4aab690f04a808911`, freeze raw inclusi binari `15229572daf69b2baab81c4e2f4311dfc9d0917b1fdadb8448fdf315230fa9da`:473 file e16 migration. PR18 e PR22 sono merged; i riferimenti precedenti a riconciliazioni non integrate e inventari13/14/15 sono checkpoint storici, superati soltanto per il contratto corrente qui descritto.

Decisioni vincolanti: **M13-P0-C01** soluzione A rafforzata; **C02** readiness strict fail-closed; **C03** E2E aggiornati ai contratti correnti; **C04** scenari browser condivisi; **C05** scope esatto14 path (11M/3A/0D),476 file finali e462 baseline protetti; **C06** Node24.14.1 runtime di riferimento senza cambio pin; **C07** WORK3 Final QG indipendente obbligatorio.

Implementazione autorizzata esclusivamente locale. Nessun risultato storico viene ricertificato. Nuove esecuzioni, failure, runtime effettivo e limiti sono nelle evidenze esterne del candidato. Se il binario24.14.1 non è disponibile, i gate su altra versione Node24 sono preliminari e `NODE_PIN_PASS=false`; la riserva continua in Runtime Readiness P1. M13 non è CLOSED e nessuno staging/produzione è dichiarato pronto.

**M13 FASE C ON_HOLD; Render, Tailscale, deploy, pubblicazione Git, M14/M15 e Asporti non autorizzati.** SEC01, BFCache/root host, Unicode/font PDF, renderer Excel, CI, retention e backup/restore conservano riserve e mandati separati. Il fake-data scan attuale non copre esaustivamente NI autonome/legacy: finding aperto per P1, nessuna estensione del relativo codice in P0.

C01/C02 mantengono il vincolo esplicito16 più un inventario nominale approvato: nessuna accettazione automatica di inventari ridotti coincidenti tra filesystem e DB. Le righe rolled back sono anomalie bloccanti anche se esiste una successiva riga riuscita. Richiedono diagnosi e nuovo intervento autorizzato, mai resolve automatico.

C03/C04 preservano create browser singoli201, replay200, conflitto409, management corrente, PHONE unknown, assignment completo e smoke M11; aggiungono V2 con binding originale obbligatorio. La versione Public non è esposta dal DTO: la verifica della versione usa una lettura Staff autenticata, senza estendere l'API pubblica. Modifica management con uno slot diverso, ottenuto da disponibilità corrente.


## M13 P1-A — mandato locale CLASSIC3 del 3 novembre 2026

Baseline main `3ae614045da426ab6e33f1d3c2d6e50a4505f983`, tree `11974842ce9fb47ab1747882523ce4a14122ea70`,476 file/schema16 e freeze raw `fca219cee14be9a3b46d1c0b963d3de53a319d824f002d53aaff001d3da4d3cd`. P0 resta CLOSED_WITH_RESERVATIONS; i checkpoint precedenti sono conservati integralmente.

P1-DEC-01 sequenza micro-tranche A→B→C→D→E; P1-DEC-02 freeze della sola A; P1-DEC-03 Node24.14.1 solo riferimento storico di riproducibilità; P1-DEC-04 nessuna approvazione operativa/security per tale pin; P1-DEC-05 npm bundled della distribuzione ufficiale, solo se verificato; P1-DEC-06 prima lane locale Windows x64 quando disponibile; P1-DEC-07 Linux/CI come gate futuro separato; P1-DEC-08 solo PostgreSQL effimero creato e posseduto dal run; P1-DEC-09 preflight prima del primo writer e di ciascun child sensibile dell'harness; P1-DEC-10 protezione di business, runner/config e lock; P1-DEC-11 nessuna nuova migration; P1-DEC-12 WORK3 Final QG indipendente dopo le evidenze.

Il mandato prevede un modulo CLI riutilizzabile con provenance del binario eseguito e del npm ufficiale, ownership Docker positiva e ambiente ridotto. Un loopback o una label non costituiscono da soli prova di proprietà: il contesto dovrà conservare la propria creazione e ricontrollare risorsa, tmpfs, rete, binding e identità PostgreSQL prima dei ruoli autorizzati, inclusi migration/seed prima dell'E2E. Le CLI legacy non saranno rese globalmente sicure dalla sola esistenza del nuovo harness.

Scope esatto4 path: modifica soltanto questa appendice; aggiunte scripts/m13-p1-environment.mjs, scripts/m13-p1-environment.test.mjs e docs/operations/local-readiness.md. Attesi479 file e475 baseline protetti byte/mode. Nessun cambio package/lock, pin, schema/migration1–16, runner, business o policy GitHub. Migration17 non autorizzata in P1-A; una futura migration richiederà mandato separato.

Le prove future dovranno registrare esiti reali e limiti: nessun PASS presunto dai gate P0, nessuna equiparazione Windows/Linux o attestazione del pin dalla sola versione. Nessuna P1-A CLOSED o SECURITY APPROVED prima di WORK3 e decisione Controller. I finding M13-P0-ENV01/COV02/DB01/EVID01 rimangono OPEN finché comprovati e ratificati; COV01/COV03/BFC01/FAKE01 e MAP01 documentale restano preservati, così come T09/T10/T11 e tutte le riserve SEC/runtime/CI.

P1-B privacy scan, P1-C worker reale, P1-D BFCache, P1-E CI/policy, retention/backup P3 e Phase C non sono implementazioni autorizzate. Runtime operativo aggiornato e Linux saranno congelati separatamente. M13 complessiva non CLOSED; Fase C ON_HOLD. Nessuna pubblicazione Git, accesso Render/Tailscale, ambiente condiviso, provider reale o deploy.


### M13 P1-A — addendum CLASSIC3: controlled delta remediation

Il Controller riconosce il precedente HARD STOP e autorizza D0→D1→D2 condizionali entro i medesimi4 path. Lo ZIP parziale `PICCADILLY_M13_P1_A_PARTIAL_ca5c9ba0fb4f.zip` (SHA256 `a0473d0507eb1827e2b8e52b1ac99858e0e88321515336328f1484366d7432ed`) rimane un checkpoint immutato; il nuovo candidato avrà un freeze misurato separato.

D0 ha osservato, sul solo nuovo container attribuito al run, una richiesta loopback dinamica in HostConfig e nessun mapping effettivo in NetworkSettings.Ports; docker port non ha restituito un endpoint in tre osservazioni limitate. Il rifiuto del preflight è corretto e il blocker DB01 rimane. Non è dimostrata la causa interna dell'Engine; non si modifica rete, configurazione globale o policy per aggirare il risultato.

La delta D1 dovrà preservare il rifiuto, distinguere pubblicazione mancante e mapping ambiguo, registrare binding richiesto/osservato e correlazione all'ID posseduto, senza wildcard o primo mapping arbitrario. ERR01 richiede close idempotente con risultato verificato stabile e separazione fra errore primario e stato cleanup; EVID01 richiede receipt ricostruibili e sanitizzati. Le54 prove precedenti restano conservate con regressioni mirate aggiuntive. PROC01 resta DOCUMENTED_LIMITATION; nessun nuovo privilegio o intervento sul sistema operativo.

D2 è autorizzata solo dopo prova positiva cumulativa di container task-owned, storage effimero, binding loopback univoco, endpoint correlato, identità DB e ambiente child sanitizzato prima del primo writer. La sola provenance Node24.14.1/npm11.11.0 non sostituisce questi gate né approva il runtime operativo. Nessun PASS reale deriva dalle fixture simulate. In assenza di tale prova la tranche resta PARTIAL_BLOCKED; closure formale dei finding e P1-A resta a WORK3/Controller con mandato separato. Tutti i confini e finding storici restano preservati, senza pubblicazione Git o attività P1-B/C/D/E, Phase C, Render/Tailscale/deploy.

### M13 P1-A — D6 CLASSIC3: topologia proxy e guard delle fasi canoniche

Il mandato D6 del3 novembre2026 congela A_EPHEMERAL_TCP_PROXY sulla stessa baseline main3ae614045da426ab6e33f1d3c2d6e50a4505f983. D4 ha identificato CONTAINER_NETWORK_CONFIGURATION: PG su sola rete internal non disponeva della rete con gateway necessaria al publishing. I checkpoint D0/D1/D3/D4/D5 restano immutati.

D6-C01 mantiene PostgreSQL sulla sola backend internal, senza porta host; HAProxy appartiene a backend e frontend, con un solo mapping host127.0.0.1 e una sola destinazione numerica PG. D6-C02 registra l'accettazione Owner del potenziale egress del proxy esclusivamente per test locali effimeri con dati sintetici. Non è zero-egress, approvazione security, CI, staging remoto o produzione. B e C non sono fallback autorizzati.

D6-C03 richiede psql Windows x64 portabile esterno, fonte/versione/integrità verificate prima dell'uso, nessuna installazione globale o sostituzione implicita. D6-C04 seleziona la candidata Docker Official Image HAProxy3.2.26-alpine3.24/linux-amd64; l'esecuzione deve riferirsi ai digest misurati, non a latest. Il checksum del client e la catena OCI acquisita sono nelle evidenze esterne e nei pin del modulo; non equivalgono a Security QG delle dipendenze. D6-C05 richiede backend internal+gateway_mode_ipv4=isolated, IPv6 disabilitato e verificato, proxy99:99/cap-drop ALL/no-new-privileges, configurazione temporanea root-owned0444 e nessun endpoint management TCP. Un limite della diagnostica level user non autorizza privilegi maggiori.

La whitelist D6 contiene8 path: questa appendice; scripts/run-vitest-isolated.mjs; scripts/run-vitest-isolated.test.mjs; scripts/run-e2e.mjs; scripts/m13-p1-environment.mjs; scripts/m13-p1-environment.test.mjs; docs/operations/local-readiness.md; scripts/run-e2e.test.mjs. Inventario atteso480 file,4M/4A/0D e472 baseline protetti. Schema,16 migration, seed, package/lock, pin Node, business/auth/export/worker/config e .github fuori scope rimangono byte/mode protetti. Nessuna migration17.

Limiti approvati: PG1536MiB/PGDATA tmpfs1024MiB; proxy256MiB/diagnostic tmpfs16MiB/maxconn64. Connect/queue3s; idle client/server1h; bootstrap topology/identity30s; comando infrastrutturale15s/query identità5s; drain proxy5s/stop Docker10s/stop PG30s. Applicazione e metadata devono coincidere; nessun aumento automatico dei budget o dei timeout storici.

La prova completa comprende creazione osservata dei quattro ID, membership esatta, immagini, budget/mount reali, mapping proxy effettivo, config/processo e identità SQL interna confrontata con quella attraverso Windows. Ogni fase canonica CREATE child DB, migration, seed, test, cleanup/drop o avvio app richiede una prova live; generation/identità/endpoint mutati revocano la lease. Non è attestazione atomica di ogni SQL o spawn interno a dipendenze. Gli hook importabili non avviano attività al semplice import e preservano i guard applicativi.

Le82 prove storiche sono conservate come regressioni sintetiche. La vecchia topologia direct-publish è limitata all'adapter esplicitamente simulato e rifiutata per esecuzione reale: non è un fallback. Il percorso operativo usa esclusivamente il nuovo harness proxy. Le CLI legacy fuori da questo contesto non diventano universalmente qualificate. Build/seed/E2E sono orchestrati come ruoli distinti, senza modificare package.json.

La prima e unica prova infrastrutturale è subordinata a G0–G3; failure prima della qualifica completa impone stop, senza seconda prova correttiva. D2 resta condizionata a ownership positiva effettiva; risultati e failure del candidato corrente sono nelle evidenze esterne, mai derivati dai PASS storici. close conserva risultato stabile e separazione primary/cleanup; risorse residue o quiescenza non provata non sono PASS. Nessuna publication Git, Render/Tailscale/deploy o P1-B/C/D/E. WORK3 Final QG e closure P1-A richiedono mandati separati.

### M13 P1-A — D8 CLASSIC3: deadline, esiti tardivi e teardown (4 novembre 2026)

Il mandato D8 accetta la diagnosi D7 sul candidato `d137cf7684d5a34e511076c8e93ddcd2c6e0ff9649b8923cf194629a30076096`; non riscrive la prova D6 consumata. Autorizza la delta soltanto in scripts/m13-p1-environment.mjs, relativo test, questa appendice e docs/operations/local-readiness.md. I quattro runner/test D6 restano byte-identici; scope cumulativo8 path,480 file e472 baseline protetti. Nessun nuovo path, schema, migration, seed, package/lock o pin.

D8-C01 applica performance.now a un deadline bootstrap unico30s, con elapsed/remaining/timeout effettivo nei receipt. Ogni comando riceve al massimo il residuo e il proprio cap; un re-check non riapre il budget. D8-C02 propaga timeout e abort fino al blocco di READY/writer: il catch opzionale ammette soltanto indisponibilità diagnostica classificata. La ricevuta positiva richiede un ultimo guard sul deadline e sulla generation.

D8-C03 registra nonce/tentativo/hash richiesta prima del create, PID della CLI, ID di risposta appena disponibile e CID file task-owned per i container. L'ID viene registrato prima del controllo post-deadline. Su timeout la CLI è arrestata e joined entro5s; stdout tardivo o CID file possono riconciliare il risultato, sempre con inspect e ownership completa prima di rimuovere. Nome/label e una lista vuota non provano da soli l'esito: senza risposta attribuibile l'outcome resta UNCERTAIN, cleanup non verificato e nuovi writer vietati. Nessuna adozione o rimozione di risorse sconosciute.

D8-C04 conserva drain proxy5s, stop proxy10s e stop PG30s; la CLI PG riceve il cap30s invece del precedente15s. Il teardown ha un budget monotonic separato70s, derivato dai cap esistenti (due finestre infrastrutturali15s più stop10s/30s), senza aumentare i limiti individuali. È un limite di implementazione, non una capacità operativa certificata. Stop/join dei processi propri, riconciliazione, rimozione e verifica assenza producono esiti distinti; close mantiene una sola Promise e primary/cleanup separati. Un teardown incompleto non diventa PASS.

D8-C05 completa la provenance immutabile prima della creazione; nel bootstrap verifica ancora eseguibili selezionati, image ID reali, configurazione, topologia e ownership fresh prima e dopo l'identità SQL. Inspect multipli e letture read-only per container conservano gli assert e producono output strutturati. HAProxy viene preparato mentre PG inizializza il proprio tmpfs; non si elimina readiness. Nessun caching permanente di proof o riuso di un PASS per nuovi writer. Il percorso operativo richiede l'ID Engine verificato nel gate G3 tramite --engine-id e lo confronta nelle verifiche live.

D8-C06 conserva i140 test e aggiunge negativi per deadline/residuo, catch, late create, abort/join, cleanup, generation e ricevute monotonic. D8-C07 autorizza una sola nuova prova reale, dopo G0–G3, test sintetici, freeze corrente e assenza dei residui precedenti. Budget30s invariato; failure impone stop senza retry. D2 rimane subordinata a identità interna/Windows completa, confronto, ownership e first-writer preflight positivi. Esiti effettivi, anche NOT_RUN/FAIL, nelle nuove evidenze esterne; nessun PASS dalla sola implementazione.

DB01/TIME01 restano aperti fino a evidenza e decisione indipendente; ART01 è tecnicamente rimediato pending QG. ERR01/EVID01/PROC01 e tutte le riserve storiche rimangono registrate. P1-A non approvata o chiusa; WORK3 richiede mandato separato. Egress proxy accettato soltanto locale sintetico; niente Git publication, Render/Tailscale, deploy, provider reali o P1-B/C/D/E.

### M13 P1-A — D9 CLASSIC3: identità IPv4 rigorosa e polling (4 novembre 2026)

Il mandato D9 accetta con riserve D8 e autorizza la delta solo nel modulo environment, relativo test e due appendici documentali. Il checkpoint D8 `5f3d4369a9f4e260b65494d8be086d0a9ced844ed7cff61a545a35e2f8a57ff8` e lo ZIP originale sono conservati. La riconciliazione offline conferma che gli indirizzi SQL inet::text hanno il suffisso /32; i restanti attributi osservati del cluster concordano. Nessuna prova D8 diventa retroattivamente positiva.

D9-C01 valida gli indirizzi numerici con il modulo built-in node:net: solo IPv4 sintatticamente valido, bare oppure /32 esatto. Maschere diverse, IPv6, hostname, whitespace, null e forme malformate sono rifiutati. L'equivalenza riguarda soltanto serverAddress/clientAddress e i loro attesi nella lease; database, ruolo, versione, porta, directory, system identifier, avvio del postmaster e generation mantengono i confronti originari. La query read-only conserva inet::text, quindi i receipt mantengono anche la rappresentazione originale. Non si sostituisce l'ownership completa con la coincidenza degli IP.

D9-C02 distingue la cadenza nominale250ms dal cap della singola fase di attesa, limitato al residuo e al cap infrastrutturale15s esistente. La pausa è al massimo250ms e, vicino alla scadenza della fase, al massimo metà del residuo intero; sotto2ms si rifiuta una nuova attesa. Ogni risveglio verifica nuovamente deadline e abort; nessun ciclo a pausa nulla, rinnovo del budget o riuso della query precedente. Il bootstrap resta unico30s, i comandi SQL restano limitati a5s. La riserva polling D8 era statica: quel ramo non era stato osservato nel tentativo precedente.

D9-C03 conserva i191 test e aggiunge39 regressioni IP/polling, con prova sintetica di readiness transitoria, abort, scadenze e rifiuto degli altri mismatch. Un endpoint alterato resta bloccante anche per il cleanup della risorsa non più verificabile: nessuna rimozione permissiva. D9-C04 permette un solo tentativo reale dopo G0–G3, test, freeze corrente e assenza residui. D2 richiede ancora catena, entrambe le identità, confronto completo, lease e first-writer preflight positivi. Esiti effettivi e failure intermedie sono nelle nuove evidenze esterne.

I quattro runner/test D6 rimangono congelati; scope cumulativo8 path,480 file e472 baseline protetti. Nessun cambio a immagini, topologia, privilegi, egress accettato, timeout, schema/migration1–16, seed, package/lock o Node pin. DB01 e TIME01 conservano gli stati aperti fino a qualifica e decisione WORK3/CLASSIC3. Il sottocaso tecnico D8-ID01 resta distinto dal significato storico di DB01. Nessuna closure P1-A, approvazione sicurezza o produzione, pubblicazione Git, Render/Tailscale/deploy o P1-B/C/D/E.

### M13 P1-A — D12 CLASSIC3: enforcement runtime e quiescenza

D12 accetta la diagnosi D11 sul candidato `a0900b053a771f3b2a8148b25a9b0240f9f5066e9c5daa587a893029bf1746f1`: il cap di fase15s non interrompeva la rivalidazione in-process, rifiutata soltanto al settlement. D10/D11 rimangono checkpoint esterni immutati. La remediation è limitata al modulo environment, suo test e queste due appendici documentali; i quattro runner/test D6, il lock canonico B SHA256 `3df80155b448db7fb00c5d5ead11faaa36d3f16c168e6cf878cd1276b6635cac` e tutti gli altri path restano congelati. Scope cumulativo9 path,480 file e471 baseline protetti; nessuna nuova dipendenza, migration17 o pubblicazione Git.

Node/npm e i binari psql vengono ricontrollati in worker read-only task-owned dello stesso modulo. Il parent conserva il deadline monotonic e può terminare il thread anche quando l'hash sincrono non coopera con AbortSignal. Nessun worker riceve credenziali, URL DB, comandi arbitrari o accesso al Docker socket. Cap runtime15s, bootstrap30s e cap precedenti invariati. Stop richiesto alla scadenza, join separato entro5s, evento exit osservato indipendentemente dal messaggio/Promise; un successo tardivo o un join incerto non produce PASS. Timer osservato e latenza OS non sono una garanzia hard real-time: i receipt distinguono lavoro attivo, richiesta abort, uscita e cleanup. Una scadenza revoca nuovi dispatch senza attendere il risultato del controllo.

I digest attesi del bundle, privati e qualificati per il run, sono riutilizzati; i byte attuali e l'enumerazione dei file vengono comunque verificati fresh. Nessun cache di ownership: container, reti, endpoint/config proxy, entrambe le identità SQL, generation e first-writer preflight restano controllati ai confini canonici. Non basta un precedente PASS o una variabile d'ambiente.

I receipt registrano child applicativi, worker di verifica, operazioni SQL-client e risorse Docker separatamente. La quiescenza non deriva dall'assenza di dispatch: servono stati di terminazione osservati. Dopo revoca la quiescenza SQL live resta NOT_VERIFIABLE e non si esegue una query diagnostica per riabilitare la lease. La terminazione del server dopo stop e assenza del PostgreSQL posseduto è una prova distinta, non una query di quiescenza riuscita. Risorse sconosciute non vengono rimosse; errore primario, diagnostica/abort/join e cleanup restano distinti. close conserva idempotenza e budget separato70s.

I230 test precedenti sono conservati e i nuovi casi RT01–RT25 comprendono un worker CPU realmente non cooperativo e la verifica indipendente del suo exit. Soltanto gate statici, provenance, capacità, Engine e assenza residui positivi consentono l'unica prova D12. Qualsiasi failure reale impone stop e teardown senza retry, cambio del budget o correzione durante il run. Esiti reali e riserve sono nelle evidenze esterne; nessuna closure P1-A, Security QG o produzione qualificata. WORK3 richiede mandato separato.

### M13 P1-A — D13 CLASSIC3: qualificazione completa e guard operativo (4 novembre 2026)

D13 mantiene la whitelist cumulativa di nove path e congela il lockfile canonico B. La delta è limitata al modulo P1-A, al suo test e ai due documenti autorizzati. Il candidato iniziale e lo ZIP D12 restano checkpoint storici; nessun PASS precedente sostituisce una lease live.

La qualifica completa verifica tutti i byte del bundle Node/npm contro il manifesto privato derivato dall'archivio ufficiale autenticato, rifiutando link e file inattesi. Le letture sono concorrenti con massimo otto operazioni nel worker D12, sempre terminabile. Il target resta 15s; il cap della sola qualifica completa è 60s, motivato dall'esecuzione D11 di 42,7365322s e dal timeout post-ci D12 a 15s. Il limite non viene esteso a bootstrap, SQL, comandi Docker o guard operativi. La Promise richiede exit osservato; nessun successo tardivo è accettato.

Prima di npm si qualifica l'intero bundle effettivamente utilizzato. Dopo ci è obbligatoria una nuova qualifica completa prima del successivo dispatch D2. I ruoli canonici rimanenti eseguono Node direttamente, senza invocare il bundle npm: il guard rilegge e confronta il binario Node corrente con il digest qualificato. Ogni successiva invocazione diretta di npm richiede ancora la qualifica completa fresh. Si riutilizzano soltanto valori attesi immutabili, non un precedente risultato di ownership o l'identità di file mai verificati.

Ogni preflight operativo live ha un deadline aggregato di 15s, con timeout subordinati limitati al residuo e revoca immediata. La readiness iniziale conserva il deadline bootstrap complessivo di 30s. Le verifiche fresh di container, network, configurazione/destinazione/binding proxy, immagini effettive, identità SQL interna e Windows, generation, lease e first writer restano obbligatorie. La scadenza globale conserva la propria classificazione. Nessuna modifica a topologia, privilegi, storage, runner, suite applicative o timeout storici.

Abort, terminate/join D12 e quiescenza restano distinti da SQL live quiescence e da terminazione/assenza del PostgreSQL posseduto. Le 255 prove precedenti sono conservate e si aggiungono solo otto regressioni sulla separazione dei livelli. L'unico run D13 è subordinato a tutti i gate statici; ogni failure reale impone stop e teardown senza retry o correzioni fuori scope. D2 prosegue nello stesso run soltanto con ownership positiva. WORK3 QG e closure formale restano separati.

### M13 P1-A — D14 CLASSIC3: censimento read-only e quiescenza finale (4 novembre 2026)

Il checkpoint D13 è conservato. La correzione riguarda esclusivamente modulo P1-A, relativo test e i due documenti autorizzati: nove path cumulativi,480 file,471 baseline protetti, lock e quattro runner/test congelati. Non cambia topologia o dipendenze. I PASS D13 sono storici e non sostituiscono i gate del nuovo run.

Il digest della risposta del controllo D13 è riconciliabile offline con ASCII 1 più LF; il tipo/stato di quel backend non è recuperabile. Il vecchio predicato includeva tutti i processi del ruolo, senza distinguere client e backend di servizio, e non prevedeva drain o censimento. D14 non attribuisce retroattivamente quel conteggio a un writer attivo.

D14 richiede zero altri client nell'intero cluster temporaneo, quindi include anche client con ruolo/database/appname inattesi o vuoti. I backend non client sono registrati separatamente e non sono assimilati a connessioni applicative. Ogni campione usa psql verificato, una connessione e transazione READ ONLY nuove, identità Docker/cluster corrente e monitor correlato per PID/backend_start/nonce/ruolo/database/read_only. Solo il monitor corrente dimostrato è escluso. Nessuna query applicativa, payload, password o appname sconosciuta viene registrata; restano conteggi, stati, PID e classificazioni sanificate.

Il drain ha massimo5s con polling positivo bounded e timeout subordinati al residuo del teardown70s; non rinnova il budget. Non termina alcun backend SQL. Active, idle, idle in transaction, stato/ownership sconosciuti impediscono PASS fino alla loro effettiva scomparsa. Campioni nuovi evitano il riuso dello snapshot statistico. Eventi distinti attestano join dei child, chiusura dei client posseduti, censimento, chiusura monitor, revoca residua, stop PG e assenza risorse.

L'unico run D14 deve superare una verifica anticipata: connessione sintetica Windows psql read-only correlata via HAProxy, rilevata dal censimento, chiusa e joined, poi nuovo campione a zero altri client. Nessun writer D2 prima del PASS. Dopo revoca non viene riabilitata la lease per SQL diagnostico. La chiusura mantiene errore primario, budget separati e idempotenza; client sconosciuti non sono ignorati e un errore di quiescenza non viene trasformato in PASS dall'assenza successiva dei container.

I263 test precedenti sono preservati nelle assertion; il fake condiviso viene esteso soltanto al nuovo protocollo census. Dieci nuovi QUIET01–10 coprono monitor, active/idle/transazioni/sconosciuti, drain finito, revoca, primary failure e risorse assenti. Qualsiasi failure reale impone stop, teardown sicuro e rapporto unico; nessun retry o modifica dei runner. Closure e WORK3 QG rimangono separati.


## D15 — identità Engine fresh tramite API locale bounded

Il guard D14 richiedeva soltanto ID da docker info, due volte per preflight. L'attesa osservata durante il comando non distingue una lentezza del daemon, della CLI o dello scheduling Windows. D15 mantiene la qualificazione completa iniziale e sostituisce esclusivamente queste invocazioni CLI del guard con GET /info sulla stessa pipe locale già qualificata, confrontando l'ID Engine attuale con quello atteso. Non è un riuso di una precedente attestazione live né una rimozione del controllo del daemon: la medesima API potrebbe ancora essere lenta e in tal caso il guard deve fallire.

Prima di ciascuna lettura Engine viene ispezionato il context corrente: nome desktop-linux e endpoint locale devono coincidere esattamente. Tutte le operazioni Docker restano vincolate alla stessa pipe. Nessun TCP, redirect, credenziale, proxy di rete o route API configurabile; l'unica richiesta aggiunta è read-only. Il risultato è accettato solo dopo risposta completa, close della richiesta e close del socket. Abort distrugge richiesta/socket; join separato massimo5s. Un trasporto non joined resta UNKNOWN e impedisce il PASS aggregato. Nessun lavoro tardivo può riabilitare lease o writer.

Restano fresh nei due controlli che circondano le identità SQL: ID e stato container, generation, network, binding loopback, configurazione e privilegi proxy, immagini effettive, storage e budget, identità PostgreSQL interna/Windows e lease. Il census D14 e il drain bounded non sono modificati. Bootstrap30s, guard15s, full qualification massimo60s condizionale e teardown70s restano invariati. Nessuna promessa hard real-time durante sospensioni o stalli del sistema operativo.

La nuova suite sintetica conserva273 test e aggiunge9 prove per API/close, CLI info lenta, Engine/context drift, resource/SQL drift, deadline, abort e trasporto non cooperativo. Una prova statica non qualifica il run reale. Solo tutti i gate positivi consentono l'unico run D15: early quiescence e preflight operativo mirato nello stesso ambiente, poi D2 canonico completo e census finale prima della revoca residua e dello stop PG. Una failure bloccante impone stop, evidenze e teardown senza retry o correzioni fuori scope; WORK3 separato.
