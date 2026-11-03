# Rediseño de Configuración → General

Rediseñar la pestaña General de Configuración contra el diseño aprobado
(`odd/tasks/config-submenu/stitch-12-general.html`), y terminar con el defecto de
layout que hoy hace que los campos se pisen.

## Specs

- **S1** — «Estoy viendo campos que se sobreponen de inputs y labels y tiene que
  ver con los diseños.» El panel de General no puede desbordar su contenedor a
  ningún ancho de ventana soportado (≥ 380 px): ningún `.settings-field` puede
  tener `scrollWidth > clientWidth`.
- **S2** — «Un rediseño de configuracion -> General.» La pestaña General se
  implementa 1:1 contra `stitch-12-general.html`: etiqueta encima del campo,
  tarjetas con cabecera (icono + título + subtítulo) y rejilla de dos columnas
  que colapsa a una en pantallas estrechas.
- **S3** — «una revision del diseño por steps no demasiados grandes»: cada
  entrega es una rebanada revisable por separado (~400 líneas), con su propio
  commit y PR, y ninguna rebanada cambia el comportamiento de guardado.
- **S4** — Lo que el diseño no contempla se conserva tal cual (Umbral de
  calidad, aMule EC, Carpetas compartidas, Indexadores): el rediseño reubica,
  no elimina ni cambia semántica.

## Tasks

| ID | Spec | Route | Commit |
|----|------|-------|--------|
| T1 | S1 | inline | `fix(config): la fila del umbral de calidad deja de desbordar el panel` |
| T2 | S3 | inline (read-only) | — (informe de deltas) |
| T3 | S2, S4 | pendiente | — |
| T4 | S2, S4 | pendiente | — |
| T5 | S2, S4 | pendiente | — |

## Log

- **L1** (2026-11-03, verbatim): «perfecto, me gustaria que me dijeras que
  tenemos pendiente y en ese pendiente que se haga una revision del diseño por
  steps no demasiados grandes. Estoy viendo campos que se sobreponen de inputs
  y labels y tiene que ver con los diseños. Un rediseño de configuracion ->
  General. agregar un buscador de peliculas duplicadas (estas no tienen porque
  ser que ocupen lo mismo, y el nombre peude estar en ruso / español /
  english)»
- **L2** (diagnóstico, medido con el backend real en `:8099` y `frontend/dist`):
  `.settings-panel` mide 816 px de ancho y 945 px de contenido a 1440×1000; el
  desbordamiento lo impone un único `.settings-field` («Umbral de calidad») que
  anida otro `.settings-field` (398 px, `min-width: auto`) junto a una etiqueta
  de 200 px, un slider y sus marcas: mínimo 913 px. El diseño de Stitch no tiene
  esa fila (se añadió después), y usa etiqueta encima del campo en rejilla de
  dos columnas, no la fila horizontal etiqueta-al-lado que implementa hoy
  `.settings-field`.
- **L3**: el buscador de duplicados del mismo mensaje se entrega como feature
  aparte (`odd/tasks/peliculas-duplicadas.md`): otro dominio, otra rama.
