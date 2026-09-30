# F-03 — Wizard de primera puesta en marcha

## Objetivo
Sustituir la pantalla única de primer arranque por un **wizard paso a paso**, como Overseerr o
aMuleTorrent: pestaña → pestaña, validando mientras configuras.

Petición original: *"preparar una página para configurar una vez arranque la aplicación, como
hacen por ejemplo en seer o amutorrent (vas step por step configurandolo todo)"*.

## Estado
`SetupPage.tsx` (184 líneas) ya existe y ya hace el trabajo de *guardar*: campos de los tres
servicios + clave de la app, prueba de conexiones, y `POST /api/setup`. **No hay ninguna lógica
de pasos** — un solo `<form>`. El grep por `step|paso|currentStep` solo encaja con
`ReleaseSearchModal` (una máquina de estados de modal, no un wizard).

---

## Las dos restricciones del backend que lo condicionan todo

Leídas de `routes/settings.py` en su versión actual (F-02h ya la tocó):

- **A · `POST /api/setup`** — anónimo, **parcial-seguro** (parte de `copy.deepcopy(current)`),
  pero solo escribe `services.*` + la clave de la app, y devuelve **403 para siempre** en cuanto
  existe una clave. Su `restart_required` filtra `services.*` sobre un conjunto que ya solo
  contiene `server.port` → **siempre `[]`** (test que lo fija).
- **B · `POST /api/settings`** — escribe cualquier grupo, **pero no es parcial-seguro**:
  `save_settings` hace `_deep_merge(DEFAULTS, data)`, así que **todo campo omitido vuelve a su
  default**. Solo sobrevive lo que restauran las claves enmascaradas.

---

## Decisiones que tomo (y por qué)

| # | Decisión | Razón |
|---|----------|-------|
| 1 | **El wizard sustituye** a la pantalla actual (mismo gate `!auth_required && needs_setup`) | Es lo que se pidió. Convivir las dos sería dos superficies que divergen. |
| 2 | **La clave de la app es el último paso** | La restricción A la fuerza: al fijarla, `/api/setup` pasa a 403 y `needs_setup` a false. Ponerla antes cortaría el wizard. |
| 3 | **Cada paso guarda con `POST /api/setup` ampliado a todos los grupos** | Es el único endpoint **parcial-seguro y anónimo** mientras no hay clave — exactamente lo que un wizard necesita. `POST /api/settings` se queda como lo autenticado de la página *Configuración*. |
| 4 | **`GET /api/services/test` acepta candidatos sin guardar** | Hoy solo sonda `config.SERVICES` (lo guardado). Un "Probar conexión" que solo funciona *después* de guardar es inútil en un wizard: el paso no podría decirte si la URL es buena antes de comprometerse. |
| 5 | **`save_settings` expone `persisted`** | Devuelve `False` con el directorio de configuración de solo lectura, y **ambas rutas responden `ok: true` igualmente**. Un wizard que dice "guardado" cuando solo vivió en memoria repite el bug que ya arreglamos en F-02g. |
| 6 | **Los mapas de ruta se unifican** en un solo módulo, con un test que fije la unión | `Page`/`PAGE_PATHS` están **duplicados** en `usePageRoute.ts` y `Sidebar.tsx` y **ningún test los comprueba**: añadir una entrada nueva es exactamente cuando se separarían en silencio. |
| 7 | **Fuera de alcance**: endpoint propio de existencia/escritura de rutas, `paths.output_mixed` y `developer` en la UI | Validación de rutas = otra superficie autenticada con su test de frontera; `output_mixed` ni siquiera está en `types.ts`. Se anotan, no se prometen. |

---

## Las tres pruebas existentes que esto rompe (a propósito)

`setupPage.test.tsx` atraviesa `<App/>` y fija la pantalla única:

| Test | Por qué deja de valer |
|---|---|
| `offers a field for each service` | exige los campos de **los tres servicios a la vez** |
| `lets the user leave the app unprotected` | exige el campo de clave de app **en el primer pintado** |
| `saves and remembers the key…` | exige **un solo POST** con todo |

Se reescriben: un wizard que muestra un paso cada vez **no puede** pasarlas. Las otras dos
(`replaces the key prompt…`, `does not appear when…`) siguen valiendo y son la red de seguridad
del gate.

## Peligro operativo que hay que diseñar en contra

`needs_setup = not auth_required() and not configured_services()` → **se pone a false en cuanto
un servicio tiene URL + clave**. El gate de `App` es exactamente `setupData?.needs_setup` con
`staleTime: Infinity`. Si un paso invalida `['setup']`, **el wizard se desmonta a mitad de
recorrido**. Por eso: no invalidar esa query hasta `onDone`.

