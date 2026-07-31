# Piccadilly Booking — Sicurezza

**Stato:** strategia approvata per lo sviluppo iniziale
**Data:** 31 luglio 2026
**Ambito:** requisiti e controlli; infrastruttura definitiva non ancora implementata

## 1. Obiettivi

- Proteggere dati personali e operativi.
- Garantire che soltanto utenti autorizzati accedano alla dashboard.
- Rendere impraticabile la previsione dei link pubblici.
- Impedire che errori o abusi compromettano le prenotazioni.
- Mantenere audit sufficiente a ricostruire le operazioni.
- Non dipendere da segreti o account personali.
- Progettare la produzione per RPO massimo 15 minuti e RTO massimo 4 ore.

## 2. Modello delle minacce iniziale

Minacce principali:

- accesso non autorizzato alla dashboard;
- furto o riuso di sessioni;
- enumerazione dei link personali;
- abuso del modulo pubblico e saturazione delle disponibilità;
- race condition sulla capacità;
- esposizione di telefono, email, allergie o note;
- dati sensibili nei log o nelle esportazioni;
- modifica non autorizzata delle configurazioni;
- perdita o corruzione del database;
- segreti inclusi nel repository;
- invii di test verso clienti reali;
- compromissione o indisponibilità dei provider esterni.

## 3. Autenticazione

### 3.1 Account

- Non esiste registrazione pubblica.
- Gli account sono creati e gestiti dall'Admin.
- Ogni account ha identità individuale; sono vietati account Staff condivisi.
- Gli account possono essere disabilitati senza eliminare l'audit storico.
- Login, logout, fallimenti rilevanti e modifiche account sono registrati.

### 3.2 Password

- Le password non vengono mai salvate o registrate in chiaro.
- L'algoritmo preferito è Argon2id con salt univoco.
- I parametri vengono calibrati sull'ambiente di produzione e documentati.
- La verifica usa la libreria scelta nella milestone autenticazione.
- È previsto l'aggiornamento dei parametri al login quando diventano obsoleti.
- Password temporanee richiedono cambio al primo accesso, se adottate.

### 3.3 Sessioni

- Sessioni revocabili conservate in PostgreSQL.
- Identificativo casuale ad alta entropia.
- Cookie HttpOnly.
- Cookie Secure in staging HTTPS e produzione; l'eccezione locale è limitata a localhost HTTP.
- SameSite `Strict` o `Lax` soltanto dopo motivazione documentata.
- Prefisso cookie `__Host-` in produzione, `Path=/` e nessun attributo `Domain`.
- Scadenza inattiva e assoluta configurate.
- Rotazione dell'identificativo dopo login e variazione privilegi.
- Nessun token di sessione in `localStorage` o `sessionStorage`.
- Protezione CSRF e verifica dell'origine per le mutazioni autenticate.

La libreria concreta di autenticazione è reversibile, ma deve rispettare questi requisiti.

## 4. Autorizzazione

### Admin

Può:

- gestire utenti e ruoli;
- modificare configurazioni, orari, cutoff, sale e limiti;
- gestire prenotazioni;
- effettuare override con motivazione;
- assegnare tavoli;
- esportare;
- consultare l'audit.

### Staff

Può:

- consultare la dashboard;
- inserire, modificare e cancellare prenotazioni;
- effettuare override con motivazione;
- assegnare sala e tavoli;
- esportare PDF ed Excel.

Non può modificare utenti o configurazioni amministrative.

### Applicazione dei permessi

- La UI può nascondere azioni non disponibili, ma non costituisce controllo di sicurezza.
- Ogni Route Handler, Server Action e caso d'uso verifica l'autorizzazione.
- Le query restituiscono soltanto i campi necessari.
- Le operazioni Admin producono sempre audit.
- Le sessioni vengono ricontrollate nel database per le operazioni sensibili.

## 5. Token pubblico delle prenotazioni

- Generazione crittograficamente sicura di 32 byte.
- Codifica URL-safe.
- Nel database viene salvato soltanto l'hash del token.
- Il token non contiene ID progressivi o dati della prenotazione.
- Il confronto usa una rappresentazione canonica e non registra il token.
- Il link permette azioni soltanto fino al cutoff configurato:
  - pranzo inizialmente 10:30;
  - cena inizialmente 17:30.
