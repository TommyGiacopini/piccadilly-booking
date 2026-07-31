# ADR 001 — Monolite modulare Next.js full-stack

**Stato:** accettato
**Data:** 31 luglio 2026

## Contesto

Piccadilly Booking deve offrire nello stesso prodotto:

- prenotazione pubblica;
- pagina personale;
- dashboard Staff/Admin;
- configurazioni;
- esportazioni;
- notifiche future.

Il progetto è iniziale, il repository è unico e non esistono client esterni indipendenti. Lo stack approvato include Next.js App Router, TypeScript strict, PostgreSQL, Prisma e Zod. Il sistema deve poter essere riprodotto su account del ristorante senza dipendenze permanenti da account personali.

Un backend separato introdurrebbe due deploy, contratti API, CORS, gestione autenticazione fra origini e maggiore costo operativo prima che tali benefici siano necessari.

## Decisione

Adottare un monolite modulare Next.js full-stack con runtime Node.js.

L'applicazione viene organizzata in moduli di dominio:

- reservations;
- availability;
- scheduling;
- rooms;
- identity;
- audit;
- exports;
- notifications.

I confini sono applicati tramite queste regole:

- le pagine e gli endpoint sono adattatori di ingresso;
- i servizi applicativi coordinano casi d'uso e transazioni;
- il dominio non dipende da Next.js o Prisma;
- Prisma è confinato negli adattatori di persistenza;
- PDF, Excel, WhatsApp ed email sono adattatori sostituibili;
- un eventuale worker usa lo stesso repository e gli stessi moduli applicativi.

Route Handler vengono usati per API, download e callback. Server Action possono essere usate per mutazioni same-origin, ma non contengono direttamente le regole di dominio.

## Conseguenze

### Positive

- un solo repository e una sola base di configurazione;
- condivisione diretta di tipi e schemi Zod;
- minore complessità di deploy e autenticazione;
- transazioni di database vicine ai casi d'uso;
- sviluppo più rapido delle prime milestone;
- possibilità di estrarre moduli in futuro grazie ai confini interni.

### Negative e vincoli

- disciplina necessaria per evitare query Prisma nelle pagine;
- web e casi d'uso vengono distribuiti insieme;
- attività asincrone richiedono in futuro un worker o processo pianificato;
- un errore di organizzazione può trasformare il monolite modulare in un monolite accoppiato;
- Prisma, PDF ed Excel richiedono runtime Node.js, non Edge.

## Alternative rifiutate

### Backend Express separato

Rifiutato nella prima versione perché aggiunge deploy, CORS, contratti e gestione sessioni separati senza un client esterno che li giustifichi.

Potrà essere rivalutato se nasceranno API pubbliche versionate, più client indipendenti o necessità di scalare backend e frontend separatamente.

### NestJS o Fastify separati

Rifiutati per le stesse ragioni di Express. La maggiore struttura di NestJS non compensa il costo operativo iniziale.

### Microservizi

Rifiutati perché il dominio e il volume previsti non richiedono distribuzione indipendente. Aumenterebbero transazioni distribuite, osservabilità e failure mode.

### Backend-as-a-Service

Rifiutato come fondamento perché può aumentare il vincolo a provider/account e non sostituisce la necessità di regole transazionali specifiche.
