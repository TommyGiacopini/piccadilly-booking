# ADR 007 — Lifecycle delle configurazioni, impatto e grandfathering

**Stato:** accettato
**Data:** 12 agosto 2026
**Aggiornamento:** 12 agosto 2026 — D-032, D-033 e M9-D

## Contesto

Una modifica amministrativa può rendere inattivi servizi, sale, tavoli o eccezioni già referenziati da prenotazioni future. Bloccare sempre la modifica impedirebbe la gestione operativa; applicarla retroattivamente alle prenotazioni creerebbe perdita o alterazione non autorizzata.

## Decisione

### Lifecycle

- Le sale V1 sono Sala 1, Sala 2, Sala 3, Galleria e Terrazzo, con codice immutabile; non si creano o eliminano sale arbitrarie.
- `DA ASSEGNARE` è una categoria virtuale della dashboard e non una `Room`.
- Le sale non possono essere rinominate o trasformate. L'Admin ne modifica soltanto stato e ordine.
- La policy persistita della sala non è modificabile dall'Admin: Sala 1/2/3 sono `DEFAULT_AVAILABLE`, Galleria/Terrazzo sono `EXPLICIT_ONLY`.
- Sale, servizi e tavoli vengono disattivati, non cancellati.
- I tavoli possono essere creati, aggiornati, disattivati e riattivati; un cambio sala richiede disattivazione e nuova creazione.
- Le eccezioni per data vengono archiviate e riattivate. Le query operative ignorano le righe archiviate; una nuova creazione con la stessa identità riattiva coerentemente la riga.

M9-A implementa soltanto il lifecycle reversibile delle date straordinarie già gestite da M4.

### Impatto

Una futura modifica con prenotazioni coinvolte applica:

1. anteprima server-side senza PII;
2. conteggio e classificazione delle prenotazioni future;
3. conferma esplicita dell'Admin;
4. ricalcolo nella transazione;
5. rifiuto `IMPACT_CHANGED` se l'impatto è cambiato;
6. applicazione della sola configurazione;
7. audit di impatto e conferma.

L'avviso è confermabile e non costituisce un blocco definitivo. M9-C implementa il motore per impostazioni di prenotazione, servizi settimanali e cutoff pubblici. L'anteprima espone soltanto conteggi, coperti, classificazione, data, servizio, slot, limiti e carico massimo; non espone PII o identificativi di prenotazione.

La conferma contiene proposta e fingerprint server-side. L'applicazione rilegge attore, configurazione, eccezioni attive e prenotazioni future confermate dentro una transazione `SERIALIZABLE`, dopo un lock advisory stabile per ristorante. Se proposta, configurazione o carico rilevante sono cambiati, restituisce `IMPACT_CHANGED` con una nuova anteprima e non produce mutazione o audit. L'aggiornamento e l'audit minimizzato sono atomici; i no-op non producono eventi.

Le classificazioni M9-C sono servizio disabilitato, fuori dai nuovi orari, capacità superata e cutoff di modifica cambiato. Le eccezioni attive mantengono la precedenza; le righe archiviate vengono ignorate. Cutoff pubblici e modifiche senza effetto sulle prenotazioni sono rappresentati esplicitamente come assenza di impatto esistente. M9-D estende lo stesso protocollo a disponibilità locale e disattivazione globale delle sale. Rendere disponibile una sala, modificarne l'ordine, materializzare lo stato predefinito o gestire tavoli non assegnati non costituisce impatto prenotazioni inventato.

### Grandfathering

Le prenotazioni confermate non vengono invalidate, modificate o cancellate automaticamente. Dati invariati possono restare anche se sala o servizio sono inattivi. Modifiche a contatti, note o richieste restano consentite. Nuovi data, servizio, ora o sala e gli aumenti di coperti rispettano le regole correnti; la riduzione dei coperti sullo stesso servizio resta consentita.

Una preferenza di sala già salvata resta visibile e conservata se la sala diventa inattiva o indisponibile. Una modifica che non cambia sala, data o servizio conserva la preferenza storica; una nuova selezione rispetta lo stato effettivo corrente.

## Conseguenze

- la storia operativa resta coerente e nessuna configurazione perde prenotazioni;
- le query tecniche devono distinguere righe attive da archiviate;
- le mutazioni ad impatto usano un protocollo a due passi con controllo concorrenziale; M9-C lo applica al proprio perimetro e i checkpoint successivi devono riutilizzarlo;
- l'audit conserva conteggi e classificazioni, non elenchi con PII.

## Addendum T05 — presentazione operativa (9 ottobre 2026)

D-045 introduce soltanto label Staff/Admin Sala 3 — Giochi (`sala-3`) e indicatore neutro Area legacy per Galleria/Terrazzo. Identità/name persistiti, code, policy, seed/default, DTO/API e audit storico non cambiano. La preferenza storica non riceve l'alias. Categoria grafica derivata da un helper puro, mai criterio di disponibilità o mutation.

DEFAULT_AVAILABLE/EXPLICIT_ONLY, configurazione per data/servizio, servizio aperto e stato globale restano M9; legacy realmente disponibili ammettono nuove assegnazioni. Stato globale, configurata ed effettiva sono distinti nella UI. Storico locale read-only e globale attuale; GET/preview/no-op senza materializzazione. Ordine Admin displayOrder/code preservato.

Grandfathering, fingerprint/apply, audit atomico, T04 no-op/concorrenza e Foundation/T03 restano canonici. Nessun rename, retired implicito, cleanup, migration16 o nuova policy capacity/collision/auto-assignment. Schema15 e checkpoint M9/M10 preservati; nessuna modifica Public/export o avvio T06/Render/Asporti. Implementazione locale soggetta a Work Final QG e separata autorizzazione Git.

## Alternative rifiutate

- Cancellazione fisica: rifiutata per perdita di storia e riferimenti.
- Blocco assoluto quando esistono prenotazioni: rifiutato perché non permette una conferma consapevole.
- Aggiornamento retroattivo delle prenotazioni: rifiutato perché viola il grandfathering.
