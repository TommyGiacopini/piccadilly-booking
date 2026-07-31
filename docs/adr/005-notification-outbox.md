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
