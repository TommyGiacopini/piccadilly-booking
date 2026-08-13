# ADR 006 — Architettura, atomicità e minimizzazione dell'audit

**Stato:** accettato
**Data:** 12 agosto 2026

## Contesto

M7 e M8 hanno introdotto `ReservationAuditEvent`, legato al ciclo della prenotazione. M9 richiede audit per autenticazione, identità e configurazione, ma un'unificazione distruttiva renderebbe più fragile il dominio prenotazioni. Gli snapshot precedenti duplicavano inoltre PII e testi liberi non necessari.

## Decisione

- `ReservationAuditEvent` resta il registro specializzato delle prenotazioni.
- `AuditEvent` è il registro generico per autenticazione, identità e configurazione, con ristorante, categoria, azione validata nel dominio, esito, attore/ruolo ed entità opzionali, correlation ID, stati e metadati minimizzati e timestamp UTC.
- Le azioni sono stringhe nel database per evitare una migrazione a ogni estensione, ma l'applicazione accetta soltanto un elenco esplicito.
- I registri saranno uniti soltanto tramite una proiezione applicativa di lettura riservata agli Admin.
- Ogni evento è scritto nella stessa transazione della mutazione; un errore audit causa il rollback dell'operazione.
- I no-op non producono eventi.
- L'applicazione tratta i registri come append-only.
- Gli snapshot sono funzioni a whitelist. È vietato serializzare direttamente modelli Prisma.

Lo snapshot prenotazione conserva soltanto dati operativi: data, servizio, ora, coperti, stato, origine, versione, codice sala, flag delle richieste e override. Esclude nome, cognome, telefono, email, token, sessioni, credenziali e testi di allergie, intolleranze, note e ricorrenze. La motivazione dell'override resta ammessa quando richiesta da D-007.

I login falliti o bloccati conservano soltanto l'impronta HMAC già usata dal rate limiter, mai username o indirizzo client. Le note operative di una data speciale diventano un semplice flag di presenza.

## Sanificazione M9-A

La migrazione M9-A trasforma gli snapshot legacy pubblici e Staff tramite una whitelist, preservando righe, ID, autore, correlation ID, timestamp e campi operativi. Non modifica `Reservation`, contatti, consensi, token o stato. La funzione SQL deterministica resta disponibile per testare la trasformazione esatta con fixture fittizie.

## Consultazione M9-F

M9-F realizza la previsione originaria senza modificare lo schema. Una singola query parametrizzata `UNION ALL` applica il `restaurantId` all'interno di entrambi i rami, seleziona solo l'intestazione minima e ordina per timestamp, ranking stabile della sorgente e UUID, tutti discendenti. La pagina successiva usa lo stesso ordinamento come predicato keyset; il cursore base64url contiene soltanto versione, posizione e fingerprint canonico dei filtri.

Il dettaglio carica un solo evento per sorgente, UUID e tenant. Gli stati JSON non vengono mai inoltrati: una proiezione positiva per categoria e azione conserva soltanto scalari, enum, flag e conteggi approvati. Valori arbitrari, campi annidati inattesi, HMAC di autenticazione, contatti, contenuti editoriali, token, credenziali e testi liberi restano esclusi anche nei record storici corrotti. La lettura rilegge ruolo e stato dell'Admin, usa `no-store` e `noindex` e non produce audit ricorsivo.

## Conseguenze

### Positive

- audit e mutazione sono atomicamente coerenti;
- l'aggiunta di azioni non richiede enum PostgreSQL;
- PII e testi sensibili non vengono duplicati nell'audit;
- il registro prenotazioni non subisce una migrazione distruttiva.
- la consultazione cronologica non crea read-model persistenti né duplica eventi.

### Vincoli

- ogni nuovo caso d'uso deve definire uno snapshot esplicito;
- tutte le query di lettura future devono includere `restaurantId` e richiedere Admin;
- lista, filtri, paginazione e dettaglio sono operazioni strettamente read-only;
- retention e accesso operativo definitivo richiedono ancora approvazione prima della produzione.

## Alternative rifiutate

- Tabella unica retroattiva: rifiutata per rischio e accoppiamento.
- Serializzazione automatica dei record: rifiutata per minimizzazione insufficiente.
- Audit fuori transazione: rifiutato perché può divergere dallo stato applicato.
