# ADR 011 — Assegnazione manuale di sala e tavoli

**Stato:** accettato; M10-A e M10-B merged su `main`; UI M10-C implementata nel working tree e in attesa di Quality Gate
**Data:** 13 agosto 2026

## Contesto

M9-D ha introdotto catalogo sale/tavoli e disponibilità per servizio senza collegare prenotazioni a `ServiceInstance`. M10 deve salvare una collocazione finale separata dalla preferenza del cliente, consentire correzioni storiche e mantenere audit e isolamento tenant senza introdurre automazione, occupazione temporale o modifiche retroattive ai flussi già approvati.

## Decisione

### Modello e stato logico

- `ReservationAssignment` è separata da `Reservation` e contiene tenant, prenotazione, sala finale, note interne, autore iniziale, ultimo autore, timestamp e `clearedAt`.
- Esiste una sola riga per prenotazione. `clearedAt IS NULL` indica l'assegnazione corrente; la rimozione valorizza il campo e non elimina la riga.
- Una nuova assegnazione dopo la rimozione riattiva la stessa entità, sovrascrive sala, tavoli e note e preserva `assignedByUserId`.
- `ReservationAssignmentTable` collega da uno a venti tavoli distinti all'assegnazione. Chiavi composte garantiscono tenant, sala finale e appartenenza del tavolo; i dati di dominio usano `ON DELETE RESTRICT`.
- `DA ASSEGNARE` non è persistita e deriva dall'assenza di assegnazione attiva. Non esiste relazione tra `Reservation` e `ServiceInstance` e non viene eseguito backfill.
- I posti minimi/massimi sono restituiti come informazioni operative ma non partecipano alla validazione. Lo stesso tavolo può comparire in assegnazioni diverse.
- Le note interne accettano al massimo 1.000 code point, non entrano nei DTO pubblici e non vengono copiate nell'audit.

### Comandi e lettura

M10-A espone soltanto `GET`, `PUT` e `DELETE /api/staff/reservations/:id/assignment`. `PUT` accetta esclusivamente versione, sala, da uno a venti UUID tavolo distinti e note opzionali/null; `DELETE` accetta esclusivamente la versione. Gli UUID tavolo sono trattati come insieme ordinato deterministicamente.

La GET è read-only: rilegge l'attore e il tenant, restituisce versione prenotazione, preferenza originaria separata, assegnazione attiva o `null`, catalogo operativo con posti minimi/massimi e flag di riferimenti inattivi o indisponibili. Non materializza istanze e non crea audit.

### Regole temporali e grandfathering

- Solo prenotazioni `CONFIRMED` possono ricevere o modificare un'assegnazione; le cancellate vengono rifiutate.
- Per data corrente o futura, una nuova sala deve essere attiva ed effettivamente disponibile per il servizio; ogni nuovo tavolo deve essere attivo e appartenere alla sala finale.
- Per una prenotazione storica, sala e tavoli nuovi devono essere attivi e coerenti, ma non si ricalcola retroattivamente una disponibilità non versionata e non si materializza `ServiceInstance`.
- Un riferimento già presente può essere conservato anche se successivamente inattivo o indisponibile. Qualunque sala o tavolo introdotto da assegnazione o riassegnazione rispetta lo stato corrente.

M10-B attua la politica approvata: una modifica effettiva di data, servizio o orario rimuove atomicamente l'assegnazione attiva, mentre persone, preferenza, contatti, esigenze e note la conservano. La cancellazione conserva storicamente l'ultima assegnazione e la esclude dagli impatti operativi. Disattivazioni e indisponibilità preservano le assegnazioni come grandfathered; nuove assegnazioni e riassegnazioni continuano a richiedere riferimenti validi.

