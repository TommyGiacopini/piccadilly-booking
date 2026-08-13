# ADR 010 — Configurazione pubblica, contenuti localizzati e durata del link

## Stato

Accettato e implementato da M9-E.

## Contesto

Telefono, URL pubblico, email, WhatsApp, testi editoriali IT/EN e durata del link personale devono essere modificabili senza cambiare codice. Contatti o testi non devono diventare provider di notifica, HTML eseguibile o dati copiati nell'audit. Una variazione della durata non può alterare i token già emessi.

## Decisione

- `RestaurantPublicSettings` è la configurazione uno-a-uno dei contatti e dell'URL canonico.
- `PublicContent` conserva esclusivamente sette chiavi approvate per le locale `IT` ed `EN`, con unicità per ristorante, locale e chiave.
- Le mutazioni di contatti, contenuti e durata sono endpoint distinti, Admin-only, strict JSON, same-origin e tenant-scoped.
- Ogni scrittura acquisisce il lock PostgreSQL stabile del ristorante, rilegge attore e stato, verifica il fingerprint, rileva i no-op e salva audit minimizzato nello stesso commit serializzabile.
- L'audit registra presenza e nomi dei campi, locale e chiavi o ore precedenti/nuove; non registra contatti, URL, testi, token o hash.
- La durata normativa resta `RestaurantBookingSettings.managementLinkDurationHours`, da 1 a 24 ore. La modifica vale soltanto per nuovi token.
- Al reschedule la durata originaria viene ricavata dalla vecchia scadenza e dal vecchio istante del servizio, validata e applicata al nuovo istante nella timezone del ristorante. Stato incoerente significa rollback.
- Le pagine pubbliche usano `lang=it|en`, italiano come fallback, testo React senza interpreti HTML/Markdown e risposte non memorizzabili in cache.

## Conseguenze

Il database mantiene una sola fonte per contatti, contenuti e durata. Non sono introdotti provider, invii, outbox, cookie lingua o aggiornamenti massivi dei token. La futura consultazione audit resta M9-F.
