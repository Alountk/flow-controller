# Feature: conexion-directa-amule — cliente EC directo + migración del flujo ED2K

Steps 1-2 del plan «conexiones directas»: sustituir el transporte ED2K de aMuTorrent (búsqueda, encolado y cola) por conexión directa al protocolo EC de amuled (`AMULE_URL`:`AMULE_EC_PORT`), con rollback por flag `AMULE_EC_DIRECT=0`.
Los Steps 3-6 del plan (cliente Torznab, sección «Indexadores», import+retiro de Prowlarr, Radarr/Sonarr sólo archivos) son features posteriores con sus propios documentos.
Estado de referencia: probe verificado en vivo contra el aMule 3.0.1 del usuario (`/tmp/ec_probe.py`: AUTH OK + 149 resultados de búsqueda).

## Specs

S1: Cliente EC directo a aMule — «ok, como estoy viendo que estoy teniendo muchos problemas, creo que vamos a implementar las conexiones directas con amule, qbittorrent y los indexadores. y dejaremos radarr y sonarr solo para el tema ...» (Log L1a).
Nuevo `backend/infrastructure/amule_ec_client.py` (sólo stdlib: `socket`, `hashlib`, sin dependencias nuevas) que habla con amuled:
- Framing: header de 8 bytes = u32 flags (bandera base 0x20) + u32 longitud del payload, big-endian; payload = u8 opcode + u16 número de tags + tags. Tag = u16 ((código<<1) | bit0=tiene subtags) + u8 tipo + u32 taglen + [u16 número de subtags si bit0] + subtags + dato propio (taglen incluye el tamaño cable de las subtags). Strings = u32 longitud + UTF-8 + NUL final (la NUL cuenta en la longitud). Enteros en el tipo más estrecho posible (el lector es agnóstico de ancho).
- Tipos EC ya verificados en vivo: STRING 0xFA, UINT16 0x02, UINT32 0x03, UINT64 0x04, HASH16 0x05; el resto, `src/libs/ec/abstracts/ECTag.abstract` de `amule-org/amule` (fuente de verdad).
- Autenticación de 3 pasos: `EC_OP_AUTH_REQ 0x02` (subtags EC_TAG_CLIENT_NAME 0x0100 string, EC_TAG_CLIENT_VERSION 0x0101 string, EC_TAG_PROTOCOL_VERSION 0x0002 u16 = 0x0204, obligatorio) → `EC_OP_AUTH_SALT 0x4F` (EC_TAG_PASSWD_SALT 0x000b, u64) → `EC_OP_AUTH_PASSWD 0x50` (EC_TAG_PASSWD_HASH 0x0001, HASH16) con digest = md5( AMULE_EC_PASSWORD + md5_hex("%lX" % salt) ) — `AMULE_EC_PASSWORD` YA es el md5-hex de 32 caracteres del password y se usa tal cual como primer término (no se re-hashea el password real). Vector de la spec para tests: password "amule", salt 0x85E4BA4461965156 → digest 9dd41c0b85c8b7cd0a0b1a8ecf9f5d29. Éxito = `EC_OP_AUTH_OK 0x04` (ec hoja EC_TAG_SERVER_VERSION 0x050b).
- Búsqueda: `search(query, mode)` envía `EC_OP_SEARCH_START 0x26` con EXACTAMENTE un tag envoltorio `EC_TAG_SEARCH_TYPE 0x0701` (dato propio u32 = tipo: LOCAL 0 / GLOBAL 1 / KAD 2) y subtags `EC_TAG_SEARCH_NAME 0x0702` (string) + `EC_TAG_SEARCH_FILE_TYPE 0x0705` (string, vacío = sin filtrar). Opcionales sólo si procede: EXTENSION 0x0706, AVAILABILITY 0x0707, MIN_SIZE 0x0703, MAX_SIZE 0x0704. El servidor responde `EC_OP_STRINGS 0x06` ("Search in progress. Refetch results in a moment!"); se hace poll de `EC_OP_SEARCH_PROGRESS 0x29` (EC_TAG_SEARCH_STATUS 0x0708) y luego `EC_OP_SEARCH_RESULTS 0x28` con EC_TAG_DETAIL_LEVEL = EC_DETAIL_FULL (0x02) → tags EC_TAG_SEARCHFILE 0x0700 con subtags: 0x0301 nombre, 0x0303 tamaño, 0x031e hash MD4, 0x030a/0x030d fuentes, 0x0308 estado. Cierre con `EC_OP_SEARCH_STOP 0x27` (sin parámetros: camino single-search legacy). Timeout y reintentos con excepción tipada; el servidor limita 10 logins fallidos/min por IP a 300 s — NUNCA reintentar autenticación a ciegas.
- Operaciones: `add_ed2k(ed2k_link)` vía `EC_OP_ADD_LINK 0x09`; operaciones de cola por hash (pausa/reanudar/prioridad/categoría `EC_TAG_PARTFILE_SET_CAT`/borrar) y descarga de resultado de búsqueda `EC_OP_DOWNLOAD_SEARCH_RESULT 0x2A`; códigos exactos de cada opcode/tag: `src/libs/ec/abstracts/ECCodes.abstract` de `amule-org/amule` (fuente de verdad).
- Referencia ejecutable ya verificada en vivo: `/tmp/ec_probe.py` (leerlo: framing, auth y búsqueda funcionan). Los tests NUNCA abren red real (socket simulado).
- Cualquier error de conexión/timeout se propaga como excepción tipada del módulo; nunca un traceback crudo hacia HTTP.

