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
- Gli account non vengono eliminati fisicamente.
- Deve esistere sempre almeno un Admin attivo per ristorante: sono vietate auto-disabilitazione, auto-retrocessione e disabilitazione o retrocessione dell'ultimo Admin; il controllo è transazionale e sicuro rispetto alla concorrenza.
- Login, logout, fallimenti rilevanti e modifiche account sono registrati.

### 3.2 Password

- Le password non vengono mai salvate o registrate in chiaro.
- L'algoritmo preferito è Argon2id con salt univoco.
- I parametri vengono calibrati sull'ambiente di produzione e documentati.
- La verifica usa la libreria scelta nella milestone autenticazione.
- È previsto l'aggiornamento dei parametri al login quando diventano obsoleti.
- Creazione e reset generano sul server una password temporanea casuale, mostrata all'Admin una sola volta e comunicata esternamente, mai tramite email o WhatsApp.
- Nel database resta soltanto l'hash Argon2id e `mustChangePassword`; le funzioni operative sono bloccate fino al cambio.
- Reset e cambio password revocano tutte le sessioni e richiedono una nuova autenticazione; la password esistente non è leggibile.
- Le password scelte dall'utente hanno lunghezza da 15 a 128 code point Unicode. Non vengono troncate, sottoposte a trim o vincoli di composizione; spazi e Unicode stampabile sono ammessi, mentre caratteri di controllo, password comuni/demo, username equivalente e password corrente sono rifiutati.
- La password temporanea contiene 24 caratteri URL-safe derivati da 18 byte CSPRNG. Compare soltanto nella risposta one-shot `no-store`: mai in database, audit, log, URL o cookie.
- Il blocco `mustChangePassword` è verificato server-side per pagine e API operative; le sole eccezioni autenticate sono cambio password e logout. Le API rispondono uniformemente `PASSWORD_CHANGE_REQUIRED`.
- Il runner browser usa account `e2e.*` dedicati e palesemente fittizi, ripristinati solo dalla preparazione E2E; il seed ordinario non sovrascrive mai password, ruolo, stato o flag degli account esistenti.
- Riferimenti di policy: [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html), [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) e [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Il progetto conserva esattamente la sequenza inserita e non applica la normalizzazione NFC raccomandata da NIST, perché la decisione vincolante M9-B vieta modifiche silenziose della password; la normalizzazione è usata soltanto per confronti anti-username/blocklist.

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
- Ogni token conserva la durata applicata alla creazione. Se la prenotazione viene spostata, la scadenza usa la durata originaria rispetto al nuovo servizio, senza rigenerare il token.
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

`ReservationAuditEvent` resta separato da `AuditEvent`, che copre autenticazione, identità e configurazione. M9-F li unisce soltanto mediante una proiezione applicativa di lettura Admin, senza duplicare o riscrivere eventi. Gli snapshot sono costruiti a whitelist e non contengono nomi, contatti, token, credenziali, sessioni né testi completi di allergie, intolleranze, note o ricorrenze; la motivazione dell'override resta ammessa quando richiesta da D-007. Ogni audit è scritto nella stessa transazione dell'operazione e l'applicazione non espone update o delete del registro.

I fallimenti di login possono essere correlati soltanto con l'impronta HMAC del rate limiter, senza username, indirizzo IP, password, cookie o secret di sessione. Logout, revoca e audit sono atomici.

## 9.1 Sicurezza delle modifiche di configurazione

Le letture e le mutazioni amministrative ricevono l'attore server-side, derivano il ristorante dalla sessione, rileggono ruolo, stato e cambio password obbligatorio e richiedono `ADMIN`; l'interfaccia non è un controllo autorizzativo. Le route JSON M9-C/M9-D/M9-E validano payload Zod strict, stessa origine e risposte `no-store`; `restaurantId`, ruolo e correlation ID non arrivano dal client.

Per impostazioni di prenotazione, servizi settimanali e cutoff pubblici M9-C usa anteprima senza PII o identificativi, conferma esplicita e ricalcolo in una transazione `SERIALIZABLE` protetta da lock advisory stabile per ristorante. Il fingerprint è derivato soltanto dal server e comprende configurazione e prenotazioni future operative rilevanti; una divergenza restituisce `IMPACT_CHANGED` con una nuova anteprima, senza mutazione né audit. Mutazione e audit minimizzato condividono la transazione, mentre un no-op non genera eventi. Nessuna configurazione modifica o cancella automaticamente prenotazioni confermate. Date straordinarie, servizi, sale e tavoli seguono disattivazione o archiviazione reversibile, non cancellazione fisica.

M9-D applica lo stesso confine a disponibilità e lifecycle sale. Il lock per istanza usa ristorante, data e servizio; l'integrità tenant è rinforzata da chiavi esterne composte. Preview obsoleta, letture e no-op non creano istanze. Audit e DTO espongono solo codice sala, stato, data/servizio e conteggi aggregati: mai PII, preferenze complete, note, credenziali, token, IP o user agent.

M9-E usa route distinte per contatti, contenuti e durata. Telefono e WhatsApp richiedono E.164; l'URL è HTTPS canonico senza credenziali, percorso, query o fragment. I contenuti accettano soltanto locale e chiavi in allow-list, rifiutano controlli e URL arbitrari e vengono renderizzati esclusivamente come testo React, senza HTML o Markdown eseguibile. Il tenant deriva sempre dalla sessione o dalla configurazione server-side. L'audit non contiene contatti, URL, testi, token o hash. Una modifica della durata non tocca token esistenti; un reschedule con durata legacy incoerente fallisce atomicamente.

M9-F espone soltanto GET Admin `no-store` e `noindex`. Ruolo, stato, cambio password obbligatorio e tenant vengono riletti dal database; il `restaurantId` è dentro ogni ramo della query unificata. Il cursore keyset è opaco e legato ai filtri, non contiene tenant o dati personali. Il dettaglio applica allow-list positive per azione anche a JSON legacy ostile e non restituisce raw JSON, HMAC, contatti, contenuti, note, token o hash. La consultazione non scrive e non genera audit ricorsivo.

## 9.2 Sicurezza delle assegnazioni manuali M10-A

Le API assegnazione sono riservate a STAFF e ADMIN con sessione verificata, account attivo, `disabledAt` nullo e `mustChangePassword=false`. Il servizio rilegge nella transazione utente, ruolo e tenant; il client non invia `restaurantId`, ruolo, username, actor ID o correlation ID. Le query di prenotazione, assegnazione, sala, tavoli e audit sono tenant-scoped e un ID cross-tenant restituisce lo stesso esito di una risorsa inesistente.

`PUT` e `DELETE` richiedono stessa origine, `application/json` e payload Zod strict. Gli ID tavolo sono UUID distinti, limitati a venti e ordinati deterministicamente; le note interne sono nullable/opzionali, limitate a 1.000 code point e mai pubbliche. Tutte le risposte usano `Cache-Control: no-store`.

Le mutazioni usano `SERIALIZABLE`, retry, lock deterministici e versione ottimistica della prenotazione. Assegnazione e audit specializzato condividono la transazione e un errore audit annulla l'intera scrittura. I no-op non cambiano versione o timestamp e non producono eventi. Gli snapshot `ASSIGNED`, `REASSIGNED` e `UNASSIGNED` includono soltanto codice sala, UUID tavolo, conteggio e flag di presenza delle note: mai testo delle note, etichette libere, PII, contatti, token, sessioni o raw request.

La GET non apre flussi di materializzazione, non crea `ServiceInstance`, non acquisisce lock di scrittura e non genera audit. Le API pubbliche e il link personale non includono assegnazione o note interne.

## 9.3 Sicurezza del lifecycle M10-B

I reschedule Staff e tramite link personale eseguono il clear logico dentro la transazione di modifica già aperta. Soltanto un cambiamento effettivo di data, servizio o orario genera `UNASSIGNED`; l'evento condivide il correlation ID con `UPDATED`, usa la motivazione allow-listed `RESERVATION_SCHEDULE_CHANGED` e non contiene testo delle note, PII, contatti, token, hash o raw request. Un errore in uno dei due audit annulla reschedule, clear e singolo incremento della versione. Le cancellazioni preservano l'assegnazione e non la espongono al cliente.

Le disattivazioni di sale/tavoli e l'indisponibilità per servizio riusano autenticazione Admin, stessa origine, Zod strict, `no-store`, lock configurazione e protocollo M9-D. Preview e audit espongono soltanto conteggi aggregati di preferenze e assegnazioni e classificazioni allow-listed, senza ID di prenotazione, tavolo o assegnazione. Il fingerprint è opaco e tenant-scoped; una variazione pertinente restituisce `IMPACT_CHANGED` prima di qualsiasi scrittura o audit. Applicare la configurazione non modifica assegnazioni, tavoli collegati, `clearedAt` o note interne.

L'ordine globale dei lock è prenotazione, configurazione tenant, capacità. I flussi configurazione non acquisiscono lock prenotazione: ricalcolo serializzabile e fingerprint impediscono cicli e stati parziali, mentre il lock configurazione condiviso impedisce a una nuova assegnazione di usare riferimenti divenuti invalidi.

## 9.4 Sicurezza della dashboard M10-C

La dashboard M10-C riceve il tenant esclusivamente dall'utente autenticato riletto server-side. Il read model filtra le prenotazioni per `restaurantId` prima di includere l'assegnazione e proietta soltanto sala finale, nomi dei tavoli e stato dei riferimenti. La presenza delle note deriva da una query tenant-scoped fissa che seleziona esclusivamente `internal_notes IS NOT NULL`, nello stesso snapshot `REPEATABLE READ` della lista: il testo non viene trasferito al processo dashboard e viene letto on demand soltanto dalla GET M10-A per Staff/Admin. Il numero delle query non dipende dalle prenotazioni; le letture di disponibilità restano fisse per pranzo e cena e non materializzano `ServiceInstance`.

Il componente client non riceve tenant, attore o correlation ID, non accede a Prisma e non mantiene uno stato autorevole. PUT e DELETE continuano a usare versione, same-origin e validazione strict delle API M10-A. `VERSION_CONFLICT` non attiva retry automatici: la scelta locale viene respinta, lo stato corrente deve essere ricaricato e l'operatore deve rivalutarlo. Sale o tavoli grandfathered restano visibili, ma le opzioni inattive o indisponibili che non appartengono all'assegnazione corrente sono disabilitate anche nel client; il server resta l'autorità finale.

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

- M12 contiene esclusivamente `SimulatedWhatsAppProvider` e `SimulatedEmailProvider`; non esistono classi, modalità, URL, SDK, segreti o trasporti di provider reali.
- Un gate statico circoscritto al modulo Notifications vieta fetch, HTTP/HTTPS request, SMTP, socket esterne, SDK provider, URL esterni e configurazioni Meta.
- Nessuna automazione WhatsApp Web.
- L'email è facoltativa e può essere fallback o parallela.
- Il gruppo WhatsApp è opzionale e non è una dipendenza del flusso interno.
- L'outbox viene salvata nella stessa transazione dell'evento di business.
- Il worker invia dopo il commit. Ogni call riceve un `AbortSignal` creato server-side e una deadline iniettabile di 30 secondi; timeout e shutdown interrompono bounded l'attesa senza persistere errori raw.
- Il processing è bounded a cinque leg concorrenti e non avvia nuove call dopo lo shutdown. Prima del claim, uno sweep `FOR UPDATE SKIP LOCKED` terminalizza al massimo 100 leg pending scadute senza provider, attempt o fallback.
- La destination è presente soltanto sulla singola leg. Il payload contiene esclusivamente nome, ristorante, data, servizio, orario e persone; non contiene cognome, note, esigenze, assegnazione, consensi, token o link personale.
- Retry e replay usano una chiave senza PII; la receipt simulata non contiene destination o payload e rileva conflitti di hash.
- Errori inattesi vengono convertiti in failure code allow-listed. Non vengono persistiti messaggi liberi, stack, SQL, payload o destination negli attempt e nei log.
- Il warning dashboard espone soltanto `Notifica non consegnata` o `Notifica consegnata soltanto su un canale`, senza destination, payload, provider reference, attempt o errore raw.
- Un errore permanente viene mostrato alla dashboard senza invalidare la prenotazione.
- M12 non implementa retention. Una policy approvata di retention/redazione per outbox, attempt e receipt è obbligatoria prima di M14 e della produzione.

## 12. Esportazioni

- Le route POST Node sono riservate a Staff e Admin con sessione valida, account attivo, `disabledAt` nullo e `mustChangePassword=false`; applicano same-origin e JSON Zod strict. Tenant, attore, ruolo, correlation ID, conteggi e filename derivano dal server e non sono accettati dal client.
- Ogni query e relazione è tenant-scoped. Il read model rilegge l'attore e usa uno snapshot `REPEATABLE READ` strettamente read-only; non acquisisce lock, non materializza `ServiceInstance` e non esegue business write.
- PDF ed Excel contengono PII operative e devono viaggiare su HTTPS con `Cache-Control: private, no-store`, `Pragma: no-cache` e `X-Content-Type-Options: nosniff`. I nomi file sono ASCII deterministici e non contengono PII.
- I file includono soltanto prenotazioni `CONFIRMED`. Sono esclusi email, UUID, tenant, versione, token, hash, consensi, audit, autore assignment, override e motivazioni override. Le note interne sono incluse soltanto negli export protetti Staff/Admin e non nei metadata PDF o audit.
- Ogni stringa destinata a Excel che inizia con `=`, `+`, `-`, `@`, tab, carriage return o line feed viene prefissata con apostrofo e scritta come cella stringa. Il generatore non imposta formule, hyperlink, external link, macro o celle unite.
- Il range Excel è calendar-based, inclusivo e massimo 31 giorni. I cap server-side sono 2.000 prenotazioni PDF, 20.000 prenotazioni Excel e 25 MiB per buffer. Un superamento restituisce un errore senza file e produce audit FAILURE soltanto per una richiesta autenticata e semanticamente valida.
- PDFKit/ExcelJS renderizzano fuori dalla transazione e raccolgono tutto in memoria. Nessun file temporaneo o permanente viene lasciato sul filesystem. L'audit SUCCESS viene completato prima della risposta; se fallisce il buffer viene scartato. Un fallimento di generazione tenta un solo audit FAILURE e non apre loop di audit.
- L'audit `EXPORT` conserva soltanto formato, modalità, periodo, numero giorni e, per SUCCESS, numero prenotazioni; per FAILURE sostituisce il conteggio con un codice allow-listed. Entità e stati sono nulli. La proiezione M9-F riapplica la stessa allow-list anche ai JSON legacy ostili.
- Noto Sans viene caricato soltanto dal server dall'asset locale, senza fetch runtime o font di sistema. La provenienza è il repository ufficiale `google/fonts`, commit `ec626514f79f831f1ab848a82114a0ce7e2d6372`, con licenza OFL e SHA-256 registrato accanto all'asset.

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

- dati fittizi e tenant demo esatto;
- database separato e mai promosso a produzione;
- provider simulati obbligatori, con kill gate su configurazioni Meta, Graph,
  SMTP, SES, Resend, SendGrid, URL, token, API key e modalità `REAL`;
- accesso HTTP Basic, con sole eccezioni `/api/health` e `/robots.txt`;
- banner demo e direttive globali `noindex`, `nofollow`, `noarchive`;
- cookie `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, senza `Domain`;
- proxy fidato abilitato esplicitamente e ultimo hop delle liste forwarded come
  valore autorevole;
- health minimizzato, senza URL database, secret, stack o dettaglio migration;
- seed e tooling vietati con `APP_ENV=production`, indipendentemente da
  `NODE_ENV`;
- fake-data scan su email `@example.test`, telefoni `+390000...`, nomi test
  prefissati, hostname e destination;
- cleanup solo per run ID confermato e controllo fingerprint PRE/POST sulle
  righe non appartenenti al run;
- nessun backup o dump di produzione e nessun collegamento al sito ufficiale.

Le credenziali Basic e demo non compaiono nel Blueprint con valori in chiaro,
nei log, negli URL o nel processo Playwright sotto forma di `DATABASE_URL`.
Render provisioning e secret configuration non appartengono alla Fase A locale.
La Fase A non usa autenticazione, token, API o workspace Render: certifica il
JSON Schema ufficiale, i test permanenti del contratto e una review statica dei
field documentati. La semantic validation e il conflict checking workspace-aware
sono rinviati per contratto alla Fase C. In quella fase workspace e autenticazione
saranno esclusivamente process-local e nessun identificativo o token verrà
versionato, scritto in `.env` repository, loggato o incluso nelle evidence.

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
