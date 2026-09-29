# Feature: Backlog del nuevo ciclo (features + bugs + recomendaciones)

## Objetivo
Estudiar el estado del proyecto, embolsar 3 features pedidas, 3 bugs reportados y una tanda de
recomendaciones, y plasmarlo en `BACKLOG.md`, `README.md` y Linear.

## Por qué
El usuario pidió: "estudia todo lo que te comento y haz un plan para mostrármelo; puedes
actualizar el README y Linear".

## Alcance autorizado
- ✅ Investigación (read-only)
- ✅ Escritura de `BACKLOG.md` y `README.md`
- ✅ Linear (acceso concedido en T0; issues creados en T8)
- ❌ Implementación de features/bugs: NO autorizada todavía (el usuario quiere ver el plan)

## Restricciones
- Conversación en español; artefactos técnicos (README/BACKLOG/código) en inglés salvo que el
  documento existente ya esté en español → el README y BACKLOG existentes están en español, se
  mantiene ese idioma por coherencia con el documento.
- Commits convencionales, sin atribución AI.
- Presupuesto de PR ~400 líneas autorizadas por PR (heurística).

## Checklist

- [x] T0 — Determinar acceso a Linear. **Resultado: ACCESO CONCEDIDO.** El usuario subió
      `LINEAR_API_KEY` a `~/.zshrc`. Verificado con `viewer`/`teams`: equipo **RAU**
      (`669a9a0f-3e01-4a83-a458-53cf4cd701d7`), viewer Raul. Etiquetas disponibles:
      `Bug`, `Feature`, `Improvement`, `Postmortem`. Estados: `Backlog`, `Todo`,
      `In Progress`, `In Review`, `Done`, `Canceled`, `Duplicate`. **No había** ningún
      proyecto ni issue de flow-controller → creado proyecto `flow-controller`
      (`ad73521a-03f2-4322-bdfb-0bbb44f6116c`).
- [x] T1 — Mapear los 3 bugs (CSS card, indexers, hardlink/move) con evidencia file:line.
- [x] T2 — Mapear arquitectura backend para la decisión Python vs Go/Rust.
- [x] T3 — Mapear flujo de releases/calidad/destino/renombrado para la feature de upgrade 4K/3D.
- [x] T4 — Verificar en disco los hallazgos críticos (no confiar solo en el mapeo):
      - ✅ `routes/actions.py:46 from state import _http_session` → **ImportError verificado en
        runtime**: `state.py` no define ese símbolo. Todo `POST /api/actions/{acción-válida}`
        devuelve 500. Ningún test publica una acción válida (`tests.py:422` solo prueba una
        desconocida).
      - ✅ `clients.py:1001` y `:1049` hacen `os.path.isdir(path)` con la ruta **cruda del arr**,
        sin `host_path()`. `copy_engine.py:88,493` sí traducen. → una película sana puede
        clasificarse `status-error` y pintar la barra roja izquierda.
      - ✅ `MissingContent.css:187-191` `.status-grabbed` pinta `border-color: var(--warn)` y
        luego `border-left-color: var(--bad)` en la misma regla. Hay guarda
        `.status-ok.status-grabbed` en `:197` pero **no** para `.status-error.status-grabbed`.
      - ✅ `MissingContent.tsx:126` encola `queueAdd('move', ...)` → `routes/files.py:219`
        `os.rename` (y en EXDEV copia + **borra origen** en `:226`).
- [x] T5 — Redactar el plan (sección siguiente) y mostrarlo al usuario.
- [x] T6 — Actualizar `BACKLOG.md`.
- [x] T7 — Actualizar `README.md` (sección "Backlog de mejoras").
- [x] T8 — Crear el backlog en Linear. Proyecto `flow-controller` + **14 issues**
      RAU-124…RAU-137, estado `Backlog`, etiquetas `Bug`/`Feature`/`Improvement`.
      Script idempotente (reutiliza proyecto y salta issues existentes).
      Relación: B-04→RAU-124, B-03→125, B-02→126, B-01→127, F-01→128, F-03→129,
      F-02→130, C-01→131, C-02→132, C-03→133, C-04→134, C-05→135, C-06→136, C-07→137.
- [x] T9 — Commit de T6+T7+T8. **`993dbc4`** `docs(backlog): record the new cycle plan in
      BACKLOG, README and Linear` (3 ficheros, 175+/2-). Solo `BACKLOG.md`, `README.md` y
      este documento; ningún fichero fuente tocado.

## Plan (resultado de T5)

### Estado
`main` = `8cd4dce` (PR #75 fix rutas aMule). Reciente: cadena #66-#73 "destino por selección"
mergeada, #74 CI (un solo publisher verificado). ~524 tests backend + 37 ficheros vitest.
`ROADMAP.md` está desactualizado (Fases 2-5 mayormente en `[ ]` pero varias ya hechas).

### A. Features nuevas
| ID | Feature | Tamaño |
|----|---------|--------|
| F-01 | Upgrade de calidad desde la biblioteca: 4K / 3D + destino + renombrado | grande (6 etapas) |
| F-02 | Estudio backend vs Go/Rust → **veredicto: no reescribir** + 8 mitigaciones | estudio + 8 tareas pequeñas |
| F-03 | Wizard de primera puesta en marcha (tipo Overseerr / aMuleTorrent) | mediana (9 pasos, ya existe `SetupPage`) |

### B. Bugs
| ID | Bug | Severidad |
|----|-----|-----------|
| B-04 | `POST /api/actions/*` → 500 por `ImportError` (descubierto en este estudio) | **alta — acción rota en producción** |
| B-03 | El escaneo encola `move` → `os.rename` rompe el hardlink del seed | alta (datos/compartición) |
| B-02 | Índice de indexadores vacío: el error se traga en 3 capas y no hay caché | media |
| B-01 | Barra roja izquierda en cards naranjas | media (2 causas distintas) |

### C. Recomendaciones (evidencia-backed)
C-01 Aviso de import bloqueado (webhook/Telegram) · C-02 Gestor de import bloqueado (reintentar/limpiar
en un clic) · C-03 E2E con Playwright · C-04 Upgrades automáticos programados 1080p→4K ·
C-05 Rate limiting + Request ID · C-06 Responsive + dark mode · C-07 `IMPORT_TIMEOUT` desde la UI.

### Orden propuesto
1. B-04 (roto ahora)
2. B-03 (pierde el seed)
3. B-02 + B-01 (UI/fiabilidad)
4. F-02a..h (mitigaciones baratas, algunas vienen de B-04)
5. F-03 (wizard)
6. F-01 (la más grande, con decisiones de producto pendientes)

## Criterios de aceptación
- Plan mostrado al usuario con evidencia file:line verificada.
- `BACKLOG.md` y `README.md` contienen F-01..F-03, B-01..B-04 y C-01..C-06 con estado.
- Linear: 14 issues creados en el proyecto `flow-controller`, todos en `Backlog` con su etiqueta.

## Verificación
- `cd frontend && npm run typecheck && npm run lint` (si toca frontend — no aplica en T6/T7)
- Relectura de `BACKLOG.md` y `README.md` tras la edición (lectura estructural: son documentos
  pasivos → lectura de vuelta es la comprobación completa).
- `git diff --stat` para revisar el alcance.

## Progreso
- [x] T0-T9 completados. Commit `993dbc4`.

## Siguiente paso
Feature cerrada. Siguiente: elegir por dónde empieza la implementación
(orden propuesto: B-04 → B-03 → B-02+B-01). Cada tarea de implementación abre su
propio documento ODD; este queda como plan de ciclo.