Il protocollo M9-D include le assegnazioni attive di prenotazioni `CONFIRMED` correnti o future interessate da disattivazione sala, disattivazione tavolo o indisponibilità per data/servizio. Preview e audit espongono soltanto conteggi e classificazioni; il fingerprint opaco include esclusivamente proposta, configurazione e dipendenze pertinenti e viene ricalcolato nella transazione. `IMPACT_CHANGED` non muta configurazioni o assegnazioni e non produce audit.

### Concorrenza, versione e audit

Le mutazioni usano transazioni `SERIALIZABLE` con retry sui conflitti. L'ordine dei lock è:

1. lock di mutazione della prenotazione;
2. lock della configurazione operativa del tenant;
3. lock di capacità per tenant, data e servizio;
4. rilettura di attore, prenotazione, assegnazione, sala e tavoli;
5. verifica di `Reservation.version`;
6. mutazione, incremento versione e `updatedAt`;
7. audit;
8. commit.

Il confronto dei tavoli è indipendente dall'ordine. Un payload invariato e la rimozione di un'assegnazione già assente sono no-op: non cambiano versione o timestamp e non creano audit. Due mutazioni concorrenti con la stessa versione hanno un solo vincitore.

`ReservationAuditEvent` aggiunge `ASSIGNED`, `REASSIGNED` e `UNASSIGNED`. Prima assegnazione e riattivazione usano `ASSIGNED`, modifica attiva usa `REASSIGNED`, rimozione usa `UNASSIGNED`. Gli snapshot contengono soltanto codice sala finale, UUID tavolo ordinati, conteggio tavoli e presenza delle note; l'assenza è `assignment: null`. Il clear automatico per reschedule aggiunge la sola motivazione canonica `RESERVATION_SCHEDULE_CHANGED`, con lo stesso correlation ID dell'audit `UPDATED` e ordine deterministico. Mutazione e audit condividono la transazione e la versione della prenotazione cresce una sola volta.

Nel reschedule tramite link personale non esiste un utente applicativo da referenziare: `updatedByUserId` conserva quindi l'ultimo autore Staff/Admin, mentre origine `PUBLIC`, correlation ID e causa della rimozione sono registrati nel relativo `ReservationAuditEvent`. Non vengono creati utenti tecnici né accettati identificativi dal client.

### Autorizzazione e sicurezza

STAFF e ADMIN possono usare le API solo con sessione valida, account attivo, `disabledAt` nullo e `mustChangePassword=false`. Attore, ruolo, tenant e correlation ID non sono accettati dal client e vengono riletti nel database. Le mutazioni richiedono stessa origine e JSON; tutte le risposte sono `no-store`. Query e join includono il tenant e un riferimento cross-tenant è indistinguibile da una risorsa inesistente.

## Conseguenze

### Positive

- preferenza, assegnazione corrente e storia audit restano separate;
- la rimozione e la riattivazione non perdono l'identità dell'assegnazione;
- tenant, sala e tavoli sono protetti anche nel database;
- M10-B applica reschedule, cancellazione e impatto senza nuova migrazione.

### Vincoli

- nessuna assegnazione automatica, combinazione, capacità tavoli o collision detection;
- nessuna UI di assegnazione appartiene a M10-A/M10-B; M10-C riusa le API esistenti e mantiene server e PostgreSQL come autorità;
- i flussi reschedule/cancellazione e i servizi Admin sale/tavoli sono integrati soltanto nel perimetro lifecycle M10-B;
- la disponibilità storica non può essere ricostruita perché non è versionata.

## Alternative rifiutate

- Campi direttamente su `Reservation`: rifiutati perché confondono preferenza e collocazione finale e rendono fragile il lifecycle.
- Una riga nuova a ogni riassegnazione: rifiutata perché la storia appartiene all'audit e deve esistere una sola assegnazione logica corrente.
- Hard delete alla rimozione: rifiutato per perdita di storia.
- Vincoli temporali sul riuso del tavolo: rifiutati finché non esiste un modello approvato di durata/occupazione.
- Materializzazione delle istanze durante letture o correzioni storiche: rifiutata perché viola ADR 009.
