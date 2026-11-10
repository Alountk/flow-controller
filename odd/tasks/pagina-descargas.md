# Página «Descargas» — cola de aMule en vivo con control (v1)

Feature de una página nueva de descargas: en v1 muestra la cola eD2K de aMule
en vivo con control por fichero; qBittorrent queda preparado pero SIN
implementar («más adelante»). Seguimiento no se toca.

## Specs

**S1 — Página «Descargas», en otra página.**
Cita del usuario: «me parece bien que viva en otra págin, una de descargas
estaria bien». Nueva entrada de navegación: union `Page` + `PAGE_PATHS`
(`/descargas`) + item del Sidebar con etiqueta «Descargas», render desde
`App.tsx`. Ningún fichero de `Seguimiento.tsx`/`Seguimiento.css` ni del panel
`auto-copy` cambia (S5).

**S2 — «las descargas de amule(ahora)»: cola EC en vivo.**
`GET /api/amule/downloads` devuelve las partfiles de aMule leídas con
`EC_OP_GET_DLOAD_QUEUE (0x0D)` → respuesta `EC_OP_DLOAD_QUEUE (0x1F)`, tags
`EC_TAG_PARTFILE (0x0300)` con sus subtags (fuente de códigos:
`src/libs/ec/abstracts/ECCodes.abstract` de `amule-org/amule`, rama `master`).
Cada fila:
`{hash, name, size_full, size_done, progress_pct, speed, eta_seconds, state,
stopped, status_code, priority, category, sources, ed2k_link}`.
- Envelope: `200 {ok: true, downloads: [...], detail}` con `detail` contando
  filas, y `{ok: false, detail}` en fallo — el mismo patrón que
  `GET /api/amule/servers` de `amule_actions.py`.
- `state` derivado (el chip pinta `state`, nunca el código crudo):
  `size_done >= size_full` → `completed`; `stopped` o `status_code == 7` →
  `paused`; `DOWNLOAD_ACTIVE`, `speed > 0` o `SOURCE_COUNT_XFER > 0` →
  `downloading`; resto → `waiting`. Verificado contra la propia UI de aMule:
  `StatusString` de `src/webserver/default/amuleweb-main-dload.php`
  (`status == 7` → Paused, `src_count_xfer > 0` → Downloading, resto →
  Waiting). El enum crudo de `PARTFILE_STATUS` se documenta en T1 con su
  fuente.
- `eta_seconds = (size_full - size_done) / speed` sólo si `speed > 0`, si no
  `null`.
- Orden: el que devuelva aMule (sin reordenar en v1).
- Sin configurar → negativa honesta «no está configurado» (mismo patrón que
  `amule_actions`/`amule_service`); la contraseña EC nunca sale en detalles.
- La fila expone `source: "amule"` (costura S4).

**S3 — Control por fichero (definición aceptada: la opción «B» elegida).**
Texto de la opción elegida: «Cola de aMule visible + control: implementar el
*listado* (EC o amuleapi) y exponer pausa/prioridad/categoría/borrar por
fichero».
- `POST /api/amule/downloads/{action}` con `action ∈ {pause, resume, delete,
  priority, category}` y `file_hash` en el cuerpo (+ `priority` o `category`
  o `delete_files` según la acción). Respuesta `200 {ok, detail}` en ambos
  sentidos; negativas en español; mismas excepciones EC tipadas mapeadas que
  `amule_actions`.
- `delete` es destructiva → bloqueada con `SAFE_MODE` activo, con el mismo
  mensaje del patrón `/api/actions`.
- `GET /api/amule/categories` → `{ok: true, categories: {título: índice}}` /
  `{ok: false, detail}` (binding ya verificado de `amule_categories()`),
  para el selector de categoría.
- Los valores de `priority` verificados en `PrioString` de amuleweb
  (`amuleweb-main-dload.php`): `0=Baja, 1=Normal, 2=Alta, 3=Muy alta,
  4=Muy baja, 5=Auto, 6=Release` — etiquetas en español en la UI; T1 confirma
  cómo rellena `EC_TAG_PARTFILE_PRIO` el servidor aMule antes de fijar la
  etiqueta final, y `status_code` crudo queda para el `title` del chip.

**S4 — «y más adelante las de qbittorrent».**
En esta feature NO se implementa qBittorrent. Sólo la costura: las filas
llevan `source` y el frontend trata las filas como de fuente agnóstica, de
modo que un segundo proveedor se sume sin reescribir la página.

**S5 — Seguimiento intacto.**
Cita del usuario: «la parte de seguimiento vamos a tener que hacer una
restructuracion bestia, dejemoslo como esta» → cero cambios en
`Seguimiento.tsx`, `Seguimiento.css` y `features/auto-copy/*`.

## Tasks

| ID | Specs | Tarea | Ruta | Commit |
|----|-------|-------|------|--------|
| T1 | S2, S3 | Cliente EC `get_downloads()` (build 0x0D, parse 0x1F con subtags PARTFILE) + `amule_service` + verificación del enum `PARTFILE_STATUS` y de `priority` en `amule-org/amule` + tests fixtures RED→GREEN | writer backend | — |
| T2 | S2, S3 | Rutas `GET /api/amule/downloads`, `POST /api/amule/downloads/{action}`, `GET /api/amule/categories` + registro en `app.py` (ratchet +N divulgado si toca) + tests RED→GREEN | writer backend | — |
| T3 | S1, S2, S3, S4 | `Descargas.tsx` + CSS, `shared/api`, tipos, `Page`/`PAGE_PATHS`/Sidebar/`App`, controles con confirmación en borrar, poll, tests RED→GREEN | writer frontend | — |
| T4 | S1–S5 | Cierre del padre: suites completas, L2 del doc, PR, CI, merge, Linear, memoria | padre | — |

## Log

L1 — «B, me parece bien que viva en otra págin, una de descargas estaria bien,
que salieran las descargas de amule(ahora) y más adelante las de qbittorrent»

L2 — T1-T3 ENTREGADOS (2026-11-10): dos writers en paralelo (backend T1+T2,
frontend T3), RED→GREEN observado en ambos; reconciliación de contrato del
padre: `category` = índice numérico o `null` (aMule omite ceros, el TAG ausente
no es índice 0), el frontend resuelve el título vía `GET /api/amule/categories`
(test «índice 0 → título» + arista `null` sin chip). Suites al cierre: backend
**2264**, frontend **1086**, tsc/eslint/vite/pyflakes/vulture 0; ratchet
3603→3604 (`app.py`, divulgado). Fronteras de rebanada (single-PR-with-
disclosure): `92d881c` backend +910, `a7a35ec` frontend +894.
