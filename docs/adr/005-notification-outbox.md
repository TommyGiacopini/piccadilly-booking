# ADR 005 — Transactional outbox per le notifiche

**Stato:** accettato
**Data:** 31 luglio 2026

## Contesto

Il sistema deve inviare conferme, modifiche, cancellazioni e promemoria. WhatsApp è il canale principale previsto in produzione; l'email è facoltativa e può essere fallback o parallela.

Una chiamata al provider può fallire, avere timeout o restituire un risultato ambiguo. La prenotazione deve restare valida anche quando WhatsApp o email non funzionano. Se l'invio avvenisse prima del commit, il cliente potrebbe ricevere una conferma per una prenotazione non salvata. Se l'evento venisse creato soltanto dopo il commit con una seconda scrittura non atomica, un crash potrebbe perdere la notifica.

## Decisione

Usare il pattern transactional outbox.

Nella stessa transazione della prenotazione vengono salvati:

- cambiamento di business;
- audit;
- elemento `notification_outbox` quando previsto.

Dopo il commit, un worker:

1. acquisisce un elemento disponibile;
2. seleziona la strategia configurata;
3. invia tramite un'interfaccia astratta;
4. registra il tentativo;
5. marca il lavoro completato oppure programma un retry;
6. segnala alla dashboard gli errori permanenti.

Interfacce previste:

- `WhatsAppProvider`;
- `EmailProvider`;
- `NotificationQueue`;
- renderer dei template.

Sviluppo e staging usano implementazioni simulate. La produzione usa Meta WhatsApp Cloud API ufficiale. L'email può essere configurata come:

- disabilitata;
- fallback dopo errore WhatsApp;
- invio parallelo.

La notifica a un numero interno è indipendente dall'eventuale gruppo WhatsApp. Il gruppo è opzionale e viene implementato soltanto se supportato da API ufficiali.

Retry e richieste al provider devono essere idempotenti. Nessun token provider o contenuto sensibile completo viene scritto nei log.

## Estensione vincolante M12

Ogni riga outbox è una singola delivery leg e conserva tenant, reservation/version, event group/type, origine, attore facoltativo, canale, strategy snapshot, sola destination della leg, payload V1 minimizzato, scheduling/expiry, stato, conteggi, policy retry, chiave SHA-256, correlation ID e lease. `NotificationAttempt` è append-oriented e non contiene destination, payload o messaggio. `NotificationSimulationReceipt`, con chiave primaria `(restaurantId, idempotencyKey)`, non contiene PII e dimostra l'idempotenza persistente.

Gli stati ammessi sono `PENDING → CLAIMED`, `PENDING → CANCELLED` e, da `CLAIMED`, `SUCCEEDED`, `PENDING`, `DEAD` o `CANCELLED`. I terminali sono immutabili. Un cancel osservato prima della provider call evita l'invio; se arriva durante la call, un successo resta `SUCCEEDED` e un fallimento diventa `CANCELLED` senza retry. Questa è una limitazione fisica inevitabile: una chiamata già iniziata non può essere ritirata.

Prima del claim, uno sweep PostgreSQL breve usa `FOR UPDATE SKIP LOCKED` e ordine expiry/creazione/UUID per terminalizzare al massimo 100 leg `PENDING` scadute con `DEAD/EXPIRED`, senza provider call, attempt o fallback. Il claim usa lo stesso meccanismo di lock, ordinamento per disponibilità/scheduling/creazione/UUID, batch 25, massimo 5 leg per tenant e lease di due minuti. Un gruppo lifecycle successivo non supera un precedente già `CLAIMED`; un reminder futuro non blocca gli eventi immediati. Una lease scaduta senza attempt torna pending; con attempt incompleto marca `ABANDONED/WORKER_INTERRUPTED` e poi requeue o cancel deterministicamente.

La provider call avviene fuori dalla transaction e fuori dal row lock: claim, apertura attempt e finalize sono transazioni brevi separate. La porta riceve un `AbortSignal` creato server-side; una deadline applicativa iniettabile di 30 secondi abortisce realmente il provider e classifica il timeout come transient sanitizzato. SIGINT/SIGTERM abortiscono le call iniziate, non avviano quelle claimed ancora in coda e lasciano attempt incompleti recuperabili dalla lease. Il batch processa al massimo cinque leg contemporaneamente, mantenendo indipendenti i canali paralleli. Il retry V1 usa 1, 5 e 15 minuti dal `completedAt` letto dopo la call, massimo quattro attempt, senza jitter. Timeout è transient; permanent non viene ritentato; completion o retry uguale o oltre expiry rende la leg dead.

Con fallback, WhatsApp esaurisce i transient retry, mentre un permanent crea subito la leg email; la creazione email e la terminalizzazione primary sono atomiche. Email mancante produce una leg `DEAD/DESTINATION_UNAVAILABLE` senza attempt. In parallelo le due leg nascono atomicamente, se disponibili, e hanno claim/retry indipendenti; l'esito globale è derivato senza tabella gruppo.

La receipt garantisce: stessa chiave e stesso payload hash restituiscono la medesima provider reference e `deduplicated=true`; hash differente produce `IDEMPOTENCY_CONFLICT`. Dopo crash fra receipt e finalize, la lease recovery abbandona l'attempt, il replay riusa la receipt e completa l'outbox con una sola receipt. La garanzia è at-least-once tecnica ed exactly-once logica nel simulatore, non exactly-once fisica per i provider reali futuri.

M12 contiene esclusivamente simulatori WhatsApp/email con default success deterministico e nessun I/O di rete. Non introduce retention: policy di retention/redazione e validazione dei provider reali sono gate obbligatori prima di M14/produzione.

## Conseguenze

### Positive

- la prenotazione viene salvata prima dell'invio;
- un crash fra commit e invio non perde l'intenzione di notificare;
- errori provider non invalidano dati di business;
- mock e provider reali sono sostituibili;
- fallback e parallelo non contaminano la logica delle prenotazioni;
- tentativi e fallimenti sono osservabili.

### Negative e vincoli

- consistenza eventuale fra prenotazione e messaggio;
- nuove tabelle e un worker da monitorare;
- necessità di retry, backoff, idempotenza e gestione dei messaggi bloccati;
- possibile invio duplicato se il provider non supporta idempotenza e il timeout è ambiguo;
- occorre gestire modifica o cancellazione dei promemoria già pianificati.

## Alternative rifiutate

### Invio sincrono prima del salvataggio

Rifiutato perché può notificare una prenotazione che poi non viene salvata.

### Invio sincrono dentro la transazione

Rifiutato perché mantiene lock durante una chiamata di rete e collega la validità della prenotazione alla disponibilità del provider.

### Invio dopo il commit senza outbox persistente

Rifiutato perché un crash immediatamente dopo il commit può perdere la notifica.

### Chiamate dirette a Meta dalla logica prenotazioni

Rifiutate perché accoppiano il dominio al provider e rendono i mock meno affidabili.

### WhatsApp Web o API non ufficiali

Rifiutati esplicitamente per sicurezza, affidabilità e conformità alle regole del progetto.

### Gruppo WhatsApp come requisito del flusso interno

Rifiutato perché la disponibilità delle API ufficiali non è garantita. Dashboard e numero interno devono bastare al funzionamento operativo.
