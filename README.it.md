# 📺 StreamApp - Rdn

[English](./README.md)

Dashboard web per cercare film e serie, consultare catalogo, valutazioni,
stagioni, episodi, cast e trailer in italiano. Il sistema combina **The Movie Database (TMDB)** per i metadati arricchiti e **Vixsrc** per la disponibilità e la riproduzione tramite stream HLS diretti.

## Architettura

- **Provider Metadati**: [The Movie Database (TMDB)](https://www.themoviedb.org/) fornisce titoli ufficiali, trame localizzate in italiano, poster e sfondi in HD, crediti di attori e troupe, trailer, generi ed elenchi completi di stagioni ed episodi per le serie TV.
- **Streaming e Disponibilità**: [Vixsrc](https://vixsrc.to/) indicizza i contenuti e gli episodi disponibili in italiano (`/api/list/movie`, `/api/list/tv`, `/api/list/episode`) ed estrae playlist HLS master per una riproduzione senza annunci pubblicitari o tracker.
- **Compatibilità Completa**: Mantiene tutte le funzionalità della piattaforma: profili account multipli, libreria dei preferiti e cronologia, pannello amministrativo e sessioni Watch Together sincronizzate in tempo reale.

## Sviluppo

Servono Node.js e npm — [installabili con nvm](https://github.com/nvm-sh/nvm#installing-and-updating) — e Python 3.10 o superiore.

```sh
git clone https://github.com/Redin00/streamapp-rdn
cd streamapp-rdn/
cp .env.example .env
npm i
npm run dev
```

Copia `.env.example` in `.env` nella cartella principale e imposta la tua `TMDB_API_KEY`.
`npm run dev` carica quel file sia per il servizio Python sia per Vite; le variabili esportate nella shell hanno la precedenza.

`npm run dev` avvia sia il servizio API Python che il server Vite, collegandoli automaticamente tramite `STREAMING_API_URL`. È possibile avviare il servizio Python manualmente: consulta [`python-service/README.md`](./python-service/README.md) per i dettagli.

> [!IMPORTANT]
> È necessaria una **Chiave API TMDB** gratuita per visualizzare metadati, ricerca e locandine.
> 1. Crea un account gratuito su [themoviedb.org](https://www.themoviedb.org/signup).
> 2. Genera una chiave API (v3 API key o v4 Read Access Token) in [Impostazioni TMDB > API](https://www.themoviedb.org/settings/api).
> 3. Inseriscila nel tuo `.env`: `TMDB_API_KEY=la_tua_chiave`.

> [!IMPORTANT]
> Se `SC_ADMIN_PASSWORD` nel file `.env` è vuota, il servizio genera una
> password amministratore e la stampa nei log **una sola volta**, quando viene creato il database.
> Salva la password oppure imposta `SC_ADMIN_PASSWORD` prima del primo avvio.

> [!NOTE]
> Il dominio di riproduzione Vixsrc può cambiare nel tempo (predefinito: `vixsrc.to`).
> Può essere modificato dal pannello amministratore nel sito senza riavviare il servizio,
> e viene aggiornato automaticamente verificando i reindirizzamenti dal backend.

## Configurazione (`.env`)

| Variabile            | Valore predefinito                 | Descrizione                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------- |
| `TMDB_API_KEY`       | vuoto                              | Chiave API / Access Token TMDB (richiesto per metadati) |
| `SC_PORT`            | `8000`                             | Porta locale del servizio Python                        |
| `SC_VIXSRC_DOMAIN`   | `vixsrc.to`                        | Host iniziale/fallback di riproduzione e catalogo (se modificato da `/admin`, il DB ha la priorità) |
| `SC_CACHE_TTL`       | `1800`                             | Durata della cache delle risposte, in secondi (30m)     |
| `SC_LOG_LEVEL`       | `INFO`                             | Livello dei log Python (`DEBUG` per più dettagli)       |
| `SC_DB_PATH`         | `python-service/data/streamapp.db` | Account, sessioni, libreria e cronologia                |
| `SC_ADMIN_NAME`      | `Admin`                            | Nome del primo profilo amministratore                   |
| `SC_ADMIN_PASSWORD`  | generata e mostrata nei log        | Password del primo profilo amministratore               |
| `SC_SESSION_DAYS`    | `30`                               | Durata di validità di una sessione                      |
| `SC_LOCKOUT_MINUTES` | `15`                               | Blocco dopo cinque accessi falliti                      |
| `SC_BASE_URL`        | vuoto                              | URL pubblico per i link alle immagini profilo           |

> [!NOTE]
> `SC_VIXSRC_DOMAIN` nel file `.env` funge da **valore predefinito iniziale (seed/fallback)** al primo avvio. Non appena un amministratore modifica il dominio dalla pagina `/admin` o se il backend rileva un redirect permanente, il nuovo host viene salvato nel database SQLite (`app_settings`) e ha la precedenza sul file `.env`.

Il file `.env.example` principale contiene tutte le variabili di configurazione disponibili.

## Account

Ogni pagina passa dal selettore di profili in stile Netflix disponibile su
`/login`. In un database vuoto il servizio crea un amministratore usando
`SC_ADMIN_NAME` e `SC_ADMIN_PASSWORD`, oppure una password generata e stampata
una sola volta nei log. Solo un amministratore può creare altri profili da
`/admin`. Dopo cinque password errate, il profilo viene bloccato per
`SC_LOCKOUT_MINUTES`; un amministratore può sbloccarlo prima.

Account, sessioni, titoli salvati e cronologia di visione sono conservati nel
file SQLite indicato da `SC_DB_PATH`. `/library` mostra i titoli salvati e riprodotti di recente dal
profilo autenticato.

Se il progetto verrà hostato, ricorda che per le foto profilo devi impostare
la variabile `SC_BASE_URL` in `.env` che fungerà da API per le foto profilo. Se non ti interessa
questa parte, puoi anche non impostarlo e usare il sito semplicemente seguendo le istruzioni base.

## Riproduzione 

La pagina di visione è `/watch/<id>`. Per le serie, `?s=<season>&e=<episode>`
seleziona stagione ed episodio. La riproduzione usa l'id TMDB e preferisce una
playlist HLS diretta rispetto all'embed iframe, risolta dal server tramite
`GET /stream`:

1. `https://<playback-domain>/api/{movie,tv}/<tmdbId>[/<season>/<episode>]`
   restituisce il percorso di una pagina embed con token.
2. La pagina viene analizzata per estrarre `window.masterPlaylist`; il token viene
   poi usato per creare l'URL della playlist riprodotta direttamente dal browser tramite
   `hls.js`.

In questo modo, la pagina dell'host non viene mai caricata nel browser e i relativi annunci non vengono eseguiti.

Se la risoluzione automatica non riesce, la pagina usa l'embed iframe standard come fallback:

- film — `https://<playback-domain>/movie/<tmdbId>`
- serie — `https://<playback-domain>/tv/<tmdbId>/<season>/<episode>`

Il servizio Python indica il provider attivo tramite `GET /player`.

## Watch Together

La pagina di visione include la modalità Watch Together per guardare contenuti
insieme ad altri profili. Crea una stanza da `/watch/<id>` e condividi il codice
della stanza o il link d'invito. Gli altri partecipanti possono entrare nello
stesso film o episodio e ricevere in sincronia gli eventi di riproduzione,
pausa e spostamento. Ogni stanza include anche una chat dal vivo, l'elenco dei
partecipanti e l'indicazione dell'host.
qualsiasi momento dalla finestra Watch Together.