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
  y quita la cola del arr antes de copiar.
- **S3 — T4 + T5: la UI.** Combo de carpeta aplicado a la selección (root folders del arr +
  `ALLOWED_ROOTS`) y la marca mostrando el destino.
- **S4 — T6 + T7: tests transversales y verificación en vivo** con `SAFE_MODE` (propone y no escribe).

## Tasks

- [ ] **T1** `own_grabs` con la columna de destino + migración v6 (S1)
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
- [ ] S1 en curso: T1 (persistencia del destino). Sin commits todavía.

## Next step

Cerrar S1 (T1) con su commit de unidad de trabajo, y seguir con S2, que es donde está el riesgo real.
