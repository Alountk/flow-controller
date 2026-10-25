# qbit-nativo — descargas magnet/http directas a qBittorrent, sin aMuTorrent de intermediario

Feature derivada de la investigación del turno 2026-10-25 sobre «no veo a quién se lo manda».
Rama: `feat/qbit-nativo` desde main `c5fc4c7`. SDD fuera (ODD por mandato).

## Specs

- **S1 (L1 — verbatim):** «no quiero tener el amutorrent como bypass para pasar las descargas de
  qbittorrent, implementemos algo nativo. No quiero dependencias, excepto las estrictas.»
- **S2 (L1 — verbatim, síntoma original):** «cuando le doy a descargar no veo a quien se lo manda
  para descarga. se hace un post a https://flow-control.androemda-surf.uk/api/indexers/download
  con un true y categoria flow, pero creo que si esto no esta conectado a la api de qbittorrent no
  hara nada, investiga» → el `detail` del resultado DEBE nombrar el destino («Descarga añadida en
  qBittorrent (http://<host>:<puerto>), categoría flow») en éxito Y el destino en el rechazo
  («qBittorrent (URL) no aceptó la descarga: …» / «qBittorrent no está configurado — añádelo en
  Configuración → Servicios» cuando falte).
- **S3 — servicio nuevo `qbit`:** `services.qbit.{url,user,password}` en settings.json con el
  patrón de máscara existente: password NUNCA en claro por API (`_mask_secrets`/`_restore_masked_secrets`
  deben incluir `("qbit", password)`; si el sentinelo enmascarado no se restaura al guardar, la
  clave se BORRA — regresión de credenciales). Tarjeta «Servicios» en Settings + `ServiceKey`
  ampliado. No configurado (`url` o `user` o `password` vacíos) → `configured:false` y toda
  descarga magnet/http nativa responde 200 `{ok:false, detail:<S2>}` — nunca un éxito inventado.
- **S4 — cliente nativo (S1):** módulo propio `backend/infrastructure/qbit_client.py` usando
  **sólo aiohttp (dependencia estricta existente)**: `POST /api/v2/auth/login` (form
  username/password/rememberMe, header `Referer`) → cookie SID → `POST /api/v2/torrents/add`
  (form `urls`+`category`, headers `Referer`/`Origin`) en la MISMA sesión. Auth = login+SID:
  Bearer devuelve **403 en el qBittorrent real** (verificado: `chan`+pass → `Ok.`, Bearer → 403,
  sin auth → 403). Categoría `DIRECT_DOWNLOAD_CATEGORY="flow"` SIN paso `ensure_category` —
  verificado en vivo: `createCategories` responde **404** en este build y el `add` **auto-crea**
  la categoría (el torrent apareció en `flow` sin crearla antes).
- **S5 — contrato honesto (raíz del bug):** éxito = HTTP **200** Y body `strip()` ∈ {"", "Ok."};
  TODO lo demás (cualquier no-200, o 200 con `Fail.`/`Fails.`/texto) → `{"ok": false, "detail":
  …}` con el body (roto a ≤200, redactando `apikey=`). El falso éxito actual —`amutorrent_add_download`
  sólo miraba status y aMuTorrent devuelve 200+`Fail.`— queda imposible. Login que responde
  `Fails.` → rechazo «qBittorrent rechazó las credenciales (URL)». Timeout = `REQUEST_TIMEOUT*12`
  (presupuesto ED2K medido, precedente PR #193) con detalle `TimeoutError: sin respuesta tras Ns`.
- **S6 — dispatch:** en `POST /api/indexers/download`, magnet/https → **nativo qbit** (S4/S5,
  destino en detail S2); en `POST /api/mixer/alternatives/language-download` → **nativo qbit**
  (mismo contrato, su rechazo deja de decir «aMuTorrent»). `ed2k://` y hash32 → **sin cambios**
  (EC directo / flag=0 → puente aMuTorrent: dominio aMule, no qBittorrent).
- **S7 — fuera de alcance (explícito):** `grab_release` con `AMULE_EC_DIRECT=0` (rollback legacy
  byte-idéntico, env-gated) sigue en `amutorrent_add_download`; `AMUTORRENT_URL` sigue vivo para
  `/indexer/amule/api` (búsqueda ED2K), WS de control y status; `amutorrent_add_download` y sus
  tests `tests_direct_add.py` se MANTIENEN (consumidores: rollback + ed2k flag=0). Sin cambios en
  e2e (ningún spec toca `indexers/download`; el fake-arr no stubbea qbit; servicio sin configurar
  → rechazo honesto, no rompe nada).
- **S8 — contratos de test:** TDD RED primero por unidad. Los strings de rechazo
  «aMuTorrent no aceptó la descarga»/«Descarga añadida (categoría flow)» de
  `tests_indexers_download.py` y `tests_mixer_language_download.py` se REESCRIBEN con
  contabilidad (justificación S2/S5/S6); `tests_direct_add.py` intacto (S7). Cero pérdidas
  netas sin contabilizar; gate: backend **1597** + tests nuevos, frontend **754** + tests nuevos,
  tsc 0, eslint 0, ratchet `MAX_LEGACY_LOC=3408` intacto (`qbit_client.py` NO es capa legacy).

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | header, S1–S8 | doc + espejo Engram | e9…(prev) |
| T2 | S2, S3, S4, S5, S6, S8 | backend worker: `qbit_client.py` + `config.py` (globals+SERVICES) + `settings.py` (máscara/restauración) + `arr_client.py` (ramas kind `qbittorrent` en `check_service`/`test_service_connection` con probe de login) + `gateways.py`/`ports.py`/bind + dispatch en `routes/indexers.py` y `routes_mixer.py` + tests (RED primero; contabilidad S8) | `feat(qbit): …` |
| T3 | S3, S8 | frontend worker (superficies disjuntas, paralelo a T2): `shared/types.ts` (`ServiceKey`+'qbit') + `features/settings/Settings.tsx` (tarjeta qbit url/user/password + fila en «Estado de las conexiones») + `shared/api/services.ts` si hace falta + tests de contrato (máscara, probe) | `feat(settings): …` |
| T4 | todos | parent: gate completo, assess, reconciliar workers | — |
| T5 | S2, S8 | parent: README (tabla `qbit` en servicios/env), Log cierre, PR único con divulgación, merge al verde | `docs: …` |

## Log

- **L1 — petición (verbatim):** «ok, ahora sale todo bien y busca perfectamente. Solo que cuando le
  doy a descargar no veo a quien se lo manda para descarga. se hace un post a
  https://flow-control.androemda-surf.uk/api/indexers/download con un true y categoria flow, pero
  creo que si esto no esta conectado a la api de qbittorrent no hara nada, investiga.»
- **L2 — investigación (turno 2026-10-25, sólo lectura + sondas reversibles):** la cadena es
  `POST /api/indexers/download` → `_download_bridge` → `amutorrent_add_download` →
  `POST {AMUTORRENT_URL=111.111.111.111:4000}/api/v2/torrents/add`. aMuTorrent (:4000) es una
  FACHADA: devuelve **200+`Fail.`** a TODO add (link real de Jackett, magnet, Bearer/cookie/SID/JSON)
  sin añadir nada (9436 torrents intactos, `flow` jamás creada; `createCategories`→401 allí) mientras
  que `arr_client.py:1017` sólo miraba status → **`ok:true` falso** (reproducido contra producción
  con link basura: respondió «Descarga añadida (categoría flow)» y el cliente intacto). Radarr sí
  funciona porque grabbea DIRECTO a `qBittorrent` 172.19.0.2:8080 (`downloadClient: qBittorrent` en
  history) — cliente distinto y sano.
- **L3 — evidencia del contrato NATIVO (sonda viva reversible contra 111.111.111.111:8080):**
  sin auth →403; Bearer `AMUTORRENT_API_KEY` →403; `login chan/PASS-de-.env.local` → `Ok.` (SID);
  `POST torrents/add` (urls=magnet dn=`__native_probe__`, category=flow) → **200 body `Ok.`**,
  categoría `flow` auto-creada y torrent `metaDL` presente; `POST torrents/delete` →200 (estado
  restaurado: 118 torrents, sin probes); `createCategories`/`deleteCategories` → **404** en este
  build (auto-creación en add = el camino). Versión v5.1.4/webapi 2.11.4 (idéntica a la que reporta
  la fachada :4000). `111.111.111.111:8088` (novpn) rechaza la misma password → distinta.
- **L4 — decisiones (parent):** (D1) cliente propio sólo con aiohttp — S1 «dependencias estrictas»;
  (D2) auth login+SID+Referer/Origin, jamás Bearer (403 verificado); (D3) éxito = 200 && body∈{"",
  "Ok."} — S5; (D4) SIN `ensure_category` (404 verificado + auto-creación verificada); (D5) scope
  S6=2 endpoints nativos, S7 rollback/ed2k quedan en aMuTorrent; (D6) servicio `qbit` configurable,
  sin default hardcoded (el usuario apunta donde quiera — recomendado
  `http://111.111.111.111:8080`/`chan`, verificado con la password de AMUTORRENT_*); (D7) destino en
  el `detail` (S2) — lo renderiza el modal ya existente, sin tocar `AlternativeModal`.
- **L5 — riesgo previsto:** item 2 (credenciales nuevas de qBittorrent en settings.json — mismo
  patrón enmascarado de `amutorrent`, password nunca en claro por API). Item 3 no aplica (API
  aditiva; strings internos). e2e intacto.
- **L6 — estrategia de entrega (corte de slice registrado en `1bcdbd6`, T2):** PR ÚNICO con
  divulgación, precedente L10 de `alternativa-indexadores` — la feature excede ~400 líneas/slice
  (T2 backend solo = ~1100 líneas con tests); el corte queda registrado aquí y el cuerpo del PR
  lo disclosea. Ratchet: `MAX_LEGACY_LOC` intacto en 3408 — +6 líneas de `config.py` compensadas
  con compactación de envolturas (−6); técnica a divulgar también en el PR (alternativa
  descartada: subir a 3414 como el precedente prowlarr).
- **L7 — cierre (2026-10-25):** PR **#236** «qbit-nativo: descargas magnet/http nativas a
  qBittorrent, sin aMuTorrent de intermediario» — CI verde (backend-tests, frontend-build,
  docker-verify, e2e; `docker-push` skipped en rama; sólo anotaciones de deprecación) →
  merge `--merge --delete-branch` → main **`a742b16`**, árbol limpio. Gates finales por el
  padre: backend **1633/0**, frontend **760/91**, tsc 0, eslint 0, build OK, ratchet 3408
  intacto, S7 intacto (180). Assess: medium, `reviewDue:false` (under budget, RDD off →
  autoverificación + focos revisados por el padre: regla de éxito 200+Ok./"", split
  `_download_bridge_legacy`, blanqueo `/api/services` a 4 campos, ratchet). Contrato
  `service` (no `key`) cruzado padre↔frontend. Feature CERRADA.
- **L8 — regresión de producción reportada por el usuario (2026-10-25):** «al entrar a
  configuración sale la pantalla de algo salió mal, cannot read properties of undefined
  (reading 'url'), mira a ver que has roto». **Reproducida** antes de decidir:
  `GET /api/settings` con un `settings.json` precaracterística no contenía `services.qbit`
  (`qbit en payload: False`) → la tarjeta lee `form.services.qbit.url` sobre `undefined` →
  ErrorBoundary. **Causa raíz:** `DEFAULTS["services"]` de `settings_store.py` no incluía
  `qbit` (omisión del brief T2 del padre; el worker T3 asumió «los trae el backend» y sus
  fixtures con `qbit` ENMASCARARON el hueco). **Fix TDD:** RED observado (`KeyError: 'qbit'`
  en tests_settings y en tests_routes con archivo LEGADO cargado por el loader real, status
  200) → GREEN añadiendo `"qbit": {url,user,password}` vacíos a `DEFAULTS` (precedente:
  prowlarr/opensubtitles/amutorrent). Backend **1633 → 1635**. **Lección:** `DEFAULTS` ES el
  contrato de payload de toda tarjeta de servicios — el brief de un servicio nuevo debe
  nombrarlo, y fixtures de frontend que modelan el contrato pueden ocultar un default faltante
  del servidor.

- **L9 — regresión 2 y botón de test (2026-10-25, usuario):** «ok habría que poner el boton
  de test en los servicios, porque estoy mandando la descarga y me devuelve esto: {"ok":
  false, "detail": "qBittorrent (http://111.111.111.111:8088/) no aceptó la descarga: HTTP
  404: Not Found"}». **Reproducido ANTES de decidir:** (a) la tarjeta guardó la URL CON barra
  final y `f"{base}/api/v2/…"` picó `//api/v2/…` → el WebUI embebido responde **404**
  (curl exacto: `//api/v2/auth/login` → 404, sin barra → 200); (b) en `:8088` hay OTRO
  qBittorrent WebUI real cuya contraseña NO es la de aMuTorrent (`Fails.` en claro) — la
  instancia verificada que funciona con esa contraseña es `:8080`. **Fix TDD:** RED (2 tests
  backend: doble barra en add y en sonda; 3 tests frontend: botón ausente) → GREEN: `rstrip("/")`
  sobre la base en `qbit_add_download` y `qbit_login_probe` + **«Probar conexión» en las 5
  tarjetas de Servicios** (`ServiceProbeButton`: sonda candidata de `POST /api/services/test`
  con LO QUE EL FORM CONTIENE, omitiendo campos vacíos/enmascarados como la tarjeta aMule EC,
  veredicto por toast con el detalle que incluye la URL intentada). Gates: backend
  **1635 → 1637**, frontend **760 → 763**/92, tsc 0, eslint 0, build OK. **Lección:** normalizar
  la URL del cliente en el borde del cliente (barra final es entrada de usuario legítima); el
  botón de test por tarjeta existía como patrón (aMule EC / wizard) pero no estaba cableado en
  Servicios.
