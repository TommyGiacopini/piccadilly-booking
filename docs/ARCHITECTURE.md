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

### Identity

Gestisce autenticazione, sessioni, ruoli Admin e Staff e autorizzazioni applicative.

### Audit

Registra eventi append-only con attore, origine, timestamp, entità, azione e valori precedenti/nuovi quando richiesti.

### Exports

Costruisce modelli di sola lettura per PDF e Excel. Non espone modelli Prisma direttamente ai generatori.

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
| `restaurants` | Timezone, telefono, dominio, email, numero WhatsApp, testi pubblici, durata link e impostazioni generali |
| `weekly_service_rules` | Regola ricorrente per giorno della settimana e pranzo/cena |
| `service_instances` | Configurazione effettiva di uno specifico servizio in una data; riga usata anche per la serializzazione concorrente |
| `rooms` | Sale del ristorante e caratteristiche |
| `service_room_availability` | Sale abilitate per uno specifico servizio, inclusi Galleria e Terrazzo |
| `dining_tables` | Tavoli fisici e sala di appartenenza |

`service_instances` contiene lo snapshot operativo effettivo: primo e ultimo slot, intervallo di 15 minuti nella prima versione, finestra fissa di 30 minuti, limite di coperti e cutoff applicabili.

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
| `users` | Account Staff/Admin, ruolo, stato e hash password |
| `sessions` | Sessioni revocabili |
| `audit_events` | Registro append-only delle operazioni |
| `idempotency_keys` | Protezione dai doppi invii |
| `rate_limit_buckets` | Contatori atomici per il rate limiting pubblico |
| `notification_outbox` | Intenzioni di notifica salvate in modo affidabile |
| `notification_attempts` | Tentativi, errori e identificativi dei provider |

Il modello completo è documentato ora; ogni tabella sarà creata nella milestone in cui diventa necessaria.

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

Il limite è configurabile dall'Admin. Il tipo e la durata della finestra non sono configurabili nella prima versione.

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

Il venerdì e sabato le nuove prenotazioni online per la cena chiudono inizialmente alle 17:30. Giorni, servizio e orario della regola sono configurabili. Il cutoff pubblico non impedisce inserimenti telefonici da parte dello staff.

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
- Il token può essere revocato o ruotato.
- La pagina non viene indicizzata e non deve essere memorizzata in cache.

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
3. lock del servizio attuale e dell'eventuale servizio nuovo;
4. ricalcolo della capacità escludendo la prenotazione corrente;
5. aggiornamento atomico e audit prima/dopo;
6. evento di notifica dopo il commit.

### 12.4 Cancellazione

1. autorizzazione e controllo cutoff;
2. lock e cambio stato a `CANCELLED`;
3. audit atomico;
4. disponibilità dei coperti immediatamente ripristinata dopo il commit;
5. nessuna eliminazione fisica.

### 12.5 Assegnazione

L'assegnazione può avvenire in qualsiasi momento. Le 17:30 sono un riferimento operativo, non un vincolo tecnico. Sala definitiva, tavoli e note interne vengono salvati separatamente dalla preferenza originale e ogni modifica viene registrata.

### 12.6 Esportazioni

Il PDF presenta nell'ordine:

1. `DA ASSEGNARE`;
2. Sala 1;
3. Sala 2;
4. Sala 3;
5. Galleria;
6. Terrazzo.

Dentro ogni sezione le prenotazioni sono ordinate per momento di creazione.

Excel supporta:

- singola giornata;
- mese, con un foglio per giorno;
- intervallo selezionato, con un foglio per giorno.

Non esiste un workbook permanente destinato a crescere indefinitamente.

## 13. Notifiche

WhatsApp è il canale principale in produzione. L'email è facoltativa e l'Admin può configurare:

- solo WhatsApp;
- WhatsApp con fallback email in caso di errore;
- WhatsApp ed email in parallelo.

Sviluppo e staging usano esclusivamente provider simulati. La produzione WhatsApp usa esclusivamente API ufficiali Meta. Il gruppo WhatsApp è opzionale; dashboard e notifica a un numero interno non dipendono dal gruppo.

Il pattern outbox garantisce che un errore del provider non perda o annulli la prenotazione. I dettagli sono in `docs/adr/005-notification-outbox.md`.

## 14. Configurazione

Devono essere configurabili e non hardcoded:

- telefono pubblico;
- dominio;
- email;
- numero WhatsApp;
- testi pubblici;
- durata del link personale;
- giorni e servizi;
- orari e slot;
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