S2: Seam de configuración (precedente OpenSubtitlesClient): puerto del servicio `amule` en `backend/application/ports.py` → `backend/application/gateways.py` → wiring HTTP, con `AMULE_URL` + `AMULE_EC_PORT` + `AMULE_EC_PASSWORD` («usando AMULE_URL y AMULE_PASSWORD de .env.local», Log L1a — resuelto a `AMULE_EC_PASSWORD`, el hash que exige el protocolo EC, verificado en vivo). Sin servicio configurado o sin credenciales → HTTP 502 con «no está configurado» (fail-closed, sin degradar a silencio).

S3: Migración del flujo grab: `backend/application/use_cases/grab_release.py` deja de usar `amutorrent_search_link`/`amutorrent_add_download` por defecto y usa búsqueda EC + encolado EC; la resolución ED2K sigue ocurriendo en la tarea asíncrona del servidor (ED2K es lento, no se bloquea la petición). Flag `AMULE_EC_DIRECT` (default activo): con `AMULE_EC_DIRECT=0` el comportamiento vuelve a ser EXACTAMENTE el actual de aMuTorrent (rollback). Las pruebas existentes del path aMuTorrent se conservan y pasan fijando `AMULE_EC_DIRECT=0`; nuevas pruebas fijan el path EC con el flag activo.

S4: Migración de la cola: `backend/copy_engine.py` reemplaza las operaciones WebSocket de aMuTorrent (borrar/quitar de cola, prioridades, categorías…) por las operaciones EC del cliente; mismo flag: `AMULE_EC_DIRECT=0` ⇒ comportamiento actual exacto (diferencial).

S5: Sin cambios observables salvo el transporte: el encolado respeta la misma carpeta/categoría de destino que hoy (categorías aMule existentes del stack: radarr, radarr-ru, tv-sonarr, tv-sonarr-ru… vía `PARTFILE_SET_CAT` cuando la ruta actual ya las aplique) y el resto del flujo (historial, seguimiento) no cambia.

S6: Verificación: RED observado antes de cada implementación nueva (nunca test verde primero, nunca aflojar tests); suite backend completa verde (base 1335 + los nuevos) con `../.venv/bin/python -m pytest` desde `backend/`; sin tocar frontend: `./node_modules/.bin/tsc -b` = 0, `./node_modules/.bin/eslint` = 0 y `MAX_LEGACY_LOC = 3270` sin cambios.

