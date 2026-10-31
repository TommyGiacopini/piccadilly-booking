# Piccadilly Booking — Specifiche funzionali

## Contratto corrente T06-A — note interne autonome e privacy export (14 ottobre 2026)

T05 è CLOSED (PR #28). Il Controller autorizza soltanto T06-A locale sulla baseline `96963f780f041394d2aaf3169a06c22f22908cd6`, senza pubblicazione Git, deploy o mutation del database persistente. Le limitazioni T05 su T06/migration16 e l'inclusione storica delle note interne negli export riportate sotto sono checkpoint superati dal presente contratto. T06-B/C/D non sono avviate.

NC è la nota condivisa `Reservation.notes`: Public create, link personale, PHONE e modifica Staff/Admin per conto del cliente mantengono payload, idempotenza e comportamento canonici. La condivisione non attribuisce al cliente la paternità materiale del testo; nessun nuovo campo di provenance.

NI è una singola nota corrente `Reservation.privateNotes`, nullable, testo semplice di massimo 1000 code point Unicode. Stringa vuota e null sono equivalenti; spazi e sequenza Unicode valida sono preservati, senza rich text, troncamenti UTF-16, storico testuale o dipendenza dalla sala. Staff/Admin possono scriverla senza assegnazione e su CONFIRMED storiche; CANCELLED è consultabile in sola lettura. Reschedule, cambio sala/servizio/orario e cancellazione non copiano né cancellano NI.

GET/PUT `/api/staff/reservations/{id}/private-notes` sono riservati a Staff/Admin con guard canonici. PUT strict contiene soltanto `version` e `privateNotes`. L'identico normalizzato, anche stale, è no-op dopo auth/tenant/CONFIRMED: zero write, versione, timestamp e audit. Una modifica reale richiede la versione corrente, incrementa una sola volta e registra atomicamente `PRIVATE_NOTES_UPDATED`; errore audit causa rollback. Nessun effetto su assegnazione, capacità, arrivo, token, outbox o configurazione.

Le note `ReservationAssignment.internalNotes` rimangono legacy, distinguibili e consultabili separatamente anche quando cleared. Nessuna promozione, copia o cleanup; lifecycle T04 invariato. L'Agenda offre un editor NI minimo, con pending, blocco doppio invio, focus/tastiera e reload esplicito dopo409.

**Nessun testo NI autonomo o legacy active/cleared compare in PDF o Excel.** La proiezione export non seleziona NI; il PDF elimina soltanto il segmento NI e conserva NC/esigenze. Excel conserva24 colonne: V contiene NC, W resta vuota, X conserva creazione. Sorting, periodi, filename, sanitizzazione formule, autorizzazioni e audit export rimangono canonici.

Migration16 aggiunge la sola colonna nullable e la action audit, estendendo il vincolo stati audit senza alterare le action precedenti. Zero backfill, journal, metadata NC o migration17; migration1–15 e FK preservate. Test esclusivamente PostgreSQL temporaneo isolato; fresh1–16, upgrade15→16 e fixture14→15 esatta sono gate separati.

## Contratto corrente T05 — presentazione operativa sale (2026-10-09)

Foundation A è CLOSED (PR #26) e T04 Revised è CLOSED (PR #27). I paragrafi precedenti/successivi che descrivono il loro avvio sono checkpoint storici. T05 è autorizzata esclusivamente come implementazione locale, in attesa di Work Final QG e di eventuali autorizzazioni Git separate.

Sala 1, Sala 2 e **Sala 3 — Giochi** sono label operative Staff/Admin dei code immutati `sala-1`, `sala-2`, `sala-3`. Galleria/Terrazzo mostrano **Area legacy**, indicatore neutro che non significa retired, disabilitata o solo storica. Nessuna rinomina DB, modifica seed/default, audit storico o DTO/API raw. Preferenza storica cliente senza alias; Public ed export restano invariati.

La disponibilità M9 resta `servizio aperto && sala globalmente attiva && configurata disponibile per data/servizio`: `DEFAULT_AVAILABLE` per Sala 1–3, `EXPLICIT_ONLY` per Galleria/Terrazzo nello stato virtuale. Local disable vale anche per le sale principali; enable legacy è isolato per data/servizio. La categoria di presentazione non decide eligibility. Ordine `displayOrder ASC`, poi `code ASC`, senza gruppi fissi; code sconosciuto usa name raw completo.

Admin distingue Stato globale, Configurata per questo servizio e Disponibilità effettiva. Il servizio storico locale è read-only, mentre lo stato globale riflette la configurazione attuale. GET/preview/no-op non materializzano; preview/fingerprint/apply e audit restano canonici.

La richiesta giochi non garantisce Sala 3 e non provoca assegnazione, capacità dedicata o esclusività adulti/bambini. `childrenCount=null` rimane sconosciuto. Badge SALA GIOCHI RICHIESTA separato dalla sala finale; priorità best-effort umana per ordine prenotazione. Label-only non cambia roomId, tavoli, note, versione, timestamp, audit o composizione. Conservati T04 (room obbligatoria, 0–20 tavoli, no-op stale dopo guard, conflict, clear logico, grandfathering, audit atomico), T03 e Foundation.

Schema/migration 1–15 protetti; nessuna migration16, auto-assignment, collision detection, nuova API, redesign Public/export, T06, Render o Asporti. Riferimento D-045.

## Contratto Owner Change v2 — Foundation A (2026-10-07)

Questa sezione prevale sui riferimenti storici alla scelta cliente di una sala fisica e al solo booleano bambini presenti nelle sezioni successive.

- `partySize` è il totale coperti, bambini inclusi. `childrenCount` nullable è il numero bambini; gli adulti sono derivati, mai persistiti separatamente.
- `childrenCount=null` e `gameRoomPreference=null` significano **composizione non specificata**. Nessun backfill o deduzione da preferenze legacy, assignment, Sala 3 o testo libero.
- Una nuova Public richiede tutti adulti (`0/null`) oppure bambini (`1..partySize` con preferenza giochi esplicita Sì/No). PHONE ammette anche Non specificato (`null/null`).
- Public, PHONE, modifica Staff e link personale non chiedono più una sala fisica. `gameRoomPreference` è una richiesta cliente non garantita per la Sala con i Giochi, non un'assegnazione né una riserva di capacità. Nessuna allocazione automatica.
- Cambiare solo composizione/preferenza non rimuove l'assegnazione operativa. Il clear per data, servizio o orario resta quello canonico. L'arrivo T03 resta indipendente.
- Un legacy sconosciuto può restare tale durante modifiche non pertinenti; cambiare il totale richiede una dichiarazione coerente. Una composizione già dichiarata non torna implicitamente sconosciuta.
- `preferences` conserva le altre richieste. `roomCode` storico resta leggibile e viene preservato server-side; nuove prenotazioni non ricevono una sala preferita fisica. Il booleano legacy `children`, ove serializzato per compatibilità, è derivato dal conteggio noto o preservato come indicazione non autorevole se sconosciuto. Non è un secondo input cliente.
- I nuovi campi fanno parte di equivalenza/no-op/audit e hash idempotency. Un payload vecchio può solo ripetere un record idempotency preesistente, corrispondente e non scaduto; non crea nuovi record e non riscrive gli hash storici.

Copy italiano congelato: «In quanti siete? (coperti totali)», «Ci sono bambini?», «No, siamo tutti adulti», «Sì, ci sono bambini», «Quanti bambini ci sono?», «Preferite un tavolo nella Sala con i Giochi?» con risposte Sì/No. La richiesta non è garantita; in caso di più richieste la priorità segue, per quanto possibile, l'ordine di prenotazione. La disposizione tavoli/sale è definita dal ristorante per esigenze organizzative e di servizio. L'inglese mantiene identica semantica, senza promesse aggiuntive.

Foundation A aggiunge soltanto la migration #15 con due colonne nullable senza default/indice e constraint di coerenza. T04 revised e T05 restano separati e non implementati in questa tranche. Il T04 locale parziale è preservato nel suo worktree e non incorporato.



**Versione:** 1.0

**Stato:** approvato per lo sviluppo iniziale

**Repository iniziale:** personale

**Produzione finale:** intestata al Risto Pizza Piccadilly



## 1. Obiettivo



Creare un sistema proprietario che diventi l'unica fonte ufficiale delle prenotazioni del Risto Pizza Piccadilly.



Il sistema deve raccogliere:



\- prenotazioni online;

\- prenotazioni telefoniche;

\- modifiche;

\- cancellazioni;

\- preferenze di sala;

\- esigenze alimentari e logistiche;

\- assegnazione manuale dei tavoli.



Il database PostgreSQL è la fonte ufficiale.



WhatsApp, email, PDF ed Excel sono strumenti collegati e non devono essere indispensabili per salvare correttamente una prenotazione.



## 2. Struttura prevista



Flusso principale:



Sito Piccadilly

→ pulsante Prenota

→ applicazione proprietaria

→ database PostgreSQL

→ dashboard del personale

→ notifiche, PDF ed Excel



Durante lo sviluppo l'applicazione viene eseguita localmente.



Successivamente verrà creato uno staging personale su Render.



La produzione finale verrà ricreata su account intestati al ristorante.



## 3. Aree del ristorante



### Sala 1



Sala principale, prevalentemente destinata agli adulti. Non contiene giochi e ospita la cassa.



### Sala 2



Sala separata dal corpo principale tramite la galleria. Utilizzata anche per compleanni, rinfreschi, battesimi ed eventi.



### Sala 3



Grande sala dotata di giochi, preferita dalle famiglie con bambini e utilizzata per compleanni con numerosi bambini.



### Galleria



Area coperta ma all'aperto, disponibile quando temperatura e condizioni lo permettono. Può essere richiesta la zona davanti alla Sala 3.



### Terrazzo



Area scoperta e all'aperto, disponibile quando condizioni meteorologiche e temperatura lo permettono.



La sala selezionata dal cliente è sempre una preferenza non garantita.



Testo da mostrare:



"La sala indicata rappresenta una preferenza. Il Piccadilly si riserva il diritto di modificare la collocazione del tavolo per esigenze organizzative, disponibilità o condizioni atmosferiche."



Galleria e Terrazzo devono poter essere attivate o disattivate dal pannello amministrativo.



## 4. Giorni e servizi



Il sistema deve gestire pranzo e cena.



L'amministratore deve poter modificare:



\- giorni di apertura;

\- giorni di chiusura;

\- disponibilità del pranzo;

\- disponibilità della cena;

\- aperture straordinarie;

\- chiusure straordinarie;

\- orari prenotabili;

\- orari prenotabili, con intervallo degli slot V1 fisso a 15 minuti;

\- sale disponibili;

\- limite di coperti;

\- orario di chiusura delle prenotazioni.

Servizi, sale, tavoli ed eccezioni vengono disattivati o archiviati, non eliminati fisicamente. In particolare la rimozione di una data straordinaria è un'archiviazione reversibile e le query operative la ignorano finché non viene ripristinata.

M9-C rende configurabili per ogni giorno e servizio l'abilitazione, il primo e l'ultimo slot, la capacità generale e il cutoff delle nuove prenotazioni pubbliche. Il cutoff pubblico è una regola generica per giorno e servizio e non si applica agli inserimenti Staff o telefonici.

M9-D introduce istanze servizio minimali, create solo al primo bisogno operativo. Lo stato virtuale deriva dalla configurazione M9-C: Sala 1–3 sono disponibili per default, Galleria e Terrazzo solo dopo abilitazione esplicita per data e servizio. Il servizio chiuso e la disattivazione globale prevalgono. Le cinque sale canoniche non possono essere create, rinominate, ricodificate o eliminate; `DA ASSEGNARE` non è persistita.



### Pranzo



\- prima prenotazione: 12:00;

\- ultima prenotazione: 14:00;

\- intervallo: 15 minuti.



### Cena



\- prima prenotazione: 19:00;

\- ultima prenotazione: 22:15;

\- intervallo: 15 minuti.



Il cliente conserva il tavolo senza durata prestabilita.



## 5. Limite iniziale



Valore iniziale:



\- massimo 30 coperti per ogni finestra di 30 minuti.



Soltanto il limite di coperti deve essere modificabile dall'amministratore. Nella V1 l'intervallo degli slot resta fisso a 15 minuti e la finestra mobile resta fissa a 30 minuti; la UI amministrativa li mostra come valori informativi e server e database devono rifiutare valori differenti.

Una riduzione del limite, una disabilitazione del servizio, una restrizione degli orari o una modifica dei cutoff con prenotazioni future confermate richiede anteprima server-side minimizzata e conferma esplicita. La conferma modifica soltanto la configurazione: nessuna prenotazione esistente viene modificata o cancellata automaticamente.



Il personale deve poter superare manualmente il limite quando inserisce una prenotazione telefonica autorizzata.



## 6. Chiusura delle prenotazioni online



Il venerdì e il sabato alle 17:30 devono chiudersi automaticamente le prenotazioni online per la cena dello stesso giorno.



Messaggio da mostrare:



"Le prenotazioni online per questa sera sono chiuse. Per verificare eventuali disponibilità, chiama cortesemente il Piccadilly al numero 059 6232237."



La regola deve essere modificabile dal pannello amministrativo.



La chiusura online non deve impedire al personale di inserire prenotazioni telefoniche.



## 7. Modulo pubblico



Campi obbligatori:



\- nome;

\- cognome;

\- telefono;

\- data;

\- pranzo o cena;

\- orario;

\- numero di persone;

\- sala preferita;

\- accettazione privacy;

\- accettazione delle condizioni.



Campi facoltativi:



\- email;

\- seggiolone;

\- passeggino;

\- accessibilità;

\- presenza di bambini;

\- celiachia;

\- allergie;

\- intolleranze;

\- compleanno o ricorrenza;

\- animali;

\- note libere.



Il campo Note deve essere sempre disponibile.



Numero minimo di persone: 1.



Non esiste un massimo assoluto, ma la conferma dipende dal limite della fascia.



La prenotazione viene confermata immediatamente quando disponibile.



## 8. Pagina personale



Ogni prenotazione deve ricevere un token pubblico casuale.



Esempio:



`/p/8fK29sQpLx7mA91Qz`



La pagina:



\- mostra solo la singola prenotazione;

\- non appare nel menu;

\- non viene indicizzata;

\- non richiede account;

\- permette modifica;

\- permette cancellazione;

\- scade dopo il servizio;

\- registra tutte le operazioni.

Ogni token conserva la durata applicata quando viene creato. Le modifiche alla configurazione valgono soltanto per token successivi; se la prenotazione viene spostata, la scadenza viene ricalcolata rispetto al nuovo servizio usando la durata originaria, senza rigenerare il token.



Il token non deve contenere l'ID progressivo del database.



## 9. Modifiche e cancellazioni



Il cliente può modificare:



\- numero di persone;

\- data;

\- orario;

\- sala preferita;

\- esigenze;

\- note.



Modifiche a persone, data o orario devono ricontrollare la disponibilità.



Fino alle 17:30 del giorno della prenotazione sono consentite modifica e cancellazione online.



Dopo le 17:30 il cliente deve essere invitato a chiamare il numero 059 6232237.



Le prenotazioni annullate non devono essere eliminate dal database.



I coperti devono tornare immediatamente disponibili.



Ogni modifica deve conservare:



\- valore precedente;

\- valore nuovo;

\- data e ora;

\- origine dell'operazione.

Una configurazione successiva non invalida retroattivamente prenotazioni confermate e non le modifica o cancella automaticamente. Contatti, note e richieste possono essere aggiornati conservando dati operativi invariati; nuova data, servizio, ora o sala e gli aumenti di coperti rispettano la configurazione corrente. Una riduzione dei coperti sullo stesso servizio resta consentita.

Le modifiche amministrative con prenotazioni coinvolte richiedono anteprima server-side senza PII, conferma esplicita, ricalcolo transazionale, rifiuto `IMPACT_CHANGED` in caso di divergenza e audit. M9-C applica questo protocollo a impostazioni, servizi e cutoff; M9-D alla disponibilità e disattivazione delle sale. M10-B estende lo stesso motore M9-D alle assegnazioni finali interessate dalla disattivazione di sale o tavoli e dall'indisponibilità di una sala per data/servizio.



## 10. WhatsApp



Verrà acquistato un nuovo numero dedicato.



Messaggi previsti:



1\. conferma della prenotazione;

2\. conferma della modifica;

3\. conferma dell'annullamento;

4\. promemoria tre ore prima.



Il reminder è pianificato tre ore assolute prima dell'istante della prenotazione nella timezone del ristorante. A esattamente tre ore viene creato ed è immediatamente processabile; a meno di tre ore non viene creato. Una prenotazione iniziata o passata non produce reminder.



M12 usa esclusivamente provider WhatsApp ed email simulati e non contiene implementazioni di rete reali. Reservation, audit e intent outbox condividono il commit; il provider viene chiamato soltanto dopo il commit e un suo errore non annulla la prenotazione.

Ogni delivery leg conserva un payload V1 minimizzato e stabile con versione schema/template, locale IT/EN, nome cliente, ristorante, data locale, servizio, orario e persone. La singola leg conserva soltanto la propria destination. Sono esclusi cognome, note, esigenze, preferenze, assegnazione, consensi, token, hash e link personale. I retry usano questo snapshot e non rileggono la reservation corrente.

Strategie di canale principale, fallback e invio parallelo, outbox e provider simulati appartengono alla milestone M12; M9 gestisce soltanto i dati di contatto.



Il sistema deve utilizzare in produzione la WhatsApp Cloud API ufficiale di Meta.



La prenotazione deve restare valida anche se WhatsApp non funziona.



L'invio automatico nel gruppo interno deve essere trattato come funzione opzionale, subordinata alla disponibilità delle API ufficiali.



## 11. Prenotazioni telefoniche



Il personale deve avere un modulo più rapido di quello pubblico.



Campi:



\- nome;

\- cognome;

\- telefono;

\- email facoltativa;

\- data;

\- servizio;

\- ora;

\- persone;

\- sala preferita;

\- esigenze;

\- note.



La prenotazione telefonica deve entrare nello stesso database e influire sulla disponibilità.



Deve essere presente l'opzione `Invia conferma WhatsApp`, selezionata per default. La disattivazione sopprime soltanto la confirmation WhatsApp iniziale: non è consenso marketing, non attiva il fallback, non sopprime reminder, aggiornamenti o cancellazioni e, nella strategia parallela, non sopprime l'email disponibile.



## 12. Dashboard



Dispositivi:



\- PC;

\- tablet;

\- smartphone.



Ruoli:



### Admin



Può modificare configurazioni, utenti, orari, sale, limiti e prenotazioni.

Per orari settimanali, capacità e cutoff M9-C ricalcola l'impatto dentro la transazione e rifiuta una conferma obsoleta con `IMPACT_CHANGED`. Il riepilogo espone soltanto conteggi, coperti e classificazioni operative, senza PII o identificativi di prenotazione.

Non esiste registrazione pubblica. M9-B implementa la gestione utenti riservata all'Admin: account individuali Admin/Staff, username normalizzato e immutabile, password temporanee casuali da 24 caratteri mostrate una sola volta, cambio obbligatorio al primo accesso e revoca di tutte le sessioni dopo reset, cambio password, variazione ruolo o disabilitazione. Deve rimanere sempre almeno un Admin attivo per ristorante; nessun utente viene eliminato fisicamente.

Le password scelte dall'utente contengono da 15 a 128 code point Unicode, possono includere spazi e caratteri Unicode stampabili e non subiscono trim, troncamento o regole di composizione. Sono rifiutati caratteri di controllo, password comuni/demo, username equivalente senza distinzione tra maiuscole e minuscole e riuso della password corrente.

M9-E rende amministrabili telefono pubblico, URL canonico HTTPS, email facoltativa, numero WhatsApp facoltativo e sette contenuti editoriali completi per `IT` ed `EN`: titolo e introduzione della prenotazione, indisponibilità, invito al contatto, conferma, titolo e introduzione della pagina personale. Etichette, validazioni ed errori tecnici restano nel codice; non esiste un archivio libero di HTML, URL editoriali o chiavi arbitrarie. La lingua usa `lang=it|en`, con fallback italiano e senza cookie.

La durata del link personale è un intero da 1 a 24 ore e una modifica vale soltanto per i nuovi token. Token e hash esistenti non vengono aggiornati o rigenerati. Se una prenotazione pubblica viene spostata dal cliente o dallo Staff, la scadenza viene ricalcolata con la durata originaria esatta del token; uno stato legacy incoerente causa rollback.

M9-F riserva all'Admin la consultazione read-only unificata dell'audit prenotazioni e amministrativo. Periodo locale, sorgente, categoria, azione, esito, attore, tipo/ID entità e correlation ID sono filtri server-side; ordinamento e paginazione sono deterministici e cursor-based. Il dettaglio mostra solo campi operativi allow-listed, mai raw JSON, PII, contatti, contenuti editoriali, HMAC, credenziali, token o hash. Ogni sorgente è filtrata sul ristorante della sessione prima dell'unione e la consultazione non genera audit.



### Staff



Può consultare, inserire, modificare, annullare, assegnare sala e tavolo, stampare ed esportare.



La dashboard deve aprirsi sul giorno corrente e mostrare:



\- prenotazioni totali;

\- coperti totali;

\- coperti per sala;

\- disponibilità residua;

\- richieste alimentari;

\- seggioloni;

\- passeggini;

\- cancellazioni;

\- modifiche recenti;

\- prenotazioni senza tavolo assegnato.



## 13. Tavoli



Nella prima versione il sistema non deve calcolare automaticamente tavoli e combinazioni.

Le sale canoniche sono Sala 1, Sala 2, Sala 3, Galleria e Terrazzo e il loro codice non cambia. I tavoli possono essere creati, aggiornati e disattivati, ma non eliminati fisicamente; per spostare un tavolo si disattiva quello precedente e se ne crea uno nuovo nella sala di destinazione.

M9-D non assegna tavoli alle prenotazioni e non deriva la capacità mobile dalla somma dei posti. Le righe storiche e le preferenze sala restano conservate; una modifica non relativa a data, servizio o sala non deve essere respinta solo perché la preferenza precedente non è più selezionabile.



Il personale assegna alle 17:30:



\- sala definitiva;

\- numero tavolo;

\- eventuali note interne.



La preferenza originale del cliente deve restare visibile.

### Fondazione M10-A

**Estensione corrente T04 Revised:** sulla Foundation A schema15 la sala è obbligatoria e i tavoli sono zero–venti distinti della stessa sala. Questa estensione prevale sulla cardinalità storica M10-A descritta sotto, preservandone i checkpoint. Schema e migration 1–15 invariati, migration16 non richiesta. UNASSIGNED deriva da assignment assente/cleared; ROOM_ONLY da attiva con zero link; ROOM_AND_TABLES da attiva con 1–20 link. Nessun nuovo enum database.

L'Agenda mostra UNASSIGNED con sala DA ASSEGNARE e tavolo —; ROOM_ONLY con sala reale e tavolo DA ASSEGNARE neutro. Room-only conta assigned e nei coperti della sala finale. Summary CONFIRMED: confirmed=assigned+unassigned, unassignedCovers somma solo non assegnate; CANCELLED escluse.

GET/PUT/DELETE canoniche preservano sicurezza, no-store e Reservation.version. PUT include room, table set e note. Il pannello carica tavoli/note persistiti; cambio sala esplicito azzera visibilmente tavoli preservando note. Rimuovi tutti i tavoli cambia solo il form e il PUT salva room-only; Rimuovi assegnazione usa DELETE logico e conserva storia. Una sala senza tavoli configurati non blocca il salvataggio. La copy è Preferenza storica di sala, assente Non specificata, distinta dalla richiesta giochi.

Un desired identico è no-op dopo auth/tenant/CONFIRMED ma prima di versione/nuovi riferimenti anche stale/grandfathered: zero write/timestamp/audit. Due PUT identiche concorrenti producono una write/no-op; differenti hanno un vincitore/conflitto. Audit ASSIGNED/REASSIGNED/UNASSIGNED atomico ammette zero tavoli e allow-list minimale codice sala, UUID/count e presenza note; failure annulla la transazione. Reschedule reale clear logico, cancellazione conserva history e impedisce PUT/DELETE anche identici. Composizione unknown/adulti/bambini, badge SALA GIOCHI RICHIESTA, arrival e raw legacy restano indipendenti. Same-table reuse ammesso; nessuna collision detection, seats capacity, auto-assignment o policy T05.

M10-A, approvata tecnicamente da Work, introduce soltanto persistenza, dominio, servizio applicativo e API Staff/Admin, senza dashboard o altri componenti UI. Ogni prenotazione può avere al massimo una assegnazione logica corrente, separata dalla preferenza originaria. Una assegnazione attiva richiede una sala finale e da uno a venti tavoli distinti appartenenti a quella sala; `DA ASSEGNARE` continua a derivare dall'assenza di assegnazione attiva.

La rimozione è esplicita e logica. Una successiva assegnazione riattiva la stessa entità persistente, preserva l'autore iniziale e registra l'ultimo autore. Non viene eseguito backfill delle prenotazioni e non viene introdotta alcuna relazione con `ServiceInstance`.

I posti minimi e massimi dei tavoli sono informazioni operative restituibili a Staff/Admin, ma non bloccano l'assegnazione e non producono override. Lo stesso tavolo può essere usato manualmente da più prenotazioni dello stesso servizio perché la prima versione non modella durata o occupazione temporale. Non esistono assegnazione automatica, combinazione automatica o collision detection.

Le note dell'assegnazione sono interne, facoltative e limitate a 1.000 code point. Non compaiono nelle API pubbliche, nel link personale o nell'audit; quest'ultimo conserva soltanto la presenza delle note, il codice sala finale e gli UUID tavolo ordinati.

Staff e Admin possono assegnare e correggere prenotazioni confermate, incluse quelle storiche. Per servizi correnti o futuri una nuova sala deve essere attiva e disponibile per data/servizio e i nuovi tavoli devono essere attivi e coerenti. Per lo storico si verificano stato attivo e appartenenza, senza ricostruire la disponibilità non versionata e senza materializzare istanze. Riferimenti già assegnati restano visibili e possono essere conservati se diventano inattivi o indisponibili; ogni riferimento nuovo deve essere attivo.

Le mutazioni incrementano la versione della prenotazione soltanto quando lo stato cambia e producono audit atomico `ASSIGNED`, `REASSIGNED` o `UNASSIGNED`. Un payload invariato e una rimozione già effettuata sono no-op.

### Integrazione lifecycle M10-B

Una modifica effettiva di data, servizio o orario rimuove logicamente l'assegnazione attiva nella stessa transazione del reschedule, senza un secondo incremento di versione. L'audit ordinario `UPDATED` e l'evento `UNASSIGNED` condividono correlation ID; quest'ultimo usa la motivazione canonica `RESERVATION_SCHEDULE_CHANGED` e la proiezione minimizzata. Se l'assegnazione è già assente non viene creata alcuna riga o audit aggiuntivo. Persone, preferenza, contatti, esigenze e note conservano integralmente l'assegnazione.

La cancellazione Staff o pubblica conserva l'ultima assegnazione, inclusi tavoli e note interne, senza valorizzare `clearedAt` e senza produrre `UNASSIGNED`; la prenotazione cancellata è però esclusa dagli impatti operativi e i dati di assegnazione non entrano nelle risposte pubbliche.

Disattivazione globale di una sala, disattivazione di un tavolo e indisponibilità della sala per data/servizio includono nel protocollo M9-D le sole prenotazioni confermate correnti o future con assegnazione attiva pertinente. La preview espone soltanto conteggi e classificazioni, richiede conferma quando necessario e usa un fingerprint opaco ricalcolato nella transazione. La configurazione applicata preserva le assegnazioni come grandfathered; prenotazioni cancellate, storiche, assegnazioni rimosse e altri tenant non partecipano all'impatto.

M10-A e M10-B sono state merged su `main` con la PR #11. M10-C, approvata da Work e merged su `main` con la PR #12, completa la superficie operativa Staff/Admin: la dashboard distingue preferenza e sala definitiva, deriva `DA ASSEGNARE`, filtra per stato e sala finale, calcola i coperti sulle assegnazioni attive e usa le API M10-A per assegnazione, riassegnazione e clear. Con questa chiusura M10 è completata e merged su `main`; M11 è stata successivamente approvata da Work e squash-merged su `main` con la PR #14. M12 è stata successivamente approvata da Work e squash-merged su `main` con la PR #16. M13 FASE A è merged con la PR #18; la riconciliazione post-corrective è in corso, mentre FASE C e la validazione remota staging non sono iniziate.



## 14. PDF



M11 genera on demand un PDF A4 landscape per una sola data locale. Include entrambi i servizi, esclusivamente prenotazioni `CONFIRMED`, e non è influenzato dai filtri dashboard diversi dalla data. Il documento deve essere diviso nel seguente ordine:



1\. `DA ASSEGNARE`;

2\. Sala 1;

3\. Sala 2;

4\. Sala 3;

5\. Galleria;

6\. Terrazzo.



Tutte le sezioni compaiono anche quando sono vuote. `DA ASSEGNARE` comprende assegnazioni assenti o rimosse logicamente; un'assegnazione attiva resta valida nell'export anche quando sala o tavoli sono stati successivamente disattivati o resi indisponibili. All'interno di ogni sezione, ordinare le prenotazioni dalla più vecchia alla più recente in base al momento di prenotazione e usare l'ID come tie-breaker deterministico.



La riga principale contiene servizio, ora di arrivo, nome e cognome, persone, telefono, preferenza di sala, sala definitiva, tavoli definitivi e momento di creazione. I dettagli includono esigenze alimentari e operative, ricorrenza, note prenotazione e note interne dell'assegnazione. Preferenza del cliente e collocazione definitiva restano sempre distinte. Email, identificativi, token, hash, consensi, override e dati audit sono esclusi.

Il PDF è multipagina, ripete sezione e intestazioni tabella dopo un page break, applica wrapping ai testi lunghi e mostra il numero pagina. Una giornata vuota restituisce comunque HTTP 200 e un PDF valido con tutte le sei sezioni.



## 15. Excel



PostgreSQL rimane la fonte ufficiale.



M11 genera file `.xlsx` on demand nelle modalità `DAY`, `MONTH` e `RANGE`, esclusivamente dalle prenotazioni `CONFIRMED`. Il sistema esporta:



\- un foglio `YYYY-MM-DD` per ogni giornata richiesta, anche vuota;

\- un solo giorno per `DAY`;

\- tutti i giorni calendario del mese per `MONTH`;

\- un intervallo inclusivo di massimo 31 giorni calendario per `RANGE`.

I fogli sono ordinati cronologicamente. Ogni foglio ha esattamente 24 colonne operative: data, servizio, ora arrivo, anagrafica essenziale, persone, telefono, origine, preferenza, stato assegnazione, sala/tavoli finali, esigenze, note e creazione. Data, ora e data/ora sono celle Excel tipizzate; l'intestazione è bloccata, filtrabile e dotata di larghezze esplicite.

I valori controllabili dall'utente che iniziano con `=`, `+`, `-`, `@`, tab, carriage return o line feed vengono neutralizzati come stringhe. Il workbook non contiene formule, hyperlink, collegamenti esterni, macro o celle unite.



La dashboard web resta lo strumento principale e unico per modificare i dati. PostgreSQL resta la fonte ufficiale; PDF e Excel non sono persistiti sul server e non sono reimportabili.



## 16. Lingue e grafica



Lingue:



\- italiano;

\- inglese.



Grafica:



\- moderna;

\- coordinata con il sito Piccadilly;

\- nero;

\- bianco;

\- arancione;

\- grigio chiaro;

\- nessuna fotografia nella prima versione;

\- logo inserito successivamente.



## 17. Sicurezza



Requisiti minimi:



\- HTTPS;

\- autenticazione staff;

\- password protette;

\- ruoli e permessi;

\- validazione server-side;

\- rate limiting;

\- protezione delle route amministrative;

\- token pubblici casuali;

\- audit log;

\- backup;

\- nessun segreto nel repository;

\- dati sensibili ridotti al minimo.



## 18. Ambienti



### Sviluppo locale



\- computer dello sviluppatore;

\- PostgreSQL tramite Docker;

\- dati fittizi;

\- notifiche simulate.



### Staging personale



\- Render personale;

\- database di prova;

\- dati fittizi;

\- nessun collegamento al sito ufficiale.



### Produzione



\- account del ristorante;

\- database nuovo;

\- dominio `prenota.ristopizzapiccadilly.it`;

\- WhatsApp del ristorante;

\- email del ristorante;

\- backup reali.



## 19. Proprietà finale



Il codice finale sarà proprietà del ristorante.



GitHub, Render, Meta, dominio, email e database di produzione saranno intestati al ristorante.



Il progetto deve poter continuare a funzionare senza dipendere dagli account personali dello sviluppatore.



## 20. Ordine delle milestone



La numerazione ufficiale è quella di `docs/ROADMAP.md`:

0\. documentazione e decisioni architetturali;

1\. fondamenta Next.js;

2\. PostgreSQL e Prisma;

3\. autenticazione e autorizzazione;

4\. configurazione del ristorante e calendario;

5\. motore prenotazioni e concorrenza;

6\. prenotazione pubblica;

7\. pagina personale;

8\. dashboard e prenotazioni telefoniche;

9\. pannello amministratore;

10\. assegnazione manuale di sala e tavoli;

11\. esportazioni PDF ed Excel;

12\. outbox e provider simulati;

13\. staging personale;

14\. provider reali;

15\. produzione, backup e consegna.

## T06-B — Agenda, dettaglio e bozze Staff (contratto congelato 16 ottobre 2026)

T06-A e T06-SEC sono chiuse sulla baseline main aa6e5aca21741b448cbcf85e7f39096f3c75f928. T06-B è autorizzata soltanto per sviluppo locale e Quality Gate indipendente. Pubblicazione Git, deploy e operazioni sul database persistente richiedono mandati separati. T06-C/D restano escluse.

L’Agenda mantiene coperti totali, orario, stato, Arrival, assegnazione, esigenze dichiarate, ricerca, quattro ordinamenti, filtri e conteggi. La composizione esplicita zero è TA; un conteggio positivo è Bimbi (N), inclusi nei coperti. Unknown e legacy bambini senza conteggio non diventano zero. NC condivise, NI autonome e legacy ACTIVE/CLEARED hanno indicatori distinti; nessun testo NI entra nel read model della lista.

Il dettaglio /dashboard/reservations/{UUID} ha un guard SSR proprio Staff/Admin e tenant. Dall’Agenda si apre un drawer da1024 CSSpx; sotto1024 si apre la pagina. La pagina resta disponibile anche da desktop. La superficie è fissata all’apertura, con un core comune: il resize non naviga né rimonta l’editor. Le sezioni lette separatamente non sono presentate come snapshot atomico; metadata mancanti non sono inventati.

PHONE preserva payload, consenso, notifiche, Idempotency-Key, replay e retry. Nessuna NI nel POST iniziale. La conferma conserva i valori correnti e usa l’ID reale per Apri dettaglio e il collegamento Torna Agenda. Staff Edit conserva tutti i campi, NC comprese, e torna all’Agenda originaria dopo successo o no-op riconosciuto. Il reschedule offre un link esplicito alla nuova destinazione senza salto automatico; l’auto-unassignment resta server-side. Errori e409 conservano la bozza e non producono navigazione di successo.

NI usa il suo endpoint Staff autorizzato e un editor unico. NC passa da Staff Edit. Le note legacy restano separate. CANCELLED è read-only per NC, NI e assignment; Arrival T03 conserva i guard già approvati.

Le bozze PHONE/Edit/NI sono esclusivamente RAM client, segregate per tenant, attore, binding di sessione, tipo e risorsa. Link e chiusure controllate offrono Resta, Esci conservando, Scarta selettivamente. Back/Forward nativi completano la transizione: il recupero è esplicito e richiede nuova autorizzazione. Nessuna promessa di recupero dopo reload, chiusura o navigazione documentale completa. Non esistono autosave o persistenza delle bozze.

## T06-C — ASSEGNA SALA (implementazione locale autorizzata)
Baseline a178d32ee61de68846f2f66a8e35b85454c890e7, schema16. Questo checkpoint supera soltanto i precedenti rinvii di T06-C; T06-D e deploy restano esclusi.

Il workspace /dashboard/assign-room espone data, singolo servizio, vista tutte le sale e vista singola sala. Selezione prenotazione → + sulla sala → conferma esplicita server. Sala1/Sala2/Sala3 — Giochi sono principali; Galleria/Terrazzo separate conservano EXPLICIT_ONLY. Conteggi CONFIRMED e coperti sono informativi, senza capacità per sala o tavoli digitali. CANCELLED esclusa dai totali; correzioni storiche secondo M10/T04.

Le righe compatte preservano nome, coperti, ora, TA/Bimbi/unknown, esigenze dichiarate e indicatori NC/NI autonome/legacy ACTIVE/CLEARED. Nessun testo NI nel read model della lista. Consultazione nel dettaglio Staff autorizzato T06-B, senza duplicare editor. Nessuna attribuzione materiale delle NC.

Tre ordini crescenti: ora di arrivo (arrivalTime), creazione prenotazione, ingresso dimostrabile nella sala corrente dall'audit. Assignment.createdAt/updatedAt non sono fallback. Cronologia assente, ambigua o incoerente → null e "Momento di assegnazione non disponibile". Nessun assignedAt persistito, backfill o migration17.

Il nuovo POST room-assignment modifica soltanto la sala: stessa sala attiva no-op anche stale; cambio senza link consentito; active/cleared con link incompatibili bloccati; cleared senza link riattivabile preservando note e autore iniziale. Guard status e data/servizio attesi precedono il no-op. PUT/DELETE legacy restano canonici per operazioni deliberate; il pannello ordinario non consente tavoli/note legacy/cleanup.

Conflitti richiedono rilettura e scelta esplicita. Errori di rete dopo invio hanno esito incerto. Nessun Undo, auto-assignment, collision detection, capacità sala o navigazione automatica alla destinazione.

## T06-D — Navigazione operativa e hub Admin

La navigazione organizza soltanto funzioni esistenti. Operatività (STAFF/ADMIN): Agenda, Nuova prenotazione telefonica con etichetta breve «Nuova prenotazione», ASSEGNA SALA. Configurazione (ADMIN): Impostazioni operative, Orari settimanali, Date speciali, Sale, Anteprima disponibilità. Comunicazione (ADMIN): Contenuti pubblici IT/EN, Notifiche. Amministrazione (ADMIN): Gestione utenti, Registro audit. Tutte le route canoniche sono conservate; il collegamento Admin apre /admin.

L'hub /admin contiene nove collegamenti nelle tre sezioni Admin, senza nuovi dati business, contatori o form. I form esistenti e le conferme impatto M9 restano invariati. STAFF non vede destinazioni Admin; i guard server di pagina e API rimangono l'autorità sull'accesso.

La shell conserva brand, rail72px, sidebar216px e menu mobile accessibile. La navigazione scorre verticalmente separatamente dalle azioni account. Il breadcrumb è unico, con label statiche senza nomi cliente, NC, NI o UUID visualizzati. Il menu aperto si chiude al passaggio desktop senza navigare o rimontare editor.

Sidebar, menu, hub, breadcrumb e navigazione secondaria usano il guard canonico del root draft host. Aprire il menu non abbandona l'editor; scegliere una destinazione richiede la decisione prevista per bozze attive. Resta conserva il menu e il trigger; navigazione e chiusura avvengono soltanto dopo consenso. PHONE/Edit/NI/ROOM, retained, pending, logout, recovery e Back/Forward mantengono il contratto T06-B/C. Nessun nuovo autosave o storage.

## T08 — Public progressiva (contratto Controller 23 ottobre 2026)
T07 è CLOSED per equivalenza funzionale con Foundation A; nessuna implementazione T07 aggiuntiva. T08 usa tre sezioni sulla stessa pagina: Quando e in quanti, Composizione ed esigenze, Dati e conferma. Le sezioni raggiunte restano accessibili; Note NC direttamente disponibili nelle Esigenze e tramite accesso anticipato, senza superare i gate di conferma. Lingua, resize e ritorno non cancellano valori. Composizione, richiesta giochi non garantita, consensi e autorità server restano canonici.
Esito incerto non significa prenotazione assente: retry esplicito con payload e chiave originali; modifica esplicita preceduta da avviso. Management limitato a OBS01: cambio lingua non rilegge né sostituisce la bozza. Nessun redesign generale, nuova API o mutation persistente autorizzata.

## T09 — Export: selezione e anteprima operativa (contratto Controller 29 ottobre 2026)

T09 implementa localmente la fondazione export e la preview HTML; il redesign PDF T10 e quello Excel T11 restano esclusi. La preview rappresenta dati operativi e non è WYSIWYG. I quattro download M11 sono disponibili in un'area distinta e non applicano i filtri o l'ordinamento della preview.

Data iniziale uguale all'Agenda, poi indipendente; servizio Pranzo/Cena scelto esplicitamente, sala TUTTO, ordine creazione crescente. Nessuna lettura automatica prima di servizio e azione esplicita. Il profilo PDF/Excel determina soltanto il cap di selezione, non genera documenti V2. Il raggruppamento è per sala effettiva: DA ASSEGNARE, Sala 1, Sala 2, Sala 3 — Giochi e, quando pertinenti, Galleria/Terrazzo come Area legacy. I tre ordini creazione, cognome/nome e arrivo si applicano dentro ciascun gruppo con tie-breaker deterministici. Preferenza cliente e richiesta Giochi non costituiscono assegnazione.

Solo CONFIRMED, tenant e giorno/servizio richiesti. Assignment assente/cleared è non assegnato; room-only e riferimenti attivi grandfathered restano validi. Nessuna riclassificazione di codici sconosciuti: la preview fallisce senza dataset parziale. Coperti totali, childrenCount e gameRoomPreference sono autorevoli; unknown non diventa zero, legacy children senza numero resta esplicito e i totali composizione noti sono dichiarati parziali. NC/esigenze sono ammesse nel contesto Staff; NI autonome/legacy, telefono ed email sono esclusi dalla query/proiezione preview. La policy T06-A continua a escludere tutte le NI dai file M11, con W vuota.

POST /api/staff/exports/preview accetta soltanto V2 strict DAY con servizio, sala e ordine espliciti; binding della sessione obbligatorio e nessun fallback headerless. Le letture sono fresche, con timestamp e avviso: richieste separate non promettono identità temporale. La sola preview non genera audit di download, non modifica business o outbox e non introduce persistenza. PDF/Excel M11, periodi, formati, filename, privacy e audit restano canonici; i cap vengono anticipati senza cambiarne le soglie.


## T10 — PDF operativo V2 (Controller CLASSIC, 30 ottobre 2026)

T09 è CLOSED sulla baseline main `2242cef809f41529906b7a03ab81db7305c4691b`. T10 è autorizzata esclusivamente per implementazione locale e Quality Gate indipendente WORK3. I checkpoint storici precedenti restano evidenze del loro momento; non autorizzano pubblicazione o deploy.

Il nuovo pulsante Scarica PDF operativo usa la selezione T09 con profilo PDF, giorno, servizio esplicito, sala effettiva e ordinamento interno canonico. POST `/api/staff/exports/pdf-v2` effettua una lettura fresca server-side indipendente dalla preview. Entrambi condividono filtri, gruppi e tie-breaker, senza garantire lo stesso snapshot temporale. Il browser invia soltanto la selezione strict V2.

A4 portrait, margini 12 mm, nero su bianco, sette colonne: Nome e cognome, Coperti, Sala, Tavolo, Arrivo, Note/richieste, Prenotata il. Corpo obiettivo 10,5 pt, coperti 14 pt, righe almeno 20 mm e area penna almeno 18 × 12 mm. C03 definitiva: Tavolo interamente vuota; nessun tavolo digitale nel DTO PDF o nelle celle. La sala effettiva rimane visibile. Database, preview e PDF/Excel legacy conservano i riferimenti digitali.

Righe misurate prima del disegno, altezza dinamica, continuazioni esplicite con riferimento locale di riga, sezione e intestazioni ripetute, footer Pagina N. Nessun limite fisso di pagine, troncamento o riduzione automatica dei caratteri. Sezioni vuote secondo T09, non secondo le sei sezioni sempre presenti del PDF M11.

partySize, childrenCount e gameRoomPreference restano autorevoli: TA per zero bambini noto, adulti/bambini numerici quando noti, ? per composizione sconosciuta. Il flag storico bambini senza conteggio resta esplicito; richieste Giochi e preferenza storica non costituiscono assegnazione. Totali di composizione parziali quando esistono unknown. NC autorizzate conservate senza redazione automatica. NI autonome/legacy e contatti strutturati esclusi dalla query V2; una NC può contenere un contatto digitato liberamente.

M11 PDF DAY ed Excel DAY/MONTH/RANGE restano invariati, inclusi privacy T06-A, telefono legacy, W vuota, formule sicure, filename, audit e limiti. Excel V2/T11 non autorizzata.
