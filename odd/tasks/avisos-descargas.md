# Avisos de descargas (C-01)

Avisos por ntfy cuando una descarga termina, en dos momentos distintos: el
cliente acabó de bajar y el archivo acabó importado. Canal configurable, envío
que nunca bloquea.

## Specs

**S1 — canal.** «ntfy (autoalojado)» (L2). Un grupo nuevo `notifications.ntfy`
con `url` (base, sin topic), `topic`, `token` opcional y `enabled`. El `token`
se guarda cifrado en reposo como las demás credenciales y sale enmascarado de
`GET /api/settings`. Sin `url` o sin `topic` el canal está «No configurado» y
no se envía nada.

**S2 — se prueba de verdad.** «un botón «Probar» que envía un mensaje real
(mismo patrón que el sondeo de servicios de T4)» (L2). El botón envía un aviso
real y devuelve `ok`, el `status` HTTP y el `elapsed_ms`; un fallo devuelve el
motivo, nunca un éxito optimista.

**S3 — aviso A: el cliente terminó.** «Aviso A: el cliente terminó de bajar.»
(L2), disparado por «qBittorrent o aMule terminan una descarga» (L1). Sale **una
vez por descarga**, en el tick del poller en que se cumple:

- **Torrent** (aMuTorrent/qBittorrent, vía cola del arr): `progress >= 100` o
  `sizeleft <= 0`. Clave de la descarga: su `hash` si el snapshot lo trae, si no
  su `name`.
- **aMule (ed2k)**: un archivo de `paths.download_amule` **visto dos ticks
  seguidos con la misma talla** (la talla dejó de crecer). Clave: su ruta
  absoluta y su talla. Un archivo visto por primera vez **sólo se registra**:
  tras un reinicio no hay tick anterior con el que comparar y avisar «terminó»
  de algo que quizá lleva horas bajando es peor que callar un tick.
- El mensaje nombra la descarga; no incluye el archivo final porque todavía no
  existe.

**S4 — aviso B: quedó importado.** «Aviso B: el archivo está importado.» (L2)
Se envía sólo cuando el archivo ya está en su carpeta final con su nombre
definitivo; nunca antes. El disparador es **del poller, no del cliente**:
`tracked_state == "imported"` para una descarga del snapshot, con el nombre del
archivo final que el snapshot traiga, y si no lo trae, el nombre de la
descarga. `importPending` e `importing` **no** son B: son «el cliente terminó»
(S3) y «está en ello».

**S5 — dos avisos distintos, no uno doble.** «Dos avisos distintos: «bajando →
terminó» y «terminó → importado»» (L2). El mensaje de A identifica la descarga
y el de B identifica el archivo final, para que «si B no llega, sabes que el
import se atascó» (L2).

**S6 — sin duplicados ni pérdidas.** Un mismo elemento no se avisa dos veces,
tampoco tras reiniciar el proceso; y no se pierde el aviso B de algo que se
estaba importando cuando el proceso se cayó. La memoria es una fila por
`(clave, aviso)` en el historial durable, con el número de intentos:

- Antes de enviar se consulta la fila; si existe con `ok`, no se envía nada.
- Tras intentarlo se escribe/actualiza la fila con `ok` y `attempts`.
- Un envío fallido **se reintenta hasta 3 veces** y después se da por perdido:
  reintentar sin fin cada 3 s contra un ntfy mal configurado es una avalancha,
  y callar sin rastro es mentir. El rastro queda en la fila y en el log.

