# Piccadilly Booking — Roadmap

**Stato:** approvata per lo sviluppo iniziale
**Data:** 31 luglio 2026

## 1. Regole della roadmap

- Ogni milestone realizza una sola area coerente.
- Le dipendenze vengono aggiunte solo quando la milestone le richiede.
- Le tabelle del modello logico vengono create progressivamente.
- Sviluppo e staging usano esclusivamente dati fittizi e provider simulati.
- WhatsApp reale non viene implementato nelle prime milestone.
- Non si inizia una milestone bloccata da decisioni funzionali non approvate.
- Ogni modifica architetturale viene registrata in un ADR.
- Non si eseguono commit, push, merge o deploy senza richiesta esplicita.

## 2. Qualità comune a ogni milestone di codice

Una milestone non è completa finché non sono soddisfatti tutti i punti applicabili:

1. lint senza errori;
2. typecheck strict senza errori;
3. test unitari pertinenti superati;
4. test di integrazione pertinenti superati;
5. test end-to-end pertinenti superati;
6. build di produzione riuscita;
7. documentazione aggiornata;
8. nessun dato reale in sviluppo o staging;
9. riepilogo dei file modificati e dei comandi eseguiti.

I test di persistenza e concorrenza devono usare PostgreSQL reale, non SQLite.

## 3. Milestone

### M0 — Documentazione e decisioni architetturali

**Obiettivo**

Definire una base tecnica approvata prima di creare codice.

**Funzioni incluse**

- architettura del monolite modulare;
- roadmap;
- decisioni approvate;
- modello dati logico;
- strategia di sicurezza;
- ADR iniziali;
- obiettivi RPO e RTO.

**Funzioni escluse**

- codice applicativo;
- `package.json`;
- inizializzazione Next.js;
- dipendenze;
- infrastruttura definitiva.

**Dipendenze**

Nessuna.

**Criteri di accettazione**

- tutti i documenti richiesti esistono;
- le decisioni approvate sono rappresentate senza contraddizioni;
- `PROJECT_SPEC.md` resta la fonte ufficiale dei requisiti funzionali;
- `AGENTS.md` e `PROJECT_SPEC.md` non sono modificati.

**Test obbligatori**

- revisione di coerenza documentale;
- `git diff --check`;
- verifica dello stato Git.

**Definizione di completamento**

Documentazione leggibile, coerente e pronta a guidare M1.

### M1 — Fondamenta Next.js

**Obiettivo**

Creare un'applicazione vuota, riproducibile e verificabile.

**Funzioni incluse**

- Next.js App Router con runtime Node.js;
- TypeScript strict;
- Tailwind CSS;
- struttura modulare iniziale;
- configurazione ambiente con valori fittizi;
- lint, Vitest, Playwright e build;
- pipeline GitHub Actions di base.

**Funzioni escluse**

- PostgreSQL e Prisma;
- autenticazione;
- logica di prenotazione;
- provider di notifica.

**Dipendenze**

M0.

**Criteri di accettazione**

- applicazione avviabile localmente;
- pagina tecnica responsive;
- nessun segreto nel repository;
- `.env.example` contiene solo valori fittizi.

**Test obbligatori**

- lint;
- typecheck;
- smoke test Vitest;
- smoke test Playwright;
- build.

**Definizione di completamento**

La base applicativa è verde in locale e in CI, senza funzione di business.

### M2 — PostgreSQL e Prisma

**Obiettivo**

Creare la persistenza locale riproducibile e la prima parte del modello dati.

**Funzioni incluse**

- PostgreSQL locale tramite Docker Compose;
- Prisma e migrazioni;
- `restaurants`, `rooms`, `weekly_service_rules`, `service_instances`;
- seed esclusivamente fittizio;
- convenzioni UUID, timestamp e timezone.

**Funzioni escluse**

- prenotazioni;
- utenti e sessioni;
- notifiche;
- export.

**Dipendenze**

M1.

**Criteri di accettazione**

- database ricreabile da zero;
- migrazioni ripetibili;
- seed riconoscibile come fittizio;
- nessun dato persistito fuori PostgreSQL.

**Test obbligatori**

