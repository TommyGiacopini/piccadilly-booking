# ADR 003 — Capacità e concorrenza delle prenotazioni

**Stato:** accettato
**Data:** 31 luglio 2026

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

Il limite iniziale è 30 ed è configurabile dall'Admin. Tipo e durata della finestra non sono configurabili nella prima versione.

### Serializzazione delle scritture

Ogni servizio concreto di una data dispone di una riga `service_instances`.

Tutte le operazioni che cambiano i coperti:

1. aprono una transazione breve;
2. acquisiscono un lock sulla riga del servizio;
3. rileggono configurazione e prenotazioni confermate;
4. controllano tutte le finestre influenzate;
5. inseriscono, modificano o cancellano logicamente;
6. scrivono l'audit necessario;
7. eseguono il commit.

Per uno spostamento fra servizi, le due righe vengono bloccate in ordine deterministico. Gli errori di serializzazione o deadlock sono ritentati un numero limitato di volte.

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
