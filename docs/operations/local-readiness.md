# M13 P1-A — Provenance runtime e preflight locale

## ALT07-A — percorso Linux remoto preparato, esecuzione non autorizzata

Questa sezione descrive il candidato locale derivato D6, non una prova runtime.
Il PC Windows non esegue Docker, PostgreSQL o i due worker per ALT07-A. Il
candidato D6 originale e il workflow diagnostico ALT02 restano congelati. Il
nuovo workflow Linux richiede revisione WORK3 e decisione CLASSIC3 separata per
pubblicazione ed eventuale dispatch. D17 resta attivo; produzione non qualificata.

### Prerequisiti esterni obbligatori

Un futuro dispatch accetta soltanto un manifest JSON pubblico in una release del
repository canonico e il suo SHA-256 approvato separatamente. Nessun valore di
identità viene generato per sostituire una prova mancante. Schema versione 1:

| Campo | Evidenza richiesta prima dell'esecuzione |
|---|---|
| `platform`, `nodeVersion` | `linux/amd64`, `24.14.1`; qualificazione Linux distinta da Windows |
| `nodeArchiveSha256` | `84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be`, archivio ufficiale Linux x64 |
| `nodeSha256` | Hash reale del binario estratto e qualificato; nessun placeholder |
| `sourceFreeze` | Inventario raw completo del candidato esatto pubblicato, ordinato per path, SHA-256 del JSON compatto `{name,sha256}` |
| `baseReference`, `baseConfig` | `docker.io/library/node@sha256:...` e config OCI reale qualificata, glibc compatibile |
| `init` | Percorso `/sbin/docker-init` e hash qualificato per l'Engine destinatario |
| `tools` | Hash reali dei tool tar e Docker CLI del runner |
| `osFiles` | Chiusura delle librerie OS del runtime Linux, path e hash; almeno libc/OpenSSL e tutte le dipendenze effettive |
| `workerSeccomp` | Profilo JSON approvato con default deny e architettura x86_64; non `unconfined` |
| `prisma` | Commit engine, SHA-256 gzip e binario Linux reali; profili esatti dei soli helper CLI generate/migrate con path, argv e hash degli entry Node quando applicabili |
| `diskAdmissionMiB` | Budget positivo sostenuto dalla futura misura di preparazione/immagini/layer/artefatti, non ricavato arbitrariamente da ALT06 |

La disponibilità di un tag non qualifica l'immagine. Il manifest non viene creato,
approvato o pubblicato automaticamente dal workflow. I suoi input non sono
secret. URL/hash sono passati alla shell tramite environment, validati prima
dell'uso e mai valutati come comandi. Il workflow usa solo `workflow_dispatch`,
`ubuntu-24.04`, permessi vuoti, checkout pubblico minimo dello SHA dispatch e
nessun upload. L'esecuzione su branch diverso da main viene rifiutata.

### Preparazione e confini di rete

Preparazione artefatti separata dal ruolo: Node ufficiale, npm ci dal lock senza
install script e con configurazioni npm vuote, generazione Prisma Linux, immagini
PG/proxy già canoniche e base qualificata. Il contesto build è esterno, derivato
da inventario positivo; niente `.git`, `.env`, evidenze, credenziali o moduli
Windows. La build ha rete disabilitata. Il costo delle dipendenze e degli artefatti
rimane una proprietà da misurare; nessun PASS locale di build o compatibilità.

La generazione usa un config esterno data-only che indica lo stesso schema
canonico congelato e non richiede un datasource prima del DB posseduto. Le
migrazioni usano invece il config canonico e il database temporaneo verificato.
Il binario Prisma Linux è scaricato dalla provenienza approvata e verificato
compresso e decompresso; nessun engine alternativo o install script implicito.
Ogni tool ha handle originale, birth identity e census dei soli helper dichiarati
per quella CLI. Questa classificazione non estende l'helper applicativo esbuild.

Prima di creare risorse applicative il bootstrap richiede il join dei tool e
passa al binario Linux qualificato mediante `process.execve`, documentato ma
sperimentale in Node 24. Il processo viene sostituito; non rimane un controller
Node aggiuntivo. Non si fa affidamento su handler di cleanup al passaggio: tutti
i tool devono essere già joined e non esistono ancora DB/worker. API assente,
ritorno inatteso o quiescenza mancante bloccano prima del ruolo. Questo handoff e
la chiusura del grafo dei tool richiedono qualificazione Linux separata; nessuna
prova nativa è stata eseguita in ALT07-A.

Topologia del ruolo: backend bridge internal/isolated, IPv6 disabilitato, con i
soli quattro ID registrati; frontend con solo proxy. PostgreSQL non ha porte host.
Il proxy pubblica `127.0.0.1:<porta-allocata>:15432`, raggiunge solo il PG posseduto
e non abilita IP forwarding. Worker backend-only, resolver loopback e nessuna
route default; niente Docker socket, bind mount host, privilegi, capability,
restart o healthcheck. UID/GID 10001, root read-only, tmpfs 64 MiB noexec/nosuid,
512 MiB hard cap ciascuno, swap disabilitato. PG 1536 MiB, proxy 256 MiB: 2816 MiB
di cap totali più 1024 MiB di riserva, ammissione 3840 MiB invariata.

Endpoint interni numerici e target SQL attestati per slot; provider esclusivamente
simulati. DB persistenti, host, gateway, Internet e provider reali non sono target
autorizzati dei worker. Il rischio egress del proxy resta quello locale sintetico
già accettato P1-A, da riconfermare sul runner; non viene dichiarato eliminato.

Per decisione esplicita CLASSIC3 il resolver interno Docker `127.0.0.11` è
ammissibile solo con upstream `127.0.0.1` verificato sull'istanza posseduta,
binding run/attempt/Engine/rete/namespace concordante e nessuna route esterna.
Il supervisor verifica la vista effettiva nel proprio namespace; metadata
mancanti o incongruenti bloccano prima dello startup. Il test sintetico non
sostituisce la qualificazione nativa di DNS ed egress.