Y si un paso mete la clave de la app antes de tiempo, todas las llamadas posteriores necesitan
`X-Api-Key` y un 401 manda al `AuthGate` — otra razón para dejarla al final.

---

## Plan de entrega

| PR | Contenido | Est. |
|----|-----------|------|
| **A** | Backend: `/api/setup` acepta todos los grupos · `test` acepta candidatos · `persisted` · tests | ~250 |
| B | Rutas unificadas + el wizard + pruebas reescritas | ~450 → **medir; si >400, preguntar** |

PR A se sostiene solo: la página *Configuración* gana el "probar lo que estoy escribiendo" y
`/api/setup` deja de ser un callejón sin salida para los grupos que no son servicios.

## Checklist
- [x] T1 — Documento (este).
- [x] T2 — **RED** backend: `/api/setup` con `paths`/`intervals` (hoy se ignoran); test con
      candidato sin guardar (hoy solo sonda lo guardado); `persisted` en directorio de solo
      lectura (hoy devuelve `ok: true` igualmente).
- [x] T3 — Implementado en `routes/settings.py`.
- [x] T4 — `pytest -q` → **601 passed** (era 591) · `tests_static` 8 · pyflakes limpio.
- [x] T5 — **PR #89** (`5753fbb`, merge `7a59534`) → backend en `main`.
- [x] T6 — **Retirado del alcance**, con razón: el wizard **no es una ruta** (sustituye a la
      pantalla de primer arranque tras el mismo gate), así que no hay entrada nueva que añadir.
      La duplicación `Page`/`PAGE_PATHS` (`usePageRoute.ts` vs `Sidebar.tsx`, sin ningún test
      que fije la unión) es un defecto latente **real**, pero meterlo en un PR de feature es
      exactamente el trabajo no pedido que evitamos en B-03. Va al `BACKLOG.md` como ítem
      aparte.
- [x] T7 — **RED** frontend: `11 failed | 2 passed` antes de implementar — los tres tests de
      pantalla única y los de navegación/guardado/sondeo no encontraban `Empezar`/`Atrás`.
- [x] T8 — El wizard, **dirección (d) focus card** (cambio del usuario tras ver los mockups).
      `canEnter = arrConfigured` con la regla *al menos uno de Radarr/Sonarr*; aMuTorrent
      opcional. RED de la regla demostrada poniendo `canEnter = true` → el test
      *disables Entrar until Radarr or Sonarr is configured* falla.
- [x] T9 — 3 reescritas (cada servicio en su paso · clave en el paso 7 · un POST por paso) +
      2 de gate (ninguno configurado → bloqueado · **solo Radarr** → desbloqueado). Las 2 del
      gate original quedan **verbatim**. 13 → 15 tests.
- [ ] T10 — Docs, commit y PR.

## Criterios de aceptación
- Un `POST /api/setup` con `paths.allowed_roots` los persiste (hoy se descartan).
- "Probar conexión" falla con una URL mala **antes** de guardar nada.
- Con `CONFIG_DIR` de solo lectura la respuesta no dice `ok: true` sin más: lleva `persisted: false`.
- El wizard no se desmonta entre pasos (ninguna invalidación de `['setup']` hasta el final).
- Los dos mapas de ruta son el mismo objeto y un test lo garantiza.

## Verificación
```bash
cd backend && python -m pytest -q && python -m pytest tests_static.py -q
cd frontend && npm run typecheck && npm run lint && npm test
```
Runtime en vivo: **N/A** — sin arr ni volumen real; los tres huecos se demuestran con
`tmp_path` y con la ruta que ya existe para el directorio de configuración irreescrito.

## Rollback
Un commit por PR; A solo toca `backend/routes/settings.py`, `backend/clients.py` y tests.

## Progreso
- [x] T1-T9
- [ ] T10 — docs, commit y PR.

## Siguiente paso
T7-T10: la parte 2 (frontend).

## Evidencia de T2-T4 (parte 1, backend)

- **RED: 8 fallos, 2 en verde** — `assert ['/mnt/storage', ...] == ['/mnt/custom']` (los
  `paths` se descartaban), `assert 15 == 45` (idem `intervals`), `config.TRACE_LIMIT == 25`
  (no llegó a `rebuild()`), `assert None is True` (no existía `persisted`), y
  **`assert 405 == 200`** para `POST /api/services/test`.
