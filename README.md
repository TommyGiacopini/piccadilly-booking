# Piccadilly Booking

Fondamenta tecniche dell'applicazione proprietaria di prenotazione del Risto Pizza Piccadilly. La Milestone M2 aggiunge PostgreSQL locale e Prisma, ma non implementa ancora autenticazione, prenotazioni o configurazioni operative.

## Requisiti locali

- Node.js 20.9 o successivo;
- npm;
- Git;
- Docker Desktop con Docker Compose.

Tutti i dati locali e di staging devono essere fittizi. PostgreSQL è l'unica fonte ufficiale dei dati; il database locale è destinato allo sviluppo e può essere eliminato e ricreato.

## Installazione

```bash
npm install
```

Copiare `.env.example` in `.env` e usare esclusivamente credenziali fittizie. I file `.env` sono esclusi da Git.

## PostgreSQL locale

Il servizio Docker si chiama `postgres`, ascolta soltanto su localhost e usa per impostazione predefinita la porta host `5433`. La porta può essere cambiata tramite `POSTGRES_PORT`.

```bash
npm run db:up
docker compose ps
npm run db:logs
```

Per arrestare PostgreSQL senza eliminare il volume nominato:

```bash
npm run db:down
```

## Prisma e database

Generare il client Prisma in `src/generated/prisma`:

```bash
npm run db:generate
```

Creare o applicare migrazioni durante lo sviluppo:

```bash
npm run db:migrate
```

Applicare migrazioni già esistenti in un ambiente non interattivo:

```bash
npm run db:migrate:deploy
```

Inserire il solo ristorante fittizio `Piccadilly Demo` con un seed idempotente:

```bash
npm run db:seed
```

Aprire Prisma Studio:

```bash
npm run db:studio
```

Il reset è un comando distruttivo riservato a `APP_ENV=development`: elimina tutti i dati del database locale, riapplica le migrazioni e richiede conferma interattiva.

```bash
npm run db:reset
```

## Applicazione e health check

```bash
npm run dev
```

- applicazione: [http://localhost:4000](http://localhost:4000/);
- health check: [http://localhost:4000/api/health](http://localhost:4000/api/health).

Con PostgreSQL disponibile il health check restituisce `status: "ok"` e `database: "ok"`. Se il database non è raggiungibile restituisce HTTP 503, `status: "degraded"` e `database: "unavailable"`, senza dettagli di connessione.

## Script disponibili

| Comando | Descrizione |
| --- | --- |
| `npm run dev` | Avvia Next.js su `http://localhost:4000`. |
| `npm run build` | Crea la build di produzione. |
| `npm run start` | Avvia una build già generata; usa `PORT` o il fallback locale `4000`. |
| `npm run lint` | Esegue ESLint sull'intero progetto. |
| `npm run typecheck` | Verifica TypeScript strict senza generare file. |
| `npm run test` | Esegue i test Vitest, inclusi quelli con PostgreSQL reale. |
| `npm run test:watch` | Esegue Vitest in modalità osservazione. |
| `npm run db:up` | Avvia PostgreSQL in Docker. |
| `npm run db:down` | Arresta i container Compose senza eliminare il volume. |
| `npm run db:logs` | Segue i log di PostgreSQL. |
| `npm run db:generate` | Genera Prisma Client. |
| `npm run db:migrate` | Crea/applica migrazioni di sviluppo. |
| `npm run db:migrate:deploy` | Applica le migrazioni esistenti. |
| `npm run db:seed` | Esegue esplicitamente il seed fittizio. |
| `npm run db:studio` | Avvia Prisma Studio. |
| `npm run db:reset` | **Pericoloso:** resetta soltanto il database di sviluppo. |

## Variabili d'ambiente

| Variabile | Valore locale fittizio | Scopo |
| --- | --- | --- |
| `APP_ENV` | `development` | Identifica l'ambiente applicativo. |
| `DATABASE_URL` | URL PostgreSQL locale su porta `5433` | Configura Prisma CLI e runtime. |
| `POSTGRES_USER` | `piccadilly_dev` | Utente del container locale. |
| `POSTGRES_PASSWORD` | `piccadilly_dev_password` | Password fittizia del container locale. |
| `POSTGRES_DB` | `piccadilly_booking` | Database locale. |
| `POSTGRES_PORT` | `5433` | Porta PostgreSQL esposta su localhost. |
| `PORT` | `4000` | Porta HTTP usata da `npm run start` quando non fornita dalla piattaforma. |

Prisma 7 usa `prisma.config.ts` per schema, migrazioni, seed e `DATABASE_URL`. A runtime il client usa l'adapter PostgreSQL ufficiale `@prisma/adapter-pg`; il singleton server-side evita pool duplicati durante l'hot reload di Next.js.

## Ambienti

- **Sviluppo locale:** PostgreSQL Docker, dati fittizi e provider simulati.
- **Staging personale:** database separato, solo dati fittizi e provider simulati; non diventerà la produzione.
- **Produzione del ristorante:** verrà ricreata in seguito su account intestati al ristorante, con database, configurazione e segreti dedicati.
