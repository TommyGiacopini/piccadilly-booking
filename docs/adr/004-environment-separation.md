# ADR 004 — Separazione degli ambienti

**Stato:** accettato
**Data:** 31 luglio 2026

## Contesto

Il progetto nasce su strumenti personali per sviluppo e staging, ma la produzione finale deve appartenere al Risto Pizza Piccadilly. Dati reali, numeri, domini, credenziali e provider non possono essere confusi con risorse di prova.

Il database staging non deve diventare il database di produzione. Nessuna funzione deve dipendere permanentemente da account personali dello sviluppatore.

## Decisione

Mantenere tre ambienti isolati.

### Sviluppo locale

- applicazione locale;
- PostgreSQL tramite Docker Compose;
- seed e dati esclusivamente fittizi;
- provider WhatsApp ed email simulati;
- segreti locali in file esclusi da Git.

### Staging personale

- applicazione e database dedicati;
- dati esclusivamente fittizi;
- provider simulati obbligatori;
- nessun collegamento al sito o dominio ufficiale;
- banner e identificazione visibile dell'ambiente;
- nessun dump o backup di produzione.

### Produzione del ristorante

- account intestati al ristorante;
- database nuovo;
- dominio, email, WhatsApp e segreti del ristorante;
- backup e monitoraggio reali;
- obiettivo RPO massimo 15 minuti;
- obiettivo RTO massimo 4 ore.

Configurazioni e segreti non sono hardcoded. Un kill switch impedisce ai provider reali di essere attivati in sviluppo e staging. Le migrazioni vengono applicate separatamente a ciascun database.

La produzione viene ricreata dalla configurazione e dalle migrazioni, non promuovendo il database staging.

## Conseguenze

### Positive

- nessun cliente reale riceve messaggi di prova;
- staging può essere azzerato senza rischio per la produzione;
- proprietà e consegna al ristorante sono chiare;
- il sistema è riproducibile su un nuovo account;
- segreti e dati hanno confini espliciti.

### Negative e vincoli

- occorrono configurazioni e database distinti;
- la produzione richiede bootstrap e collaudo separati;
- non si può usare staging come scorciatoia per la consegna;
- le procedure di backup e restore devono essere sviluppate e provate;
- i test con provider reali richiedono risorse controllate del ristorante.

## Alternative rifiutate

### Database condiviso fra staging e produzione

Rifiutato per rischio di contaminazione, cancellazione e invii verso clienti reali.

### Promozione del database staging

Rifiutata perché lo staging usa dati fittizi e account personali.

### Provider reali in staging

Rifiutati perché possono generare comunicazioni involontarie e dipendenze da risorse personali.

### Segreti nel repository

Rifiutati perché esposti alla cronologia Git e incompatibili con la rotazione sicura.

### Dipendenza permanente dall'hosting personale

Rifiutata perché la produzione e il codice finale devono appartenere al ristorante.
