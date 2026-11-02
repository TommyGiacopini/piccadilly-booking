# ADR 013 — Excel operativo V2

**Stato:** ratificato Controller CLASSIC per implementazione locale T11; WORK3 Final QG obbligatorio.

## Contratto
Endpoint dedicato POST /api/staff/exports/excel-v2, schema V2 strict target EXCEL e solo DAY/LUNCH/DINNER con sala/ordine T09. Un Agenda visibile, contesto righe1–6, intestazioni7, dati8+, freeze7/2, filtro A7:Nultima solo se presenti prenotazioni. Nessun foglio aggiuntivo o riga artificiale vuota. Quattordici colonne: Ordine; Sala effettiva; Arrivo; Cognome; Nome; Coperti; Adulti; Bambini; Composizione; Giochi; Preferenza sala (storica); Esigenze/richieste; Note cliente NC; Prenotata il.

K usa preferredRoom senza duplicarlo in L e sostituisce la proposta tavoli digitali respinta. Nessun riferimento digitale ai tavoli nel DTO/workbook. N usa wall-clock tipizzato del ristorante, timezone esplicita, formato italiano dd/mm/yyyy hh:mm. Conversione da istante con Intl/timezone esplicita, non timezone macchina. L'ora ripetuta autunnale non distingue tutti gli istanti; ordine iniziale deriva dal builder T09 e non viene ricalcolato sulle celle locali.

Composizione TA con bambini0/adulti=partySize, DECLARED con conteggi noti, UNKNOWN con entrambi null e flag legacy esplicito. Giochi non equivale assegnazione. Totali selezione server invarianti ai filtri Excel con dicitura italiana; Ordine ricostruisce la sequenza iniziale.

## Architettura e alternative
Riutilizzo diretto reader e builder T09, nuovo DTO positivo distinto da PDF, nuova policy, renderer streaming ExcelJS4.4.0 interno con sink bounded e shared strings. Nessun HTTP stream prima dell'audit SUCCESS, nessun file temporaneo, nuova dipendenza o migration. Endpoint legacy/renderer M11 e PDF V2 protetti; MONTH/RANGE rimangono M11. Estensione del vecchio endpoint e workbook combinato/multi-day non approvati.

La policy valida UTF16/XML, non elimina controlli o tronca stringhe. Sanitizer M11 invariato per neutralizzare formule; escape ST_Xstring dei letterali riservati e CR; XML escaping del writer una sola volta. Limiti32767 unità UTF16 dopo prefisso e253 LF; errori sanitizzati per dati non rappresentabili. Shared strings verificate dopo decodifica singola. Tab/LF e combinanti/emoji validi conservati. Nessuna normalizzazione Unicode estetica. Il testo che supera l'altezza riga massima409pt resta completo nel valore, consultabile nell'editor; no shrink automatico. Nessuna cella unita nell'area filtrabile.

## Sicurezza e audit
Auth/Origin/password/binding/body2048 canonici T09 invariati, tenant server-side, no-store. Busy/proof/fencing/abort/session switch/stale response e Object URL controllati nel browser, nessun fallback. Rilettura indipendente dalla preview. NI e contatti strutturati fuori query; NC integrali possono contenere contatti/tavoli liberi. Metadata statici senza PII cliente.

Audit EXCEL/DAY canonico dopo rendering e prima della consegna; SUCCESS fallito scarta file, FAILURE singolo senza loop, nessuna scrittura business. Mancata distinzione V1/V2 e filtri nell'audit esplicitamente accettata. Cap20000/cap+1 dopo filtri,25MiB output, overflow mai parziale.

## Limiti e verifica
Streaming rilascia righe ma conserva dataset/shared strings/stili/buffer ZIP, concatenazione e copia risposta: non è memoria costante né capacità produttiva certificata. Gate su 0/1/101/20000/20001, stringhe ripetute/distinte/lunghe, overflow/sink failure e concorrenza controllata. Misure RSS/heap/external/ArrayBuffer/durata/dimensioni XLSX/XML decompresso. Analisi indipendente ZIP CRC/XML namespace-aware oltre alla riapertura ExcelJS. Test mutativi solo su DB temporaneo identificato prima di migration/seed/runner; ogni receipt conserva candidato e runtime effettivi, incluso mancato pin se assente. Failure intermedie conservate.

## Governance
20 path esatti7M/13A/0D,473 finali e453 protetti dalla baseline460. Nessuna modifica a T09/T10/M11/package/schema/migration1–16. T11 non CLOSED, nessuno staging/commit/push/PR/merge/deploy; WORK3 richiesto. M13 ON_HOLD, Render/Tailscale vietati. Tutte le riserve T10/T09/storiche restano aperte.

Il cleanup osserva anche la Promise di Archiver.finalize che ExcelJS4.4 ignora: dopo un sink failure e abort tardivo, il rigetto è inoltrato al listener error del writer. Verifica dedicata in processo Node con unhandled-rejections=strict oltre al gate Vitest; nessuna modifica al package.

La cella N usa il valore numerico nativo Excel con stile data/ora: conversione del wall-clock nel sistema1900, inclusa la discontinuità del fittizio29/02/1900. Evita lo scarto del convertitore Date ExcelJS per gennaio/febbraio1900; casi1,59,61 verificati nell'XML reale. Non modifica M11, non introduce formule o colonne UTC.