- **GREEN: 10/10** en `tests_setup_wizard.py`; suite completa **601 passed** (+10),
  `tests_static` 8, pyflakes limpio.
- Los 2 que ya pasaban eran las garantías de no-regresión: que un cuerpo solo de `services`
  siga reportando `restart_required == []` (contrato que fija `tests_routes.py`) y que el
  `GET /api/services/test` siga sondeando lo guardado.

## Dirección elegida: **(d) focus card** — decidida por el usuario **tras ver los prototipos**

**Corrección de dirección.** El usuario eligió primero (c) *antes* de poder ver los mockups, y
tras desplegarlos cambió a **(d) focus card**. Se descarta la columna izquierda de `setup-01`
(já no hay lista de pasos ni navegación por salto) y se **mantienen** el guardado por paso, el
sondeo en línea y el mapeo de los cuatro `error_kind`, que son independientes del diseño.

Sobre las tres variantas de `prototypes/setup-0*.html`, el planteamiento original era **(c)**: la
**estructura de `setup-01`** (stepper lateral, 8 pasos, progreso, navegación hacia atrás) con la
**validación en línea de `setup-03`** (el resultado de *Probar conexión* bajo cada campo de
servicio), **sin** el panel persistente de `setup-03` — que es lo más frágil de esa variante
(tres columnas, y el panel se cae por debajo de 1120px).

Concreta en tres reglas:

1. Stepper lateral con los 8 pasos, estado hecho/actual/pendiente, navegación libre hacia los
   ya completados, barra de progreso.
2. En cada paso de servicio, el resultado del *probe* **junto al campo**, con uno de los cuatro
   estados reales de la API: `✓ Conectado (vX)` · `✗ API key rechazada (HTTP 401)` ·
   `⏱ no respondió a tiempo` · `⚠ no se pudo conectar`.
3. **El probe es disuasorio, no una pared**: `Siguiente` queda habilitado aunque falle (un
   servicio puede estar reiniciándose), pero el paso queda marcado *sin verificar* y el paso de
   resumen los lista. Bloquear a mitad de instalación por un arr caído sería peor que dejar
   entrar con una URL a medias.

## Peligro operativo (ya documentado arriba, se reitera para la implementación)

- **No invalidar `['setup']` hasta `onDone`**: `needs_setup` pasa a `false` en cuanto un
  servicio tiene URL+clave, y el gate de `App` es exactamente esa bandera → invalidarla
  desmonta el wizard a mitad de recorrido.
- **Tras guardar la clave de la app (paso 7), `rememberApiKey` debe ejecutarse en ese momento**,
  no al final: cualquier llamada posterior necesita `X-Api-Key` o un 401 manda a `AuthGate`.
- El paso 8 **no escribe nada** (por eso la clave va en el 7).

## Tamaño esperado
~450 líneas para T7-T10 → **por encima de 400**. Medir al terminar y preguntar si toca partirlo
(`ask-on-risk`) o si se acepta `size:exception`.

## T10 — Presupuesto: `size:exception` concedido por el usuario

**1728 líneas autoradas** (1486 añadidas + 219 borradas, incluidos `BACKLOG.md` y este documento)
contra un presupuesto de ~400. El corte honesto que manda la regla no produce ninguna pieza que
funcione por separado:

| Corte | Por qué no sirve |
|---|---|
| API (`saveSetupStep`/`probeService`) aparte, UI después | `runSetup` lo usa el formulario actual: quitarlo en A **rompe** lo que hay; no quitarlo deja las funciones nuevas como **código muerto** |
| UI en *shell* + *cuerpo de pasos* | un shell sin cuerpos es una pantalla rota — no es medio producto |
| Componente aparte, tests aparte | los tests van con el código que verifican |
| Subcomponente a otro fichero | mueve líneas entre archivos, no reduce la superficie de revisión |

El wizard **es una unidad**: 8 pasos en un componente (679), su CSS (350) y 15 tests (519).

### Verificación final
- `npx tsc -b --noEmit` → sin errores · `npm run lint` → limpio
- `npm test` → **33 ficheros / 235 tests** (eran 225)
- `npx eslint src/ --format json` → **0 errores, 0 warnings, 80 ficheros**
- `git status --short` → **cero ficheros de `backend/`**

### Corrección de dirección (registrada)
El usuario eligió primero (c) híbrida *antes* de poder ver los mockups y cambió a **(d) focus
card** tras desplegarlos. Se descartó la columna de pasos de `setup-01`; se mantuvieron el
guardado por paso, el sondeo en línea y el mapeo de `error_kind`, que no dependen del diseño.
