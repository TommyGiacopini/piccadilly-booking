# ADR 012 — PDF operativo V2

**Stato:** approvato dal Controller CLASSIC per implementazione locale T10, 30 ottobre 2026; WORK3 Final QG richiesto.

## Contesto
M11 esporta l'intera giornata in landscape. T09 introduce selezione e preview positive, prive di NI e contatti, con servizio esplicito, gruppi e ordinamenti canonici. Il personale richiede un documento A4 portrait leggibile e spazio per i tavoli annotati a penna.

## Decisione
Endpoint dedicato POST /api/staff/exports/pdf-v2, senza modificare le route legacy. Riutilizzo del reader, builder, guard e body reader T09; nuovo service con porte, DTO positivo privo anche dei tavoli digitali, layout misurato e renderer PDFKit separato. Nessun package, migration o tabella nuova.

C03 definitiva impone Tavolo completamente vuota; sala effettiva conservata, nessuna modifica alle assegnazioni digitali. A4 portrait B/N, margini12mm, corpo10,5pt, coperti14pt, righe almeno20mm, area penna almeno18×12mm. Continuazioni esplicite, intestazioni/sezione ripetute, Pagina N, nessun page cap/shrink/troncamento.

Snapshot indipendente dalla preview. Binding obbligatorio e autenticazione request-scoped, body2048byte effettivi, cap2000/cap+1 e25MiB, nessun download anonimo. Audit SUCCESS canonico completato prima della risposta, FAILURE senza loop; nessuna nuova metadata. Nessuna persistenza del documento.

## Alternative
Estendere /pdf con union V1/V2 avrebbe accoppiato compatibilità headerless e nuovo confine bound. Endpoint dedicato mantiene protetti renderer e contratti M11. Buffering di tutte le pagine per N di M respinto a favore di Pagina N e rilascio progressivo. Tavoli digitali più spazio penna respinti dal Controller; appendice telefoni non autorizzata.

## Conseguenze e verifica
Proiezione e rendering V2 separati evitano reinterpretazioni legacy. I limiti output non limitano il picco RAM: servono misure locali RSS/heap/external/ArrayBuffer e durata senza certificazione produttiva. Geometria verificata sia sul layout sia sul PDF effettivo con PDF.js, poi rasterizzazione e review visiva. NC conservate, compresi eventuali contatti liberamente digitati; NI e contatti strutturati esclusi dalla query.

## Governance
20 path esatti,7M/13A/0D,460 file finali previsti e440 baseline protetti. Test mutativi esclusivamente su PostgreSQL temporaneo verificato prima di seed/migration. Worktree storici preservati. T10 non CLOSED; pubblicazione Git, PR, merge, deploy, T11 e M13 non autorizzati. Riserve storiche conservate.
