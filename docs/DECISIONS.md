# Piccadilly Booking — Registro delle decisioni

**Stato:** approvato
**Data:** 31 luglio 2026

## 1. Scopo e autorità

`docs/PROJECT_SPEC.md` resta la fonte ufficiale dei requisiti funzionali. Questo registro conserva le decisioni approvate che precisano l'implementazione o risolvono ambiguità senza modificare direttamente la specifica.

Ogni nuova decisione architetturale significativa deve essere aggiunta qui e, quando opportuno, accompagnata da un ADR.

## 2. Decisioni approvate e vincolanti

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

## 3. Decisioni reversibili

Le seguenti scelte possono cambiare senza alterare il dominio, purché il cambiamento venga testato e documentato:

- libreria concreta per autenticazione e sessioni;
- libreria Argon2id concreta;
- generatore PDF;
- libreria Excel;
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
- regola operativa sul riuso dello stesso tavolo, dato che non esiste una durata prestabilita;
- limiti massimi pratici dell'intervallo Excel per tempo di generazione e dimensione del file;
- criteri di retention o revoca per token scaduti e record tecnici di rate limiting.

## 6. Modifica delle decisioni

Una decisione vincolante cambia soltanto tramite:

1. richiesta esplicita;
2. analisi dell'impatto;
3. aggiornamento di questo registro;
4. aggiornamento dell'ADR pertinente;
5. eventuale aggiornamento autorizzato di `PROJECT_SPEC.md`.
