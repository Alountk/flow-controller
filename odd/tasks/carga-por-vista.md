# Carga por vista — cada pantalla trae su propio trozo

Reemplaza el único bundle por un chunk por página: el navegador baja el JS y el
CSS de la pantalla que se abre, no los de las once. Tailwind queda fuera, y esto
no es un detalle de la propuesta: Tailwind emite un stylesheet global, así que
no da la propiedad que se busca; el corte lo hace el bundler, no la hoja de
estilos (`odd/tasks/carga-por-vista.md`, L6).

## Specs

- **S1** — Cada página se carga en su propio trozo (JS **y** su CSS) la primera
  vez que se abre. El shell (sidebar, topbar, tokens y utilidades compartidas)
  sigue en el trozo inicial y no se duplica en los demás. El dashboard —la vista
  por defecto— no cambia.
- **S2** — Mientras el trozo viaja, el usuario ve un estado honesto y accesible
  (`role="status"`, texto «Cargando…»), no un hueco en blanco.
- **S3** — La app se comporta igual: la URL pinta su página, el sidebar navega,
  el gate de auth/setup sigue delante, y cada página conserva sus tests.

## Tasks

- **T1** — Este documento. `S1-S3`.
- **T2** — `frontend/src/app/App.tsx`: `lazy()` + `Suspense` por página, con el
  fallback de S2. Tests: uno que fije S2 y otro que fije S1 por el trozo
  emitido. Commit propio.
- **T3** — Adaptar los tests que asumen render síncrono de página (ayudarles a
  esperar; ninguno se borra). Commit propio.
- **T4** — Medir `dist` antes/después, gates completos (vitest, tsc, eslint,
  build, pytest) y PR. `S1`.

## Specs — detalle

### S1 — qué se corta y qué no

Cortar por página: `Peliculas` (sirve a `peliculas` y `peliculasV2`), `Series`,
`Estrenos`, `Seguimiento`, `DiskSpace`, `FileManager`, `MediaMixer`, `Settings`,
`Prototypes`. Quedan en el trozo inicial: `AuthGate`, `SetupPage`, `Sidebar`,
`Topbar`, `ServiceChips`, `ToastViewport`, `DashboardCards`, `IncidentsBand`,
`ActivityTable` y `Dashboard.css`, porque el dashboard los usa y es la vista por
defecto.

### S2 — el estado de carga

Un `<p className="page-loading" role="status">Cargando…</p>` dentro del
`Suspense`. Tiene que ser corto: con el trozo en caché no se ve nunca, y con red
lenta es lo único que separa al usuario de una pantalla vacía.

## Log

- **L1** — Pedido del usuario, literal: «una cosa los estilos no podriamos hacer
  algo como hace tailwind, que solo cargara en la vista que toca? además creo que
  los diseños de stitch utilizan tailwind, no? podriamos utilizarlo si no lo
  hacemos ya.»
- **L2** — Respuesta del padre: Tailwind no carga por vista (emite un stylesheet
  global; el recorte es de utilidades no usadas en todo el proyecto, no por
  pantalla), y migrar 10.192 líneas de CSS con 35 archivos, tokens en
  `global.css` y tests que consultan clases `.sec-*` no da ninguna propiedad
  nueva. Lo que sí da la propiedad pedida es `React.lazy` por ruta: Vite emite un
  trozo de JS **y su CSS** por página. Recomendación: sí a lazy por ruta, no a
  Tailwind. El mock de Stitch sí es Tailwind (`h-[72px]`, valores arbitrarios),
  pero es el artefacto de exportación del generador, no un requisito del diseño.
- **L3** — Decisión del usuario, literal: «dale».
- **L4** — Medición de partida (`frontend/dist` en `4b21465`): **un** CSS de
  136 KB (20.5 KB gzip) y **un** JS de 524 KB (148 KB gzip). No hay carga
  diferida: `App.tsx` importa las once páginas de forma estática, así que no hay
  cortes que el bundler pueda emitir. El peso dominante es el JS, no el CSS.
- **L5** — Fuera de alcance: precarga al pasar el ratón por el sidebar y
  `manualChunks` a medida. Si la medición de T4 muestra que el trozo inicial
  sigue pesado, se evalúan en un trabajo aparte.
- **L6** — Riesgo conocido: con red rápida el fallback de S2 apenas se ve; con
  red lenta, cada navegación cuesta un round-trip más. Es el precio de no
  descargar nueve pantallas que el usuario no ha abierto.
- **L7** — Medición después (mismo comando, `frontend/dist` reconstruido):

  | | Antes (`4b21465`) | Después |
  |---|---|---|
  | CSS inicial | 136 KB (20.5 KB gz) | 17 KB (**4 KB gz**) |
  | JS inicial | 524 KB (148 KB gz) | 289 KB (**89 KB gz**) |
  | **Carga inicial** | **168.5 KB gz** | **93 KB gz (−45 %)** |
  | Trozos emitidos | 1 JS + 1 CSS | 20 JS + 12 CSS |

  El total del `dist` sube (190 KB gz entre todos los trozos, porque el runtime
  compartido se repite en varios), pero eso no se descarga: cada pantalla trae
  entre 7 y 12 KB gz cuando se abre. El dashboard sigue en el trozo inicial, así
  que la pantalla de entrada no paga ningún round-trip extra.
- **L8** — T3: el único test que asumía render síncrono era
  `seguimientoJump.test.tsx` (contaba filas justo después del salto). Se le
  añadió la espera a tres filas; no se borró ni se relajó nada más. El resto de
  los tests de App ya usaban `waitFor`/`findBy`.
