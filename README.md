# Piccadilly Booking

Monolite modulare Next.js del sistema proprietario di prenotazione del Risto Pizza Piccadilly. La Milestone M4 aggiunge la configurazione operativa del ristorante e il calendario tecnico protetto; non comprende ancora prenotazioni, disponibilità pubblica o dashboard operative.

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

Le variabili M3 sono:

| Variabile | Valore locale fittizio | Scopo |
| --- | --- | --- |
| `AUTH_RESTAURANT_ID` | UUID deterministico del ristorante demo | Limita il login al ristorante configurato. |
| `AUTH_RATE_LIMIT_SECRET` | stringa locale di almeno 32 caratteri | Anonimizza con HMAC le chiavi del rate limit. Deve essere diversa e segreta fuori dallo sviluppo. |
| `AUTH_TRUST_PROXY` | `false` | Abilita l'uso degli header proxy soltanto dietro un proxy noto e correttamente configurato. |
| `AUTH_DEMO_ADMIN_PASSWORD` | password locale fittizia | Password usata dal seed per l'Admin demo. |
| `AUTH_DEMO_STAFF_PASSWORD` | password locale fittizia | Password usata dal seed per lo Staff demo. |

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

La migrazione M4 aggiunge:

- `Room` e la relazione `Restaurant.rooms`;
- `DiningTable` e la relazione `Room.diningTables`;
- `WeeklyServiceSchedule` per giorno, servizio e intervallo slot;
- `RestaurantBookingSettings` in relazione uno-a-uno con il ristorante;
- `SpecialDateOverride` per eccezioni complete, pranzo o cena;
- gli enum `ServiceType`, `DayOfWeek` e `SpecialDateScope`.

PostgreSQL usa colonne native `TIME(0)` per gli orari del giorno e `DATE` per le date locali. Il codice converte questi valori al bordo Prisma usando esclusivamente campi UTC della rappresentazione JavaScript: non viene associata una data operativa fittizia e una data come `2026-10-25` non slitta a causa della conversione `Europe/Rome`/UTC. I vincoli SQL impediscono intervalli invertiti, slot o capacità non positivi, posti massimi inferiori ai minimi e duplicati di sale, tavoli, regole settimanali o eccezioni.

Il seed è idempotente e mantiene un solo ristorante `Piccadilly Demo`, un Admin e uno Staff fittizi insieme alla configurazione M4. Rifiuta sempre le credenziali demo con `APP_ENV=production`.

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

Capacità, slot, orari, abilitazione dei servizi e cut-off sono modificabili dall'Admin. La durata della finestra mobile viene persistita e mostrata, ma resta fissata a 30 minuti nella prima versione per rispettare la decisione architetturale approvata. Le date speciali possono chiudere l'intera giornata, soltanto il pranzo o soltanto la cena; un'apertura può avere orari e capacità speciali opzionali. Il seed non inserisce date speciali, perché non sono documentate chiusure reali approvate.

## Account locali fittizi

| Ruolo | Username | Password |
| --- | --- | --- |
| `ADMIN` | `demo.admin` | valore locale di `AUTH_DEMO_ADMIN_PASSWORD` |
| `STAFF` | `demo.staff` | valore locale di `AUTH_DEMO_STAFF_PASSWORD` |

Queste identità non corrispondono a persone reali. Le password di `.env.example` non devono essere usate in staging o produzione. Non esiste registrazione pubblica: la futura creazione degli account rimane un'operazione riservata all'Admin.

`ADMIN` accede anche alla pagina tecnica `/admin`; `STAFF` può usare l'area protetta ordinaria ma viene respinto dalle pagine e dalle mutazioni di configurazione. I controlli sono eseguiti sul server e ogni aggiornamento è limitato al `restaurantId` della sessione.

## Percorsi Admin M4

- `/admin/configuration`: capacità e cut-off;
- `/admin/rooms`: ordine e stato delle sale, modifica dei tavoli demo;
- `/admin/schedules`: servizi e orari settimanali;
- `/admin/special-dates`: creazione, modifica e rimozione delle eccezioni locali.

