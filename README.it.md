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

> [!NOTE]
> **Prerequisiti Python (Linux & Windows)**:
> - **Linux**: assicurati che siano installati `python3`, **`python3-venv`**, **`python3-pip`** (e i relativi pacchetti di base per gli ambienti virtuali):
>   - **Debian / Ubuntu / Mint**: `sudo apt update && sudo apt install -y python3 python3-venv python3-pip python3-dev`
>   - **Fedora / RHEL**: `sudo dnf install -y python3 python3-pip python3-devel`
>   - **Arch Linux**: `sudo pacman -S python python-pip`
> - **Windows**: installa Python 3.10+ dal [sito ufficiale python.org](https://www.python.org/downloads/windows/) (oppure tramite terminale con `winget install -e --id Python.Python.3.12`).
>   - Durante l'installazione spunta obbligatoriamente **"Add python.exe to PATH"**; i moduli `venv` e `pip` sono già inclusi nell'installer ufficiale di Windows (assicurati che la voce **pip** sia selezionata nelle *Optional Features*).
>   - Per Node.js su Windows puoi usare [nvm-windows](https://github.com/coreybutler/nvm-windows) oppure l'installer LTS da [nodejs.org](https://nodejs.org/).

```sh
git clone https://github.com/Redin00/streamapp-rdn
cd streamapp-rdn/
cp .env.example .env
npm i
npm run dev
```

Copia `.env.example` in `.env` nella cartella principale: l'app è già pronta all'uso fin da subito con valori predefiniti funzionanti!
`npm run dev` carica automaticamente il file `.env` sia per il servizio Python sia per Vite (le variabili già esportate nella shell hanno la precedenza) e collega i due servizi tramite `STREAMING_API_URL`. È comunque possibile avviare il servizio Python manualmente: consulta [`python-service/README.md`](./python-service/README.md) per i dettagli.

> [!IMPORTANT]
> **Credenziali Admin Predefinite**:
> Al primo avvio viene creato automaticamente il profilo amministratore predefinito:
> - **Profilo**: `Admin`
> - **Password**: `admin123`
>
> Puoi modificare la password in qualsiasi momento dalla pagina `/admin` (o dalle impostazioni del profilo) oppure personalizzarla prima del primo avvio tramite `SC_ADMIN_PASSWORD` nel file `.env`.

> [!TIP]
> **Chiave API TMDB (Opzionale ma consigliata)**:
> Non è obbligatorio inserire una `TMDB_API_KEY` per iniziare: se lasciata vuota, il sistema utilizza automaticamente una **chiave TMDB predefinita integrata** per far funzionare subito catalogo, ricerca e locandine.
> Per un utilizzo continuativo o in caso di hosting pubblico è comunque consigliabile inserire la propria chiave gratuita:
> 1. Crea un account gratuito su [themoviedb.org](https://www.themoviedb.org/signup).
> 2. Genera una chiave API in [Impostazioni TMDB > API](https://www.themoviedb.org/settings/api).
> 3. Inseriscila nel file `.env`: `TMDB_API_KEY=la_tua_chiave`.

> [!NOTE]
> Il dominio di riproduzione Vixsrc può cambiare nel tempo (predefinito: `vixsrc.to`).
> Può essere modificato dal pannello amministratore nel sito senza riavviare il servizio,
> e viene aggiornato automaticamente verificando i reindirizzamenti dal backend.

## Configurazione (`.env`)

| Variabile            | Valore predefinito                 | Descrizione                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------- |
| `TMDB_API_KEY`       | chiave integrata di default        | Chiave API TMDB (opzionale; consigliata una personale)  |
| `SC_PORT`            | `8000`                             | Porta locale del servizio Python                        |
| `SC_VIXSRC_DOMAIN`   | `vixsrc.to`                        | Host iniziale/fallback di riproduzione e catalogo (se modificato da `/admin`, il DB ha la priorità) |
| `SC_CACHE_TTL`       | `1800`                             | Durata della cache delle risposte, in secondi (30m)     |
| `SC_LOG_LEVEL`       | `INFO`                             | Livello dei log Python (`DEBUG` per più dettagli)       |
| `SC_DB_PATH`         | `python-service/data/streamapp.db` | Account, sessioni, libreria e cronologia                |
| `SC_ADMIN_NAME`      | `Admin`                            | Nome del primo profilo amministratore                   |
| `SC_ADMIN_PASSWORD`  | `admin123`                         | Password iniziale del primo profilo amministratore      |
| `SC_SESSION_DAYS`    | `30`                               | Durata di validità di una sessione                      |
| `SC_LOCKOUT_MINUTES` | `15`                               | Blocco dopo cinque accessi falliti                      |
| `SC_BASE_URL`        | vuoto                              | URL pubblico per i link alle immagini profilo           |

> [!NOTE]
> `SC_VIXSRC_DOMAIN` nel file `.env` funge da **valore predefinito iniziale (seed/fallback)** al primo avvio. Non appena un amministratore modifica il dominio dalla pagina `/admin` o se il backend rileva un redirect permanente, il nuovo host viene salvato nel database SQLite (`app_settings`) e ha la precedenza sul file `.env`.

Il file `.env.example` principale contiene tutte le variabili di configurazione disponibili.

## Account

Ogni pagina passa dal selettore di profili in stile Netflix disponibile su
`/login`. In un database vuoto il servizio crea il profilo amministratore predefinito
(`Admin` con password standard `admin123`, salvo diversa configurazione in `SC_ADMIN_NAME` e `SC_ADMIN_PASSWORD`).
L'amministratore può creare o gestire altri profili da `/admin` (oltre alla registrazione pubblica dei profili membro). Dopo cinque password errate, il profilo viene bloccato per
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