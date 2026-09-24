# 📺 StreamApp - Rdn

[English](./README.md)

Dashboard web per cercare film e serie, consultare catalogo, valutazioni,
stagioni ed episodi tramite il servizio italiano StreamingCommunity. Il progetto
usa la libreria Python
[`streamingcommunity-unofficialapi`](https://pypi.org/project/streamingcommunity-unofficialapi/)
e include un player incorporato.

## Sviluppo

Servono Node.js e npm — [installabili con nvm](https://github.com/nvm-sh/nvm#installing-and-updating) — e Python 3.10 o superiore.

```sh
git clone <url-del-repository>
cd <nome-della-cartella>
cp .env.example .env
npm i
npm run dev
```

Copia `.env.example` in `.env` nella cartella principale e modifica i valori
necessari. `npm run dev` carica quel file sia per il servizio Python sia per
Vite; le variabili esportate nella shell hanno la precedenza.

`npm run dev` avvia il servizio API Python e il server Vite, collegandoli
automaticamente tramite `STREAMING_API_URL`. È possibile avviare il servizio
Python manualmente: consulta [`python-service/README.md`](./python-service/README.md)
per i dettagli.

> [!IMPORTANT]
> Se `SC_ADMIN_PASSWORD` nel file `.env` è vuota, il servizio genera una
> password e la stampa nei log **una sola volta**, quando viene creato il database.
> Salva la password oppure imposta `SC_ADMIN_PASSWORD` prima del primo avvio.

> [!NOTE]
> I domini di StreamingCommunity e Vixsrc possono cambiare nel tempo. Entrambi
> possono essere modificati dal pannello amministratore nel sito senza riavviare il servizio.
> I domini vengono inoltre aggiornati automaticamente verificando i loro reindirizzamenti da
> uno script periodico automatico, assicurando funzionalità quasi sempre.

## Configurazione (`.env`)

| Variabile            | Valore predefinito                 | Descrizione                                       |
| -------------------- | ---------------------------------- | ------------------------------------------------- |
| `SC_PORT`            | `8000`                             | Porta locale del servizio Python                  |
| `SC_CACHE_TTL`       | `600`                              | Durata della cache delle risposte, in secondi     |
| `SC_LOG_LEVEL`       | `INFO`                             | Livello dei log Python (`DEBUG` per più dettagli) |
| `SC_DB_PATH`         | `python-service/data/streamapp.db` | Account, sessioni, libreria e cronologia          |
| `SC_ADMIN_NAME`      | `Admin`                            | Nome del primo profilo amministratore             |
| `SC_ADMIN_PASSWORD`  | generata e mostrata nei log        | Password del primo profilo amministratore         |
| `SC_SESSION_DAYS`    | `30`                               | Durata di validità di una sessione                |
| `SC_LOCKOUT_MINUTES` | `15`                               | Blocco dopo cinque accessi falliti                |
| `SC_BASE_URL`        | vuoto                              | URL pubblico per i link alle immagini profilo     |

I domini del catalogo e della riproduzione hanno valori predefiniti in
`python-service/main.py` e possono essere cambiati dal pannello amministratore
senza riavviare il servizio. Il file `.env.example` principale contiene tutte
le variabili di configurazione disponibili.

## Account

Ogni pagina passa dal selettore di profili in stile Netflix disponibile su
`/login`. In un database vuoto il servizio crea un amministratore usando
`SC_ADMIN_NAME` e `SC_ADMIN_PASSWORD`, oppure una password generata e stampata
una sola volta nei log. Solo un amministratore può creare altri profili da
`/admin`. Dopo cinque password errate, il profilo viene bloccato per
`SC_LOCKOUT_MINUTES`; un amministratore può sbloccarlo prima.

Account, sessioni, titoli salvati e cronologia di visione sono conservati nel
file SQLite indicato da `SC_DB_PATH`. Esegui un backup del file e non inserirlo
nel repository. `/library` mostra i titoli salvati e riprodotti di recente dal
profilo autenticato.

Se il progetto verrà hostato, ricorda che per le foto profilo devi impostare
la variabile `SC_BASE_URL` in `.env` che fungerà da API per le foto profilo. Se non ti interessa
questa parte, puoi anche non impostarlo e usare il sito semplicemente seguendo le istruzioni
base.

## Riproduzione 

*Leggi solamente se vuoi capire il funzionamento tecnico*

La pagina di visione è `/watch/<id>`. Per le serie, `?s=<season>&e=<episode>`
seleziona stagione ed episodio. La riproduzione usa l'id TMDB e preferisce una
playlist HLS diretta rispetto all'embed iframe, risolta dal server tramite
`GET /stream`:

1. `https://<playback-domain>/api/{movie,tv}/<tmdbId>[/<season>/<episode>]`
   restituisce il percorso di una pagina embed con token.
2. La pagina viene analizzata per trovare `window.masterPlaylist`; il token viene
   poi usato per creare l'URL della playlist riprodotta dal browser tramite
   `hls.js`.

Non tutti i titoli sono disponibili: il servizio può avere episodi mancanti o
una struttura HTML modificata. Se la risoluzione non riesce, la pagina di visione
usa l'embed iframe come fallback:

- film — `https://<playback-domain>/movie/<tmdbId>`
- serie — `https://<playback-domain>/tv/<tmdbId>/<season>/<episode>`

Il servizio Python indica il provider attivo tramite `GET /player`.

I domini di embed possono cambiare e possono offrire contenuti che non hai il
diritto di vedere. Mantieni il dominio configurabile e verifica di avere i
diritti necessari per i contenuti a cui accedi.

## Watch Together

La pagina di visione include la modalità Watch Together per guardare contenuti
insieme ad altri profili. Crea una stanza da `/watch/<id>` e condividi il codice
della stanza o il link d'invito. Gli altri partecipanti possono entrare nello
stesso film o episodio e ricevere in sincronia gli eventi di riproduzione,
pausa e spostamento. Ogni stanza include anche una chat dal vivo, l'elenco dei
partecipanti e l'indicazione dell'host. È possibile abbandonare la stanza in
qualsiasi momento dalla finestra Watch Together.