**S7 — nunca bloquea ni rompe.** Un ntfy caído, lento o con token inválido no
puede detener un import, un sondeo ni una petición HTTP: el envío tiene timeout
corto, y su fallo se registra, no se propaga.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S7 | inline | `00c420e` (#288) |
| T2 | S2 | inline | `6147078` (#290) |
| T3 | S3, S6 | inline | `5297e2a` + `f3619dd` (#291) |
| T4 | S4, S5 | inline | `5297e2a` (#291) |
| T5 | S6 | inline | `24d71f0` (#291) |
| T6 | S3, S4 | inline | verificado: 2 procesos, A → reinicio → B sin repetir (#291) |

## Log

**L1** (petición original, literal): «C-01 avisos al completar descargas
(disparador confirmado: qBittorrent o aMule terminan una descarga)».

**L2** (2026-11-04, respuestas del usuario a las dos preguntas): canal
«ntfy (autoalojado)»; disparador «Ambos, como dos avisos distintos» con la
descripción: «Aviso A: el cliente terminó de bajar. Aviso B: el archivo está
importado. Si B no llega, sabes que el import se atascó: es un diagnóstico
gratis.»

**L3** (2026-11-04, exploración, evidencia). Lo que existe hoy, y que decide el
diseño:

- **Ya hay un poller de descargas**: `downloads_poller()`
  (`backend/application/use_cases/downloads_cache.py:193`) corre desde el
  lifespan (`backend/app.py:101`) cada `DOWNLOADS_TTL = 3.0` s
  (`downloads_cache.py:50`) y construye un snapshot con `progress`,
  `tracked_state` (`importPending`/`importing`/`imported`/`importBlocked`),
  `sizeleft` y `torrent_state` por descarga (`_build_download`,
  `downloads_cache.py:76-115`). **El aviso A del lado torrent no necesita
  ningún sondeo nuevo**: es una comparación entre dos snapshots consecutivos.
- **El aviso B del lado torrent tampoco**: `tracked_state == "imported"` es
  exactamente «el archivo está importado» (S4).
- **aMule ed2k no expone progreso en ninguna parte**: el cliente EC sólo
  implementa `add_ed2k` y la búsqueda
  (`backend/infrastructure/amule_service.py:72`); no hay
  `EC_OP_GET_DOWNLOAD_QUEUE`, ni lectura de `size_done`/`size_full`. Añadirlo
  sería trabajo de protocolo EC, no de esta feature.
- **Pero sí hay registro de archivos de aMule**:
  `amule_downloads(path, first_seen_at)` (`sqlite_history.py:174`), escrito y
  podado por la retención (`sqlite_history.py:755-791`). La carpeta es
  `paths.download_amule`. El aviso A de aMule sale de ahí: **un archivo nuevo
  cuya talla deja de cambiar**, sin tocar el protocolo EC.
- **El bus de eventos ya existe** (`backend/event_bus.py`): `publish` recibe
  del task registry, del trace sweep y del downloads poller. Es el canal para
  que la UI sepa de un aviso enviado, no el canal del aviso en sí.
- **Historial durable** (`sqlite_history.py`, migraciones v2..v11 con
  `CREATE TABLE IF NOT EXISTS`): es donde cabe la memoria de lo ya avisado
  (S6) sin inventar un fichero nuevo.
- **HTTP saliente**: `aiohttp` vía `state.http_session()`
  (`backend/state.py:9`), con `httpx` también declarado en
  `backend/requirements.txt`.
- **Secretos**: `ENCRYPTED_SECRET_FIELDS` (`credentials.py:48`) y el
  enmascarado de `GET /api/settings` (`routes/settings.py:145`) son el patrón
  para el `token` de ntfy (S1).

**L4** (2026-11-04, alcance). El usuario escribió «qBittorrent o aMule». En
este despliegue el cliente torrent es **aMuTorrent** (`QBIT_*` vacío en
`.env.local`), así que «qBittorrent» se lee como «el cliente torrent» y el
aviso A lo cubre mediante la cola del arr, que es la que ve a cualquier
cliente. aMule (ed2k) se cubre por carpeta, como en L3.

**L5** (2026-11-04, decisiones de arquitectura para T3–T5, con la evidencia de
L3 delante).

- **El disparador vive en el tick del poller**, no en un sondeo nuevo ni en el
  arranque: `downloads_poller()` ya recorre las descargas cada 3 s y su
  iteración es el único sitio donde «dos snapshots consecutivos» existe.
  `get_downloads()` es la ruta de lectura y no puede tener efectos: el aviso no
  se dispara ahí.
- **`app.py` no se toca**: el techo legacy está en **3.466 líneas y su holgura
  es cero**. Los adaptadores se alcanzan por `application.gateways`, que es el
  registro de puertos que `app.py` ya rellena; `history` y `settings` están
  ahí. Un import de `infrastructure` desde `application` está prohibido por
  `tests_architecture.py`.
- **La memoria durable es una tabla nueva del historial** (migración v12, con
  la disciplina `CREATE TABLE IF NOT EXISTS` de las anteriores), no un fichero
  aparte: es el único almacén que ya sobrevive a un reinicio.
- **`notices` no se envía en el hilo del poller sin blindaje**: el tick envuelve
  la comprobación en `try/except` como ya envuelve la recolección, porque un
  canal caído no puede congelar el snapshot (S7).
