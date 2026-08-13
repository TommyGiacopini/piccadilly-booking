# ADR 003 — Capacità e concorrenza delle prenotazioni

**Stato:** accettato
**Data:** 31 luglio 2026
**Aggiornamento:** 12 agosto 2026 — D-021, M9-C

## Contesto

La regola iniziale limita a 30 i coperti in ogni finestra di 30 minuti. Gli slot prenotabili sono distanziati di 15 minuti. Prenotazioni online, telefoniche e modifiche possono arrivare contemporaneamente.

Una semplice sequenza “leggi il totale, controlla, inserisci” non è sicura: due transazioni possono leggere lo stesso totale e confermare entrambe oltre il limite.

La specifica consente allo staff di superare il limite in casi autorizzati. La decisione approvata estende questa possibilità ad Admin e Staff, imponendo sempre una motivazione e l'audit.

## Decisione

### Finestre mobili

La prima versione usa finestre mobili fisse di 30 minuti, ancorate a ogni slot di 15 minuti.

Per ogni inizio finestra `w`:

```text
coperti = somma delle prenotazioni confermate
          con arrivo >= w
          e arrivo < w + 30 minuti
```

Il totale deve essere minore o uguale al limite configurato.

Esempio:

- 19:00 include arrivi alle 19:00 e 19:15;
- 19:15 include arrivi alle 19:15 e 19:30;
- 19:30 include arrivi alle 19:30 e 19:45.

Il limite iniziale è 30 ed è l'unico valore configurabile dall'Admin. L'intervallo degli slot è fisso a 15 minuti e la finestra mobile è fissa a 30 minuti nella prima versione. La UI amministrativa M9-C li mostra come valori informativi non editabili; validazione server e vincoli PostgreSQL rifiutano ogni valore differente.

Quando l'Admin riduce il limite, M9-C calcola l'impatto sulle finestre mobili reali usando soltanto prenotazioni future confermate. Le prenotazioni annullate non contano, le eccezioni attive di capacità conservano la precedenza e la conferma non modifica le prenotazioni esistenti.

### Serializzazione delle scritture

Un servizio può restare virtuale senza riga `service_instances`. Il lock advisory PostgreSQL deriva sempre da `restaurantId + localDate + serviceType` e quindi non dipende dall'esistenza preventiva dell'istanza.

Tutte le operazioni che cambiano i coperti:

1. aprono una transazione breve;
2. acquisiscono il lock advisory del servizio;
3. rileggono configurazione e prenotazioni confermate;
4. controllano tutte le finestre influenzate;
5. inseriscono, modificano o cancellano logicamente;
6. scrivono l'audit necessario;
7. eseguono il commit.

Per uno spostamento fra servizi, le due righe vengono bloccate in ordine deterministico. Gli errori di serializzazione o deadlock sono ritentati un numero limitato di volte.

M9-D riutilizza lo stesso lock per la materializzazione lazy: dopo il lock rilegge l'identità, crea al massimo una `ServiceInstance` e inizializza tutte le righe sala in ordine deterministico. Prenotazione, materializzazione e audit esistente condividono la transazione `SERIALIZABLE` e il commit.

Nessuna chiamata di rete, notifica o generazione di file viene eseguita dentro la transazione.

### Override

Admin e Staff possono confermare oltre il limite soltanto con:

- comando esplicito;
- motivazione non vuota;
- autorizzazione server-side;
- record dedicato dell'override;
- audit con limite, totale precedente e totale risultante.

L'override non cambia la configurazione del limite. Le successive prenotazioni pubbliche non sono confermate finché le finestre interessate restano oltre limite.

Una richiesta pubblica senza disponibilità viene rifiutata senza creare una prenotazione confermata e mostra l'invito a telefonare.

## Conseguenze

### Positive

- il limite non viene superato per race condition;
- online e telefono condividono la stessa regola;
- cancellazioni e modifiche aggiornano subito la disponibilità;
- gli override sono espliciti e ricostruibili;
- non servono Redis o lock distribuiti nella prima versione.

### Negative e vincoli

- le scritture dello stesso servizio vengono serializzate;
- ogni percorso di scrittura deve rispettare lo stesso protocollo;
- sono necessari test di concorrenza con PostgreSQL reale;
- occorre gestire timeout, deadlock e retry;
- la regola limita il flusso degli arrivi, non l'occupazione simultanea, perché il tavolo non ha durata prestabilita.

Per il volume previsto, la serializzazione per singolo pranzo/cena è un compromesso accettabile.

## Alternative rifiutate

### Controllo solo applicativo senza lock

Rifiutato perché non impedisce il superamento concorrente.

### Finestre fisse non sovrapposte

Rifiutate perché consentirebbero concentrazioni ai confini, per esempio 19:15 e 19:30 in blocchi distinti.

### Contatore in memoria

Rifiutato perché non è condiviso fra istanze, si perde al riavvio e non è la fonte ufficiale.

### Redis come lock o contatore iniziale

Rifiutato perché aggiunge infrastruttura e una seconda fonte di stato non necessaria per il volume previsto.

### Vincolo SQL basato soltanto su righe di prenotazione

Rifiutato come unica difesa perché la capacità è un aggregato su finestre sovrapposte e non è esprimibile con un semplice vincolo di riga.

### Blocco globale di tutte le prenotazioni

Rifiutato perché serializzerebbe inutilmente date e servizi indipendenti.
