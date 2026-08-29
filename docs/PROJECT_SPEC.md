# Piccadilly Booking — Specifiche funzionali



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

M10-A e M10-B sono state merged su `main` con la PR #11. M10-C, approvata da Work e merged su `main` con la PR #12, completa la superficie operativa Staff/Admin: la dashboard distingue preferenza e sala definitiva, deriva `DA ASSEGNARE`, filtra per stato e sala finale, calcola i coperti sulle assegnazioni attive e usa le API M10-A per assegnazione, riassegnazione e clear. Con questa chiusura M10 è completata e merged su `main`; M11 è stata successivamente approvata da Work e squash-merged su `main` con la PR #14. M12 è implementata nel working tree ed è in attesa di Quality Gate Work.



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