- Dopo il cutoff la pagina resta consultabile in sola lettura.
- Il link scade inizialmente 24 ore dopo l'orario prenotato; la durata è configurabile.
- Token scaduti, revocati o inesistenti non devono rivelare quale condizione si è verificata.
- La pagina usa `noindex`, `Cache-Control: no-store` e una Referrer Policy restrittiva.
- Token e URL personali vengono esclusi da log, analytics e sistemi di tracciamento.

## 6. API pubbliche e rate limiting

Il rate limiting si applica almeno a:

- ricerca disponibilità;
- creazione prenotazione;
- accesso e mutazioni tramite token;
- login.

Strategia iniziale:

- bucket atomici in PostgreSQL;
- chiavi derivate da endpoint e indirizzo IP normalizzato;
- eventuale uso di hash di telefono o token senza conservarli nei contatori;
- limiti separati per letture e mutazioni;
- scadenza e pulizia dei bucket;
- corretta configurazione dei proxy fidati;
- risposte che non espongono dettagli interni.

Il CAPTCHA non è inizialmente obbligatorio. Può essere aggiunto se il rate limiting e i controlli anti-automazione leggeri non sono sufficienti.

## 7. Validazione e sicurezza applicativa

- Zod valida tutti gli input sul server.
- Le validazioni client migliorano soltanto l'usabilità.
- Le stringhe vengono limitate in lunghezza.
- Email e telefono vengono normalizzati senza assumere che la normalizzazione dimostri l'identità.
- Date, slot, sale e servizi vengono verificati contro la configurazione corrente.
- Modifiche a data, ora o coperti ricontrollano la capacità.
- L'idempotenza evita doppi inserimenti.
- Le transazioni e i lock impediscono il superamento concorrente della capacità.
- Gli errori pubblici non includono stack trace, query o identificativi interni.
- Le dipendenze vengono fissate a versioni determinate e controllate prima dell'installazione.

## 8. Dati personali

### Dati trattati

- nome e cognome;
- telefono;
- email facoltativa;
- informazioni sulla prenotazione;
- esigenze logistiche;
- allergie, intolleranze, celiachia e accessibilità;
- note libere;
- consensi e relativa provenienza.

Alcune esigenze possono rivelare informazioni particolarmente sensibili. Devono essere applicati minimizzazione, accesso limitato e conservazione proporzionata.

### Principi

- Non viene creato un CRM implicito.
- I dati sono raccolti per gestire la singola prenotazione.
- Le schermate e i DTO espongono soltanto i campi necessari.
- I log tecnici non contengono PII, token o testo completo delle note.
- Le esportazioni sono accessibili solo a Staff/Admin.
- I file vengono generati su richiesta e non conservati permanentemente sul server.
- Le politiche di conservazione devono essere approvate prima della produzione.
- Cancellazione o anonimizzazione per obblighi privacy non deve distruggere indebitamente l'audit necessario; la regola concreta richiede approvazione legale e operativa.

### Consensi

Il consenso non è un semplice booleano in `reservations`. Si conserva:

- tipo di informativa o condizione;
- versione;
- lingua;
- modalità di acquisizione;
- data e ora;
- origine;
- utente che lo ha raccolto quando telefonico.

Per le prenotazioni telefoniche sono obbligatori origine `PHONE`, consenso verbale, versione, data/ora e utente Staff/Admin.

## 9. Audit log

L'audit è append-only a livello applicativo e registra almeno:

- creazione, modifica e cancellazione;
- valori precedenti e nuovi per le modifiche;
- origine pubblica, telefonica o amministrativa;
- attore e ruolo;
- override e motivazione;
- assegnazioni e riassegnazioni;
- cambi configurazione;
- utenti e ruoli;
- esportazioni;
- eventi e tentativi di notifica rilevanti.

Ogni evento include timestamp UTC, tipo entità, identificativo, azione e correlation ID. L'accesso alla consultazione dell'audit è riservato all'Admin.

L'audit non deve duplicare indiscriminatamente dati sensibili. La necessità di conservare prima/dopo va bilanciata con minimizzazione e retention; i campi più delicati richiedono accesso ristretto.

## 10. Segreti e configurazione

- `.env` e varianti con segreti sono esclusi da Git.
- `.env.example` contiene soltanto valori fittizi.
- Produzione e staging usano secret store separati.
- Nessun segreto Meta, email, database o sessione viene incluso nel repository.
- I segreti hanno proprietario, scopo e procedura di rotazione.
- Le credenziali personali dello sviluppatore non diventano dipendenze permanenti.
- Telefono, dominio, email, numero WhatsApp, testi e durata link sono configurazioni, non segreti hardcoded.
- Le configurazioni operative dell'Admin sono in PostgreSQL; i segreti dei provider restano nell'ambiente.

