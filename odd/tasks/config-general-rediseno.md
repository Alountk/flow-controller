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
| T1 | S1 | inline | `db6be2c` |
| T2 | S3 | inline (read-only) | — (informe de deltas) |
| T3 | S2 | pendiente | — anatomía de campo: etiqueta encima + rejilla de dos columnas dentro de tarjeta |
| T4 | S2, S4 | pendiente | — «Estado de las conexiones» como tabla del diseño |
| T5 | S2, S4 | pendiente | — orden de tarjetas, cabeceras con icono y subtítulo |
| T6 | S2 | pendiente | — responsive por debajo de 640 |

### T1 — hecho

Ninguna fila anida a otra; `.settings-input` puede encogerse (`min-width: 0`);
la fila hace `flex-wrap`; el raíl se apila por debajo de 1024 px. Medido con
backend real + `frontend/dist`: desbordamiento 0 del panel a 1600/1440/1280/
1100/900/700 (antes desbordaba ya a 1440). 991 tests, `tsc`, `eslint` verdes.

### T2 — informe de deltas (General vs `stitch-12-general.html`)

**D1. Anatomía de campo (el de mayor impacto).** El diseño apila: `label`
`display:block` encima y `input` `w-full` debajo, dentro de una rejilla
`grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6`. La implementación usa una fila
horizontal con etiqueta de 200 px fija y campo al lado. Eso es lo que produce
los campos pisados y los inputs de 90 px a 700 px de ancho.

**D2. «Estado de las conexiones» es una tabla** con columnas Servicio /
Endpoint / Estado / Latencia y píldoras «Conectado»/«No configurado»/«Alerta»
(`2ms`, `Timeout`). La implementación pinta una tarjeta por servicio con botón
«Probar conexión». S4: el botón se conserva como acción de fila.

**D3. Orden de tarjetas.** Diseño: Estado de las conexiones → Servicios →
aMule (EC) → Seguridad → Rutas → Intervalos → Seguimiento → Servidor.
Implementación: Servicios → Estado → Seguridad → Rutas → Intervalos →
Calidad de biblioteca → Seguimiento → Servidor → Logs.

**D4. Cabecera de tarjeta.** El diseño la compone con icono de material,
título `headline-sm` y subtítulo explicativo, separada por borde inferior. La
implementación usa solo `<h3>` de sección con borde inferior.

**D5. Lo que el diseño no tiene** (posteriores, S4 los conserva): «Calidad de
biblioteca» (umbral-calidad), «Logs del Sistema», «Carpetas compartidas», y
la tarjeta aMule EC, que `amule-control` movió a pestaña propia. Ubicación
propuesta: Calidad de biblioteca como tarjeta propia tras Intervalos (es un
umbral, no un intervalo); Logs al final, sin tocar.

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