### Autorità, processi e shutdown

Controller unico, una sola generation/attempt per slot, canale Engine privato e
sequenze monotone. Le operazioni impegnate prima dell'abort possono essere in
transito e vanno riconciliate secondo il contratto composto D15 accettato dal
Controller. Nessun dispatch nuovo dopo la revoca del controller e nessuno spawn
dopo la revoca locale. Il supervisor rilegge l'autorità dopo le attese e prima
dello spawn, senza await interposto. PID o container ID da soli non provano
ownership. Perdita del canale è terminale; nessun resume/restart automatico.

Si attestano init, supervisor, consumer e helper Linux esbuild con tuple di
istanza, hash, argv e namespace. Un helper già identificato può essere osservato
nel drain dopo la fine del consumer; nessun nuovo processo diventa ammesso per
questo motivo. Ogni presenza ignota o riconciliazione incompleta impedisce PASS
e vieta una terminazione indiscriminata del container.

In presenza di un membro sconosciuto il supervisor mantiene una quarantena
inerte e fenced, così la sua uscita non uccide implicitamente altri membri del
namespace. Il controller termina la verifica entro il budget con FAIL e risorsa
residua esplicita. Non è un join infinito né un prolungamento dell'autorità;
nessuna terminazione del membro ignoto o fallback `docker stop` è consentita.
La fine della VM GitHub non dimostra riconciliazione e non è qualificata qui.

C10 nel receipt intermedio resta NOT_VERIFIABLE finché init/supervisor sono vivi;
solo il teardown finale indipendente può attestare l'assenza completa. Le
evidenze runtime restano esterne al checkout: prima di un futuro dispatch serve
una decisione separata sulla loro conservazione/estrazione, perché il workflow
non effettua upload automatici e il runner è effimero.

Teardown: origine unica alla prima revoca/chiusura; cutoff cumulativi 10 s per
stop/join, 20 s per census SQL, 25 s per release supervisor/init, 55 s per stop
PG/proxy, 65 s per rimozione, 70 s per verifica finale. Ogni sottocomponente
conserva i limiti più stretti. Timeout, ACK, exit container e assenza di risorse
non sostituiscono il join applicativo né la quiescenza SQL live. Una perdita di
ownership vieta nuove query, anche diagnostiche. Risorse non riconciliabili
rimangono registrate come residue; nessun prune, force remove o kill sconosciuto.

### C01–C10: contratto per la futura prova

| Caso | Artefatti e condizione PASS | Condizione FAIL e responsabilità cleanup |
|---|---|---|
| C01 | Due READY e due claim non vuoti trattenuti nello stesso intervallo, due backend realmente bloccati sul lock | Startup soltanto sequenziale o intervallo non dimostrato; controller revoca entrambi |
| C02 | Ledger claim per delivery leg senza sovrapposizioni valide, risultati DB coerenti | Lease concorrenti o leg estranea; STOP coordinato e conservazione errore |
| C03 | Receipt simulata unica per outbox, reference/hash coerenti con provider e persistenza | Receipt duplicata/estranea o conteggio incompleto; nessuna deduzione dal solo successo delivery |
| C04 | `pg_locks` e `pg_stat_activity` attestano entrambi i consumer sul lock reale; row lock conserva la leg e consente le altre | Lock non osservato o leg bloccata modificata; locker rollback/close separati |
| C05 | A exit 86 soltanto alla barriera receipt armata, join positivo, lease originale 120000 ms e recupero B dopo scadenza | Crash non armato, lease abbreviata, A non joined o nuovo consumer; nessun restart |
| C06 | Replay B con una receipt, attempt ABANDONED/WORKER_INTERRUPTED seguito da SUCCESS deduplicato | Duplicazione logica o stato non verificabile; DB resta posseduto per census solo se guard validi |
| C07 | Retry delivery canonico 60000 ms, permanente un solo attempt, runtime distinto | Mutazione policy o retry anticipato; fermare consumer, conservare attempt/receipt |
| C08 | Consumer non interrotto: STOP, abort osservato, DB disconnect, exit 0 e close/join distinti | ACK senza join o errore cleanup; A controllatamente crashato non viene dichiarato graceful |
| C09 | Ledger fence controller/peer, assenza di nuovi impegni dopo revoca, riconciliazione in-flight | Nuovo grant dopo fence, spawn dopo revoca locale o eventi non correlati; nessun PASS globale fisico improprio |
| C10 | Join dei due consumer originali, census senza helper/orfani/zombie, release init/S e risorse Docker assenti | Container exit da solo, PID assente da solo o risorsa non riconciliata non bastano |

Ogni scenario resta `NOT_RUN` fino alla prova autorizzata. M12 e C01–C10 non
vengono ridotti per ottenere un risultato positivo. Linux container qualification,
concorrenza locale sintetica, process tree Windows e deployment produttivo restano
qualificazioni distinte. Nessuna chiusura retroattiva TREE01/STOP01 Windows.

Mandato CLASSIC3 del 3 novembre 2026, sola implementazione locale. Baseline main
`3ae614045da426ab6e33f1d3c2d6e50a4505f983`, tree
`11974842ce9fb47ab1747882523ce4a14122ea70`,476 file/schema16 e freeze raw
`fca219cee14be9a3b46d1c0b963d3de53a319d824f002d53aaff001d3da4d3cd`.
Il candidato richiederà WORK3 Final QG indipendente e ratifica Controller.
Questo runbook non dichiara P1-A CLOSED, SECURITY APPROVED o PRODUCTION READY.

## Prerequisiti e fiducia

La prima lane prevista è Windows x64 con Docker Desktop Linux locale. Il modulo
non installa runtime/tool globali e non modifica runner, config, lock o business.
Node24.14.1 è esclusivamente riferimento storico di riproducibilità; la scelta
operativa aggiornata e la lane Linux/CI richiederanno mandati separati.

