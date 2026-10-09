# Feature: Tres destinos como raíces etiquetadas en Archivos

**Estado**: implementado, pendiente de entrega · **Fecha**: 2026-10-05 · **Rama**: `feat/files-labelled-roots`

## Objetivo

Que la pestaña *Archivos* muestre los tres tipos de destino como raíces con
etiqueta — las bibliotecas de Radarr/Sonarr, la carpeta 4K y la carpeta 3D —
**solo cuando están configuradas y existen en disco**, sin tocar el orden en el
que los dos paneles empiezan.

## Por qué

`GET /api/files/roots` devuelve hoy solo `ALLOWED_ROOTS` (los montajes), sin
distinguir qué es un volumen para navegar y qué es un destino al que se manda
contenido. El usuario pide verlos etiquetados: *"Biblioteca (películas) · 1080 y
por debajo"*, *"4K · 2160p"*, *"3D"*.

## Alcance autorizado

- ✅ `backend/interfaces/http/routes/files.py` — `file_roots` gana `role`,
  `label`, `service` y `detail` (**aditivo**: `path` y `name` intactos).
- ✅ Tests backend nuevos: `backend/tests/interfaces/routes/tests_files_roots.py` (8 casos).
- ✅ Frontend: `types.ts` (campos opcionales), `FileManager.tsx` (`label ?? name`
  + `<optgroup label="Destinos">`) y su test.
- ✅ Docs: este documento + `BACKLOG.md` (F-10).
- ❌ `MediaPane` y `MediaMixer` no se tocan: también consumen `fetchRoots` y los
  campos nuevos son opcionales.
- ❌ Nada fuera de la lista anterior.

## Decisiones (no preguntadas, y por qué)

| # | Decisión | Razón |
|---|----------|-------|
| 1 | **Navegación primero, destinos después** | `FileManager` arranca los dos paneles en `roots[0]`/`roots[1]`: reordenar la lista movería el punto de partida visible sin que nadie lo pidiera |
| 2 | **`arr_root_folders` en paralelo (`asyncio.gather`) y desde `application.gateways`** | dos arrs muertos cuestan un `REQUEST_TIMEOUT` (5 s), no dos; `interfaces/` no puede importar `infrastructure/` (`tests_architecture.py` lo prohibe) |
| 3 | **`config.X` como atributo, nunca `from config import X`** | los tests hacen `monkeypatch.setattr(config, "PATH_4K", ...)`; un nombre importado quedaría congelado en el import |
| 4 | **Excluir `PATH_4K`/`PATH_3D` del paso de navegación** | `config.rebuild()` los mete DENTRO de `ALLOWED_ROOTS` (el motor de copia debe poder escribirlos): sin esa exclusión se listarían dos veces, uno de ellos como navegación |
| 5 | **`detail` nombra al arr que no devolvió carpetas raíz** | misma regla que `calendar_destinations`: decir lo que pasó en vez de afirmar éxito con una lista corta. Sin arr configurado, `detail` vacío: no falló nada |
| 6 | **Etiquetas por servicio (`LIBRARY_LABELS`)** | el combo ofrece películas y series juntas: "Biblioteca" sola no dice a cuál apunta cada opción. Clave desconocida → `f"Biblioteca ({key}) · 1080 y por debajo"` |

## Criterios de aceptación (verificados en PR #148 · BACKLOG F-10 ✅ Entregado)

- [x] `GET /api/files/roots` conserva `path`/`name` exactamente como antes y añade
  `role`, `label` (`service` en bibliotecas) con `detail` siempre presente.
- [x] Las raíces de navegación siguen siendo `roots[0]`/`roots[1]`.
- [x] Un destino sin configurar (`PATH_4K = ""`) o que no exista en disco no aparece.
- [x] Un arr configurado que devuelve `[]` no pone biblioteca y lo dice en `detail`.
- [x] El combo de *Archivos* pinta `label ?? name` y agrupa los destinos en
  `Destinos` (optgroup solo si hay algún destino).
- [x] `python3 -m pytest -q` verde (**860**: base 852 + 8 nuevos), `pyflakes`
  limpio, `npx tsc -b --noEmit` y `npm test` verdes (**391**: base 390 + 1).

## Verificación

```bash
cd backend && python3 -m pytest -q                    # 860 (base 852 + 8)
cd backend && python3 -m pytest tests/contracts/tests_static.py tests/contracts/tests_architecture.py -q
cd backend && python3 -m pyflakes .
cd frontend && npx tsc -b --noEmit
cd frontend && npm test                               # 391 (base 390 + 1)
```

## Rollback

Un commit por unidad de trabajo; el endpoint vuelve al contrato antiguo con un
revert (el frontend ignora los campos opcionales si no llegan).

## Progreso

- [x] Backend: `file_roots` con navegación, bibliotecas (gather) y destinos.
- [x] Tests backend: 8 casos en `tests_files_roots.py`.
- [x] Frontend: tipos opcionales + `label ?? name` + optgroup `Destinos` + test.
- [x] Docs: este documento + `BACKLOG.md` (F-10).
- [ ] Entrega: commit(s), PR y verificación en vivo en la pestaña *Archivos*.

## Próximo paso

Entrega del orquestador: commits por unidad de trabajo (backend+tests,
frontend+tests, docs) y PR; después, verificación en vivo con la instancia real
(las seis raíces del objetivo, comprobando que `detail` queda `""`).