## 11. Notifiche

- Sviluppo e staging usano esclusivamente mock.
- Un kill switch impedisce di selezionare provider reali fuori produzione.
- WhatsApp usa in produzione soltanto Meta Cloud API ufficiale.
- Nessuna automazione WhatsApp Web.
- L'email è facoltativa e può essere fallback o parallela.
- Il gruppo WhatsApp è opzionale e non è una dipendenza del flusso interno.
- L'outbox viene salvata nella stessa transazione dell'evento di business.
- Il worker invia dopo il commit.
- Retry idempotenti evitano duplicati.
- Payload e log vengono minimizzati.
- Un errore permanente viene mostrato alla dashboard senza invalidare la prenotazione.

## 12. Esportazioni

- Solo Staff e Admin possono esportare.
- PDF ed Excel contengono dati personali e usano HTTPS e `no-store`.
- I nomi file non contengono dati personali.
- Nessun file permanente viene lasciato sul filesystem del server.
- L'audit registra utente, tipo, periodo e momento dell'esportazione, non il contenuto completo.
- Le formule Excel provenienti da input utente devono essere neutralizzate per prevenire formula injection.
- I limiti massimi dell'intervallo esportabile saranno definiti prima di M11.

## 13. Logging e osservabilità

- Log strutturati con correlation ID.
- Nessun nome, telefono, email, token, allergia o nota libera nei log.
- Errori tecnici classificati senza includere query complete con parametri sensibili.
- Metriche iniziali: errori, latenza, transazioni fallite, retry, coda outbox, login falliti e backup.
- Alert di produzione per indisponibilità, crescita outbox e fallimenti backup.
- Accesso ai log limitato e soggetto a retention.

## 14. Ambienti

### Locale

- dati fittizi;
- database Docker locale;
- segreti locali non tracciati;
- provider mock.

### Staging personale

- dati fittizi;
- database separato;
- provider mock obbligatori;
- nessun backup o dump di produzione;
- nessun collegamento al sito ufficiale.

### Produzione

- account intestati al ristorante;
- database nuovo;
- segreti propri;
- provider ufficiali;
- backup e monitoraggio;
- principio del minimo privilegio.

## 15. Backup, RPO e RTO

### Obiettivi approvati

- **RPO massimo 15 minuti:** in un incidente non devono andare persi più di 15 minuti di dati confermati.
- **RTO massimo 4 ore:** il servizio deve poter essere ripristinato entro quattro ore dall'attivazione della procedura di disaster recovery.

### Requisiti di progettazione

- backup automatici e cifrati;
- soluzione compatibile con point-in-time recovery o meccanismo equivalente entro 15 minuti;
- conservazione su infrastruttura del ristorante o contrattualmente trasferibile;
- controllo automatico dell'esito dei backup;
- runbook di ripristino;
- inventario di database, applicazione, segreti, dominio e provider;
- prova periodica di restore su ambiente isolato e autorizzato;
- misurazione reale del tempo di ripristino;
- documentazione delle dipendenze esterne che possono impedire l'RTO.

### Stato corrente

Gli obiettivi sono documentati ma l'infrastruttura definitiva non è ancora selezionata o implementata. Provider, frequenza concreta, retention e procedura di restore saranno definiti nella milestone produzione.

## 16. Verifiche di sicurezza obbligatorie

- test autorizzazioni Admin/Staff;
- accesso diretto agli endpoint protetti;
- token valido, invalido, revocato e scaduto;
- cookie e sessioni;
- CSRF;
- rate limiting;
- idempotenza;
- concorrenza della capacità;
- redazione log;
- formula injection Excel;
- assenza di provider reali in staging;
- dipendenze vulnerabili;
- backup e restore prima della produzione.

## 17. Punti da completare prima della produzione

- approvazione legale dei testi e delle versioni privacy;
- politica di conservazione e anonimizzazione;
- parametri definitivi di Argon2id e sessione;
- soglie di rate limiting;
- provider backup e point-in-time recovery;
- retention backup e audit;
- runbook incidenti e contatti;
- prova documentata di RPO/RTO;
- verifica delle API ufficiali Meta disponibili;
- scelta e valutazione del provider email.
