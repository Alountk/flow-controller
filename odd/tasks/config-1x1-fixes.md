# Feature: config-1x1-fixes — sonda EC con lo escrito + implementación ESTRICTA 1:1 de los diseños

Dos defectos reportados por el usuario tras #224: (1) «Probar conexión EC» responde «no está configurado» en Configuración; (2) la implementación no es 1:1 con los diseños Stitch — «te has tomado libertades cuando realmente tenías que haber seguido el diseño estrictamente».

## Specs

S1: Sonda EC con los valores escritos (verbatim L1: `{"ok":false,"detail":"amule no está configurado (faltan la URL o la API key)"}`) — `POST /api/amule/test` acepta ahora body OPCIONAL `{url?, ec_port?, ec_password?}` al estilo del precedente `POST /api/services/test` («sonda de lo que el usuario acaba de escribir, antes de guardarlo»): con body → sondea ESOS valores; sin body → la config guardada/env actual (comportamiento existente intacto). La contraseña del body viaja por la misma superficie confiable que el guardado, jamás se refleja ni se loguea. Frontend: «Probar conexión EC» envía los valores ACTUALES del formulario de la tarjeta (si el campo está vacío → se omite y manda lo guardado). Además: cadena save→probe (POST /api/settings con `services.amule` → `config.rebuild()` → probe con guardado) pinneada en tests — fue la cadena que el usuario no pudo completar. Contexto de despliegue descubierto (sin cambiarlo): `docker-compose.deploy.yml` NO inyecta `AMULE_URL/AMULE_EC_PORT/AMULE_EC_PASSWORD` (ni `FC_SECRET` — Portainer es quien pone env), así que en prod la vía por defecto es la tarjeta guardada.

S2: Fidelidad estricta 1:1 (verbatim L2: «los diseños no son 1:1. Te has tomado libertades cuando realmente tenias que haber seguido el diseño estrictamente») — la UI resultante de #224 debe seguir **estrictamente** `odd/tasks/config-submenu/stitch-12-general.html` y `stitch-13-indexadores.html` en todo lo que es alcance de esta feature:
- **Sub-raíl VERTICAL** (~320px) dentro de Configuración con título «Configuración», su descripción («Parámetros operacionales, endpoints locales, demonios multimedia y credenciales de acceso.»), ítems **General** (default) / **Indexadores** y la tarjeta de pie del diseño («Sincronización de Daemons…») — NO tabs horizontales.
- Cabecera de «General» con título+subtítulo y acciones **«Guardar cambios» (primario) y «Descartar»** arriba a la derecha, según el diseño (ajustando el flujo actual de guardado para conservar su comportamiento y tests).
- Tarjeta aMule (EC): badge **«Protocolo Nativo»**, subtítulo «External Connection (EC) para telemetría directa con el core aMuled.», y la nota con **«Indexadores» como enlace** que conmuta a la pestaña Indexadores (la regla de accesibilidad que lo convirtió en texto plano fue una libertad: ahora es accionable y con nombre accesible correcto).
- Rejilla de categorías con el aspecto del diseño (casillas con nombre+id, 4 columnas) en `Settings.css`/CSS del módulo — **sin estilos inline como plan B**.
- La «descarga» de libertades ya cometidas se corrige; cualquier elemento del HTML que NO sea implementable sin inventar datos (p. ej. latencias/polling de «Estado de las conexiones» que el diseño muestra y el backend no expone) se REPORTA como fuera de alcance en vez de improvisarse — regla: **diseño → implementación; imposible → reportar; jamás variante propia**.

