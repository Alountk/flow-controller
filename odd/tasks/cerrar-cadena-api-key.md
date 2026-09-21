# Cerrar la cadena de la API key

## Objective

Que nadie que alcance el puerto obtenga credenciales ni datos sin conocer la API key.

## Problem

Auditadas las 48 rutas: **21 no tienen autenticación**, y `/api/config` reparte la API key sin
pedir nada. Cadena de escalada verificada en vivo:

```
alcanzar el puerto
  -> GET /api/config     (sin auth)  -> devuelve la API key
  -> GET /api/settings   (con la key) -> devuelve radarr.api_key, sonarr.api_key,
                                          amutorrent.password
```

Y sin necesidad de la key, varios GET ya exponen datos por sí solos:

| Ruta | Qué filtra |
| --- | --- |
| `GET /api/files/browse` | Explorador de archivos: listar directorios |
| `GET /api/wanted`, `/all`, `/series/all` | La biblioteca completa |
| `GET /api/logs` | Logs |
| `GET /api/trace` | Estado de la biblioteca |
| `GET /api/disk`, `/api/calendar`, `/api/downloads`, `/api/debug/indexers`, `/api/actions` | Rutas, calendario, descargas, acciones |

El patrón: **la key solo protege las mutaciones (POST)**; los GET quedaron abiertos.

`SAFE_MODE` protege menos de lo que parece: bloquea solo `remove_queue` y `delete_torrent`. Las
otras 7 acciones, incluidas `copy_files` y `fix_category`, pasan.

## Why

El usuario va a exponer la app a internet (con proxy inverso, opción A). Hoy depende de que nadie
en su LAN curiosee.

## Scope

Dentro:

- `/api/config` deja de devolver la API key. Pasa a informar `auth_required`.
- Nuevo `GET /api/auth/check` (protegido) para validar la clave introducida.
- `Depends(verify_api_key)` en **todos** los endpoints de datos.
- El frontend pide la clave una vez y la guarda (patrón "trae tu propia clave").
- Las 5 llamadas del frontend que no mandan `authHeaders` empiezan a mandarlo.
- La CI pasa a usar `/api/health` para el healthcheck.

Fuera:

- TLS y autenticación de usuarios (Paso 3, opción A: proxy inverso).
- Persistencia con SQLite (Paso 2).

## Constraints

- **Público a propósito**: `/` y `/{full_path}` (shell del SPA, si no no carga la app),
  `/api/config` (solo informa, sin secretos) y `/api/health` (liveness para Docker y CI).
- **Debe seguir funcionando sin API_KEY configurada**: `verify_api_key` retorna temprano si
  `API_KEY` está vacío, así que añadir la dependencia es inocuo en ese caso. Cero regresión.
- La CI hace healthcheck contra `/api/status`, que pasará a estar protegido: hay que cambiarla a
  `/api/health` o el pipeline se rompe.

## Tasks

- [x] **T1** Backend: `/api/config` sin la clave, con `auth_required`
- [x] **T2** Backend: `GET /api/auth/check` protegido
- [x] **T3** Backend: `Depends(verify_api_key)` en todos los endpoints de datos
- [x] **T4** CI: healthcheck contra `/api/health`
- [x] **T5** Frontend: bootstrap con clave de `localStorage` y pantalla de acceso
- [x] **T6** Frontend: `authHeaders` en las 5 llamadas que faltan
- [x] **T7** Tests backend: toda ruta de datos responde 401 sin clave
- [x] **T8** Tests frontend: la pantalla de acceso aparece y valida
- [x] **T9** Verificación en vivo de la cadena cerrada

## Acceptance criteria

- `/api/config` no contiene la API key en ningún caso.
- Sin clave, toda ruta de datos responde 401; `/`, `/api/config` y `/api/health` siguen públicos.
- Con `API_KEY` vacía, el comportamiento es exactamente el de antes.
- Con `API_KEY` configurada, el navegador pide la clave una vez y la recuerda.
- La CI sigue en verde.

## Applicable checks

- Backend: `python -m pytest -q`, `python -m pyflakes *.py routes/*.py`, `python -m vulture`
- Frontend: `npm test`, `npm run build`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`).

## Progress

- Rama: `fix/cerrar-cadena-api-key`. **Todos los tasks hechos.**

## Verification evidence

**En vivo, con `API_KEY=clave-secreta`:**

- `/api/config` -> `{"developer":"true","auth_required":true}` — **ya no contiene la clave**.
- **11 rutas de datos sin clave -> todas 401** (`/api/settings`, `/api/files/browse`, `/api/wanted`,
  `/api/trace`, `/api/logs`, `/api/status`, `/api/disk`, `/api/downloads`,
  `/api/calendar/indexers`, `/api/actions`, `/api/debug/indexers`).
- Públicas a propósito: `/api/health` 200, `/api/config` 200, `/` 200.
- Con la clave correcta: `/api/settings`, `/api/wanted`, `/api/trace`, `/api/downloads` -> 200.
- `/api/auth/check`: clave correcta 200, errónea 401.
- **Regresión sin `API_KEY`**: `/api/settings` 200, `/api/wanted` 200 y
  `auth_required: false` — comportamiento idéntico al de antes.

**Guards validados revirtiendo:**
- Quitar la auth de `/api/files/browse` hace fallar el test estructural **y lo nombra**.
- El guard enumera rutas vía `app.openapi()`: la primera versión usaba `app.routes` y
  **encontraba cero rutas**, pasando en vacío. Hay un test que lo impide
  (`test_the_guard_actually_sees_routes`).

**Suites:** backend 217 -> 223 passed; frontend 127 -> 136 passed. `pyflakes` y `vulture` limpios.

## Next step

Ninguno: PR abierta. Paso 2 (SQLite para historial) y Paso 3 (TLS + proxy) quedan pendientes.
