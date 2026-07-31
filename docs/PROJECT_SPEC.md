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

\- intervallo degli slot;

\- sale disponibili;

\- limite di coperti;

\- orario di chiusura delle prenotazioni.



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



Il valore deve essere modificabile dall'amministratore.



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



## 10. WhatsApp



Verrà acquistato un nuovo numero dedicato.



Messaggi previsti:



1\. conferma della prenotazione;

2\. conferma della modifica;

3\. conferma dell'annullamento;

4\. promemoria tre ore prima.



Se la prenotazione viene effettuata quando mancano meno di tre ore, non deve essere inviato il promemoria.



Durante lo sviluppo utilizzare un provider WhatsApp simulato.



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



Deve essere presente un'opzione per inviare o non inviare la conferma WhatsApp.



## 12. Dashboard



Dispositivi:



\- PC;

\- tablet;

\- smartphone.



Ruoli:



### Admin



Può modificare configurazioni, utenti, orari, sale, limiti e prenotazioni.



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



Il personale assegna alle 17:30:



\- sala definitiva;

\- numero tavolo;

\- eventuali note interne.



La preferenza originale del cliente deve restare visibile.



## 14. PDF



Il PDF A4 deve essere diviso nel seguente ordine:



1\. Sala 1;

2\. Sala 2;

3\. Sala 3;

4\. Galleria;

5\. Terrazzo.



All'interno di ogni sala, ordinare le prenotazioni dalla più vecchia alla più recente in base al momento di prenotazione.



Colonne:



\- nome;

\- cognome;

\- numero ospiti;

\- ora di arrivo;

\- sala;

\- data e ora della prenotazione;

\- note;

\- telefono.



## 15. Excel



PostgreSQL rimane la fonte ufficiale.



Il sistema deve poter esportare un file `.xlsx` con:



\- un foglio per ogni giornata;

\- giorno corrente facilmente raggiungibile;

\- dati consultabili;

\- possibilità di scaricare una singola giornata.



La dashboard web deve restare lo strumento principale per modificare i dati.



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



1\. documentazione e architettura;

2\. fondamenta Next.js;

3\. database;

4\. autenticazione;

5\. configurazione ristorante;

6\. prenotazione pubblica;

7\. pagina personale;

8\. dashboard;

9\. PDF ed Excel;

10\. WhatsApp;

11\. staging;

12\. test;

13\. produzione e consegna.
