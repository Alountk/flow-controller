# amule-watchdog — detección de aMule colgado + auto-restart por Docker

Detección: canario EC real (búsqueda) con timeout en tarea periódica del lifespan del backend.
Reinicio: Docker Engine API sobre socket montado (aMule corre en contenedor; decisiones del usuario 2026-10-28).

## Specs

S1 — Petición verbatim (2026-10-28): «ok, ahora detecto de vez en cuando que amule se queda colgado. se puede detectar de alguna manera esto? y si se puede reiniciar por ec»

S2 — Qué es «colgado» (Ask, respuesta verbatim): «cuando se hace cualquier busqueda, no funciona por ejemplo, cambias de servidor no responde». El detector NO puede ser solo el handshake de `POST /api/amule/test`: debe ejercitar una operación real de EC (una búsqueda con timeout corto) porque el handshake seguiría pasando con el subsistema de búsquedas/cola muerto, que es justo lo reportado. 2 fallos consecutivos del canario = colgado confirmado. Nota: el protocolo EC no tiene opcode de cambio de servidor, así que «cambias de servidor no responde» se observa por el mismo canario de búsqueda (subservicio de servidores/cola compartido).

S3 — Alcance del reinicio (Ask, respuesta verbatim): «Auto-restart vía Docker» → sobre colgado confirmado, el backend reinicia el contenedor de aMule por la Docker Engine API y luego VERIFICA la recuperación con el canario. Si el canal Docker no está disponible → modo solo-detección (S1 queda satisfecha igualmente): nunca se intenta un reinicio sin canal.

S4 — Dónde corre aMule (Ask, respuesta verbatim): «Contenedor Docker» → canal: socket de Docker (`/var/run/docker.sock`) montado en el contenedor de flow-controller. Resolución del contenedor: `AMULE_CONTAINER` (settings/env) si está definido; si no, coincidencia ÚNICA por nombre/imagen /amule/i. 0 o ≥2 coincidencias → fail-closed a solo-detección con la razón visible (nunca reiniciar un contenedor ambiguo).

S5 — Guardrails anti-bucle: umbral de 2 fallos consecutivos para declarar colgado; enfriamiento mínimo entre reinicios; máximo de reinicios consecutivos SIN recuperación → se deja de reiniciar y el estado queda en alerta para intervención manual; varias recuperaciones seguidas reinician el contador. El timeout del canario y la cadencia son configurables con defaults razonables (no hardcodeados en la lógica).

S6 — Visibilidad: el estado (sano / colgado / reiniciando / recuperado / alerta, con detalle y hora) es observable por API y visible en la tarjeta aMule de Ajustes (hoy sólo sonda bajo demanda con «Probando…»). Todo reinicio automático deja rastro visible, nunca silencioso.

S7 — Sin regresiones: `POST /api/amule/test` conserva su comportamiento exacto (HTTP 200 siempre + `{ok, detail}`, sólo handshake, config leída en el momento); cliente EC (`amule_ec_client.py`) y operaciones de `amule_service.py` intactos; suites existentes verdes sin tocar aserciones.

S8 — Prohibido: tocar `copy_engine.py`, `grab_release` o la cola EC; añadir operaciones EC nuevas al cliente (el canario reutiliza `amule_search` existente); sentar precedente de comandos arbitrarios — la llamada a Docker es UN shape fijo (restart del contenedor resuelto) sin shell ni paths del usuario; exponer la contraseña EC ni credenciales Docker en respuestas/logs.

## Tasks

