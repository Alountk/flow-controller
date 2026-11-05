# Renombrar — registro de lo hecho y renombrado a mano

Rediseño de la pantalla `Renombrar` con Stitch, más dos cosas que hoy no existen:
un registro durable de lo ya renombrado y una entrada para renombrar un fichero
concreto elegido a mano.

## Specs

- **S1 — diseño (Stitch, familia visual).** La pantalla tiene dos vistas con
  chips: `Candidatos N` y `Renombrados N`. Cabecera: título «Renombrar» y
  subtítulo «Copias 4K y 3D que no siguen la plantilla de Radarr». Botones
  `Actualizar` y `Aplicar N cambios`. Tarjeta de resumen. Tabla de candidatos con
  columnas `AHORA` (nombre actual, mono, apagado), `QUEDA COMO` (nombre
  propuesto, claro), `CARPETA` (destino, mono pequeño), `TIPO` (insignia `4K` /
  `3D`) y `ACCIONES` (`Omitir`). Una copia sin propuesta aparece **en la lista**
  con insignia `Revisar` y el motivo escrito, y su casilla deshabilitada.
- **S2 — registro durable.** Cada renombrado aplicado se guarda: ruta de origen,
  ruta de destino, fecha, origen (`lote` | `a mano`) y, si se sabe, la película.
  Vive en la base de datos de historial (esquema v14). Un fichero que vuelve a
  salir de plantilla reaparece en `Candidatos`: el registro cuenta lo que pasó,
  no bloquea el futuro.
- **S3 — vista `Renombrados`.** Resumen «N copias renombradas · la última hace …»
  y la nota «El registro se guarda al aplicarlo: si un fichero vuelve a salir de
  plantilla, aparece otra vez en Candidatos.». Tabla: `NOMBRE ACTUAL`, `ANTES`,
  `CUÁNDO`, `ORIGEN` (insignia `lote` / `a mano`) y `ACCIONES`
  (`Abrir carpeta`). Sin casillas: aquí no se aplica nada.
- **S4 — a mano desde Archivos.** Con un fichero de vídeo seleccionado en el
  explorador, se ofrece `Renombrar`: se muestra su ruta actual y el nombre
  propuesto (editable) y dos botones, `Cancelar` y `Renombrar`. El registro de
  ese movimiento queda con origen `a mano`.
- **S5 — Radarr se entera.** Si el fichero pertenece a una película del catálogo,
  después de renombrar se lanza un `RescanMovie` de esa película. Si el rescan
  falla, el resultado lo dice; el renombrado no se presenta como éxito completo
  sin esa confirmación.
- **S6 — reglas de siempre intactas.** Los sidecars viajan con el vídeo. Una
  colisión de nombres no renombra **nada** y explica el motivo. Una copia que no
  se puede proponer no se oculta. El lote se aplica de uno en uno. Un fichero
  cuyo nombre cambia pero que sólo se mueve de carpeta se sigue diciendo
  («solo se movió a su carpeta»), no «renombrado».
- **S7 — no mentir.** `Renombrados` sólo lista lo que está en el registro. Si el
  fichero ya no está en el destino, la fila lo dice en vez de ofrecer abrirlo.

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S2 | backend: tabla `rename_log` (v14) + `GET /api/files/renames` + registro al aplicar en lote | «registro durable» |
| T2 | S4, S5 | backend: propuesta y aplicación sobre cualquier fichero elegido + `RescanMovie` + origen `a mano` | «a mano y Radarr se entera» |
| T3 | S1, S6 | frontend: `Renombrar` rediseñada (chips, resumen, tabla) | «la pantalla como el diseño» |
| T4 | S3, S7 | frontend: vista `Renombrados` | «la pantalla como el diseño» |
| T5 | S4 | frontend: entrada `Renombrar` en Archivos sobre el fichero seleccionado | «la pantalla como el diseño» |
| T6 | todas | verificación real (disco + Radarr falso), suites, docs | «verificado con ficheros de verdad» |

