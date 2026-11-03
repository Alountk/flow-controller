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
| T4 | S2, S4 | inline | `feat(config): la tabla de conexiones muestra estado y latencia del diseño` |
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

### T4 — spec de la tabla de conexiones (D2)

El diseño (`stitch-12-general.html`) dibuja esta sección como **tabla** de
cuatro columnas — `Servicio`, `Endpoint`, `Estado`, `Latencia` — con el estado
en píldora (`Conectado`, `No configurado`, `Alerta`) y la latencia en
milisegundos (`2ms`) o `Timeout`. Hoy la implementación pinta una lista de
tarjetas `.service-test` después de pulsar «Probar conexiones».

Lo que hay y lo que falta:

- `GET /api/services` devuelve `services[]` con `key`, `kind`, `url`,
  `configured`; **no sondea** (contrato documentado: «sin salir a la red»).
- `GET /api/services/test` devuelve `results[]` con `key`, `kind`, `url`, `ok`,
  `version`, `detail`, `error_kind`. **No mide latencia**: hay que añadir
  `elapsed_ms` midiendo alrededor de la llamada HTTP del sondeo.

Reglas:

- S2: tabla con las cuatro columnas del diseño y su jerarquía (píldora en
  Estado, monoespaciada en Endpoint y Latencia).
- S4: antes de sondear, una fila por servicio de `/api/services` con
  «Sin comprobar» (configurado) o «No configurado»; el sondeo sigue siendo
  explícito (botón de la sección y botón por servicio en su tarjeta), nunca al
  montar la página: cinco salidas HTTP en la carga de Configuración la harían
  lenta y chocarían con el límite de peticiones.
- S4: los botones «Probar conexión» de las tarjetas de Servicios se conservan y
  rellenan la misma fila de la tabla.
- Estados ⇒ píldora: `Conectado` (ok), `Alerta` (fallo), `No configurado`,
  `Sin comprobar`.
- Latencia: `Nms` desde `elapsed_ms`; `Timeout` cuando el fallo es de tiempo
  agotado (`error_kind`), `—` cuando no hay medida.

Implementado (evidencia): `elapsed_ms` se mide una sola vez, envolviendo la
sonda entera en `arr_client.test_service_connection` —los clientes no miden
por su cuenta, o los números se separarían— y se devuelve también en los
fallos. La tabla se siembra con `GET /api/services` (query key `['services']`,
la misma de Indexadores: no hay una segunda petición) y el sondeo sólo rellena
sus filas. El motivo del fallo se conserva bajo la píldora «Alerta»: una
píldora sola no distingue «API key rechazada» de «no responde», que es
exactamente lo que el usuario viene a leer. Verificado con el backend real:
sección 752 px sin desbordamiento a 1600/1440/1280/1100/900/700 y las seis
filas con su píldora y su `—`.

Correcciones tras medir con las URLs reales de `.env.local` (sembradas en el
fixture de `/tmp/fc-config`, nunca en el repo):

- **aMule no se quedaba en «Sin comprobar» para siempre**: su sonda es EC sobre
  TCP, así que el botón no lo toca nunca. Estado propio `external` → píldora
  «Sin sonda» con borde discontinuo y `title` que lo explica. Antes de esto la
  fila prometía una comprobación que jamás iba a llegar.
- **Nada de latencia inventada**: el backend devuelve un resultado también para
  lo no configurado, con `elapsed_ms: 0`; pintar «0ms» ahí era una medida que
  no ocurrió. La columna solo mide en filas `ok`/`fail`.
- **Medido de verdad** (servicios del usuario, todos al mismo host): Radarr
  10ms, Sonarr 8ms, Prowlarr 8ms, aMuTorrent 898ms, aMule «Sin sonda»,
  qBittorrent «No configurado». El sondeo completo tardó **976 ms**, no
  minutos: la espera de 30 s que vi antes era el host inalcanzable del fixture
  heredado, no el comportamiento normal.


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

### Fronteras de rebanada

- **R1** (#284, `9f0957b`): T1–T3 — desbordamiento, anatomía de campo, rejilla
  de dos columnas.
- **R2** (PR de esta rama): T4 — tabla de conexiones con `elapsed_ms`. 531
  líneas: sobre el presupuesto de ~400, porque el cambio atraviesa backend,
  frontend y dos archivos de test. Se entrega sola, sin T5, para que la tabla
  se revise sin el ruido del reordenado de tarjetas.
- **R3**: T5–T6 — orden de tarjetas, cabeceras con icono y subtítulo, y el
  responsive por debajo de 640 (donde el límite es el armazón de la app).