T1 — Seam Docker (worker, `Spec: odd/tasks/amule-watchdog.md, T1`): `infrastructure/docker_client.py` con HTTP stdlib sobre unix socket — resolución del contenedor (env → única coincidencia /amule/i, fail-closed tipado), `restart` con timeout, errores tipados; tests RED→GREEN en `backend/tests/infrastructure/tests_docker_client.py` (socket ausente, contenedor ambiguo, éxito, API caída) — commit al entregar
T2 — Canario EC (worker, `Spec: odd/tasks/amule-watchdog.md, T2`): `infrastructure/amule_canary.py` — búsqueda trivial con timeout corto vía `amule_service.amule_search` + stop garantizado, devuelve OK/fallo tipado; tests RED→GREEN en `backend/tests/infrastructure/tests_amule_canary.py` (éxito, timeout, conexión rechazada, sin configurar) — commit al entregar
T3 — Watchdog (padre o worker): tarea en el lifespan de `app.py` con patrón `background_checker` (while/try/sleep), máquina de estados según S2-S5 (umbral 2, cooldown, secuencia confirmar → reiniciar → verificar → alerta) y superficie de estado expuesta por API (S6); tests de estados y guardrails — commit al entregar
T4 — Superficie frontend: estado del watchdog en la tarjeta aMule (`AmuleEcSection`) + cliente api + tests — commit al entregar
T5 — Deploy/config: montaje de `/var/run/docker.sock` en `docker-compose.deploy.yml` (+ `AMULE_CONTAINER` documentado para Portainer), wiring settings/env (defaults razonables de cadencia/timeout), HANDOFF/README — commit al entregar
T6 — Gates + entrega: backend full, frontend full, tsc, eslint, build; seam review del padre; assess CON `escalate item 2` (socket Docker = acceso root al host) e item 5 (entorno de deploy); PR → CI → merge → deploy = pull+redeploy manual del usuario → verif prod — commit al entregar

## Log

L1 — «ok, ahora detecto de vez en cuando que amule se queda colgado. se puede detectar de alguna manera esto? y si se puede reiniciar por ec»
L2 — Ask (2026-10-28) respuestas verbatim: colgado = «cuando se hace cualquier busqueda, no funciona por ejemplo, cambias de servidor no responde»; alcance del reinicio = «Auto-restart vía Docker»; dónde corre = «Contenedor Docker».
L3 — Hechos de exploración (padre): cliente EC completo con timeouts tipados y op NOOP (`backend/infrastructure/amule_ec_client.py`), sonda read-only `POST /api/amule/test` (settings.py:362, sólo handshake), `amule_service.amule_search` reutilizable, patrón de tareas periódicas en `app.py` lifespan (`status_routes.background_checker`), `docker-compose.deploy.yml` NO inyecta `AMULE_*` (Portainer pone el env). EC NO tiene opcode de reinicio (ni de cambio de servidor) ⇒ «reiniciar por EC» es imposible por protocolo; se resolvió con el canal Docker que el usuario eligió. Riesgo: montar el socket Docker = items 2 (seguridad) y 5 (entorno) → disclosure en PR + assess con escalate item 2.
L4 — Entrega y verificación T1-T5 (2026-10-29, todo seam review + gates independientes del padre): T1+T2 workers `mvsr7hli-v-b4e5`/`mvsr7hll-w-k0au` — seam del padre OK (tests de costura 78 pass: canario 11 + amule_service + amule_ec_client + contratos); T3 worker `mvss1xht-x-9ajq` — seam OK (tabla de transiciones fiel a S2-S5, fail-closed S4, snapshot atómico, `app.py` +1 línea neto, ratchet 3454→3455 con entrada house; ediciones en el RED del padre aceptadas: import muerto retirado + aridad `explode(timeout)` = costura real `run_canary(timeout)`), gates del padre `npm run build=0` + `pytest **1704 passed** exit 0` (vulture rc0, dist fresco); T4 worker `mvss3x4r-y-89d0` — seam OK (contrato exacto, labels ES verbatim, poll 30 s con cleanup, sin estilos inline), gates del padre vitest exit0 / tsc 0 / eslint 0, RED→GREEN 10/10→13/13; T5 inline — socket `:ro` + `group_add ${DOCKER_GID:-999}`, README (+3 variables + sección), `ruby -ryaml` OK. Knobs: los tres restantes también aceptan env (`AMULE_WATCHDOG_COOLDOWN`/`_MAX_RESTARTS`/`_CANARY_TIMEOUT`) con precedencia settings→env del patrón de casa; README documenta settings `services.amule.watchdog_*`. Semántica fijada: tick con watchdog desactivado publica `sin-datos` (pin del RED: nada de rastro obsoleto). Slices (superan 400 L ⇒ PR único con disclosure): C1 doc+T1+T2, C2 T3, C3 T4, C4 T5+este registro.
