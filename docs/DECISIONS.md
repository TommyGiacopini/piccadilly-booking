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

Il venerdì e il sabato le nuove prenotazioni online per la cena chiudono inizialmente alle 17:30. Giorni, servizio e orario della regola sono configurabili. Il cutoff non impedisce inserimenti telefonici Staff/Admin.

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
- orizzonte temporale con cui vengono materializzati i servizi futuri.

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
