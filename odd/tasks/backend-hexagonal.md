# Backend → Clean Architecture + Hexagonal

**Estado**: en curso · **Inicio**: 2026-10-04 · **Rama**: `refactor/backend-hexagonal-<paso>`

## Objetivo

Reestructurar `backend/` con **Clean Architecture + Hexagonal** sin romper nada, en **steps
cortos**, con eficiencia y velocidad en cada merge.

## Problema

63 ficheros Python, casi todos planos en `backend/`, con **la capa HTTP hablando directamente
con los adaptadores**. No hay un solo sitio que diga *«esto de aquí dentro no depende de eso de
ahí fuera»* — la dependencia es una convención, y las convenciones se rompen en silencio.

### Hallazgos del análisis de imports (AST, no opinión)

| # | Violación | Evidencia |
|---|---|---|
| 1 | **7 de 9 routers importan `clients` directamente** | `routes/{calendar,downloads,mediacover,settings,status,wanted}.py` |
| 2 | **Servicios de aplicación tocan infraestructura** | `auto_copy_driver → clients, history` · `copy_engine → clients` |
| 3 | **`state.py` es un cajón desastre compartido** | sesión HTTP + buffer de log + singleflight, importado por casi todo |
| 4 | **`routes_mixer.py` vive fuera de `routes/`** | único router disperso |
| 5 | **`clients.py` es un dios de 1782 líneas** | Radarr + Sonarr + qBit + aMule + posters + quality en un fichero |

### Lo que ya está limpio (y es la semilla de `domain/`)

- `auto_copy.py` — **política pura** (`decide_copy`, `_grace_gate`): solo importa `datetime`. Cero I/O.
- `naming.py` — **reglas puras** (`evaluate`, `reproduced_radarr`, `MEDIA_EXTENSIONS`). Cero I/O.

## Por qué así (decisiones)

1. **Move + shim, nunca rename en caliente.** Cada fichero migra con `git mv` y el camino viejo
   queda como re-export. **Los 828 tests no cambian ni una línea** en los pasos de movimiento.
   → diff mínimo, revisión rápida, merge rápido.
2. **La regla de dependencias se implementa como test** (`tests_architecture.py`), no como
   documentación. Falla el CI si alguien invierte la dirección. Es la esencia de Clean
   Architecture: *las dependencias apuntan hacia dentro*.
3. **Hexagonal estricto: `interfaces/` NO importa `infrastructure/`.** El cableado ocurre solo
   en la raíz de composición (`app.py`). Es lo que permite testear las rutas sin HTTP real.
4. **`git mv` en cada movimiento** para que Git detecte el rename → el diff del paso es
   *docenas* de líneas, no 1782.

## Capas objetivo

```
domain/            política y objetos de valor puros — sin I/O, sin imports externos
application/       casos de uso + PUERTOS (Protocol) por los que hablan
infrastructure/    adaptadores detrás de esas puertas (HTTP, SQLite, FS, ...)
interfaces/        entrega (rutas HTTP) — habla con puertos, nunca con adaptadores
app.py             raíz de composición: SOLO cablea
```

### Regla de dependencias (la que fija el test)

| Capa | Puede importar | Prohibido |
|---|---|---|
| `domain` | `domain` | todo lo demás |
| `application` | `domain`, `application` | `infrastructure`, `interfaces`, legacy |
| `infrastructure` | `domain`, `application`, `infrastructure` | `interfaces`, legacy |
| `interfaces` | `domain`, `application`, `interfaces` | **`infrastructure`**, legacy |
| tests / legacy | lo que sea | — (en migración) |

## Plan — steps cortos (un PR por paso)

| ID | Paso | Riesgo | Movimiento |
|---|---|---|---|
| **T-1** | Esqueleto + `tests_architecture.py` | nulo | solo aditivo |
| **T-2** | `domain/naming.py` | mínimo | `git mv naming.py` + shim |
| **T-3** | `domain/policy.py` | mínimo | `git mv auto_copy.py` + shim |
| **T-4** | `domain/quality.py` | bajo | helpers puros de `config.py` (`destination_for_quality`, clasificación de calidad) |
| **T-5** | `application/ports.py` | nulo | **solo interfaces** (`Protocol`): `ArrPort`, `HistoryPort`, `SettingsPort`, `FilesystemPort` |
| **T-6** | `infrastructure/arr_client.py` | medio | `git mv clients.py` + shim (1782 líneas, rename → diff corto) |
| **T-7** | `infrastructure/sqlite_history.py` | medio | `git mv history.py` + shim |
| **T-8** | `infrastructure/settings_fs.py` | medio | `git mv settings.py` + `credentials.py` + shims |
| **T-9** | `infrastructure/file_storage.py` | bajo | FS de `copy_engine.py` / `config.py` |
| **T-10** | `application/use_cases/` | medio | orquestación desde `copy_engine.py` + `auto_copy_driver.py` |
| **T-11** | `interfaces/http/routes/` | bajo | `git mv routes/` + `routes_mixer.py` + shims |
| **T-12** | `app.py` = raíz de composición | bajo | cablea puertos→adaptadores; retira shims internos |

## Criterios de aceptación (todos los pasos)

- [ ] `python3 -m pytest -q` verde (**828+**, sin perder ninguno)
- [ ] `python3 -m pytest tests_static.py -q` verde (8)
- [ ] `python3 -m pytest tests_architecture.py -q` verde
- [ ] **Ningún test modificado** en T-2…T-11 (solo shims)
- [ ] `git mv` para que Git detecte el rename
- [ ] El contador de legacy **baja** (ratchet en `tests_architecture.py`)
- [ ] `graphify update .` tras cada cambio de código

## Alcance autorizado

Solo `backend/` y su documentación. **El frontend no se toca.** No se cambia comportamiento:
es refactor puro. Cualquier cambio observable es un bug de este trabajo.

## Progreso

- [x] **T-1** — esqueleto + `tests_architecture.py` (3 tests) · ratchet `MAX_LEGACY_LOC = 9630`
- [x] **T-2** — `domain/naming.py` + shim · ratchet **9630 → 9434**
- [ ] T-3 … T-12 pendientes
- [x] **T-2** — `domain/naming.py` + shim · ratchet **9630 → 9434**
- [ ] T-3 … T-12 pendientes

## Próximo paso

**T-3**: mover `auto_copy.py` a `domain/policy.py` con shim (~317 líneas de política pura).
