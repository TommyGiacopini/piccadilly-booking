# ADR 002 — PostgreSQL come unica fonte ufficiale

**Stato:** accettato
**Data:** 31 luglio 2026

## Contesto

Il ristorante necessita di una fonte unica per prenotazioni online e telefoniche, modifiche, cancellazioni, preferenze, assegnazioni, configurazioni e audit.

PDF ed Excel sono necessari per consultazione, stampa e operatività giornaliera. Se venissero usati come archivi modificabili o database paralleli, sarebbe impossibile garantire disponibilità, concorrenza, audit e coerenza.

## Decisione

PostgreSQL è l'unica fonte ufficiale dei dati e la dashboard è lo strumento principale per consultarli e modificarli.

Sono persistiti in PostgreSQL:

- prenotazioni e relativi dati collegati;
- modifiche e cancellazioni logiche;
- configurazioni e servizi;
- utenti e sessioni;
- preferenze e assegnazioni;
- consensi;
- audit;
- outbox e tentativi di notifica;
- metadati tecnici necessari a idempotenza e rate limiting.

PDF ed Excel:

- sono generati a partire da letture PostgreSQL;
- non vengono reimportati per aggiornare prenotazioni;
- non sono conservati come archivio autorevole;
- un errore di generazione non modifica dati di business.

Excel è disponibile per singola giornata, mese o intervallo, con un foglio per giorno. Non esiste un workbook unico e crescente.

Il PDF contiene prima `DA ASSEGNARE`, poi Sala 1, Sala 2, Sala 3, Galleria e Terrazzo; ogni sezione è ordinata per momento di creazione.

## Conseguenze

### Positive

- coerenza fra tutti i canali di inserimento;
- transazioni e lock applicabili in un unico punto;
- cancellazioni e modifiche immediatamente visibili;
- audit ricostruibile;
- backup e ripristino concentrati sul database;
- esportazioni sempre rigenerabili.

### Negative e vincoli

- la disponibilità della dashboard dipende dal database;
- le esportazioni offline possono diventare obsolete appena scaricate;
- occorrono backup e procedure di ripristino coerenti con RPO/RTO;
- eventuali correzioni operative devono passare dalla dashboard, non da Excel.

## Alternative rifiutate

### Excel come database operativo

Rifiutato perché non offre transazioni concorrenti, vincoli, audit affidabile o controllo degli accessi sufficiente.

### Sincronizzazione bidirezionale database–Excel

Rifiutata perché introduce conflitti, duplicazione dello stato e ambiguità sulla fonte autorevole.

### Conservazione permanente dei PDF come archivio primario

Rifiutata perché il PDF non rappresenta le modifiche successive e non è interrogabile come il database.

### Database distinti per prenotazioni online e telefoniche

Rifiutati perché causerebbero disponibilità incoerente e necessità di sincronizzazione.
