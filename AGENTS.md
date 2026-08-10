# Piccadilly Booking — Istruzioni permanenti per Codex



## Missione



Costruire il sistema proprietario di prenotazione del Risto Pizza Piccadilly.



Il sistema deve diventare l'unica fonte ufficiale per:



\- prenotazioni online;

\- prenotazioni telefoniche;

\- modifiche;

\- cancellazioni;

\- preferenze di sala;

\- assegnazione manuale dei tavoli;

\- notifiche WhatsApp;

\- archivio giornaliero;

\- esportazione Excel;

\- stampa PDF.



## Documentazione ufficiale



Prima di pianificare o modificare il codice, leggere:



\- `AGENTS.md`;

\- `docs/PROJECT\_SPEC.md`;

\- `docs/ARCHITECTURE.md`, quando disponibile;

\- `docs/ROADMAP.md`, quando disponibile;

\- `docs/DECISIONS.md`, quando disponibile;

\- `docs/SECURITY.md`, quando disponibile.

\- `docs/GIT_WORKFLOW.md`, quando disponibile.



`docs/PROJECT\_SPEC.md` è la fonte ufficiale dei requisiti funzionali.



In caso di conflitto tra il codice e le specifiche, non modificare automaticamente il comportamento approvato. Segnalare prima il conflitto.



## Metodo di lavoro



1\. Non costruire tutto il gestionale in una singola attività.

2\. Lavorare su una sola milestone o funzionalità coerente per volta.

3\. Prima di modificare i file, esaminare il repository e proporre un piano breve.

4\. Non effettuare modifiche estranee alla richiesta.

5\. Non cambiare architettura senza documentare la decisione.

6\. Seguire `docs/GIT_WORKFLOW.md`: commit e push sono consentiti soltanto al gate finale di una milestone completa, testata e revisionata; merge e deploy richiedono sempre una richiesta esplicita.

7\. Non lavorare direttamente sul branch `main`.

8\. Non eliminare codice funzionante senza una ragione verificabile.

9\. Mostrare sempre i file modificati.

10\. Dichiarare chiaramente ciò che non è stato testato.



## Ambienti



Il progetto deve mantenere separati:



1\. sviluppo locale;

2\. staging personale;

3\. produzione del ristorante.



Regole:



\- sviluppo e staging devono utilizzare dati fittizi;

\- il database di staging non diventerà quello di produzione;

\- la produzione verrà ricreata su account intestati al ristorante;

\- nessuna funzione deve dipendere permanentemente da account personali;

\- domini, numeri, credenziali e provider devono essere configurabili;

\- il progetto deve essere riproducibile su un nuovo account di hosting.



## Stack tecnico iniziale



\- Next.js con App Router;

\- TypeScript in modalità strict;

\- PostgreSQL;

\- Prisma ORM;

\- Zod per la validazione;

\- Tailwind CSS;

\- npm;

\- Docker Compose per PostgreSQL locale;

\- Vitest per test unitari;

\- Playwright per test end-to-end;

\- GitHub Actions;

\- predisposizione per Render.



Non aggiungere dipendenze importanti senza motivarne l'utilità.



## Fonte ufficiale dei dati



PostgreSQL è la fonte ufficiale dei dati.



Excel e PDF sono soltanto:



\- esportazioni;

\- strumenti di consultazione;

\- documenti operativi;

\- documenti di stampa.



Excel non deve essere utilizzato come database principale.



## Regole sulle prenotazioni



\- salvare la prenotazione nel database prima di inviare notifiche;

\- un errore WhatsApp non deve perdere la prenotazione;

\- un errore email non deve perdere la prenotazione;

\- un errore PDF o Excel non deve perdere la prenotazione;

\- le prenotazioni annullate non devono essere eliminate fisicamente;

\- ogni modifica deve essere registrata;

\- le operazioni importanti devono entrare nell'audit log;

\- i link pubblici non devono contenere ID progressivi prevedibili;

\- le modifiche a data, ora o numero di ospiti devono ricontrollare la disponibilità.



## WhatsApp ed email



WhatsApp ed email devono essere implementati attraverso interfacce astratte.



Durante sviluppo e staging utilizzare provider simulati.



Non utilizzare:



\- API WhatsApp non ufficiali;

\- automazioni basate su WhatsApp Web;

\- account Meta personali definitivi;

\- numeri reali di clienti nei test.



Le risorse Meta e WhatsApp definitive verranno create direttamente per il ristorante.



## Sicurezza



\- non salvare segreti nel repository;

\- escludere `.env` da Git;

\- fornire `.env.example` con valori fittizi;

\- validare tutti gli input sul server;

\- proteggere le password con un algoritmo sicuro;

\- usare cookie HttpOnly, Secure e SameSite;

\- proteggere tutte le route amministrative;

\- applicare rate limiting alle API pubbliche;

\- usare token casuali, lunghi e non sequenziali;

\- non inserire dati sensibili nei log;

\- limitare le operazioni in base al ruolo;

\- registrare le operazioni amministrative.



## Qualità obbligatoria



Prima di dichiarare conclusa un'attività:



1\. eseguire il lint;

2\. eseguire il typecheck;

3\. eseguire i test pertinenti;

4\. eseguire la build;

5\. indicare i comandi eseguiti;

6\. segnalare eventuali errori;

7\. riepilogare i file modificati.



Non dichiarare completata una funzione quando i test falliscono.



## Git



\- branch principale: `main`;

\- non modificare direttamente `main`;

\- usare un branch per ogni milestone;

\- mantenere commit piccoli e descrittivi;

\- non eseguire force push;

\- non riscrivere la cronologia;

\- seguire il gate di pubblicazione definito in `docs/GIT_WORKFLOW.md`;

\- eseguire commit e push soltanto dopo implementazione completa, test superati, review superata, diff pulito e verifica del branch;

\- effettuare il push esclusivamente verso il feature branch corrente;

\- non richiedere una conferma aggiuntiva per commit e push quando tutte le condizioni del gate sono dimostrate;

\- non eseguire merge, Pull Request, release o deploy senza una richiesta esplicita separata.



## Interfaccia



La grafica pubblica deve essere moderna e coordinata con il sito Piccadilly.



Colori principali:



\- nero;

\- bianco;

\- arancione;

\- grigio chiaro.



Requisiti:



\- responsive;

\- utilizzabile da smartphone, tablet e PC;

\- interfaccia pubblica in italiano e inglese;

\- niente fotografie nella prima versione;

\- logo aggiunto successivamente.



## Lingue del progetto



\- codice e nomi delle variabili: inglese;

\- commenti tecnici: inglese;

\- interfaccia: italiano e inglese;

\- documentazione: italiano;

\- messaggi Git: inglese.



## Comportamento richiesto a Codex



Prima di implementare:



1\. leggere le istruzioni e la documentazione;

2\. ispezionare il repository;

3\. identificare i file coinvolti;

4\. proporre un piano breve;

5\. implementare soltanto la richiesta corrente;

6\. eseguire i test;

7\. effettuare una revisione finale.



Non eseguire autonomamente operazioni irreversibili. L'autorizzazione condizionata di `docs/GIT_WORKFLOW.md` riguarda esclusivamente staging, commit finale e push non forzato del feature branch.
