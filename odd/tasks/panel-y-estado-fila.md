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
| **A** | `.sec-detail` sticky | 🔄 |
| **B** | Reposición del `Releases`: auto-búsqueda, selector de archivo con 4 metadatos, `Acción principal` que explica el enrutado | ⬜ |
| **C** | Estado de fila/panel: nombre del fichero, tags 1080-color / 4K-3D-gris, idiomas (+ slice de backend `movieFile.file_name` / `languages`) | ⬜ |

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
