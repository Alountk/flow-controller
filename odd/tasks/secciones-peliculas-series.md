# Secciones Películas / Series — prototipos + rediseño de la galería

## Objetivo

1. **8 prototipos** (4 de *Películas*, 4 de *Series*) que propongan cómo reunificar lo que
   hoy está repartido por la web.
2. **Rediseñar la página *Prototipos*** para que se vea qué está **seleccionado** y qué ha
   **quedado descartado**.

## Qué se reunifica (inventario de lo actual)

| Hoy | En Películas | En Series |
|---|---|---|
| `Faltantes` (`/faltantes`) — `MissingContent` | pestaña de películas | pestaña de episodios |
| `Calendario` (`/calendario`) — `Calendar` + `ReleaseSearchModal` (grab, destino, 4K/3D) | películas | episodios |
| `Archivos` (`/archivos`) — `FileManager` (renombrar, escanear, retención) | carpetas de pelis | carpetas de series |
| Biblioteca (la pestaña "Todas" de `MissingContent`) | ✔ | ✔ |
| **NUEVO**: pestaña *Calidad* (4K/3D de F-01) | ✔ | — |
| `Dashboard`, `Trazabilidad`, `Disco`, `Media Mixer`, `Configuración` | **fuera** de las dos secciones | |

## Dónde viven los prototipos

- `prototypes/*.html` → el endpoint `GET /api/prototypes` **lista el directorio solo**
  (`routes/settings.py:163`) — no hay registry que tocar: **basta con soltar el `.html`**.
- `archive/` queda fuera (el `listdir` no es recursivo) ✓.

## 2. Rediseño de la galería — el hueco real

Hoy `Prototypes.tsx` pinta **una pestaña plana por archivo**. Con 11 prototipos (3 de setup,
2 de landing, +8 nuevos) eso es ilegible, y **no distingue** lo elegido de lo descartado.

### Decisión: `prototypes/manifest.json`

Estado y agrupación **no pueden vivir en el nombre del fichero** (renombrar mataría la
referencia) ni en el código (añadir un prototipo exigiría compilar). Van en un manifiesto al
lado de los prototipos:

```json
{ "items": [
  { "file": "setup-02-focus-card.html", "section": "setup",
    "status": "selected", "recommend": true, "note": "..." }
] }
```

| `status` | Significado |
|---|---|
| `selected` | Elegido |
| `descartado` → **`discarded`** | Descartado, con **por qué** en `note` |
| `candidate` | En liza (los 8 nuevos empiezan aquí) |
| *(sin entrada)* | **`unlisted`** — el endpoint sigue funcionando aunque falte el manifiesto |

- **Fail-open**: manifiesto ausente o ilegible → los ficheros aparecen como `unlisted`,
  nunca se pierde la galería.
- Un fichero en el manifiesto **que no existe** se descarta de la respuesta (no hay nada
  que previsualizar).

### Rediseño de `Prototypes.tsx`

- **Segmentado**: `Todos · Seleccionados · Descartados · En liza`.
- **Agrupado por sección** (`setup`, `landing`, `peliculas`, `series`), con cabecera.
- **Tarjeta por prototipo**: nombre, **insignia de estado**, **insignia de recomendación**,
  `note`, y *Ver* que carga el iframe.
- El iframe se mantiene debajo — es la razón de existir de la página.

## Reparto en PRs

| PR | Contenido | Por qué va solo |
|----|-----------|-----------------|
| **A** | Manifiesto + endpoint enriquecido + **rediseño de la galería** + tests | Es la infraestructura; los3 setups existentes ya la validan. Sin ella, 11 pestañas planas |
| **B** | **4 prototipos de Películas** + entradas en el manifiesto | Artefactos puros, cero dependencia de código |
| **C** | **4 prototipos de Series** + entradas | Ídem |

## Aceptación

- [ ] **A**: un prototipo con `status: selected` se ve con su insignia; `discarded` muestra el
      `note` del porqué; un `.html` **sin** entrada sigue apareciendo; manifiesto roto → la
      galería **no** se cae.
- [ ] **B/C**: 8 prototipos accesibles desde la galería, cada uno con **recomendación** y
      justificación escritas.

## Checks

```
cd backend && python -m pytest -q
cd backend && python -m pytest tests_static.py -q
cd frontend && npx tsc -b --noEmit && npm run lint && npm test
```

## Riesgos

- 🟠 **El manifiesto es opcional por diseño.** No lo hagas obligatorio: `archive/` ya
  demuestra que el directorio puede contener cosas que la galería no debe mostrar, y una
  versión vieja del backend no debe romper al añadir prototipos.
- 🟠 **8 HTML no son triviales.** Cada uno es ~300 líneas de maqueta; ir uno a uno y
  verificar que la galería los lista, no maquetarlos todos y descubrir que no cargan.
- ⬜ Ninguna de las dos secciones **se implementa** aquí: esto es **maqueta para decidir**.
