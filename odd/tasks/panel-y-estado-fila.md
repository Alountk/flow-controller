# Tweaks al diseño nuevo (post F-08) — panel y estado de fila

## Contexto

F-08 cerró en 10 PRs (`#107`–`#116`). El usuario ha probado el resultado y pide **cambios
pequeños**. Tres cosas, en este orden:

---

## 1. `.sec-detail` se pierde al hacer scroll 🔴

**Síntoma:** dentro de `.sec-split`, al bajar, el panel de detalle se va arriba y desaparece.

**Causa verificada:** `.sec-split` es `display:grid` con `align-items: start` (correcto) pero
**`.sec-detail` no tiene ninguna `position`**. El `grep` de `position: sticky` en
`Sections.css` → **0 resultados**. Mientras tanto `.topbar` sí es `sticky; top:0; height:56px`.

**Arreglo:** `.sec-detail { position: sticky; top: 72px; max-height: calc(100vh - 88px); overflow-y: auto; }`
— el topbar (56) + el hueco de 16px de `gap`. El panel **scrollea por dentro**, que es lo que
pide: *"debería verse siempre"*.

⚠️ El `overflow: hidden` actual de `.sec-master, .sec-detail` está en **los propios
elementos**, no en un ancestro → **no rompe** `sticky` (sticky solo se rompe por ancestros).

---

## 2. `sec-detail` no se parece a los diseños 🔴

Heredó el cuerpo del **modal** (`ReleaseSearchModal` con `presentation: 'panel'`). El usuario
describe el flujo que quiere:

```
Seleccionar Indexador  →  busca automáticamente
        ↓
Selector de archivos:  nombre
                       idioma · calidad · size · semillas
        ↓
Acción principal (calidad):
  · 1080 o menor  → donde digan Radarr / Sonarr  (biblioteca)
  · 4K / 3D       → donde diga la config 4K/3D, o la carpeta de destino
```

- **Auto-búsqueda al elegir indexador** (hoy hay un botón `🔍 Buscar Releases` aparte).
- Las **3 filas de metadatos** por archivo: idioma · calidad · size · semillas.
- **`Acción principal` debe explicar el enrutado**, no solo ofrecer un `<select>`: el usuario
  quiere *ver* adónde va cada clase.
- **En todas las secciones** (Películas y Series).

### Datos disponibles (verificado)

| Dato | ¿Existe? | Dónde |
|---|---|---|
| idiomas del release buscado | ✅ | `Release.languages` (`clients.py:1362`) |
| calidad, size, seeders, índice | ✅ | `Release.*` |
| destinos (`GET /api/calendar/destinations`) | ✅ | ya lo usa el combo |
| `paths.path_4k` / `path_3d` | ✅ | expuestos desde PR `#113` |

**Nada nuevo que buscar en el backend para este punto.**

---

## 3. «Ya tiene archivo descargado» es una mala respuesta 🔴

**Archivo actual:** `ReleaseSearchModal.tsx:488` → `<div>✓ Ya tiene archivo descargado</div>`.

Lo que pide el usuario:

1. **Qué archivo es el descargado** (el nombre real, no un "✓").
2. **Cuáles faltan.** Ejemplo: *ParaNorman* → tag **`1080` en color** (lo tienes) y **`4K`**
   y **`3D` en gris** (no los tienes).
3. **Los idiomas** de cada vídeo.

### Interpretación (declarada para que se pueda corregir)

> Los tags de calidad indican **qué tienes (color) y qué te falta (gris)** para ese título.

### Datos

| Dato | ¿Existe? |
|---|---|
| calidad de la biblioteca | ✅ `AllMovie.quality` (desde PR `#113`) |
| **nombre del fichero descargado** | ❌ — **`movieFile.relativePath` no se expone** |
| **idiomas del fichero descargado** | ❌ — **`movieFile.languages` no se expone** |

→ **Requiere un slice de backend pequeño**: en `fetch_all_movies_detailed` ya leemos
`movieFile` para `quality`; añadir `file_name` y `languages` es **el mismo `get`, cero llamadas
nuevas al arr**.

⚠️ Para *Series*: `movieFile` es por **episodio**, no por serie → no hay un "fichero descargado"
único. Habrá que decidir (¿el episodio más reciente? ¿ninguno y mostrar solo tags?) — **preguntar
si hace falta antes de construirlo**.

---

## Reparto

| PR | Contenido | Estado |
|----|-----------|--------|
| **A** ✅ | `.sec-detail` sticky — **PR #117**, `c6c7ece`, 136 líneas |
| **B** ✅ | `Releases` recompuesto — **PR #118**, `ed36203`, 562 líneas |
| **C** ✅ | Fichero + idiomas + tags + **botón `Buscar versiones`** — **PR #119**, `f685d14`, 765 líneas |

## Checks

```
cd frontend && npx tsc -b --noEmit && npm run lint && npm test
cd frontend && npx eslint src/ --format json -o /tmp/opencode/e.json   # severity-2 = 0
cd backend && python -m pytest -q      # si hay slice de backend
```

## Riesgos

- 🟠 **`sticky` depende de los ancestros**: si alguien añade `overflow:hidden` a `.section-shell`
  o `.layout`, el panel deja de pegarse **en silencio**. Merece un comentario en el CSS.
- 🟠 El PR B rehace el cuerpo de un componente **compartido con el modal** (`presentation:
  overlay | panel`) — el overlay **no debe cambiar de comportamiento** (Calendario y el
  flujo e2e lo usan).
- ⬜ Los tags de calidad de Series son ambiguos (calidad por episodio) → decidir antes.


---

## 🏁 LOS TRES CAMBIOS ENTREGADOS

| | PR | Líneas |
|---|---|---|
| A | `.sec-detail` sticky | 136 |
| B | `Releases`: auto-búsqueda · selector de archivo · `Acción principal` | 562 |
| C | Fichero + idiomas + tags + **entrada de F-01** | 765 |

### Hallazgo importante del PR C

El `✓ Ya tiene archivo descargado` **no era un mensaje: era el único bloqueo de F-01**.
`autoSearchable = !item.has_file` → un título con fichero **no se podía buscar**, y el
BACKLOG lo arrastraba como hueco desde que la feature se entregó (*«sin esto no hay upgrade»*).

**Resuelto en las secciones** con el botón `Buscar versiones`. Decidido explícitamente por el
usuario (opción: *«Añadir el botón»*) en vez de auto-búsqueda, porque cada búsqueda puede
tardar **hasta 240 s**.

### Dos huecos que quedan (reportados, fuera del alcance de estos PRs)

1. **La vista `Calidad` no pasa los campos nuevos** (`file_name`/`languages`/`quality`) →
   el bloque se degrada ahí. ~4 líneas en `Peliculas.tsx` / `Series.tsx`.
2. **`Calendar.tsx:112` sigue sin abrir el modal** para un título con fichero → la entrada de
   F-01 **desde Estrenos** sigue tapada.

### Decisión tomada sin preguntar (declarada)

**Tags de Series**: el `1080`/`4K` se quedan **gris** porque la lista de Sonarr **no trae
calidad por serie** — misma razón que el PR 4. `3D` sigue la regla de la carpeta.
