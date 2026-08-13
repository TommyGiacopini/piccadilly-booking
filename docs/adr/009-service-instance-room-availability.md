# ADR 009 — ServiceInstance e disponibilità delle sale

**Stato:** accettato, implementato da M9-D
**Data:** 12 agosto 2026
**Aggiornamento:** 12 agosto 2026 — D-032 e D-033

## Contesto

Regole settimanali ed eccezioni devono convergere in una configurazione effettiva per uno specifico pranzo o cena. Galleria e Terrazzo possono essere disponibili in modo diverso per data e servizio. Una tabella parallela di override delle sale introdurrebbe due fonti concorrenti.

## Decisione

### Identità e contenuto

- `ServiceInstance` è unica per `restaurantId`, data locale e servizio.
- Contiene soltanto identità, versione, relazioni e timestamp. Orari, capacità, cutoff e apertura restano calcolati dalle fonti M9-C.
- Gli stati logici sono derivati: `VIRTUAL` senza riga, `MATERIALIZED` con riga e `HISTORICAL` quando la data è precedente a oggi nella timezone del ristorante. Non esiste enum persistente.
- `ServiceRoomAvailability` collega l'istanza a ogni sala reale dello stesso ristorante. Non viene creata `RoomAvailabilityOverride` o altra struttura parallela.

### Materializzazione

La materializzazione è esclusivamente lazy. Avviene nella transazione della prima prenotazione creata con successo o della prima modifica Admin effettiva della disponibilità. GET, preview, no-op, backfill e job di orizzonte futuro non creano righe. La procedura acquisisce un advisory transaction lock stabile per ristorante/data/servizio, rilegge l'istanza, crea una sola istanza e tutte le righe sala in ordine deterministico, usando `SERIALIZABLE` e retry limitato.

Non viene eseguito backfill delle prenotazioni e `Reservation` non referenzia `ServiceInstance`. Le istanze non vengono eliminate o archiviate; quelle storiche sono read-only.

### Policy e precedenze

Le sale reali sono le cinque canoniche. Sala 1/2/3 usano `DEFAULT_AVAILABLE`; Galleria/Terrazzo usano `EXPLICIT_ONLY`. Nello stato virtuale la policy determina la disponibilità. Alla materializzazione viene creata una riga per ogni sala con il valore della policy; una riga mancante è un errore sicuro.

Il servizio viene prima risolto da eccezione specifica, eccezione `ALL`, calendario settimanale e impostazioni generali. Un servizio chiuso o una sala globalmente inattiva prevalgono sempre sulla disponibilità locale. Il runtime usa la policy persistita e non riconosce le aree esterne tramite nome o codice.

Una modifica futura usa anteprima, fingerprint pertinente, conferma, ricalcolo transazionale e audit secondo ADR 007. Le prenotazioni esistenti restano confermate e seguono il grandfathering.

## Conseguenze

- esiste una sola configurazione effettiva per servizio;
- il lock di capacità può convergere sulla stessa identità di servizio prevista dall'ADR 003;
- la materializzazione idempotente è condivisa con il lock di capacità;
- la disponibilità delle sale non viene dedotta da una seconda catena di override.

## Alternative rifiutate

- `RoomAvailabilityOverride` separata: rifiutata perché duplica precedenza e stato.
- Calcolo sempre al volo senza istanza: rifiutato come destinazione perché complica lock, impatto e audit.
- Modifica automatica delle prenotazioni durante il ricalcolo: rifiutata per grandfathering.
