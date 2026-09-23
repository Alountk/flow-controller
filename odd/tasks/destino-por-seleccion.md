# Destino por selección de releases

## Objective

Al buscar releases de una película o serie, poder asignar **una carpeta destino distinta** a las
filas que marques. Lo no marcado sigue yendo a la biblioteca.

## Problem

Hoy el destino lo decide el arr: su root folder más la ruta del título, y no hay forma de decir
"esta descarga va a otro sitio". El buscador ya permite marcar varias filas y descargarlas en lote,
pero todas acaban donde diga el arr.

## Why

Petición textual del usuario: *"cuando estamos buscando una película / serie poder escoger otros
archivos vistos y asignarles otra carpeta, por ejemplo: los de 1080 que vayan a la carpeta normal y
los otros seleccionados a una carpeta específica seleccionada con un combo"*.

## Decisión tomada (2026-09-23)

**Carpeta ajena: el arr no la toca.** La app copia ahí y **evita que el arr la importe** — si no, el
mismo contenido acabaría dos veces, una en la carpeta elegida y otra en la biblioteca. El combo
aplica a **la selección**; lo no marcado va a la biblioteca (el root folder del arr).

## Diseño

- **UI**: en `ReleaseSearchModal`, un combo de carpeta que aplica a **las filas marcadas**, con
  "Biblioteca (la del arr)" por defecto.
- **De dónde salen las carpetas**: de los *root folders* del arr (`arr_root_folders`, que ya existe)
  **más** las raíces permitidas de la app (`ALLOWED_ROOTS`). Nunca una lista inventada.
- **Persistencia**: `own_grabs` gana una columna con el destino elegido (migración aditiva, esquema
  v6). El barrido automático la necesita para copiar donde toca.
- **La copia**: se reutiliza el motor (`do_action("copy_files")`), que ya hace recursivo con
  estructura y hardlink primero. Ojo: hoy resuelve el destino **desde el arr**, así que hay que
  dejarle recibir un destino explícito.
- **"El arr no la toca"**: hay que **quitarle el item de la cola sin borrar los ficheros**.
  `arr_delete_queue` hoy manda `removeFromClient=true`, que **mataría el sembrado** — y el usuario
  quiere seguir compartiendo. Hace falta la variante con `removeFromClient=false`.
- **La marca naranja** mostraría también a dónde se mandó, no solo cuándo.

## Decisión: cuándo se le dice al arr que no la toque (cerrada 2026-09-23)

**Al copiar, justo antes de copiar. Nunca al hacer el grab.** Y solo para los grabs cuyo destino es
una carpeta ajena; los que van a la biblioteca no tocan la cola.

Razonado contra las dos constraints del usuario:

- **Al hacer el grab no solo hay carrera: rompe la detección de la app.** El grab va por
  `POST /api/v3/release`, así que es el arr quien encola el item. `build_traces` —de donde sale el
  `stage` que gobierna la política— lee **la cola del arr**. Quitar el item ahí dejaría a la app sin
  forma de saber cuándo terminó la descarga: se llevaría por delante el mecanismo que decide copiar.
- **Al copiar, la carrera ya está resuelta a nuestro favor.** La política no copia mientras el arr
  importa (`importing` → WAIT) ni dentro de la ventana de gracia; solo copia ante un `warning` (arr
  atascado) o cuando el arr no importó en 30 min. En ese momento el arr ya no está a punto de
  importar: se quita el item con `removeFromClient=false` (sin blocklist) y se copia.
- **Si el arr ganó la carrera igualmente, se honra "no catalogado por el arr" a costa de la
  intención**: el guard `arr_has_file` ya responde "el arr ya tiene el fichero" y la copia no ocurre.
  Nunca hay duplicado, y el motivo deja claro por qué la carpeta quedó vacía. Fallo honesto y visible.

Riesgo residual aceptado y documentado: quitar el item sin importarlo deja el título como faltante,
así que el arr puede volver a buscarlo por RSS. Es el precio de "el arr no la toca"; la marca y el
historial de transiciones lo hacen visible.

Supuesto menor tomado (corregible): en una carpeta ajena el contenido va **directo** a ella, sin el
subdirectorio `Season XX` que sí se aplica en la biblioteca.

## Slices (PRs, presupuesto de 400 líneas)

- **S1 — T1: el destino viaja y se persiste.** Migración de esquema v6 + columna `destination` en
  `own_grabs`; `record_own_grab(destination=...)`; `/api/calendar/grab` y `/grab-batch` aceptan un
  `destination` opcional (uno por lote: la UI agrupa por destino). Sin cambio de comportamiento:
  ausente/NULL = biblioteca.
