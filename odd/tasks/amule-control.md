# amule-control — pestaña de aMule + acciones EC (añadir servidores y enlaces)

Feature ODD iniciada 2026-10-29. Mueve la configuración de aMule a su propia pestaña de
Ajustes e implementa acciones de control de aMule por External Connections (EC), empezando
por servidores y enlaces. Alcance fijado en vivo con el usuario (L2).

## Specs

S1 — «abstraigamos las configuraciones de amule a otra pestaña de ajustes»: la
configuración de aMule (url, ec_port, ec_password, su prueba de conexión, la tarjeta del
watchdog con su poll de 30 s y su enlace a Indexadores) se traslada de la tarjeta actual a
una **tercera pestaña «aMule»** del rail vertical de Ajustes, sobre el patrón
`role="tablist"` existente con «General»/«Indexadores» (ambos paneles montados; el
inactivo con `hidden` + `aria-hidden`). Nada cambia de significado: mismas claves
`services.amule.*`, misma máscara de secretos del backend, mismo ciclo Guardar/Descartar
de cabecera y badge de dirty.

S2 — «mira la documentacion de la api»: research realizada contra la documentación
oficial de EC de aMule y `src/libs/ec/abstracts/ECCodes.abstract` (opcodes y fuentes en
L3). El cliente del repo no tenía NINGÚN opcode de servidores (L4) ⇒ se añaden solo los
opcode y tags documentados que S3 exige, sin inventar nada.

S3 — acciones de servidores, forma verbatim del Ask elegido:
```
POST /api/amule/servers/add | /remove | /connect
GET  /api/amule/servers   (listado con estado)
```
- add → `EC_OP_SERVER_ADD` (0x31) con `EC_TAG_SERVER_ADDRESS` («ip:puerto») y
  `EC_TAG_SERVER_NAME` (patrón de `amule-remote-gui.cpp`).
- list → petición `EC_OP_GET_SERVER_LIST` (0x2C) con respuesta `EC_OP_SERVER_LIST`
  (0x2D): cada servidor con nombre, dirección y estado de conexión.
- remove → `EC_OP_SERVER_REMOVE` (0x30); connect → `EC_OP_SERVER_CONNECT` (0x2F) —
  mismos tags de dirección que add (tags exactos verificados en `ECCodes.abstract` al
  implementar; L3).
- Contrato de respuesta de casa (predecesor `POST /api/amule/test`): HTTP 200 siempre
  con `{ok, detail}` — `detail` en español y honesto — autenticado con `verify_api_key`,
  y jamás filtra la contraseña EC ni credenciales.

S4 — enlaces, forma verbatim del Ask elegido: `POST /api/amule/links      (ed2k/magnet
→ cola)` — acepta `ed2k://` y `magnet:`, rechaza cualquier otro esquema con
`{ok:false, detail}` honesto, y reutiliza la costura ya existente `EC_OP_ADD_LINK`
(0x09, `build_add_link` del cliente).

S5 — frontend: la nueva pestaña «aMule» concentra la config (S1), la tarjeta del
watchdog y un **bloque de acciones**: listado de servidores con estado por fila +
formulario «añadir servidor» (dirección y nombre) + botones quitar/conectar por fila +
formulario «añadir enlace». Las acciones NO pasan por «Guardar cambios» (precedente:
`IndexadoresSection`/`SharedDirsSection` escriben por su cuenta). Estados honestos: sin
EC configurado o caído ⇒ detalle en español, nunca spinner infinito; toda etiqueta nueva
en español; sin estilos inline.

S6 — arquitectura: `interfaces` sigue sin importar `infrastructure` (puerto
`AmuleECService`/`gateways` o inyección como `routes/amule_shares.py`); si `app.py`
crece, bump del ratchet `MAX_LEGACY_LOC` con entrada de formato de casa; pyflakes y
vulture en verde sin ampliar whitelist.

S7 — «luego visualiza otras opciones interesantes»: el informe de cierre presenta (sin
implementar) el catálogo de opciones futuras derivado de L3: pausa/reanudar/prioridad/
cancelar descargas (`EC_OP_PARTFILE_PAUSE/RESUME/PRIO_SET/DELETE`), conectar y
desconectar redes (`EC_OP_CONNECT/DISCONNECT`, `EC_OP_KAD_START/STOP`), límites de
ancho de banda en vivo (`EC_OP_GET/SET_PREFERENCES`), log (`EC_OP_GET_LOG`/`RESET_LOG`),
estadísticas (`EC_OP_STATS`), categorías (`EC_OP_CREATE/UPDATE/DELETE_CATEGORY`),
recarga de compartidos (`EC_OP_SHAREDFILES_RELOAD`) y de ipfilter
(`EC_OP_IPFILTER_RELOAD`), y actualización de lista de servidores por URL
(`EC_OP_SERVER_UPDATE_FROM_URL`).

S8 — prohibiciones: ningún opcode fuera de `ECCodes.abstract`; nunca exponer la
contraseña EC ni credenciales en respuestas o payloads; cero cambios en la lógica del
watchdog; las rutas existentes `/api/amule/test`, `/api/amule/health` y
`/api/amule/shared-dirs` quedan intactas en comportamiento; sin cambios en e2e.

## Tasks

