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
| **A** ✅ | Manifiesto + endpoint enriquecido + **rediseño de la galería** + tests — **PR #107**, `b5cc5b4`, 678 backend / 268 frontend | La galería pasó de 11 pestañas planas a secciones + filtros con recuento + insignias de estado |
| **B** | **4 prototipos de Películas** + entradas en el manifiesto | ✅ **PR #108**, `912ebd9` — entregado junto con C por decisión del mantenedor |
| **C** | **4 prototipos de Series** + entradas | ✅ **PR #108** — acoplados a B: el encabezado de `series-01` cita a `peliculas-02` como su alternativa directa |

## Aceptación

- [x] **A**: un prototipo con `status: selected` se ve con su insignia; `discarded` muestra el
      `note` del porqué; un `.html` **sin** entrada sigue apareciendo; manifiesto roto → la
      galería **no** se cae.
- [x] **B/C**: 8 prototipos accesibles desde la galería, cada uno con **recomendación** y
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

---

## Estado: **ambos entregados** — falta TU decisión

- **`peliculas-02-maestro-detalle`** ⭐ y **`series-01-arbol`** ⭐ son los recomendados.
- La decisión real de Series no es árbol contra rejilla, es **idiomático por tipo de
  contenido vs. consistencia entre secciones** — y por eso `series-01` declara en su propio
  encabezado que, si prefieres un solo lenguaje, la respuesta es `series-04` (el gemelo del
  recomendado de Películas).
- Los 8 están como **`candidate`** en el manifiesto. Nadie se ha pronunciado → **nadie debe
  inventar un `selected`/`discarded`**.
- Cada fichero cierra con su **`Nota para revisión`**: ahí están las preguntas que hay que
  cerrar antes de implementar nada.

---

## ✅ DECISIÓN DEL USUARIO (registrada)

> *"creo que el de peliculas el 2 y de series el 4. Son el Maestro-detalle. Se aprende una vez
> y todo funciona igual."*

- **Películas → `peliculas-02-maestro-detalle`**
- **Series → `series-04-maestro-detalle`** *(no `series-01-arbol`, que era la recomendada)*

**Ganó la consistencia sobre lo idiomático.** Un solo modelo, aprendido una vez, operado igual
en ambas secciones. El manifiesto lleva ese razonamiento **en la nota de `series-01`**, para
que nadie vuelva a proponerla sin saber que ya se decidió.

**Regla para el manifiesto**: `recommend` queda `true` **solo en los seleccionados** — la
estrella marca *"esto es lo que se construye"*, no *"lo que sugirió el diseño"*. Que `series-01`
fuera la recomendada vive en su `note`, no en un badge contradictorio sobre una tarjeta
descartada.

### Siguiente: implementación

| PR | Contenido |
|----|-----------|
| **1** ✅ | Techo: navegación, `Page`/`PAGE_PATHS` unificados, envolturas maestro–detalle vacías — **PR #110**, `00b042a` |
| **2** ✅ | Mover **Biblioteca + Faltantes** a las dos secciones — **PR #111**, `32ef040` |
| **3** | Mover **Estrenos**; el modal de releases → **panel de detalle** |
| **4** | Mover **Archivos** como pestaña del panel; retirar `Faltantes`/`Calendario` del menú |

**Cada PR deja la app funcionando**: primero se añade el techo, después se mueve el contenido,
y solo al final se retira lo viejo.
