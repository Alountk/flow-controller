# Feature: Hardlink siempre (nada rompe la semilla)

## Objetivo
Ninguna operación de flow-controller debe destruir la ruta que aMule/qBittorrent está
compartiendo. Principio del usuario: *"en un principio no deberíamos romper el hardlink…
siempre deberíamos hacer las cosas con hardlink"*.

## Por qué
B-03 arregló el escaneo, pero quedan tres operaciones que siguen rompiendo la semilla y una
que duplica gigas sin motivo. El usuario aprobó el paquete 1-4 y dejó el 5 pendiente.

## Alcance autorizado
- ✅ Implementar los puntos 1-4 de la propuesta.
- ❌ Punto 5 (`importMode: Move` → `Copy` en `clients.py:1465,1474`): **NO** — el usuario lo
  difiere hasta comprobar el ajuste de hardlinks de Radarr/Sonarr.
- ❌ Nada tocado fuera de este paquete (B-01, B-02, F-01…F-03 siguen abiertos).

## Restricciones / decisiones de diseño
- **`strict_tdd: false`** (origen `sdd-init/flow-controller`) → checks funcionales por tarea.
  Aun así: RED primero donde aporte, GREEN después.
- **Cambio de plan respecto a la propuesta original (punto 1).** La propuesta decía convertir
  "Mover al otro panel" en *colocar* y renombrar el botón. Al diseñarlo aparecía un problema:
  tras B-03 el botón "Copiar" **ya** es enlace-duro-primero, así que los dos botones harían
  exactamente lo mismo y habría que fusionarlos — perdiendo la capacidad de reorganizar la
  biblioteca. **Decisión: (B)** "Mover" sigue siendo un movimiento real, pero se **rechaza**
  cuando el origen está en una carpeta de descarga. Los dos botones conservan un significado
  distinto y ninguna operación rompe la semilla.
- El guard usa `config.FOLDER_DOWNLOAD_AMULE` y `config.FOLDER_DOWNLOAD_TORRENT` (vienen de
  `settings.json`, no de literales) — si el usuario cambia sus carpetas en Configuración, el
  guard las sigue.
- Rechazo **en el momento de encolar** (`queue_add`), no durante el consumo: el usuario ve el
  motivo en la UI (`FileManager` ya pinta `res.detail` en `.fm-error` cuando `ok:false`).

## Checklist

- [x] T1 — Documento de tareas (este).
- [x] T2 — Guard de origen protegido en `POST /api/files/queue/add` para `type="move"`.
      RED primero: encolar un `move` con origen bajo `FOLDER_DOWNLOAD_AMULE` debe rechazarse.
- [x] T3 — Guard también en `POST /api/files/rename` (renombrar dentro de la carpeta de
      descarga rompe la ruta de la semilla aunque el inodo siga vivo).
- [x] T4 — Quitar `POST /api/files/move` y el helper `moveItem` del frontend: es destructivo,
      nadie lo llama (verificado por grep) y "siempre hardlink" lo deja sin uso legítimo.
- [x] T5 — `_copytree_with_progress` con enlace duro por fichero (`copy_function` intentando
      `os.link` y cayendo a `shutil.copy2` en EXDEV). Hoy `shutil.copytree` duplica byte a byte.
- [x] T6 — Tests de frontend: **N/A**. El guard es backend y `FileManager` ya pinta
      `res.detail` en `.fm-error` cuando `ok:false`; lo único de frontend fue borrar el
      helper `moveItem` que ningún sitio usaba.
- [x] T7 — Docs: `BACKLOG.md` (fila C-08 + sección renombrada a «Recomendaciones y reglas
      del ciclo» + trazabilidad) y `README.md` (fila C-08).
- [x] T8 — Linear: **RAU-138** (`improvement`, proyecto `flow-controller`, estado *In Progress*
      hasta que se merge; pasa a *Done* después).
- [ ] T9 — Commit + push + PR (y luego RAU-138 → Done).

## Criterios de aceptación
- Mover un fichero cuyo origen está bajo `FOLDER_DOWNLOAD_*` → `ok:false` con motivo claro,
  nada encolado, origen intacto.
- Renombrar en la misma situación → `ok:false` con motivo claro.
- `/api/files/move` ya no existe (404/NotFound vía SPA o "Not Found" de la API).
- Copiar una carpeta crea enlaces duros por fichero en el mismo dispositivo; entre dispositivos
  copia de verdad.
- Suite backend + `tests_static` en verde; frontend typecheck/lint/test en verde.

## Verificación
```bash
cd backend && python -m pytest -q            # 549 + los nuevos
cd backend && python -m pytest tests_static.py -q   # pyflakes + vulture
cd frontend && npm run typecheck && npm run lint
cd frontend && npm test
```
Comandos de runtime en vivo: **N/A** — no hay cliente de descargas ni arr en esta sesión; el
guard se prueba con ficheros reales sobre `tmp_path`.

## Rollback
Un revert por unidad de trabajo; cada commit toca un conjunto cerrado de ficheros.

## Progreso
- [x] T1-T8
- [ ] T9

## Siguiente paso
T9: commit `fix(files): …`, push y PR.

## Nota sobre el número de commits
Se planteó partirlo en tres unidades (guard / endpoint fuera / copytree). Los cambios de
`routes/files.py` y `tests.py` están entrelazados en los tres, y no son tres propósitos:
**una sola regla** («nada que hagamos rompa o duplique la descarga cuando un enlace basta»)
aplicada a las operaciones que la violaban. Se cierra con **un commit**; el mensaje cuenta
las tres partes y cada una tiene su test.