Squash `23e1016` en `main` (PR #302), CI verde **antes** de mergear. Los commits de
rama quedaron inalcanzables al mergear, así que la tabla nombra el asunto y aquí
queda el hash que sí se puede citar.

## Log

### L1 — petición del usuario (verbatim)

> 1-coge y rediseña la parte de Renombrar hablar con stitch y que te de el
> diseño nuevo luego implementalo. Además tenemos que controlar los que ya han
> sido renombrados y marcarlos, aparte creo que deberiamos de tener una opción
> que si seleccionamos a mano algun archivo poder renombrarlo.

### L2 — decisiones del usuario

- **Renombrados**: «Registro durable + sección «Renombrados»» — tabla nueva en la
  base de datos, con pestaña propia (no un filtro).
- **A mano**: «Desde Archivos, sobre el fichero seleccionado».
- **Diseño**: «Misma familia visual, diseño nuevo» — Stitch lo genera dentro de la
  familia de Configuración y Películas V2.
- **Radarr**: «Renombrar y avisar a Radarr (rescan)» — Radarr localiza el fichero
  por su ruta; renombrar por detrás sin avisar deja la película «sin archivo» y
  el fichero huérfano.

### L3 — fuente de diseño

Proyecto Stitch `4305330220058954866` («FlowController — Diseños»):
- `acb538ce12024395aed258ec23dc086e` — «Renombrar — FlowController» (vista
  Candidatos + tarjeta de fichero elegido a mano).
- `588a6968807f4273acb6d3b90a89cd5b` — «Renombrar — Renombrados — FlowController»
  (vista de historial con las insignias `lote` / `a mano`).

### L4 — esta spec SUSTITUYE una regla anterior, y una limitación honesta

`odd/tasks/renombrar-seccion.md` decidió quitar el renombrado del explorador («dos
puertas con sus propias reglas se separan»). La decisión del usuario la sustituye
**parcialmente**: vuelve a haber una entrada en Archivos, pero no es una segunda
puerta — es el mismo `LibraryRenameDialog` y el mismo `POST /api/files/rename-apply`,
y marcan el registro con `origin: "a mano"`. El test que fijaba la ausencia se
reescribió para fijar la equivalencia.

Limitación declarada: `Abrir carpeta` en la vista `Renombrados` muestra la ruta en
mono con su `title` en vez de navegar. El explorador no acepta una carpeta de
arranque por URL, y llevar el botón a la raíz habría sido un botón que no hace lo
que dice. Añadir esa navegación es una rebanada aparte.

Verificación real (2026-11-04): dos `.mkv` de verdad en `/private/tmp/ren` y un
Radarr falso que anota los comandos.
- Lote: `The.Batman.2022.2160p.UHD.BluRay.x265-TERMiNAL.mkv` →
  `The Batman (2022)/The Batman (2022) Bluray-2160p.mkv`, `RescanMovie [7]`,
  fila con origen `lote`.
- A mano: `movies/Heat (1995)/heat.mkv` (fuera de las raíces 4K/3D) → preview
  `outside_roots: true` con la película identificada 949, renombrado en su sitio,
  `RescanMovie [949]`, fila con origen `a mano`.
- Pantalla: chips `Candidatos 1` / `Renombrados 2`, la fila imposible con
  `Revisar` y su motivo, y el registro con `ANTES`, `CUÁNDO` e insignias.

### L5 — la limitación de L4 se pagó (2026-11-05, `8428ede`)

`Abrir carpeta` (S3) navega de verdad. La carpeta viaja en la URL
(`#/archivos?path=…`), `navigateTo` empuja la ruta, el explorador abre **en esa
carpeta** y el parámetro se consume al llegar: es una puerta, no estado, así que
recargar tras navegar no arrastra a nadie a una carpeta ya abandonada. La fila
cuyo fichero ya no existe sigue sin ofrecer carpeta. Verificado en el navegador
con un renombrado real en el disco: `Renombrar → Renombrados → clic` aterriza en
`/private/tmp/fc-expl-demo/Interestellar (2014)` con su fichero, URL limpia.