- **S2 — T2 + T3: copiar a un destino explícito y que el arr no la toque.** `copy_files` acepta
  `dest_root`; `arr_delete_queue` gana `remove_from_client`; el driver resuelve el destino del grab
  y quita la cola del arr antes de copiar. Detalles que S2 tiene que respetar:
  - **Trampa detectada (crítica)**: `run_copy_background` hoy, tras copiar, lanza
    `ProcessMonitoredDownloads` al arr y sondea con `verify_import` hasta que el arr tiene el
    fichero. En un destino ajeno eso es **justo lo contrario** de lo pedido: haría que el arr
    importara a la biblioteca. La copia a carpeta ajena **no** debe disparar la importación ni
    sondearla; termina en `done` con un motivo que diga que el arr no la toca.
  - **Orden y fail-closed**: quitar de la cola **antes** de copiar, de forma síncrona en
    `do_action("copy_files")`, para que un fallo devuelva `ok:false` y el sweep lo reintente sin
    haber copiado. Si el ítem ya no está en la cola (404) no hay nada que impedir: se copia. Cualquier
    otro error es real y **no** se copia (honra "no catalogado por el arr").
  - **De dónde sale el destino**: el driver necesita la fila del propio grab, no un booleano. Se
    añade un buscador que devuelve la fila (la más reciente que casa) y `matches_own_grab` pasa a
    delegar en él para no cambiar los 16 puntos que ya lo usan. `destination` NULL = biblioteca =
    comportamiento de hoy.
  - **Defensa en profundidad**: `copy_files` vuelve a validar `dest_root` contra las raíces
    permitidas antes de escribir nada.
- **S3 — T4 + T5: la UI.** Combo de carpeta aplicado a la selección (root folders del arr +
  `ALLOWED_ROOTS`) y la marca mostrando el destino.
- **S4 — T6 + T7: tests transversales y verificación en vivo** con `SAFE_MODE` (propone y no escribe).

## Tasks

- [x] **T1** `own_grabs` con la columna de destino + migración v6 (S1) — hecho en `72357ae`
- [ ] **T2** `copy_files` aceptando un destino explícito (S2)
- [ ] **T3** variante de quitar de la cola del arr **sin** borrar del cliente (S2)
- [ ] **T4** UI: combo de carpeta aplicado a la selección (S3)
- [ ] **T5** la marca muestra el destino (S3)
- [ ] **T6** tests (persistencia, destino explícito, la orden al arr, la UI) (S4)
- [ ] **T7** verificación en vivo con `SAFE_MODE` (S4)

## Constraints

- Hay que **seguir sembrando**: nunca borrar del cliente de descarga.
- Un destino fuera de los root folders del arr **no puede acabar catalogado por el arr sin
  querer**.
- `SAFE_MODE` sigue gobernando cualquier acción que toque la cola del arr o la biblioteca.

## Applicable checks

- Backend: `cd backend && python3 -m pytest -q`, `python3 -m pyflakes *.py routes/*.py`,
  `python3 -m vulture`
- Frontend: `cd frontend && npm test && npm run build`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`).

## Progress

- [x] Diseño cerrado (el timing quedó resuelto: se actúa al copiar, no al hacer el grab).
- [x] **S1 cerrada** (rama `feat/destino-por-seleccion`, desde `main` = `193b430`):
  - `421b8ca` docs(odd): el documento de feature.
  - `72357ae` feat(calendar): persistir el destino opcional en los propios grabs.
  - 333 líneas autoradas. Verificación: `pytest -q` → **499 passed** (base 489), `pyflakes` y
    `vulture` sin salida.
  - Deuda anotada: la lista de raíces permitidas sigue **duplicada literal** en `routes/files.py`,
    `routes/wanted.py` y `routes_mixer.py`; existe ya una autoridad única (`config.ALLOWED_ROOTS` +
    `path_is_allowed`) a la que se pueden migrar, fuera del alcance de esta feature.
- [!] **Revisión nativa de S1: parada, no cerrada.** Linaje `review-9545e53c1d8e3453` (riesgo medio,
  una lente: `review-reliability`). La lente devolvió resultado vacío dos veces
  (`opencode_task_output_empty`), se declaró el slot inalcanzable y Go devolvió
  `stop / unachievable_lens_slot`. **S1 queda sin revisar**; la entrega es decisión del usuario bajo
  la política normal del repo.
- [x] **S2 cerrada** (misma rama), en dos commits porque T2 solo ya pasaba de 400:
  - `53658ca` feat(clients): quitar de la cola del arr sin borrar del cliente (97+/10−).
  - `11ac52e` feat(auto-copy): copiar a un destino explícito que el arr no importa (501+/31−).
  - Verificación: `pytest -q` → **517 passed** (base 489), `pyflakes` y `vulture` sin salida.
  - La trampa de `ProcessMonitoredDownloads` quedó cerrada: en carpeta ajena no se dispara la
    importación ni se sondea; y la copia es fail-closed si no se puede garantizar que el arr no la toque.
  - Test que el writer no añadió (anotado, no escondido): fuente **archivo** + `dest_root` end-to-end.
- [x] **Revisión nativa del candidato S2: saltada por el usuario** (`declined_this_candidate`, sin
  registro de revisión, revisiones futuras siguen activas).
- [!] **Decisión de entrega pendiente**: el candidato acumulado son **1117 líneas en 15 ficheros**.
  T3 (107) cabe en un PR; **T2 (532) no cabe sin partirse o sin `size:exception`**.
- [ ] S3 pendiente: T4 + T5 (UI).
- [ ] Tras la feature: el *check de los dos `.env`* (`FC_SECRET` vs `API_KEY`, raíz y `backend/`).

## Next step

Resolver el reparto en PRs (presupuesto de 400) y seguir con S3 (T4 + T5: el combo de carpeta
aplicado a la selección y la marca mostrando el destino).