S3: Sin regresiones — todo lo ya construido se conserva (card aMule con campos/sonda+cifrado, checkbox con exclusividad y personalizada, CRUD/búsqueda/viscindad de #222); gate: backend ≥1577, frontend ≥707, tsc/eslint 0, ratchet 3408; adaptaciones de tests sólo por el cambio estructural de navegación (documentadas, sin aflojar).

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1-S3 | parent — feature doc | (este commit) |
| T2 | S1, S3 | worker — probe con body opcional + envío desde el formulario + test de la cadena save→probe, RED→GREEN | `76ad49d` |
| T3 | S2, S3 | worker — rework 1:1 **pantalla 12**: sub-raíl vertical + cabecera Guardar/Descartar + tarjeta aMule (badge/enlace) con CSS en Settings.css, RED→GREEN | `ba491dc` |
| T4 | S2, S3 | worker — rework 1:1 **pantalla 13** + 4b (literales de formulario y callout por prop): IndexadoresSection al `stitch-13`, rejilla en CSS, decisiones reportadas, RED→GREEN | `e50b808` + `6567025` |
| T5 | S3 | parent — gate + docs + PR único con divulgación + merge | gate abajo; PR al cierre |

## Log

L1 (queja 1, literal): «poniendo la configuracion el test de ec falla: {"ok":false,"detail":"amule no está configurado (faltan la URL o la API key)"}»

L2 (queja 2, literal): «aparte los diseños no son 1:1. Te has tomado libertades cuando realmente tenias que haber seguido el diseño estrictamente»

L3 (diagnóstico): `config.rebuild()` SÍ se ejecuta tras guardar (`routes/settings.py:180`) y la persistencia profunda de `services.amule` está probada — la cadena save→probe es sólida en código; el fallo del usuario es que **la sonda sólo lee config guardada y no lo escrito en la tarjeta** (patrón candidato de `POST /api/services/test` no aplicado). Despliegue: `docker-compose.deploy.yml` no inyecta `AMULE_*` (ni `FC_SECRET`) — en prod la vía natural es la tarjeta. Preferencia durable guardada: **implementación estricta 1:1, sin libertades** (Engram 1457, con la lección de conceder surfaces de CSS de entrada). Libertades concretas de #224 a corregir (del informe de T3): tabs horizontales en vez de raíl vertical, estilos inline, enlace «Indexadores» convertido en texto plano, acciones de guardado fuera de la cabecera del diseño.

L4 (frontera de alcance): se respeta el diseño 1:1 en TODO lo que es delta de esta feature; las secciones preexistentes conservan sus campos/estados actuales pero se acomodan al raíl del diseño. Elementos del mockup que exigen datos nuevos (columna LATENCIA + chip «Polling: 5s» de «Estado de las conexiones») NO se implementan con datos inventados — se reportan como candidato a feature aparte (regla de honestidad de datos del repo).

L5 (reparto de tareas): el rework 1:1 se divide en **T3 = pantalla 12** (raíl vertical + cabecera + tarjeta aMule) y **T4 = pantalla 13** (IndexadoresSection + rejilla), gate → T5; T2 cerrado con `76ad49d` (11+3 tests; fuga de la contraseña candidata encontrada en RED y corregida — redacción unificada).

L6 (cierre de T4/4b y gate — 2026-10-23): **gate observado por el parent**: backend **1588 passed**, frontend **88 files / 730 passed** (base 707 → +23), `tsc -b` 0, `eslint` 0. Entregas: T3 `ba491dc` (checklist 1:1 pantalla 12; libertades corregidas: tabs→raíl vertical, inline→Settings.css, enlace→accionable, acciones→cabecera; 18 cadenas contrastadas carácter a carácter), T4 `e50b808` (pantalla 13; datos inventados del mockup NO renderizados con test negativo pinneado; «Importar» y «Probar» del formulario **disabled-honestos** con motivo real), 4b `6567025` (literales «Nombre/URL/API Key» + submit «Guardar» en ambos modos; callout por prop `onOpenGeneral`; colisiones por scope — `apiKeyMask` autorizado prosaicamente). Imposibilidades reportadas (jamás improvisadas): iconos Material Symbols (fuentes no cargadas; requeriría `index.html`), latencias/polling/uptime/estado de socket del mockup (datos inexistentes → L4, candidato a feature aparte), barra inferior del build. Decisiones ratificadas: tabla de 6 columnas (HTML manda sobre mi enumeración de 5), «Guardar» en edición (botón único del diseño). Slice: **3264 líneas / 5 commits** — PR único con divulgación. **Review nativa**: clone-local OFF (D) → sin review (disposición mantenida).
