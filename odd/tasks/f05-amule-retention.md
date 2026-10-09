# F-05 — Retención de las descargas de aMule

## Objetivo
Saber **cuánto lleva** cada fichero descargado en el ordenador y cuáles han pasado de la
ventana de retención, para poder borrarlos **tú**, con aviso de irreversibilidad.

Pedida en dos mensajes:
1. *"en la carpeta de amule me gustaría saber si los archivos están controlados por radarr o
   sonarr, podríamos marcarlos de alguna manera, para localizar los que puedo borrar"*
2. *"los archivos pudieran vivir unos días como los he descargado y luego borrarlos (rollo
   guardar esta información en la base de datos y hacer check de cuánto lleva en el ordenador)"*
3. Y la decisión: *"la decisión de borrado tiene que ser mía, con un aviso de que si borro no
   podré recuperar los datos."*

## Decisiones
| # | Decisión | Razón |
|---|----------|-------|
| 1 | **El sweep nunca borra.** El endpoint solo marca | Regla del usuario. Un endpoint de lectura que además limpia tomaría la decisión él solo |
| 2 | `first_seen_at` se escribe **solo la primera vez** (`INSERT OR IGNORE`) | Refrescarlo en cada observación haría que **nada caducara nunca** |
| 3 | **7 días** por defecto, configurable en `retention.amule_days` | El usuario dijo "unos días" sin número; configurable cubre la incertidumbre |
| 4 | Si el almacén no está disponible, el fichero se devuelve **sin edad** en vez de inventar una | Una edad inventada podría justificar borrar algo que nunca se guardó |
| 5 | Los `path` de ficheros **ya desaparecidos** se podan | Si no, la tabla acumula cada descarga de la historia |
| 6 | **Procedencia (¿radarr/sonarr?) fuera de este PR** | Reutilizar `build_traces` obliga a mover su caché (la de `routes/status.py`, con sus propios tests en `tests_trace_cache.py`): no es gratis. Va aparte |

## Reparto (medido, no supuesto)
| PR | Contenido | Líneas |
|----|-----------|--------|
| **A** | `settings.py` + `config.py` + `history.py` (v7) + `GET /api/files/retention` + tests | **309** ✅ |
| B | `FileManager` (chips de edad + *Marcar caducados*) + campo en Configuración + tests | por medir; si >400 → `ask-on-risk` |

## Contrato de `GET /api/files/retention?path=`
```json
{"ok": true, "path": "…", "days": 7,
 "files": [{"name": "…", "first_seen_at": 1690000000.0, "age_days": 9.2, "expired": true}]}
```
- auth `verify_api_key` (satisface `TestAuthBoundary`)
- fuera de `ALLOWED_ROOTS` → **403** (reutiliza `_validate_path`)
- `first_seen_at: null` / `age_days: null` cuando la BD no está disponible → `expired: false`

## Migración
`SCHEMA_VERSION` 6 → **7**, tabla `amule_downloads(path PRIMARY KEY, first_seen_at REAL)` con el
mismo `CREATE TABLE IF NOT EXISTS` dentro del script que ejecuta `init_db` en cada arranque →
un fichero v6 gana la tabla sin `ALTER` y el bump solo lo registra (disciplina de v2-v6).

## Checklist
- [x] T1 — Documento (este).
- [x] T2 — **RED**: `tests_retention.py` → 7 fallos, todos "la facilidad no existe"
      (`{"detail":"Not Found"}`, `no attribute 'remember_downloads'`, `KeyError: 'days'`).
- [x] T3 — Implementado: settings + config + history (v7) + endpoint.
- [x] T4 — Verificación backend: **618 passed**, `tests_static` 8, pyflakes limpio.
- [ ] T5 — PR A → merge.
- [ ] T6 — Frontend: chips de edad, *Marcar caducados*, campo de retención en Configuración.
- [ ] T7 — **RED** frontend + tests.
- [ ] T8 — Verificación completa + docs + PR B.
- [ ] T9 — (aparte) Procedencia: cola/histórico del arr, mostrada sin bloquear.

## Errores míos en el camino (registro)
1. El primer test tenía una aserción basura (`assert body["status"] == 200 or True`) y una API
   especulativa (`history._first_seen_now`) que no existe → reescrito contra la API real.
2. Usé `tmp_path` con `_validate_path` real → **403** y `KeyError: 'files'` en vez de RED útil.
   Solución: parchear `_validate_path` en los tests que usan tmp, y dejar **sin parchear** el de
   rechazo, que es justo el que prueba el guard real.
3. Mi sonda manual de migración v6→v7 creó una BD falsa incompleta →
   `no such column: source` y concluí (mal) que la migración fallaba. El test correcto parte de
   una BD **real** con la tabla borrada y `user_version=6`.

## Verificación
```bash
cd backend && python -m pytest -q && python -m pytest tests_static.py -q
```

## Rollback
Un commit por PR; A toca `backend/{settings,config,history}.py`, `backend/routes/files.py`,
`backend/tests_history.py`, `backend/tests_retention.py` (nuevo).

## Progreso
- [x] T1-T4
- [x] T5-T8 (cerrado: BACKLOG F-05 ✅ Entregado — A+B)
- [ ] T9 (aparte: procedencia, fuera del alcance de F-05)