- avvio container;
- applicazione migrazioni su database vuoto;
- test dei vincoli e del seed;
- lint, typecheck e build.

**Definizione di completamento**

Lo schema iniziale è riproducibile senza account esterni.

### M3 — Autenticazione e autorizzazione

**Obiettivo**

Proteggere l'area Staff/Admin.

**Funzioni incluse**

- tabelle `users` e `sessions`;
- login e logout;
- password con Argon2id o alternativa formalmente approvata;
- cookie HttpOnly, Secure in produzione e SameSite;
- ruoli Admin e Staff;
- sessioni revocabili;
- audit di login e operazioni account.

**Funzioni escluse**

- gestione completa delle configurazioni;
- prenotazioni;
- autenticazione cliente;
- OAuth esterno.

**Dipendenze**

M2.

**Criteri di accettazione**

- utenti anonimi non accedono alle route interne;
- Staff e Admin ricevono permessi diversi;
- un utente disabilitato perde l'accesso;
- le autorizzazioni vengono controllate anche nei casi d'uso.

**Test obbligatori**

- credenziali valide e non valide;
- cookie e scadenza sessione;
- revoca e session fixation;
- matrice Admin/Staff;
- accesso diretto agli endpoint protetti;
- lint, typecheck e build.

**Definizione di completamento**

L'area interna dispone di autenticazione e autorizzazione server-side verificate.

### M4 — Configurazione del ristorante e calendario

**Obiettivo**

Calcolare correttamente servizi, slot, cutoff e sale disponibili.

**Funzioni incluse**

- giorni di apertura;
- pranzo e cena;
- orari configurabili;
- slot iniziali ogni 15 minuti;
- aperture e chiusure straordinarie;
- cutoff pranzo iniziale 10:30;
- cutoff cena iniziale 17:30;
- chiusura online della cena venerdì e sabato alle 17:30;
- Galleria e Terrazzo attivabili per data e servizio;
- telefono, dominio, email, WhatsApp, testi e durata link configurabili.

**Funzioni escluse**

- creazione prenotazioni;
- dashboard completa;
- notifiche reali.

**Dipendenze**

M2 e M3.

**Criteri di accettazione**

- la precedenza eccezione, regola settimanale, default è deterministica;
- i cutoff sono configurabili dall'Admin;
- nessun contatto o testo pubblico è hardcoded;
- i calcoli usano `Europe/Rome` come timezone iniziale.

**Test obbligatori**

- giorni aperti e chiusi;
- apertura e chiusura straordinaria;
- pranzo e cena;
- venerdì e sabato;
- cambio ora legale;
- attivazione sale esterne;
- autorizzazioni Admin/Staff;
- lint, typecheck e build.

**Definizione di completamento**

Il motore restituisce una configurazione effettiva univoca per ogni data e servizio.

### M5 — Motore prenotazioni e concorrenza

**Obiettivo**

Implementare il nucleo server-side che garantisce la capacità.

**Funzioni incluse**

- tabelle principali della prenotazione;
- finestre mobili di 30 minuti su slot di 15 minuti;
- limite iniziale 30, modificabile dall'Admin;
- transazioni e lock per servizio/data;
- idempotenza;
- cancellazione logica;
- versionamento delle modifiche;
- override Admin/Staff con motivazione;
- audit atomico.

**Funzioni escluse**

- modulo pubblico completo;
- pagina personale;
- dashboard completa;
- notifiche.

**Dipendenze**

M4.

**Criteri di accettazione**

- senza override nessuna combinazione concorrente supera il limite;
- una richiesta pubblica non disponibile non viene confermata;
- l'override non cambia il limite globale;
- la cancellazione libera subito i coperti dopo il commit.

**Test obbligatori**

- unitari sulle finestre mobili;
- integrazione con PostgreSQL;
- richieste parallele sullo stesso slot;
- richieste su slot diversi della stessa finestra;
- modifica fra servizi;
- cancellazione simultanea;
- override simultaneo;
- retry su deadlock o errore di serializzazione;
- lint, typecheck e build.

**Definizione di completamento**

Le invarianti di capacità sono dimostrate da test concorrenti ripetibili.

