# Piccadilly Booking

Fondamenta tecniche dell'applicazione proprietaria di prenotazione del Risto Pizza Piccadilly. La Milestone M1 contiene soltanto la base Next.js e non implementa ancora funzioni di prenotazione.

## Requisiti locali

- Node.js 20.9 o successivo;
- npm;
- Git.

PostgreSQL e Docker non sono ancora necessari: verranno introdotti in una milestone successiva.

## Installazione

```bash
npm install
```

Copiare `.env.example` in un file locale `.env.local` e mantenere esclusivamente valori fittizi durante lo sviluppo.

## Avvio

```bash
npm run dev
```

L'applicazione è disponibile su `http://localhost:4000`.

Il controllo tecnico è disponibile su `http://localhost:4000/api/health`.

## Script disponibili

| Comando | Descrizione |
| --- | --- |
| `npm run dev` | Avvia il server di sviluppo su `http://localhost:4000`. |
| `npm run build` | Crea la build di produzione. |
| `npm run start` | Avvia una build già generata; usa `PORT` oppure la porta locale `4000`. |
| `npm run lint` | Esegue ESLint sull'intero progetto. |
| `npm run typecheck` | Verifica TypeScript senza generare file. |
| `npm run test` | Esegue una volta i test unitari Vitest. |
| `npm run test:watch` | Esegue Vitest in modalità osservazione. |

## Variabili d'ambiente

| Variabile | Valori supportati | Valore predefinito | Scopo |
| --- | --- | --- | --- |
| `APP_ENV` | `development`, `staging`, `production` | `development` | Identifica l'ambiente applicativo nel health check. |
| `PORT` | Numero da `1` a `65535` | `4000` per `npm run start` | Configura la porta del server; staging e produzione usano il valore fornito dalla piattaforma. |

`.env.example` contiene soltanto valori fittizi. I file `.env` reali sono esclusi da Git e non devono contenere credenziali versionate.

Il fallback `4000` riguarda esclusivamente l'avvio locale. Lo script multipiattaforma di `npm run start` legge prima la variabile di processo `PORT`, così l'hosting può assegnare la propria porta senza modifiche al codice applicativo.

## Ambienti

- **Sviluppo locale:** esecuzione sul computer dello sviluppatore, dati fittizi e provider simulati.
- **Staging personale:** ambiente separato, esclusivamente dati fittizi e provider simulati; non diventerà la produzione.
- **Produzione del ristorante:** verrà ricreata in seguito su account intestati al ristorante, con configurazione e segreti dedicati.

PostgreSQL sarà la fonte ufficiale dei dati, ma database, Prisma e Docker Compose appartengono alle milestone successive e non sono inclusi in M1.
