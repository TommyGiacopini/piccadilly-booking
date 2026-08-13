# Riepilogo canonico M9

**Stato al 13 agosto 2026:** `M9 IMPLEMENTATA LOCALMENTE — REVISIONE FINALE WORK RICHIESTA`.

La chiusura effettiva, il commit, la pubblicazione del branch e la pull request richiedono un incarico successivo. Il lavoro resta sul branch locale `feature/admin-panel`; non sono stati eseguiti deploy né usati dati reali o provider esterni.

## Checkpoint

- **M9-A — audit e privacy:** introduce `AuditEvent`, mantiene `ReservationAuditEvent` specializzato, rende atomiche le scritture audit, sanifica gli snapshot prenotazione legacy e rende reversibili le date straordinarie.
- **M9-B — utenti:** account individuali Admin/Staff, password temporanea one-shot, cambio obbligatorio, revoca sessioni, disattivazione senza eliminazione e protezione concorrente dell'ultimo Admin.
- **M9-C — servizi, cutoff e capacità:** orari settimanali, limite coperti, cutoff di gestione e regole pubbliche generiche, con preview minimizzata, fingerprint, lock e ricalcolo `SERIALIZABLE`.
- **M9-D — istanze e sale:** `ServiceInstance` lazy, disponibilità per servizio delle cinque sale, policy `DEFAULT_AVAILABLE`/`EXPLICIT_ONLY`, lifecycle sale e catalogo tavoli senza assegnazioni.
- **M9-E — configurazione pubblica:** contatti, URL canonico, sette contenuti completi IT/EN e durata prospettica dei nuovi link; token esistenti e durata originaria al reschedule restano preservati.
- **M9-F — consultazione audit:** lista unificata read-only, filtri server-side, ordinamento globale, cursore keyset e dettaglio a allow-list resistente a JSON legacy ostile.

Le note finali M9-E sono chiuse da test espliciti: i sei scenari browser coprono sette requisiti, l'email preserva la parte locale e normalizza solo il dominio, PostgreSQL conserva esattamente 14 contenuti e un lettore concorrente vede soltanto il vecchio o il nuovo set completo. Sono inoltre rieseguite le verifiche prospettiche e DST dei token.

## Decisioni e architettura

D-022–D-035 e ADR 007–010 descrivono account, impatto, lifecycle, istanze e configurazione pubblica. D-036 e ADR 006 stabiliscono che i due registri audit restano separati e vengono uniti solo in lettura. La query M9-F applica `restaurantId` dentro entrambi i rami della `UNION ALL`, quindi ordina per `createdAt DESC`, ranking sorgente stabile (`ADMINISTRATIVE` prima di `RESERVATION`) e `id DESC`.

La paginazione non usa `OFFSET`: il cursore opaco base64url contiene soltanto versione, timestamp, ranking, UUID evento e fingerprint canonico dei filtri. Il limite è 25 per default e 100 massimo; il periodo predefinito è di 30 giorni locali e non può superare 366 giorni. Lista e dettaglio rileggono dal database ruolo, stato, cambio password e tenant dell'Admin.

Il dettaglio non inoltra JSON persistito. Una allow-list positiva per categoria e azione ammette soltanto enum, date/orari, UUID, codici, flag e conteggi operativi. Sono esclusi PII, contatti, contenuti editoriali, note, allergie testuali, HMAC, credenziali, sessioni, token e hash anche quando presenti in record storici o corrotti. La consultazione non modifica tabelle e non genera audit ricorsivo.

## Pagine e API

- `/admin/users`, `/admin/configuration`, `/admin/public-settings`, `/admin/rooms`, `/admin/schedules`, `/admin/special-dates` e `/admin/availability-preview` coprono le superfici amministrative M9-A–M9-E.
- `/admin/audit` offre filtri, elenco cronologico, pagina successiva, stato vuoto/errore e dettaglio accessibile e responsive.
- `GET /api/admin/audit` restituisce il contratto lista minimizzato e il cursore successivo.
- `GET /api/admin/audit/<source>/<id>` restituisce un singolo dettaglio minimizzato.

Le route audit sono esclusivamente GET e inviano `Cache-Control: no-store` e `X-Robots-Tag: noindex, nofollow, noarchive`. Non esistono endpoint di creazione, modifica, cancellazione o export dell'audit.

## Migrazioni M9

M9 usa cinque migrazioni, tutte già introdotte prima di M9-F:

1. `20260812090000_add_admin_audit_foundation` — fondazione audit M9-A;
2. `20260812120000_add_user_lifecycle` — lifecycle identità M9-B;
3. `20260812160000_add_generic_booking_cutoff_rules` — cutoff generici e invarianti M9-C;
4. `20260812200000_add_service_instance_room_availability` — istanze e sale M9-D;
5. `20260813123000_add_public_settings_and_content` — configurazione pubblica M9-E.

M9-F non modifica `prisma/schema.prisma`, non crea migrazioni, viste, indici, trigger permanenti o tabelle read-model e non aggiorna dipendenze. Il seed resta strutturale, idempotente e privo di prenotazioni o eventi audit dimostrativi permanenti.

## Verifica e sicurezza

I test M9 coprono matrice Admin/Staff/anonimo/cambio obbligatorio/disabilitato, isolamento cross-tenant, atomicità audit, concorrenza dell'ultimo Admin, preview e fingerprint, grandfathering, istanze lazy, disponibilità sale, contatti e contenuti, token prospettici, DST, proiezione audit, privacy legacy, filtri, keyset e read-only. Le integrazioni di persistenza e concorrenza usano PostgreSQL reale; gli E2E usano esclusivamente dati fittizi.

La regressione finale locale è verde: Prisma ha trovato esattamente 11 migrazioni e database aggiornato; due seed consecutivi sono riusciti; lint e typecheck non hanno errori; Vitest ha superato 372 test in 41 file; Playwright ha superato 32 scenari; il build di produzione è riuscito. Lo stato Git e l'audit del diff completo rispetto a `main` restano riportati nel report finale Work senza creare commit o file staged.

## Funzioni escluse

Restano fuori da M9: assegnazione definitiva di sala e tavoli e ogni funzione M10; PDF/Excel e M11; notifiche, outbox, provider e M12; retention o archiviazione audit; export audit/CSV/analytics/grafici; staging, deploy, backup di produzione e dati reali. `DA ASSEGNARE` resta virtuale e non è stata introdotta alcuna automazione tavoli.