### M6 — Prenotazione pubblica

**Obiettivo**

Consentire al cliente di creare una prenotazione online.

**Funzioni incluse**

- modulo italiano e inglese;
- campi obbligatori e facoltativi della specifica;
- preferenza di sala non garantita;
- consensi versionati;
- disponibilità indicativa;
- conferma atomica;
- rate limiting;
- invito a telefonare quando non disponibile o dopo il cutoff.

**Funzioni escluse**

- modifica e cancellazione;
- dashboard;
- notifiche reali.

**Dipendenze**

M5.

**Criteri di accettazione**

- flusso completo da smartphone, tablet e PC;
- nessuna prenotazione persa per doppio invio;
- nessuna conferma oltre capacità;
- testi e contatti provengono dalla configurazione.

**Test obbligatori**

- E2E italiano e inglese;
- validazione server-side;
- idempotenza;
- rate limiting;
- cutoff;
- sala disattivata;
- accessibilità di base;
- lint, typecheck e build.

**Definizione di completamento**

Una prenotazione online disponibile viene salvata e confermata correttamente con dati fittizi.

### M7 — Pagina personale

**Obiettivo**

Consentire consultazione, modifica e cancellazione tramite link sicuro.

**Funzioni incluse**

- token casuale di 32 byte;
- solo hash nel database;
- consultazione fino a 24 ore dopo l'orario prenotato;
- azioni fino al cutoff configurato;
- pagina consultabile ma in sola lettura dopo il cutoff;
- modifica con ricontrollo capacità;
- cancellazione logica;
- `noindex` e `no-store`.

**Funzioni escluse**

- account cliente;
- riattivazione autonoma di una prenotazione cancellata;
- notifiche reali.

**Dipendenze**

M6.

**Criteri di accettazione**

- nessun ID progressivo nel link;
- token scaduto o revocato non espone dati;
- dopo il cutoff non sono possibili mutazioni;
- tutte le operazioni sono auditate.

**Test obbligatori**

- token valido, errato, revocato e scaduto;
- cutoff pranzo/cena;
- durata configurabile;
- modifica concorrente;
- cancellazione e liberazione coperti;
- indicizzazione e cache headers;
- lint, typecheck e build.

**Definizione di completamento**

Il cliente può gestire in sicurezza la singola prenotazione entro i limiti approvati.

### M8 — Dashboard e prenotazioni telefoniche

**Obiettivo**

Fornire al personale l'operatività giornaliera.

**Funzioni incluse**

- dashboard sul giorno corrente;
- totali, coperti, disponibilità, esigenze e non assegnate;
- inserimento telefonico rapido;
- origine `PHONE`;
- consenso verbale, versione informativa, data/ora e utente;
- override con motivazione;
- modifica e cancellazione Staff/Admin.

**Funzioni escluse**

- assegnazione tavoli;
- export;
- notifiche reali.

**Dipendenze**

M3, M5 e M7.

**Criteri di accettazione**

- la prenotazione telefonica usa lo stesso database e la stessa capacità;
- i dati di consenso richiesti sono sempre presenti;
- dashboard coerente dopo creazione, modifica e cancellazione.

**Test obbligatori**

- E2E Staff/Admin;
- consenso telefonico obbligatorio;
- totali e filtri;
- override;
- autorizzazioni;
- layout responsive;
- lint, typecheck e build.

**Definizione di completamento**

Il personale può gestire il ciclo principale senza strumenti esterni.

### M9 — Pannello amministratore

**Obiettivo**

Rendere modificabili le configurazioni operative.

**Funzioni incluse**

- utenti e ruoli;
- orari, cutoff, limite e servizi;
- aperture e chiusure straordinarie;
- sale e tavoli;
- Galleria e Terrazzo;
- contatti e testi pubblici;
- durata link;
- consultazione audit.

**Funzioni escluse**

- configurazione dei provider reali;
- infrastruttura di backup.

**Dipendenze**

M3, M4 e M8.

**Criteri di accettazione**

- solo Admin modifica configurazioni e utenti;
- cambiamenti con prenotazioni esistenti producono avvisi e audit;
- una riduzione del limite non cancella prenotazioni esistenti.