T1 — Tests RED de S3/S4 (padre): builders de servidores en el cliente EC + rutas del
router nuevo — pendiente commit
T2 — Backend: opcodes/tags de servidores + builders + funciones de servicio + router
`routes/amule_actions.py` con registro en `app.py` (worker, `Spec: odd/tasks/amule-control.md, T2`)
— pendiente commit
T3 — Seam review + gates padre (focused + full + tsc/eslint/build + ratchet/vulture) —
pendiente
T4 — Frontend: pestaña «aMule» (traslado de config, S1) + bloque de acciones (S5) + tests
(worker, `Spec: odd/tasks/amule-control.md, T4`) — pendiente commit
T5 — Seam review + gates padre — pendiente
T6 — Docs (README/HANDOFF) + gates full finales → HANDOFF → assess → PR con disclosure →
CI → merge → recordar deploy manual → verif prod → informe con S7 (opciones futuras) —
pendiente

## Log

L1 — Petición original del usuario (verbatim): «abstraigamos las configuraciones de amule
a otra pestaña de ajustes, luego mira la documentacion de la api y implementemos acciones
para controlar amule desde mi aplicacion, como por ejemplo añadir servidores, luego
visualiza otras opciones interesantes.»
L2 — Ask de alcance (2026-10-29), pregunta «¿Qué bundle de acciones de control de aMule
implemento en la v1? (el resto lo presento como opciones futuras tras la entrega)»,
respuesta del usuario: «Servidores + enlaces (recomendado)» con preview verbatim:
`POST /api/amule/servers/add | /remove | /connect` / `GET  /api/amule/servers   (listado
con estado)` / `POST /api/amule/links      (ed2k/magnet → cola)`.
L3 — Research EC (fuentes: amule-org.github.io/docs/developer/ec-protocol, wiki.amule.org
EC Protocol HOWTO, `amule-org/amule` → `src/libs/ec/abstracts/ECCodes.abstract` y
`src/amule-remote-gui.cpp`, docs de `amulecmd` y `server.met`). Opcodes de interés
confirmados con valores hex: `EC_OP_ADD_LINK 0x09`, `EC_OP_GET_SERVER_LIST 0x2C`,
`EC_OP_SERVER_LIST 0x2D`, `EC_OP_SERVER_DISCONNECT 0x2E`, `EC_OP_SERVER_CONNECT 0x2F`,
`EC_OP_SERVER_REMOVE 0x30`, `EC_OP_SERVER_ADD 0x31`, `EC_OP_SERVER_UPDATE_FROM_URL
0x32`, `EC_OP_GET/SET_PREFERENCES 0x3F/0x40`, `EC_OP_PARTFILE_PAUSE/RESUME/STOP/PRIO_SET/
DELETE 0x19–0x1D`, `EC_OP_CONNECT/DISCONNECT 0x4A/0x4B`, `EC_OP_KAD_START/STOP 0x48/0x49`;
protocolo actual `EC_CURRENT_PROTOCOL_VERSION 0x0204`; add-server usa
`EC_TAG_SERVER_ADDRESS` («ip:puerto») + `EC_TAG_SERVER_NAME` (ancla:
`CamuleRemoteGuiApp::AddServer`); `amulecmd add` acepta enlaces ed2k de archivo, de
servidor y serverlist y magnet; handshake = salt MD5 como ya implementa el cliente.
L4 — Explore handoff (`mvtb89bd-z-81ad`, evidencia path:line): rail con
`role="tablist"` «General»/«Indexadores» en `frontend/src/features/settings/Settings.tsx:307-356`
(const `TABS` :143-146, estado :211, paneles montados con `hidden` :358-364/365/589);
`AmuleEcSection` montado en `Settings.tsx:526-533` (valores :52-58, escribe
`services.amule.{url,ec_port,ec_password}` :163/:170/:177, probe :204, poll watchdog
:114-131); claves backend `backend/config.py:199-201` y `watchdog_*` leídas en
`backend/infrastructure/amule_watchdog.py:163-189`; cliente EC con tabla de opcodes
`:152-181` (sin opcodes de servidores) y builders `:488+` (`build_add_link` :570);
servicio `amule_service.py` fns :51-105; rutas `routes/settings.py` (placeholders
:22-32, `_probe_amule_ec` :337, test :369, health :388); predecesor de router propio
`routes/amule_shares.py` registrado en `app.py:125`; puertos en
`application/gateways.py:70-114` + `ports.py:255-273` (wrappers `gateways.amule_*`
:385-423, bind `app.py:46`); inyección de settings en `app.py:63` (línea ya tope del
ratchet); contrato de capas y ratchet
`backend/tests/contracts/tests_architecture.py:38-44/96/205-246` (`MAX_LEGACY_LOC=3455`);
patrón de acciones fuera de «Guardar cambios»: `Settings.tsx:571-574/593-597`
(`SharedDirsSection`/`IndexadoresSection`); test files de ancla listados en el handoff
(route tests de amule y tests de infra).
L5 — Frontera de slice (2026-10-29): `05851f5` (doc, 128 L) + `22d940d` (RED, 277 L)
= 405 L autoriginales en 2 commits > presupuesto ~400 ⇒ ESTRATEGIA DE ENTREGA:
**PR único con disclosure en el cuerpo** (mismo criterio que file-navigator F1/F2/F3/F4,
idiomas-metadata 1051 L y amule-watchdog 2033 L), frontera anotada aquí. Redis de
observación: builders rc=2 (ImportError de los nombres nuevos) y rutas 15 failed (404
router inexistente) — evidencia dada al worker de T2. Frontera ampliada con cada unit:
`5ca33d3` (esta entrada) y `f94da28` (T2 backend + seam T3 del padre: fix de 3 corchetes
CJK en mensajes de servicio, gates propios focused 39/arch/vulture/pyflakes rc=0 y full
1743 passed + 1 dist-fresh pendiente del rebuild tras T4) ⇒ acumulado **1008 L / 4
commits**; estrategia invariante: PR único con disclosure del total final en T6.
