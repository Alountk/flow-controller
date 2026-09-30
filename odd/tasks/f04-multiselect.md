# F-04 — Selector múltiple en el explorador de ficheros

## Objetivo
Selección de varios ficheros en la pestaña *Archivos* + acciones en lote, con **resultado por
fichero**. Base sobre la que se apoya después F-05 (borrado en lote de descargas caducadas).

Petición: *"en la sección de archivos, que es como un explorador de carpetas, un selector de
varios archivos"*.

## Lo que había
- `FileManager.tsx:47` → `selected: string | null` (**selección unitaria**).
- Todas las acciones en la fila: `handleQueue(type, item)` (copiar/mover), `handleDelete`
  con `confirm()` por fichero.
- **`FileManager.tsx` (542 líneas) no tenía ni un test.**

## Decisiones tomadas

| # | Decisión | Razón |
|---|----------|-------|
| 1 | La selección se resuelve con **`utils/selection.ts`** importado, nunca reescrito | Su docstring lo dice: *"two copies of this logic is two chances to drift, and the drift is silent"*. Es la misma trampa de los dos `PAGE_PATHS` |
| 2 | **Sin endpoints nuevos**: el lote es N llamadas a `deleteItem`/`queueAdd` | No hay `batch` y no lo inventamos. La cola ya es secuencial y persiste en SQLite |
| 3 | Borrado **secuencial**, no `Promise.all` | 50 `unlink` en paralelo contra un montaje de red es como se consiguen timeouts |
| 4 | **Toast con recuentos + informe persistente de rechazados** con el `detail` literal | Un fallo parcial es el caso normal (el guard de semilla rechaza algunos): "algo falló" es mentir |
| 5 | El lote de borrado pide confirmación con la **cuenta y la frase de irreversibilidad** | Regla del usuario: *"la decisión de borrado tiene que ser mía, con un aviso de que si borro no podré recuperar los datos"* |
| 6 | La selección se limpia tras cada lote y al navegar | Dejar filas marcadas invita a un segundo clic que encola dos veces |
| 7 | **Fuera de alcance**: endpoints `batch`, subida de directorios completos en la selección, límite de elementos | Ver "Abierto" en `BACKLOG.md` |

## Tests
Nuevo `frontend/src/__tests__/FileManager.test.tsx` — **4 tests, RED primero**
(comprobado con `git stash` → los 4 fallaban por no existir el checkbox):

1. *Seleccionar todo* solo toca lo visible y `Limpiar` vacía (la regla de `utils/selection.ts`)
2. el borrado en lote manda **una petición por fichero** y la confirmación muestra la cuenta
   **y** la frase de irreversibilidad
3. un `move` que el guard de semilla **rechaza a mitad** pinta el `detail` de ese fichero y
   el resto reporta éxito
4. la selección se limpia al navegar de directorio

Más una guarda de `stopPropagation`: marcar dos filas debe dar `2 seleccionados` y falla si el
checkbox llega al manejador de la fila.

## Presupuesto — `size:exception` concedido por el usuario

**585 líneas añadidas** (287 de componente+CSS, 298 del test) contra ~400. El corte honesto no
produce piezas que funcionen por separado:

| Corte | Por qué no sirve |
|---|---|
| Infraestructura de selección sola (checkbox + contador) | casillas sin ninguna acción |
| Acciones por tipo (solo borrar / solo copiar-mover) | corta por comodidad, no por dominio; y el informe por fichero —lo que da valor— se duplicaría |
| Tests aparte del código | van con el código que verifican |

Es una unidad: 287 + 298.

## Verificación
- `npx tsc -b --noEmit` → sin errores · `npm run lint` → limpio
- `npm test` → **34 ficheros / 239 tests** (base real **235**, no 225: ese número era el
  anterior al wizard y lo escribí mal en el encargo)
- `npx eslint src/ --format json` → **0 errores, 0 warnings, 81 ficheros**
- `git status --short` → **cero ficheros de `backend/`**
- `graphify update .` → 3147 nodos, 6138 aristas

## Rollback
Un commit; toca `frontend/src/components/FileManager.{tsx,css}`,
`frontend/src/__tests__/FileManager.test.tsx` (nuevo), `BACKLOG.md` y `README.md`.

## Progreso
- [x] Todo