Le pagine sono minimali e tecniche. Un anonimo viene reindirizzato a `/login`; `STAFF` non può effettuare scritture. Le mutazioni POST same-origin validano sul server un elenco esplicito di campi e non espongono query, stack trace o dettagli interni.

## Login locale

```bash
npm run dev
```

- applicazione: [http://localhost:4000](http://localhost:4000/);
- login: [http://localhost:4000/login](http://localhost:4000/login);
- dashboard tecnica protetta: [http://localhost:4000/dashboard](http://localhost:4000/dashboard);
- verifica tecnica ADMIN: [http://localhost:4000/admin](http://localhost:4000/admin);
- configurazione ADMIN: [http://localhost:4000/admin/configuration](http://localhost:4000/admin/configuration);
- sale e tavoli ADMIN: [http://localhost:4000/admin/rooms](http://localhost:4000/admin/rooms);
- orari ADMIN: [http://localhost:4000/admin/schedules](http://localhost:4000/admin/schedules);
- date speciali ADMIN: [http://localhost:4000/admin/special-dates](http://localhost:4000/admin/special-dates);
- health check: [http://localhost:4000/api/health](http://localhost:4000/api/health).

Il login accetta username normalizzati e password di almeno 12 caratteri. Le risposte per username inesistente, password errata e utente disabilitato non rivelano quale controllo sia fallito.

## Password e sessioni

Le password sono memorizzate soltanto come hash Argon2id. La configurazione iniziale usa 19 MiB di memoria, 2 iterazioni e parallelismo 1; prima della produzione i parametri devono essere calibrati sull'infrastruttura definitiva senza scendere sotto questa base.

Ogni login crea una nuova sessione opaca con scadenza assoluta di 8 ore. Il cookie contiene soltanto un UUID e un secret casuale a 256 bit; nel database è salvato esclusivamente l'hash SHA-256 del secret. Il cookie è `HttpOnly`, `SameSite=Lax`, `Path=/`, ad alta priorità e `Secure` in produzione. Non viene usato `localStorage`.

Il logout valorizza `revokedAt`, cancella il cookie e rende inutilizzabile il token precedente. Se un utente viene disabilitato, la validazione respinge la sessione e revoca tutte le sue sessioni ancora aperte. In locale una nuova sessione si crea eseguendo nuovamente il login; per revocare una sessione specifica usare il logout. Per verifiche amministrative sui soli dati fittizi è possibile aprire `npm run db:studio` e valorizzare `revokedAt` senza eliminare utenti o database.

Le richieste POST di login/logout richiedono un'origine coerente con l'host e il cookie SameSite. I redirect dopo il login sono limitati a `/dashboard` e `/admin`.

## Rate limit del login

I tentativi falliti sono persistiti in PostgreSQL: 5 errori nella finestra di 15 minuti bloccano la chiave per 15 minuti. La chiave combina username normalizzato e indirizzo client, quindi viene salvata solo dopo HMAC e non rivela i valori originali. Le righe scadute sono rimosse durante i tentativi successivi.

Con `AUTH_TRUST_PROXY=false` gli header inoltrati sono ignorati. Impostare `true` soltanto quando l'app è dietro un proxy fidato che sovrascrive `X-Forwarded-For`, `X-Forwarded-Host` e `X-Forwarded-Proto`.

## Health check

Il percorso pubblico `/api/health` continua a restituire soltanto stato del servizio, ambiente e disponibilità del database. Non espone utenti, sessioni, credenziali o dettagli di autenticazione.

## Comandi di qualità

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

La suite Vitest comprende test unitari e test d'integrazione con PostgreSQL reale; non usa SQLite.

## Confini della Milestone M4

La dashboard e le pagine Admin restano tecniche. Non esistono modelli `Reservation`, `ServiceInstance`, clienti, disponibilità o slot prenotabili definitivi. Restano esclusi modulo pubblico, pagina personale, agenda, assegnazione prenotazioni–tavoli, override per prenotazione, gestione utenti definitiva, audit completo, eventi, notifiche, outbox, WhatsApp, email, PDF, Excel, deploy, database cloud e dati reali.