**Test obbligatori**

- matrice Admin/Staff;
- validazione configurazioni;
- modifiche con prenotazioni esistenti;
- audit prima/dopo;
- lint, typecheck e build.

**Definizione di completamento**

Le configurazioni approvate non richiedono modifiche al codice.

**Checkpoint M9-A — revisionato e approvato da Work**

M9-A registra le decisioni vincolanti, introduce l'audit generico per autenticazione e configurazioni M4, minimizza e sanifica gli snapshot prenotazione, rende atomiche le scritture audit, rafforza la lettura Admin e sostituisce la cancellazione delle date straordinarie con archiviazione reversibile. Non completa M9: utenti, `ServiceInstance`, motore d'impatto, nuove regole di cutoff, funzioni sale/tavoli, contatti/testi, durata link e consultazione audit restano checkpoint successivi.

**Checkpoint M9-B — revisionato e approvato da Work**

M9-B implementa account individuali Admin/Staff, password temporanee one-shot, cambio obbligatorio e volontario, revoca completa delle sessioni, protezione concorrente dell'ultimo Admin e audit atomico delle identità. Non completa M9: `ServiceInstance`, motore d'impatto, nuove regole di cutoff, funzioni sale/tavoli, contatti/testi pubblici, durata link e consultazione audit restano checkpoint successivi.

**Checkpoint M9-C — revisionato e approvato da Work**

M9-C implementa gestione Admin di servizi e orari settimanali, limite di capacità, cutoff di modifica/cancellazione e regole generiche di cutoff pubblico per giorno e servizio. Il motore d'impatto minimizzato copre questo perimetro con conferma esplicita, fingerprint, ricalcolo `SERIALIZABLE`, lock advisory per ristorante e audit atomico; le prenotazioni esistenti non vengono mutate. Slot e finestra V1 sono vincolati a 15 e 30 minuti. Non completa M9: `ServiceInstance`, disponibilità sale per servizio, funzioni sale/tavoli, contatti/testi pubblici, durata link e consultazione audit restano checkpoint successivi.

**Checkpoint M9-D — revisionato e approvato da Work; note chiuse in M9-E**

M9-D implementa `ServiceInstance` minimale e lazy, disponibilità delle cinque sale per data/servizio, policy `EXPLICIT_ONLY` per Galleria/Terrazzo, lifecycle globale reversibile delle sale e catalogo tavoli senza assegnazioni. Letture, preview e no-op non materializzano; mutazioni effettive usano fingerprint, lock, transazioni `SERIALIZABLE` e audit minimizzato. Le note residue su contatti, testi e durata link sono state chiuse in M9-E; la consultazione audit è stata completata in M9-F. L'assegnazione di sale e tavoli resta separata in M10.

**Checkpoint M9-E — revisionato e approvato da Work; note chiuse in M9-F**

M9-E implementa configurazione Admin dei contatti pubblici, URL canonico, sette contenuti editoriali completi IT/EN e durata da 1 a 24 ore per i nuovi link. Le pagine pubbliche preservano `lang`; mutazioni e audit minimizzato sono atomici e concorrenti; token e hash esistenti restano invariati e il reschedule conserva la durata originaria anche con DST. M9-F aggiunge le verifiche esplicite su email, completezza esatta delle 14 righe, rollback e lettura concorrente old/new.

**Checkpoint M9-F — revisionato e approvato tecnicamente da Work**

M9-F implementa la consultazione Admin read-only dei due registri audit tramite proiezione unificata minimizzata, tenant filter per sorgente, ordinamento globale, cursor keyset, filtri server-side e dettaglio a allow-list resistente a eventi legacy ostili. Non aggiunge schema, migrazioni, dipendenze, seed o scritture. La Milestone M9 è tecnicamente completata e approvata da Work. Il relativo change set è tracciato nella PR #10. Al momento di questo checkpoint, deploy e M10 non rientravano nella chiusura M9.

### M10 — Assegnazione manuale di sala e tavoli

**Obiettivo**

Supportare la preparazione operativa del servizio.

**Funzioni incluse**

