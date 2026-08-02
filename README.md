# Piccadilly Booking

Monolite modulare Next.js del sistema proprietario di prenotazione del Risto Pizza Piccadilly. La Milestone M3 aggiunge autenticazione del personale, utenti individuali, ruoli e sessioni revocabili; non comprende ancora prenotazioni o dashboard operative.

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

La migrazione M3 crea soltanto `User`, `Session`, `LoginRateLimit` e l'enum `UserRole`, oltre alla relazione `Restaurant.users`. Il seed è idempotente e mantiene un solo ristorante `Piccadilly Demo`, un Admin e uno Staff fittizi.

## Account locali fittizi

| Ruolo | Username | Password |
| --- | --- | --- |
| `ADMIN` | `demo.admin` | valore locale di `AUTH_DEMO_ADMIN_PASSWORD` |
| `STAFF` | `demo.staff` | valore locale di `AUTH_DEMO_STAFF_PASSWORD` |

Queste identità non corrispondono a persone reali. Le password di `.env.example` non devono essere usate in staging o produzione. Non esiste registrazione pubblica: la futura creazione degli account rimane un'operazione riservata all'Admin.

`ADMIN` accede anche alla pagina tecnica `/admin`; `STAFF` può usare l'area protetta ordinaria ma viene respinto da `/admin`. I controlli sono eseguiti sul server.

## Login locale

```bash
npm run dev
```

- applicazione: [http://localhost:4000](http://localhost:4000/);
- login: [http://localhost:4000/login](http://localhost:4000/login);
- dashboard tecnica protetta: [http://localhost:4000/dashboard](http://localhost:4000/dashboard);
- verifica tecnica ADMIN: [http://localhost:4000/admin](http://localhost:4000/admin);
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

## Confini della Milestone M3

La dashboard e la pagina Admin sono esclusivamente tecniche. Restano escluse prenotazioni, agenda, disponibilità, sale, tavoli, configurazioni operative, gestione utenti completa, recupero password, 2FA, notifiche, PDF, Excel, worker e risorse cloud.
