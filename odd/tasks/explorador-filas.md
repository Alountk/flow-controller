# explorador-filas

La fila del explorador peleaba por una sola línea: el nombre, la ruta, las
chips y la fecha eran hermanos de flex, así que un nombre largo empujaba el
tamaño y las acciones fuera del panel, y una procedencia larga rompía la fila.
Ahora el nombre y lo que lo explica son **un bloque** con dos líneas.

## Specs

**S1** — Cada fila tiene un bloque `.fm-row-main` que ocupa el ancho sobrante
con dos líneas: el nombre arriba y, debajo, la ruta, la antigüedad de retención,
la procedencia y la fecha de modificación. Ninguno de esos cuatro es ya una celda
hermana del nombre.

**S2** — La cabecera nombra solo las columnas que la fila sigue presentando:
`Nombre · Tamaño · Acciones`.

**S3** — Un nombre o una procedencia largos no desplazan el tamaño ni las
acciones: el nombre elide, la procedencia elide, y la segunda línea envuelve
cuando el panel es estrecho en vez de recortar la fecha.

## Tasks

- **T1** — `FileNavigator`: el bloque nombre + sub-línea. → S1
- **T2** — `FileManager`: la sub-línea con procedencia, edad y fecha; la
  cabecera de tres columnas. → S1, S2
- **T3** — `FileManager.css`: `flex-basis: 0` en el bloque, la sub-línea que
  envuelve, y los anchos de tamaño/acciones reservados. → S3
- **T4** — Tests migrados y gates.

## Log

- **L1** — «-estoy teniendo problemas con el explorador de archivos, los nombres
  colapsan son nombres muy largos y la procedencia tambien y rompe las columnas
  hay que arreglar esto. Tal vez poner la procedencia como ponerlo debajo del
  nombre y la modificacion tambien abajo.»
- **L2** — La causa medida en el navegador: `.fm-item` es un flex con `wrap`, y
  el bloque del nombre tenía `flex: 1 1 auto`. Con `wrap`, el tamaño hipotético
  del ítem decide el salto de línea, así que un nombre largo (ancho intrínseco
  enorme) mandaba tamaño y acciones a una tercera línea. `flex-basis: 0` +
  `min-width: 0` es la corrección, no un `overflow` más agresivo.
- **L3** — Dos tests viejos asumían el modelo anterior y se migraron: el de la
  cabecera de seis columnas de `fmDesignExtras` y las aserciones de `fm-prov` /
  `fm-date` como celdas hermanas.