- sala definitiva;
- uno o più tavoli manuali;
- note interne;
- assegnazione in qualsiasi momento;
- preferenza originaria sempre visibile;
- audit delle riassegnazioni.

**Funzioni escluse**

- calcolo automatico;
- combinazione automatica;
- controllo automatico della durata tavolo.

**Dipendenze**

M8 e M9.

**Criteri di accettazione**

- Staff e Admin possono assegnare e correggere;
- sale e tavoli inattivi non sono assegnabili senza gestione esplicita;
- le 17:30 non sono un blocco tecnico.

**Test obbligatori**

- assegnazione e riassegnazione;
- uno o più tavoli;
- autorizzazioni;
- preferenza preservata;
- audit;
- lint, typecheck e build.

**Definizione di completamento**

La dashboard distingue chiaramente preferenza, sala definitiva e non assegnate.

**Checkpoint M10-A — fondazione server-side, approvata tecnicamente da Work e merged su `main`**

M10-A formalizza D-037 e ADR 011, introduce una sola migrazione additiva per assegnazione e tavoli, dominio/repository/servizio nel modulo Rooms, API Staff/Admin `GET`/`PUT`/`DELETE`, audit prenotazione minimizzato, tenant isolation, autorizzazione, concorrenza e test PostgreSQL. Non modifica reschedule, cancellazione, configurazione sale/tavoli o superfici pubbliche; non aggiunge UI o Playwright. M10-A non completa M10.

**Checkpoint M10-B — integrazioni lifecycle, approvata tecnicamente da Work e merged su `main`**

M10-B applica la rimozione logica atomica su cambio data/servizio/orario con singolo incremento versione, audit `UPDATED`/`UNASSIGNED` correlato e motivazione canonica. Modifiche agli altri campi e cancellazioni conservano l'assegnazione; le cancellate sono escluse dagli impatti operativi. Il protocollo M9-D include disattivazione sala, disattivazione tavolo e indisponibilità per data/servizio, con conteggi minimizzati, conferma, fingerprint ricalcolato, `IMPACT_CHANGED`, audit atomico e grandfathering. Non aggiunge schema né una UI di assegnazione e non completa M10.

**Checkpoint M10-C — operatività visuale approvata da Work e merged su `main` con la PR #12**

M10-C integra nel read model tenant-scoped assegnazione attiva, filtri `DA ASSEGNARE`/assegnate e sala definitiva, indicatori dei coperti non assegnati e per sala finale. Il pannello responsive riusa le API M10-A per prima assegnazione, riassegnazione, note e clear, mostra posti informativi e riferimenti grandfathered e richiede una rilettura esplicita sui conflitti di versione. I test unitari, PostgreSQL e Playwright coprono il checkpoint approvato. Con il merge di M10-C, M10 è completata e merged su `main`; M11 è la milestone successiva e non è ancora iniziata.

### M11 — Esportazioni PDF ed Excel

**Obiettivo**

Produrre documenti operativi senza alterare la fonte dati.

**Funzioni incluse**

- PDF A4 con `DA ASSEGNARE` e sale nell'ordine approvato;
- ordinamento per creazione dentro ogni sezione;
- Excel per giorno;
- Excel per mese, un foglio per giorno;
- Excel per intervallo, un foglio per giorno;
- audit del download.

**Funzioni escluse**

- importazione Excel;
- workbook permanente;
- conservazione server dei file.

**Dipendenze**

M8 e M10.

**Criteri di accettazione**

- file leggibili e coerenti con PostgreSQL;
- errori di generazione non modificano prenotazioni;
- accesso limitato a Staff/Admin.

**Test obbligatori**

- ordine sezioni e righe;
- prenotazioni non assegnate;
- intervallo e mese;
- caratteri italiani;
- autorizzazioni;
- failure injection;
- lint, typecheck e build.

**Definizione di completamento**

PDF e Excel sono esportazioni riproducibili della dashboard.

### M12 — Outbox e provider simulati

**Obiettivo**

Preparare notifiche affidabili senza comunicazioni esterne.

**Funzioni incluse**

- interfacce WhatsApp/email;
- `notification_outbox` e `notification_attempts`;
- provider simulati;
- retry e idempotenza;
- canale principale, fallback e parallelo configurabili;
- reminder tre ore prima.

