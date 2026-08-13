# ADR 008 — Identità, password temporanee e protezione dell'ultimo Admin

**Stato:** accettato, implementato in M9-B
**Data:** 12 agosto 2026

## Contesto

M9 dovrà gestire account individuali senza registrazione pubblica né canali automatici per consegnare credenziali. La disabilitazione concorrente di Admin potrebbe inoltre lasciare un ristorante senza amministratore attivo.

## Decisione

- Non esiste registrazione pubblica.
- Creazione e reset generano sul server una password temporanea casuale, mostrata all'Admin una sola volta.
- La password è comunicata esternamente: nessun invio email o WhatsApp.
- PostgreSQL conserva soltanto l'hash Argon2id e il flag persistente `mustChangePassword`.
- Fino al cambio password le funzioni operative sono bloccate.
- Reset e cambio password revocano tutte le sessioni; il cambio termina con una nuova autenticazione.
- Non esiste alcuna funzione di lettura della password corrente.
- Gli utenti vengono disattivati, mai eliminati fisicamente.
- Un Admin non può disabilitare o retrocedere se stesso.
- Deve rimanere almeno un Admin attivo per ristorante; disabilitazione e retrocessione dell'ultimo Admin sono vietate.
- La verifica dell'ultimo Admin avviene nella stessa transazione serializzabile dopo un lock advisory PostgreSQL stabile per ristorante e produce audit generico.
- Le password temporanee sono stringhe URL-safe di 24 caratteri generate da 18 byte CSPRNG e sono restituite soltanto dalla risposta one-shot `no-store`.
- Le password scelte contano code point Unicode (15–128), preservano esattamente l'input, ammettono spazi e Unicode stampabile e rifiutano controlli, blocklist locale, username equivalente e riuso della password attuale.

M9-A ha preparato le azioni del dominio audit; M9-B implementa modello, UI, API e casi d'uso utenti.

Riferimenti normativi correnti consultati: [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html), [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Conseguenze

- nessuna password in chiaro viene conservata o recuperata;
- la consegna una tantum richiede una comunicazione operativa esterna;
- la protezione non può essere affidata a un conteggio non bloccante o alla sola UI;
- revoca sessioni e mutazione identità devono essere atomiche con l'audit.

## Alternative rifiutate

- Password scelta dall'Admin e memorizzabile: rifiutata.
- Invio automatico della password: rifiutato per il checkpoint utenti.
- Eliminazione utenti: rifiutata perché spezza storia e audit.
- Controllo ultimo Admin solo applicativo prima della transazione: rifiutato per race condition.
