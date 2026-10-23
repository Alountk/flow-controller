# Feature: config-submenu — Configuración con submenú General | Indexadores (estilo Radarr)

Reestructura Configuración en dos subpáginas con raíl interno (General | Indexadores), añade la tarjeta «aMule — conexión directa (EC)» en General con sus campos editables y prueba, y convierte el campo de categorías de los indexadores en selector con checkbox.
Fuentes de diseño (HTML, no screenshots — regla del usuario): `odd/tasks/config-submenu/stitch-12-general.html` y `stitch-13-indexadores.html` (Stitch proyecto `4305330220058954866`, pantallas 12/13; gotcha: `edit_screens` no persistió el cambio de checkboxes al HTML — la spec L2 manda sobre el mockup en ese campo).

## Specs

S1: Submenú estilo Radarr — la página Configuración (`features/settings/Settings.tsx`) pasa de pila única a **doble raíl**: sub-nav interno con «General» e «Indexadores». **General** (default) contiene las secciones actuales tal cual: Servicios, Estado de las conexiones, **aMule — conexión directa (EC)** (nueva, ver S2), Seguridad, Rutas, Intervalos, Seguimiento, Servidor, Logs. **Indexadores** contiene `IndexadoresSection` (construida en #222: CRUD + Probar + búsqueda unificada + descarga). Cero pérdidas: todos los tests existentes de Settings (títulos de secciones, colliders de labels de #222) deben seguir verdes — los tests que asuman la presencia directa de una sección se adaptan SÓLO si la navegación lo exige (documentarlo, nunca aflojar aserciones).

S2: Tarjeta aMule (EC) en General — «Recuerda que los datos para conectar amule son diferentes a los indexadores de prowlarr y jackett por ejemplo» (Log L1c): campos **Host/URL**, **Puerto** (default 4712) y **Contraseña EC** (password, respuesta SIEMPRE enmascarada, jamás logueada) editables desde el form de Configuración con la semántica de servicios existentes (clave vacía en POST = conservar la guardada; defaults desde env `AMULE_URL`/`AMULE_EC_PORT`/`AMULE_EC_PASSWORD` que `config.py` ya lee). Backend: persistencia en `settings.json → services.amule.*` (mismo patrón que los servicios; el propio endpoint de settings ya gestiona el guardado y enmascarado — extender `_mask_secrets` al campo `ec_password`), **nunca** exponerlo en `GET /api/config`. Botón **«Probar conexión EC»** → `POST /api/amule/test` nuevo (read-only: abre `AmuleECClient`, handshake completo y cierra; responde 200 `{ok, detail}` estilo refusal — éxito con `server_version`, fallo con el texto corto y sin secretos). La card lleva la nota del mockup: «Es la conexión al daemon aMule por el protocolo EC (eD2k/Kad). No es un indexador Torznab: los indexadores se configuran en la pestaña Indexadores.»

S3: Categorías por checkbox (verbatim L2) — en el formulario de `IndexadoresSection` (alta y edición) el campo «Categorías» deja de ser texto libre y pasa a **rejilla de checkbox** (3-4 columnas): ☑ Todas (sin filtro) por defecto + Películas 2000, Películas HD 2010, 3D 2020, Remux 2045, Series 5000, Series HD 5010, Anime 5070, Documentales 5040, Música 3000, Audiolibros 3030, Libros 4000, Consola 1000 — cada casilla muestra nombre e id. Comportamiento: **«Todas» es exclusiva** (marcarla desmarca las demás; marcar cualquier específica desmarca «Todas»; desmarcar todo vuelve a «Todas»). La API no cambia: el estado se une a la cadena csv que la tabla `indexers` ya guarda (`categories TEXT`); edición carga el csv → casillas marcadas; vacío = Todas. Sin backend nuevo para esto.

S4: Diseño como fuente de verdad — implementar contra los HTML guardados en `odd/tasks/config-submenu/` (abribles en navegador a resolución real). Prohibido usar screenshots como especificación (regla del usuario, Engram 1453). El campo de checkbox del mockup quedó desfasado por el gotcha de Stitch («edit_screens NO edita en situ»): se implementa según L2 aunque el HTML no lo refleje.

S5: Alcance — sólo frontend de Configuración + el endpoint `POST /api/amule/test` y el enmascarado del S2 en backend. No se toca: `grab_release`, `copy_engine`, búsquedas, la API CRUD `/api/indexers` (salvo lo que S2/S3 exijan estrictamente), ni la barra lateral del panel (Sólo Ajustes sigue apuntando a Configuración).

S6: Verificación — TDD RED→GREEN por tarea; gate final: backend **≥1551**, frontend **≥687** (adaptaciones de navegación documentadas, cero aserciones aflojadas), `tsc -b`=0, `eslint`=0, ratchet `MAX_LEGACY_LOC` sólo sube si toca legacy (con disclosure). Ninguna respuesta HTTP contiene la contraseña EC (test de no-fuga).

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1-S6 | parent — feature doc + HTMLs de diseño | `740b17a` |
| T2 | S2, S6 | worker — backend: `services.amule.*` editable + enmascarado `ec_password` + `POST /api/amule/test` (handshake EC read-only), tests RED→GREEN | `e88ef5a` |
| T3 | S1, S6 | worker — frontend: doble raíl General│Indexadores en Settings + tarjeta aMule (EC) con Probar, tests adaptadas sin aflojar | `f482b00` |
| T4 | S3, S6 | worker — categorías por checkbox con exclusividad «Todas» (alta/edición), tests frontend | `b1779b6` |
| T5 | S6 | parent — gate (backend+frontend+tsc+eslint+ratchet), docs, PR único con divulgación, merge | gate abajo; PR al cierre |

## Log

L1 (peticiones originales, literales — 2026-10-23):
- L1a: «no me gusta nada, como esta, podriamos mover esta parte de los indexadores a una subcarpeta de configuraciones y poner las configuraciones generales en un lado y en otra los indexadores, algo parecido a Radarr.»
- L1b: «Pidele a Stitch un diseño para estas dos partes con todas las cosas que necesiere.» (registro: «…necesites»)
- L1c: «Recuerda que los datos para conectar amule son diferentes a los indexadores de prowlarr y jackett por ejemplo.»

L2 (ajuste + aprobación, literal con sus typos): «las caegorias delos idnexadores deberia deberia ser un seleccionable con checkbox. el resto esta bien, puedes implementar pero recuerda utilizar html en vez de screenshots.»

L3 (diseño Stitch): pantallas **12 Configuración — General** (`4cf5538c398846a0ab514737fb02784d`) y **13 Configuración — Indexadores** (`6800944798204ab392aaa62d2e2a8c8a`) en proyecto `4305330220058954866`, DS `assets/5781956853225900110`; QA visual del padre: doble raíl presente, tarjeta aMule (EC) destacada con nota separadora, semillas vs «fuentes: 12» distinguidos, estados honestos, botón «Importar de Prowlarr/Jackett…» (Step 5). HTML guardados (46KB/41KB). Regeneración y `edit_screens` reportaron éxito pero los artefactos quedaron **stale** (mismo `html_6347c573…` byte a byte) — gotcha preexistente de HANDOFF («edit_screens NO edita en situ»); por eso L2 manda en el campo de checkbox. Preferencia «HTML, no screenshots» guardada en Engram **1453**.

L4 (decisiones técnicas): persistencia de aMule EC en `settings.json → services.amule` con defaults desde env (precedente de servicios y `config.py`); enmascarado del `ec_password` en las respuestas (S2) siguiendo `_mask_secrets`; `POST /api/amule/test` read-only con el cliente EC ya verificado en #220 (nunca encola descargas); checkbox → csv en cliente (sin cambios de API); navegación por pestañas internas (sin rutas nuevas) para no tocar la barra lateral.

L5 (gate y cierre de T4 — 2026-10-23): **gate observado por el parent**: backend **1577 passed**, frontend **88 files / 707 passed** (base 687), `tsc -b` 0, `eslint` 0, ratchet intacto (3408; `app.py` net-154 por líneas compartidas). Ampliación aceptada de T2 (Risk item 2): `ec_password` **cifrada en reposo** vía `ENCRYPTED_SECRET_FIELDS` (RED con el secreto en claro antes del fix; matriz de degradación FC_SECRET documentada). Tests: T3 **0 adaptados**; T4 **1 adaptado** (`indexadoresSection` «add form»: texto→dos clicks, aserción `toEqual` estricta intacta y el `100000` custom pasó a estar pinneado en el test nuevo anti-pérdida). Incidente: el worker T3 fue **abortado por el usuario en fase de lectura** (24 turns/40 calls, árbol limpio, `ps` limpio — misma firma de los cuelgues 2 y Engram 1446); mitigación aplicada: `subagent_continue` (leyendas conservadas) + **checkpoint temprano** (fichero RED primero). Slice tras T4: **3217 líneas / 4 commits** — estrategia PR único con divulgación. **Review nativa**: clone-local sigue OFF (D de #220) → este PR sin review nativa (disposición mantenida).