Scaricare fuori dal repository soltanto da
`https://nodejs.org/dist/v24.14.1/` il ZIP Windows x64, SHASUMS256.txt e la sua
versione clearsigned SHASUMS256.txt.asc. Verificare prima dell'esecuzione firma
e checksum, seguendo le istruzioni ufficiali
[Node.js](https://github.com/nodejs/node#verifying-binaries), con keyring ufficiale
[nodejs/release-keys](https://github.com/nodejs/release-keys), commit del keyring
e fingerprint del firmatario registrati. Usare un homedir GPG isolato; il GPG
MSYS incluso in Git for Windows richiede percorsi MSYS. Il warning relativo a
firma non detached impone di confrontare il contenuto firmato con il manifest
plain: non basta verificare un file asc e ignorare il file usato per gli hash.

Il trust anchor versionato del ZIP è SHA256
`6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70`, ricavato
dal manifest ufficiale firmato. Il modulo verifica ZIP e manifest contro tale
anchor, confronta process.execPath e tutti i byte Node/npm con i membri del ZIP
autenticato, rifiuta file npm aggiuntivi/link ed esegue il bundled npm tramite
process.execPath per rilevarne la versione reale. Il modulo non implementa
OpenPGP: la verifica indipendente della firma è una prova bootstrap da conservare.
Nessun npm globale/esterno viene adottato. Se manca la prova, NOT_VERIFIABLE e
nessun NODE_PIN_PASS. Non disabilitare TLS o le verifiche per ottenere PASS.

Il modello assume OS, daemon Docker e tool locali fidati. Non protegge da un
amministratore ostile che modifica contemporaneamente processi/daemon/file.
Le prove sono locali e non certificano la quiescenza di un worker remoto.

## CLI

Da un workspace dedicato verificato, usare l'eseguibile estratto dal ZIP già
autenticato; gli esempi PowerShell non contengono credenziali:

```powershell
& 'C:\task-runtime\node-v24.14.1-win-x64\node.exe' scripts/m13-p1-environment.mjs verify --distribution-dir 'C:\task-runtime' --evidence-dir 'C:\task-evidence\verify'
& 'C:\task-runtime\node-v24.14.1-win-x64\node.exe' --test scripts/m13-p1-environment.test.mjs
& 'C:\task-runtime\node-v24.14.1-win-x64\node.exe' scripts/m13-p1-environment.mjs run --distribution-dir 'C:\task-runtime' --evidence-dir 'C:\task-evidence\core' --plan core
```

`verify` è non mutativo per Docker/DB: qualifica solo la provenance e dichiara
ownership DB NOT_RUN. I test built-in usano adapter simulati e probe innocui di
exit/deadline/abort/process tree; le stesse assertion sono raccolte anche dal
Vitest canonico, senza modificare la sua config. I receipt simulati non attestano
NODE_PIN_PASS né una prova infrastrutturale positiva reale.

`run` possiede un unico contesto effimero per l'intero piano. Non accetta URL DB,
container preesistenti, comandi shell, npm CLI o argomenti arbitrari. I piani sono:

- `core`: npm ci, unit, Prisma generate/validate, lint/typecheck/build, migrate,
  seed, Vitest pertinenti e browser M13 P0 tramite runner canonici.
- `full`: medesime preparazioni, poi full Vitest e full Playwright; da motivare
  per cambio runtime. Playwright conserva workers1/retries0 della config protetta.
- `diagnostics`: npm ls e audit full/production separati. Exit1 è failure/finding,
  mai PASS; non viene eseguito audit fix.

Ogni ruolo è avviato separatamente tramite process.execPath dopo controllo live
runtime/ownership. In particolare build, migration, seed ed E2E hanno preflight
distinti: il seed precedente al runner non è affidato al suo guard interno.
Non usare il composito legacy npm test:e2e per questo gate.
Prima dell'E2E devono essere libere le porte4000 su IPv4/IPv6 loopback; un server
HTTP preesistente viene rifiutato prima del child. Il contesto deve restare locale
e senza writer concorrenti: non è una prenotazione atomica della porta per il
server interno al runner protetto, né una qualifica di un host condiviso ostile.

## Ownership positiva

Solo il run corrente può creare la propria network Docker `--internal`, poi
il container dall'image ID locale immutabile di postgres:18.4-alpine3.24 con
RepoDigest registrato, `--pull=never`, label owner/run casuali, nessun volume/bind
persistente, tmpfs su /var/lib/postgresql e porta dinamica su127.0.0.1.
Il Docker endpoint è esplicitamente la pipe locale Docker Desktop Linux;
contesti TCP/remoti e variabili Docker non fidate vengono rifiutati.

Il contesto conserva privatamente gli ID restituiti dai propri create, timestamp,
credenziali sintetiche e identità cluster. Prima di start verifica la proprietà
della risorsa e la configurazione: l'initdb del container è bootstrap
infrastrutturale task-owned, distinto dal primo writer applicativo.
Prima di ogni ruolo controlla nuovamente ID, image, label, processo, network,
mount e binding; verifica il tmpfs reale in /proc/mounts e l'identità PostgreSQL
tramite psql TCP nel container con le credenziali assegnate dal run. Il mapping
Docker lega quel server alla porta host generata; nessuna URL esterna è adottata.
Cluster system_identifier, ruolo, DB e versione devono restare coerenti.

Loopback e nome casuale da soli non sono prove. Non si adotta un container
etichettato ma non creato da questo contesto. Introspezione incerta, mount
persistente, altro server/ruolo/DB, rete esterna o binding ambiguo bloccano i child.
I negativi simulano tali condizioni senza contattare DB persistenti.

## Ambiente, segnali e teardown

NODE_OPTIONS/NODE_PATH/preload e configurazioni remote non sono autorità.
La CLI rifiuta flag Node e variabili pericolose; il caller deve già avviare il
bootstrap senza preload (un preload potrebbe essere eseguito prima del modulo).
Sono rifiutati .env locali e .npmrc di progetto. I child ricevono soltanto OS
allowlisted, PATH con runtime selezionato, configurazioni npm vuote esterne,
URL assegnata dal run e credenziali/configurazioni sintetiche. Nessun flag
APP_ENV/RENDER viene usato come prova dell'host; APP_ENV resta development.

SIGINT/SIGTERM interrompono il child posseduto e avviano teardown. La deadline
dell'harness è distinta dai timeout storici: non li modifica. Windows usa taskkill
/T sul PID appena avviato e ancora attivo; i child vengono attesi fino a close.
I runner canonici conservano la gestione dei propri discendenti: non si dichiara
una nuova qualificazione del vero worker, né una protezione globale del sistema.

Il cleanup rimuove solo container/network di cui il contesto conserva la prova
di creazione, dopo nuova verifica di proprietà. Nessun volume viene cancellato.
Se tale prova manca o il cleanup fallisce, registra TEARDOWN_INCOMPLETE e non
forza cleanup generici. Non usare docker prune o rm su risorse scelte dall'Owner.

## Receipt, limiti e tranche future

runtime.json e run.json esterni riportano OS/arch, execPath/hash, origine
Node/npm, strumenti selezionati, run ID, create/preflight/first-writer, PID,
comandi, exit/reason/start/stop/join, identità DB e source freeze before/after.
I log child sono sanitizzati per segreti sintetici/URL/cookie/binding; non
contengono dump DB o trace browser. Non pubblicare output non revisionato.
Questa sanitizzazione non è il privacy scan NI/PII esaustivo P1-B.

Le CLI legacy restano invocabili direttamente e non diventano automaticamente
protette: il contratto riguarda solo i flussi lanciati tramite questo harness.
I discendenti dei runner canonici operano sul server task-owned e con ambiente
ereditato; il preflight dell'harness precede ciascun ruolo diretto, non intercetta
ogni spawn interno del codice protetto. Non dichiarare una copertura globale.

P1-B, worker reale/due consumer P1-C, BFCache P1-D, CI/policy P1-E, Linux e runtime
operativo aggiornato richiederanno decisioni separate. Rimangono aperti i finding
P0/storici, senza riaprirne o cancellarne i checkpoint. M13 non è CLOSED;
Fase C ON_HOLD, niente Render/Tailscale/provider reali/deploy o Git publication.

## Addendum CLASSIC3 — diagnosi controllata e delta P1-A

Il checkpoint parziale `ca5c9ba0fb4fece5958b38047d2dced0f56e79f4fe6966f0ce43ed9f0d30552b`
e il relativo ZIP sono storici e restano immutati. D0 ha riprodotto la creazione
una sola volta su nuove risorse task-owned, senza query SQL o child applicativi.
Tre osservazioni dello stesso container hanno mostrato richiesta
`HostConfig.PortBindings={"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]}`,
ma stato effettivo `NetworkSettings.Ports={"5432/tcp":[]}` e `docker port` exit1
senza endpoint. Non esiste quindi un mapping positivo da selezionare in quel run.
La causa sottostante della mancata pubblicazione nell'Engine non è stabilita.
Nessuna modifica a rete, Docker Desktop o policy è autorizzata da questa diagnosi.

Il parser mantiene il rifiuto e distingue ora PORT_BINDING_NOT_PUBLISHED dalla
cardinalità ambigua. Richiesta e stato effettivo devono essere univoci e correlati;
la pubblicazione riportata da Docker deve corrispondere esattamente al mapping
del container creato. Duplicati, mapping aggiuntivi, wildcard, interfacce diverse,
configurazioni non previste ed endpoint discordanti non producono un target.
Nessuna selezione arbitraria del primo elemento o fallback a un altro DB.

I receipt registrano gli oggetti di binding filtrati, la classificazione e il
rifiuto prima del child. Un candidateMapping di metadati non è ancora una scelta
di endpoint: selectedMapping compare solo dopo la correlazione con docker port.
Il target registrato non contiene credenziali. Config.Env non viene persistito.
events.jsonl esterno viene scritto progressivamente con flush; un errore di
persistenza blocca i child e rimane distinto dall'esito del teardown.

close() conserva una sola Promise e restituisce lo stesso risultato verificato
alle richieste successive o concorrenti. Un esito false non diventa true su una
seconda chiamata. Sono verificate l'assenza del container e della network posseduti.
Il finalizzatore conserva primaryFailure e cleanupStatus separati: un cleanup
completo non maschera la causa primaria, mentre un cleanup incompleto rimane
visibile e bloccante. Non si ripetono rimozioni né si forza un cleanup estraneo.

D2 resta condizionata a tutti i gate di ownership, inclusa identità PostgreSQL.
La riproduzione D0 non ha fornito tale PASS: nessun npmci, migration, seed, build
o runner applicativo va avviato sulla base delle sole prove simulate. I test D1
conservano le54 assertion/test precedenti e aggiungono binding e teardown mirati;
non chiudono formalmente finding o P1-A. PROC01 resta una limitazione documentata,
senza nuovi privilegi amministrativi o cambi di policy per ottenere PASS.

## D6 — flusso locale proxy autorizzato da CLASSIC3

Il percorso operativo richiede Node24.14.1 Windows x64 e npm bundled già
qualificati, psql Windows portabile esterno e immagini esatte verificate. Il
mandato consente una sola prova reale dopo G0 baseline/integrità, G1 syntax/unit,
G2 provenance di ogni artefatto e G3 budget/topologia/task ownership. Non
rilanciare dopo failure infrastrutturale senza nuova decisione Controller.

La registry appartiene al run e conserva containerPG, containerHAProxy,
backend/frontend, Created/StartedAt/PID, image ID/digest, config hash e generation.
PG è solo backend internal+isolated, senza publishing; HAProxy ha entrambe le
reti e solo127.0.0.1:porta_run→15432/tcp. Egress potenziale del proxy accettato
dall'Owner soltanto per questo ambiente locale sintetico, non una sandbox Internet.
User99:99, cap-drop ALL, no-new-privileges; niente Docker socket/privileged/volumi.

Artefatti esterni richiesti: manifest/index/config OCI postgres e haproxy, archivio
EDB autenticato e cartella windows-psql contenente psql.exe e DLL byte-identici
all'archivio. I pin misurati sono verificati dal modulo. Nessun client globale,
PATH alternativo, .env o profilo libpq remoto può diventare un fallback.
Nessun segreto compare in config, argv o receipt. Il client psql riceve solo
credenziali sintetiche del run nell'ambiente ridotto e query read-only fisse.

Esempio di sola provenance runtime, senza DB:

```powershell
& '<distribuzione-esterna>\node-v24.14.1-win-x64\node.exe' scripts/m13-p1-environment.mjs verify --distribution-dir '<distribuzione-esterna>' --evidence-dir '<evidenze-esterne>\verify'
```

La seguente è la singola esecuzione controllata, da avviare soltanto dopo receipt
positivi G0–G3 e verifica che la prova autorizzata non sia stata consumata:

```powershell
& '<distribuzione-esterna>\node-v24.14.1-win-x64\node.exe' scripts/m13-p1-environment.mjs run --distribution-dir '<distribuzione-esterna>' --artifact-dir '<artefatti-qualificati-esterni>' --evidence-dir '<nuove-evidenze-esterne>' --plan full
```

Non è un'autorizzazione a ripetere il comando. La porta è selezionata e il socket
chiuso tramite callback prima di Docker create/start proxy; resta una race,
gestita fallendo su collisione. La prova è il mapping effettivo, non la riserva.
La config è trasferita con tar UID0/mode0444 e riletta dal container prima dello
start; nessun bind mount host. Budget: PG1536MiB/tmpfs1024MiB;
HAProxy256MiB/tmpfs16MiB/maxconn64. Nessun aumento automatico.

Ogni preflight verifica metadata/processi/mount/reti, config proxy e indirizzi,
mapping Docker e identità del cluster sia interna sia via Windows. Un cambiamento
revoca la lease e impedisce nuovi writer. Event stream del solo run monitorato;
perdita stream o mutazioni inattese causano abort, non un nuovo server.

Le fasi canoniche dei runner importabili hanno hook prima di CREATE/migration/
seed/test/cleanup/drop e preparazione/app/Playwright/fingerprint. Il semplice
import è inerte. La modalità stretta richiede callback positiva; non è un flag
env sufficiente. Il percorso CLI legacy resta distinto e non qualificato da
questa sola esistenza dell'harness. Non lanciare direttamente npm test:e2e:
il seed dell'alias storico precede il runner e va protetto come ruolo separato.

Gli82 test D0/D1 restano nell'adapter simulato, mai un fallback operativo alla
pubblicazione diretta PG. Le nuove prove esercitano la catena proxy e le fasi
annidate. PASS_REPORTED_ONLY di un adapter non diventa ownership reale.

Su abort/deadline: niente nuovi dispatch, stop/join dei child registrati e
quiescenza prima di cleanup SQL ancora autorizzato. Poi stop proxy/PG, rm dei
soli CID attribuiti e reti vuote, check assenza per ID. close cached conserva
true/false e primary failure. Non prune, non cleanup sconosciuto; residui e
process join incompleto restano finding. tmpfs non è erasure forense dello swap.

I risultati del candidato D6, compresi NOT_RUN/FAIL/BLOCKED, sono nel nuovo ZIP
esterno. Non pubblicare trace/browser output o log non sanitizzati. Linux/CI,
worker reale, BFCache e scan privacy esaustivo rimangono separati. M13 complessiva
non CLOSED, Phase C ON_HOLD; niente Git publication, Render/Tailscale o deploy.

## D8 — deadline e prova condizionata

D8 modifica soltanto modulo, relativo test e le due appendici documentali autorizzate. I quattro file runner/test D6 rimangono congelati. I checkpoint D6/D7 e i loro esiti non sono sostituiti: le nuove evidenze stanno fuori dal repository.

Prima di creare risorse: verificare baseline/tree, precedente freeze,8 path cumulativi/472 protetti/480 file, conservazione dei140 test, syntax e nuovi negativi. Qualificare Node/npm/psql/immagini, capacità e ID dello stesso Engine; verificare in sola lettura l'assenza dei run precedenti. Se un gate manca, non avviare Docker. Nessun pull o credential helper implicito: ART01 resta documentato separatamente.

La CLI run D8 richiede esplicitamente l'ID ottenuto da G3, oltre agli artefatti qualificati. Esempio con soli segnaposto:

```powershell
& '<distribuzione-esterna>\node-v24.14.1-win-x64\node.exe' scripts/m13-p1-environment.mjs run --distribution-dir '<distribuzione-esterna>' --artifact-dir '<artefatti-qualificati-esterni>' --engine-id '<UUID-ENGINE-VERIFICATO>' --evidence-dir '<nuove-evidenze-esterne>\run-d8' --plan full
```

Il comando non va ripetuto dopo failure. Il singolo tentativo deve essere registrato dal collector esterno prima dell'avvio. verify rimane una modalità di sola provenance runtime e non qualifica un DB.

Il bootstrap usa performance.now con un solo deadline30s dalla prima creazione, dopo la provenance preliminare. Timeout per comando≤15s, SQL≤5s e sempre≤residuo; watchdog/AbortSignal e guard prima/dopo le fasi impediscono nuovi dispatch o READY scaduti. I receipt contengono UTC, monotonicMs, elapsed/residuo/cap effettivo e classificazione distinta di timeout, abort, diagnostica e cleanup. Non è una promessa hard real-time contro stalli OS o rollback delle richieste già ricevute dal daemon.

Il controllo iniziale e finale conserva tutti i campi di ownership; le letture aggregate si correlano per ID, non per primo elemento. Output proc/cgroup, config e diagnostica sono strutturati e limitati. Il cap diagnostico non assorbe timeout o abort. La readiness interna parte dopo creazione/configurazione proxy e controllo topologia; PG può inizializzare in parallelo, ma nessuna identità viene presunta. L'identità Windows usa il psql verificato, l'unico endpoint proxy e query fisse read-only. Prima del writer servono confronto completo e verifica finale fresh della medesima generation.

Ogni create ha nonce, hash richiesta, PID CLI e receipt precedente al dispatch. Un ID ricevuto tardivamente viene conservato prima di lanciare timeout; per i container è previsto un CID file esterno esclusivo del tentativo. La CLI viene stop/joined entro5s; soltanto un ID di risposta/CID file correlato e un inspect positivo permettono cleanup. Se l'esito resta UNCERTAIN, le liste filtrate sono diagnostica e non prova di assenza: nessuna adozione per nome/label, nessun rm su sconosciuti, cleanupVerified=false. Richiedere decisione Controller e non iniziare una nuova prova.

close è idempotente anche concorrente. Il teardown ha deadline separato70s (due finestre15s e stop10s/30s), stop/join dei soli processi propri e cap individuali invariati: drain5s, stop proxy10s, stop PG30s. Ogni operazione è troncata al residuo; primaryFailure non è sostituito dal cleanup. SQL cleanup/quiescenza solo se la catena è ancora attribuibile; altrimenti NOT_VERIFIABLE. Si rimuovono solo container noti e reti possedute vuote, verificando gli ID residui. Una Promise scaduta non prova la terminazione del processo o della richiesta daemon.

Durante D2 gli hook dei runner mantengono verifiche live prima delle fasi canoniche; ogni ruolo ha il proprio budget finito e non estende il bootstrap. Build/seed/E2E restano ruoli distinti: non invocare direttamente l'alias storico test:e2e. Nessuna garanzia universale sui comandi manuali legacy. I risultati reali e i limiti della prova D8 sono nel pacchetto esterno; test sintetici e provenance non equivalgono a ownership PostgreSQL, Security QG o produzione qualificata.

## D9 — confronto IPv4 e attesa di readiness

Prima delle modifiche D9 sono verificati baseline, main remoto, freeze D8, ZIP originale e receipt. Il rifiuto DATABASE_IDENTITY_MISMATCH deriva dalla rappresentazione inet::text con /32 confrontata con l'IP Docker bare; entrambe le query D8 erano osservate, senza first writer né D2. I checkpoint restano immutati.

L'harness canonizza esclusivamente i campi IP di identità: IPv4 numerico valido, con maschera assente o /32 esatto. Non elimina genericamente testo dopo slash. /24, /31, /33, altre maschere, IPv6, hostname, indirizzi diversi, whitespace e valori mancanti/malformati falliscono. I receipt conservano i valori SQL originali; gli altri confronti del cluster, client atteso per ciascuna connessione, ruolo/database, endpoint e generation restano obbligatori.

Il polling continua solo per POSTGRESQL_STARTING. La cadenza nominale250ms non è più anche il deadline dell'operazione: l'attesa usa il budget della fase corrente, con cap15s e residuo globale. Il delay è min(250ms, floor(residuo effettivo/2)); sotto1ms di delay si blocca invece di girare senza pausa. I guard prima e dopo il sonno propagano abort/scadenza; dopo il risveglio si rilegge l'identità SQL. Nessun budget è rinnovato, nessuna query negativa diventa positiva. Bootstrap30s, cap SQL5s, stop/join e teardown D8 invariati.

La CLI e gli argomenti D8 restano invariati; usare una nuova directory di evidenze e registrare l'unico tentativo D9 nel collector prima dell'avvio. Prima della prova:191 test precedenti conservati,39 nuovi casi IP/polling, syntax e scope positivi; provenance degli stessi artefatti, Engine/capacità e assenza dei residui nuovamente verificati. Il PASS sintetico non autorizza da solo Docker. Qualsiasi failure reale impone stop e teardown senza modifica del codice o retry.

Solo ownership completa e fresh, identità interna/Windows, confronto e first-writer preflight positivi consentono i ruoli D2 del piano già autorizzato. Non invocare l'alias legacy con seed prima del guard. Freeze, log raw sanitizzati, risultati effettivi anche FAIL/NOT_RUN e assenza risorse devono essere nel pacchetto esterno D9. Nessun PASS applicativo derivato dai test Node, nessuna closure formale o pubblicazione Git.

## D12 — worker runtime, abort e quiescenza

La modalità CLI e la topologia restano quelle D8/D9: distribuzione e artefatti esterni qualificati, stesso Engine verificato, nuova evidence directory per ogni run. Il lock canonico B è congelato. Prima del singolo tentativo D12 verificare G0, scope9 path/480 file/471 protetti, tutti i230 test precedenti e i nuovi RT01–RT25, syntax, provenance Node/npm/psql/immagini, capacità e assenza dei run precedenti. Non ripetere il tentativo dopo failure.

La rivalidazione usa un worker read-only dello stesso file, senza nuova dipendenza o helper di repository. Gli hash sincroni sono isolati dal parent: alla scadenza il parent revoca nuovi dispatch, invia abort e richiede terminate; attende l'exit entro un join separato5s. Un messaggio positivo senza exit non certifica quiescenza. Un thread sconosciuto o non joined blocca PASS e cleanup completo. La fase resta15s e il bootstrap30s: il receipt contiene deadline/start/end monotonic, effective timeout, abort request, lavoro attivo e abort/join separati. Non si nasconde la latenza di stop nel tempo di lavoro e non si promette hard real-time sotto stalli OS.

Il worker non esegue SQL, Docker, provider o script npm. Riceve solo percorsi controllati e digest attesi privati del run; nessuna password o URL. Rilegge i file effettivi, verifica file non regolari/link/inattesi e il runtime scelto. Il manifesto atteso riusato non è una prova live. I preflight Docker/SQL e gli hook dei runner rimangono fresh, inclusi migration, seed prima E2E, child DB e cleanup.

Il teardown blocca nuovi writer, ferma e attende i child posseduti, riconcilia i create e verifica i quattro ID task-owned. I receipt distinguono application/runner process, worker, infrastructure process, SQL-client e risorse. Dopo revoca, SQL live quiescence resta NOT_VERIFIABLE e non viene fatta una query verso un target non più qualificato. L'eventuale prova OWNED_POSTGRESQL_STOPPED_AND_ABSENT certifica terminazione del server posseduto, separatamente dalla quiescenza SQL prima dello stop. Non basta osservare zero nuovi dispatch. Assenza risorse e completezza globale del teardown sono campi distinti; nessuna rimozione di risorse sconosciute e nessun errore secondario cancella il primario.

Solo la nuova catena qualificata consente D2. npm ci va eseguito una volta nel nuovo run con scripts attivi; non si sostituisce con il PASS D10 e non si ripete se è già positivo nello stesso run. Un gate fallito impedisce i successivi. Nessuna variazione di timeout, retry, assertion, runner o configurazione per ottenere PASS; nessuna CI/Render/Tailscale, provider reale, deployment o tranche P1-B/C/D/E. La raccolta è esterna, sanitizzata e comprende anche failure/NOT_RUN, timing, stop/join e residui. Nessuna chiusura formale o approvazione WORK3 è implicita.

## D13 — due livelli di verifica runtime

Usare gli stessi artefatti qualificati, un nuovo collector/evidence directory esterno e una nuova generation. Prima del singolo tentativo: checkpoint D12, lock SHA-256 invariato, nove path cumulativi/480 file/471 protetti, syntax e 263 test sintetici positivi, provenance, identità Engine/capacità e assenza delle risorse precedenti. Non modificare i quattro runner/test congelati.

La qualificazione completa legge e confronta tutti i file del runtime e bundle npm effettivi col manifesto atteso già qualificato; mantiene enumerazione rigorosa e rifiuto di link/file aggiuntivi. Otto letture concorrenti nel worker riducono attese seriali senza saltare byte. Il target è 15s. Il massimo di 60s si applica soltanto a questa qualifica: D11 aveva osservato 42,7365322s senza enforcement, mentre D12 aveva interrotto il controllo post-ci a 15s. Deadline monotonic, abort, terminate e join separato di massimo 5s rimangono obbligatori.

L'harness richiede una qualifica completa prima del primo dispatch, prima di ogni comando che esegue npm e di nuovo dopo ci, prima dei successivi gate D2. I ruoli diretti Node hanno un guard fresco del binario effettivamente eseguito; non rieseguono una qualifica del bundle npm che non invocano. Non è un controllo solo di versione, path, mtime o nome: il binario corrente è confrontato per SHA-256 con il digest qualificato. Un eventuale uso diretto successivo di npm riattiva l'intera verifica del suo bundle. Nessun PASS di run precedenti viene riutilizzato.

Il preflight live operativo ha un cap aggregato di 15s; tutti i comandi e le query ricevono al massimo il residuo. La sola readiness iniziale resta nel bootstrap totale di 30s. Le identità Docker/network/proxy/SQL, generation e lease sono rilette e confrontate nei punti canonici prima dei writer e durante cleanup. Nessuna verifica live obbligatoria è spostata fuori dal punto richiesto.

Dopo i gate positivi eseguire nello stesso run ci una sola volta, poi generate/validate, typecheck, ESLint, build e test mirati/completi Vitest e Playwright attraverso l'harness. Migration/seed soltanto quando richiesti, dopo preflight. Nessun alias legacy con seed anticipato. Non proseguire ai gate dipendenti se una fase fallisce; conservare l'errore e verificare teardown e assenza delle sole risorse possedute. Processi del task, SQL live quiescence, terminazione server PG e assenza risorse sono attestazioni separate. I risultati reali, anche NOT_RUN e FAIL, appartengono al pacchetto conclusivo D13; nessuna approvazione WORK3 o produttiva è implicita.

## D14 — censimento read-only e quiescenza finale

Prima dell'unico tentativo D14 verificare checkpoint/ZIP D13, lock congelato, scope di quattro delta e nove path cumulativi,480 file/471 protetti, syntax e273 test sintetici (263 precedenti più10 nuovi). Stesso Engine e artefatti qualificati; capacità e residui devono essere verificati. Bootstrap30s, guard15s, qualifica completa massimo60s condizionale e teardown70s restano invariati.

Dopo create/preflight, validateQuiescence è obbligatorio prima dei ruoli D2. La prova usa psql Windows qualificato con default_transaction_read_only=on, statement_timeout5s e idle_session_timeout15s. Una connessione sintetica con nonce attende su stdin; viene correlata per PID/ruolo/database/read_only, osservata nel census, chiusa con quit e joined. L'API non accetta SQL applicativo. Non è un secondo run Docker. Un errore impedisce l'avvio di D2.

Il censimento finale segue blocco dei dispatch, stop/join dei child e chiusura dei client posseduti. Il monitor interno task-owned esegue query fisse READ ONLY dopo controllo fresh Docker/cluster. Ogni campione usa una connessione/transazione nuova, evitando snapshot riutilizzati. Il monitor è escluso soltanto con PID/backend_start/nonce/database/ruolo/read_only corrispondenti. Tutti gli altri client, anche unnamed o con database/ruolo inatteso, devono scomparire. Active, idle, idle in transaction e unknown sono contati separatamente; query e dati non sono selezionati. Backend non client sono registrati per tipo/conteggio e non assimilati a connessioni applicative.

Il drain massimo5s usa il residuo del teardown e pause positive; nessun polling infinito, pg_terminate_backend o filtro permissivo. Il monitor termina prima del successivo campione e prima della revoca residua e dello stop PG. Dopo revoca non viene riabilitata una lease per SQL diagnostico. SQL live quiescence, processi del task, terminazione server e assenza delle risorse sono attestazioni distinte: un errore SQL non diventa PASS dopo la rimozione dei container.

Solo early validation e ownership positive consentono tutti i gate D2 nello stesso run, senza riuso dei PASS D13 o alias legacy con seed anticipato. Qualsiasi failure richiede stop, evidenze e cleanup delle sole risorse dimostrate. Nessun retry, modifica ai runner congelati, dati reali, provider reali, pubblicazione o closure formale; WORK3 QG separato.

## D15 — preflight operativo e completamento consolidato

Verificare il checkpoint D14, ZIP originale, lock congelato, quattro delta e nove path cumulativi/480 file/471 protetti prima degli interventi. Syntax e282 test sintetici (273 precedenti conservati più9) devono essere positivi prima delle letture Docker di qualificazione e dell'unico tentativo. Gli altri cinque path rimangono congelati.

Il guard non avvia più docker info: legge fresh l'ID tramite GET /info sulla pipe locale qualificata, dopo context inspect corrente. L'identità Engine resta confrontata, così come ogni attributo live delle risorse e l'identità SQL; la full qualification iniziale non è sostituita. L'API fissa non consente TCP, redirect o mutazioni. Deadline e abort chiudono richiesta/socket e ne verificano il close entro join5s; UNKNOWN impedisce PASS. Il cap operativo resta15s, bootstrap30s e full massimo60s condizionale. Non si assume risolta una lentezza del daemon o uno stallo OS sulla base del solo cambio di trasporto.

Dopo create eseguire validateQuiescence e un preflight operativo mirato sul medesimo run, con receipt di duration/cap/Engine/context e identità SQL, prima della suite. Solo dopo questi PASS eseguire ci una volta con scripts attivi, unit, Prisma generate/validate, typecheck, lint, build, migration/seed canonici e Vitest/Playwright mirati e completi. Ogni fase sensibile mantiene il proprio hook fresh. Nessun PASS storico sostituisce il nuovo gate.

Al termine bloccare dispatch, join dei child e chiusura client, ownership fresh, census READ ONLY e drain5s entro teardown70s. Registrare monitor e conteggi/stati sanitizzati, anche idle e unknown. Solo zero altri client consente SQL live quiescence positiva. Chiudere il monitor, revocare accesso residuo, arrestare PG e rimuovere soltanto risorse possedute; verificare separatamente processi, server e assenza container/network. Se la lease è già revocata non eseguire nuovi SQL e mantenere NOT_VERIFIABLE. Una failure non diventa PASS dopo la rimozione fisica. Un solo pacchetto conclusivo con risultati effettivi, failure, manifest e SHA-256; nessuna closure formale o pubblicazione Git.
## M13 P1-C — due consumer reali nello stesso ruolo

Il piano versionato `--plan worker` esegue soltanto `ci`, `generate`, `validate`,
`migrate`, `worker-runtime`. Il ruolo finale possiede due processi Node del worker
notifiche reale sul medesimo PostgreSQL effimero P1-A. Non eseguire due `run()`
concorrenti, comandi worker manuali o il launcher Render per sostituire questo piano.

Conservare i prerequisiti CLI già descritti: distribuzione Node/npm autenticata,
artefatti qualificati esterni, Engine locale verificato, source freeze, assenza di
residui, ambiente senza `.env` personali e directory evidenze nuova. Dopo `create`,
la CLI richiede `validateQuiescence()` positivo prima del primo ruolo. La migration
deploy e tutte le fixture restano vincolate al database privato della lease.

I cap restano bootstrap30s, guard operativo15s, qualifica completa massimo60s
condizionale e teardown70s. Solo `worker-runtime` ha un cap aggregato600s;
le altre modalità conservano i propri limiti. Le richieste di preflight dei due
consumer sono serializzate; coda e lavoro consumano il deadline del guard.

Il coordinatore verifica PID/runtime, nonce, generation e identità SQL prima del
loop; usa esclusivamente i simulatori M12. Barriere prima/dopo il claim e lock
PostgreSQL osservati dimostrano la contesa effettiva. Il test mantiene batch25,
max5 per tenant/consumer, processing5, sweep100 e lease120s. Non richiede fairness.
Il primo retry attende realmente60s; il crash controllato di A dopo la receipt è
l'ultimo scenario, seguito da recovery/replay in B dopo la scadenza reale della
lease. Non si modificano timestamp o stati per anticipare questi eventi.

Su Windows lo shutdown normale usa STOP IPC collegato all'abort della CLI reale;
`child.kill(SIGTERM)` non è una prova di graceful shutdown. Servono disconnect
Prisma, close osservato, join e inventario dei helper attribuiti. Il crash di A
è registrato separatamente dallo stop graceful di B. Ogni altro exit inatteso,
messaggio fuori protocollo, drift, scadenza o stato UNKNOWN blocca il run.

`worker-runtime.json` conserva solo identità tecniche, contatori, hash, esiti e
timing, senza contatti, payload, query text, URL DB o errori grezzi. Dopo chiusura
dei client, il census P1-A deve dimostrare zero altri client prima della revoca e
dello stop PostgreSQL. Quiescenza dei processi, SQL live, stop del server e assenza
container/network restano prove distinte. Dopo perdita della lease non si
riabilita SQL diagnostico né si dichiara quiescenza verificata per deduzione.

P1-C resta locale/sintetico; nessun provider reale, Render o produzione.
Le riserve P1-A e P1-B OPAQUE01 rimangono valide; WORK3 QG è separato.