S7: Fixtures de red: tests unitarios sin red real (socket simulado/mock); fixtures byte-a-byte incluyen el vector de autenticación de la spec, el paquete de `SEARCH_START` con el tag envoltorio y un `SEARCH_RESULTS` real capturado por el probe.

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1-S7 | parent — feature doc | (este commit) |
| T2 | S1, S7 | worker — `amule_ec_client.py`: framing + auth + búsqueda + ops de cola, tests RED→GREEN | pendiente |
| T3 | S2, S6 | parent — seam ports/gateways + configuración `amule` + 502 fail-closed, tests | pendiente |
| T4 | S3, S6 | worker — `grab_release.py` a EC por defecto + flag rollback; Risk: item 3 | pendiente |
| T5 | S4, S5, S6 | worker — `copy_engine.py` a EC + flag rollback; Risk: item 3 | pendiente |
| T6 | S6 | parent — gate (suite completa + tsc + eslint + ratchet), docs si aplican, PR único con divulgación, review nativa, merge | pendiente |

## Log

L1 (petición original, citas literales tal como quedaron registradas; L1a/L1b vienen truncadas del historial compactado):
- L1a: «ok, como estoy viendo que estoy teniendo muchos problemas, creo que vamos a implementar las conexiones directas con amule, qbittorrent y los indexadores. y dejaremos radarr y sonarr solo para el tema ...»
- L1b: «vale he mirado la configuracion de AMULE EC y el de WEBSERVER: [ExternalConnect] UseSrcSeeds=0 AcceptExternalConnections=1 ECAddress= ECPort=4712 ... [WebServer] ...» (pegado de configuración con EC en 4712; claves AMULE_EC_PASSWORD/AMULE_WEB_PASSWORD ya presentes en .env.local).
- L1c: «adelante con la implementacion»

L2 (evidencia de verificación en vivo): AUTH OK contra aMule 3.0.1 por EC:4712 con `AMULE_EC_PASSWORD` (hash md5) usando el vector de la spec; STATS: CONNSTATE 0x15 (eD2k+Kad), 58.805 usuarios ed2k, 841 nodos Kad. Búsqueda EC global "ubuntu" → reply "Search in progress" + 149 resultados (nombre/tamaño/hash/fuentes). La UI amuleweb no devuelve resultados en ningún modo (bug aMule #1556; el workaround de #292 tampoco sirve). `amuleapi` (REST, 4713) NO está desplegado: 4713 y 4712 cerrados a HTTP; decisión = cliente EC directo, sin cambios de infraestructura.

L3 (decisiones):
- Alcance de la caja de búsqueda del futuro MVP «Indexadores»: «Torznab + aMule + Prowlarr» (respuesta del usuario a la pregunta de alcance).
- Prowlarr: «Importar catálogo y retirarlo» — sus 13 indexadores pasan a conexiones Torznab directas y luego se retira (la búsqueda por idioma de la PR #218 se re-cableará).
- Storage de indexadores (Steps 3+): tabla SQLite `indexers`, nunca `config/settings.json`.
- Flag de rollback: `AMULE_EC_DIRECT`, default activo (path EC); `=0` ⇒ path aMuTorrent actual exacto (también fijado en las pruebas existentes que lo pinnean).
- Resolución de credenciales: el contrato usa `AMULE_EC_PASSWORD` (md5-hex, ya presente en .env.local), no `AMULE_PASSWORD` (texto plano, es de la web); verificado en vivo. Nunca imprimir estos valores.
- Descarga en vivo EC (`ADD_LINK`/`DOWNLOAD_SEARCH_RESULT`) NO probada en el probe a propósito (encolaría descargas reales): queda cubierta por TDD con socket simulado en T2.

L4 (progreso):
- T1 hecho: este documento. Rama `feat/conexion-directa-amule`.