**Funzioni escluse**

- Meta Cloud API;
- provider email reale;
- gruppo WhatsApp.

**Dipendenze**

M7 e M8.

**Criteri di accettazione**

- prenotazione valida anche con provider sempre in errore;
- nessun invio duplicato dopo retry;
- staging e sviluppo non possono selezionare provider reali.

**Test obbligatori**

- successo, errore temporaneo e permanente;
- retry con backoff;
- fallback email;
- invio parallelo;
- prenotazione a meno di tre ore;
- modifica/cancellazione del reminder;
- lint, typecheck e build.

**Definizione di completamento**

La pipeline di notifica è verificata interamente con mock.

### M13 — Staging personale

**Obiettivo**

Validare il sistema remoto con dati fittizi.

**Funzioni incluse**

- applicazione Render personale;
- database staging separato;
- migrazioni;
- seed fittizio;
- provider simulati obbligatori;
- smoke test e Playwright staging.

**Funzioni escluse**

- sito ufficiale;
- dominio e account del ristorante;
- dati o backup di produzione;
- provider reali.

**Dipendenze**

M1–M12.

**Criteri di accettazione**

- ambiente ricreabile;
- nessun invio esterno possibile;
- nessuna dipendenza permanente da account personali nel codice.

**Test obbligatori**

- deploy e migrazioni;
- smoke test;
- E2E principali;
- controllo dati fittizi;
- controllo kill switch provider;
- build.

**Definizione di completamento**

Staging dimostra il funzionamento senza diventare base della produzione.

### M14 — Provider reali

**Obiettivo**

Preparare le integrazioni di produzione senza cambiare la logica delle prenotazioni.

**Funzioni incluse**

- adattatore Meta WhatsApp Cloud API ufficiale;
- adattatore email scelto;
- notifica a numero interno;
- configurazione fallback/parallelo;
- contract test e gestione errori provider.

**Funzioni escluse**

- API WhatsApp non ufficiali;
- WhatsApp Web;
- dipendenza obbligatoria dal gruppo WhatsApp;
- abilitazione dei provider reali nello staging personale.

**Dipendenze**

M12 e M13.

**Criteri di accettazione**

- gli adattatori rispettano le stesse interfacce dei mock;
- gli errori non invalidano prenotazioni;
- dashboard e numero interno funzionano senza gruppo.

**Test obbligatori**

- contract test;
- idempotenza;
- timeout e rate limit provider;
- fallback e parallelo;
- redazione dei log;
- lint, typecheck e build.

**Definizione di completamento**

I provider sono pronti per essere configurati negli account del ristorante.

### M15 — Produzione, backup e consegna

**Obiettivo**

Creare e consegnare l'ambiente ufficiale del ristorante.

**Funzioni incluse**

- account intestati al ristorante;
- database nuovo;
- dominio ufficiale;
- segreti e provider reali;
- backup coerenti con RPO massimo 15 minuti;
- procedure coerenti con RTO massimo 4 ore;
- prova di ripristino;
- runbook e consegna credenziali.

**Funzioni escluse**

- promozione del database staging;
- dati fittizi residui;
- dipendenze operative da account personali.

**Dipendenze**

Tutte le milestone precedenti.

**Criteri di accettazione**

- collaudo del ristorante;
- backup e restore verificati;
- proprietà degli account documentata;
- piano di rollback;
- monitoraggio operativo essenziale.

**Test obbligatori**

- migrazione su database nuovo;
- E2E controllato;
- verifica cookie e HTTPS;
- prova restore;
- verifica RPO/RTO documentale e operativa;
- test autorizzazioni e notifiche.

**Definizione di completamento**

Il ristorante può gestire e riprodurre il sistema senza account personali dello sviluppatore.

## 4. Funzioni rinviate oltre la prima versione

- assegnazione automatica e combinazione tavoli;
- gruppo WhatsApp, salvo disponibilità di API ufficiali;
- account cliente;
- CRM;
- pagamenti;
- meteo automatico;
- importazione Excel;
- microservizi;
- multi-ristorante;
- analytics avanzate.
