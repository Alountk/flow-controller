# amule-32-control — ENTREGADO (179ff5d) · espejo de odd/amule-32-control/tasks

Subir el stack de descargas a aMule 3.2.0 + `amuleapi` REST, sacar aMuTorrent
del camino activo y automatizar el barrido. Decisión del usuario: plan completo.

## Specs

Citas verbatim del usuario (L1): «no tener control sobre amule», «se vaya
rompiendo cada dos por tres», «otro cliente de amule que pueda utilizar para
conectarlo con flow-control», «implementar emule a nuestro proyecto para poder
tocar lo que queramos». Decisión (L2): «Plan completo (recomendado)».

- **S1 (P1)** — aMule en producción corre ≥3.2.0 y `amuleapi` está comprobable:
  sin credencial responden `GET /api/v1/health` y `GET /api/v1/version`; el EC
  de flow-controller sigue conectando (cifrado negociado y **apagado** por
  defecto en 3.1/3.2); en instalación nueva el remote-control sólo escucha en
  loopback (hay que fijar dirección para el contenedor de flow-controller); si
  algo cambia carpetas por API, la ruta debe estar en `allowed-remote-dirs.dat`
  (contrario → `403 path_not_allowed`).
- **S2 (P2)** — Ninguna llamada activa pasa por aMuTorrent (`:4000`). Búsqueda
  ed2k: `POST /api/v1/search` → `GET /api/v1/search/{id}/results` →
  `POST /api/v1/search/results/{hash}/download`. Categorías:
  `POST /api/v1/categories`. Auth JWT: `POST /api/v1/auth/login?include_token=true`
  con `Accept: application/jwt`; el **primer `401` es terminal** (re-login, nunca
  reintento ciego: rate limit 5 fallos/60 s → 300 s de bloqueo). aMuTorrent
  queda sólo como rollback documentado. Fuentes: `docs/api/REFERENCE.md` y
  `docs/api/EVENTS.md` de `amule-org/amule` (v1, ETag versionados).
- **S3 (P3a)** — La ventana de gracia de 30 min no aplica a descargas directas
  que el arr nunca vio: el motivo «el arr puede importarlo solo» no aparece
  jamás para `direct=1`/arr-untracked; con modo seguro apagado, el primer
  barrido disponible las mueve.
- **S4 (P3b)** — El barrido se dispara solo: intervalo configurable con
  interruptor, respeta el modo seguro (sólo propone) y su resultado aparece en
  Seguimiento igual que el manual.
- **S5** — Docs al día en el mismo PR (runbook, contratos, aMuTorrent como
  rollback). Lo que el diseño no menciona se conserva: cliente EC propio,
  watchdog, canary, qBittorrent nativo.

## Tasks

| ID  | S#       | Ruta / superficie                                                  | Commit |
|-----|----------|--------------------------------------------------------------------|--------|
| T1  | S1/S5    | Runbook de subida a 3.2.0 + amuleapi (este doc; README en T5)       | 8244826 |
| T2  | S1       | Servicio `amuleapi` en settings + salud/versión (Conexiones/pestaña aMule) | 1a00a41 |
| T3  | S2       | `infrastructure/amuleapi_client.py`: login JWT, 401-terminal, errores tipados | 41c8053 |
| T4  | S2       | Búsqueda ed2k vía amuleapi (sustituye `amutorrent_search_link`) + categorías | 651b8ec + c1380f8 |
| T5  | S2/S5    | aMuTorrent fuera del camino activo: flags/Settings/README + frontend | e44e3e1 |
| T6  | S3       | Gracia sólo para descargas que el arr conoce (`domain/policy`) + `tests_amule_mover_loop` en verde | df725bb |
| T7  | S4       | Barrido automático: scheduler + setting + respeta modo seguro       | 7920486 + f235336 |
| T8  | S1-S5    | Suites completas, evidencia en este doc y cierre                    |        |

Orden: P1 (T1-T2) → P2 (T3-T5) → P3 (T6-T7) → cierre (T8).

## Runbook (T1)

Hechos verificados contra `amule-org/amule` (changelog 3.1.0/3.2.0,
`docs/api/REFERENCE.md`, `docs/QUICKSTART-AMULEAPI.md`, `docs/EC_SRP.md`):

- **3.2.0 (28-oct-2026)** es la última release y es de seguridad: 15 avisos
  (varios «cualquiera que alcance el puerto 4712» sin contraseña). 2.3.3/3.0/3.1
  los comparten.
- **EC sigue compatible en 3.2**: el cifrado se negocia por sesión y viene
  **apagado**; nuestros clientes siguen conectando sin tocar. **3.3.0 (en
  desarrollo) lo romperá**: SRP-6a + X25519 obligatorios, sin fallback
  (`docs/EC_SRP.md`) → migrar a `amuleapi` **antes** de subir a 3.3.
- **Loopback por defecto desde 3.1 en instalaciones nuevas**: el remote-control
  sólo acepta desde la misma máquina salvo que se fije dirección
  (Preferences → Remote Controls). Config guardada por 2.3.x/3.0.x conserva
  escucha en todas las interfaces. Verificar si flow-controller (otro
  contenedor) conecta tras la subida.
- **`amuleapi`**: HTTP en `4713` (sólo HTTP; TLS en proxy), contratos en
  `docs/api/`, auth JWT HS256 con roles admin/guest, passwords PBKDF2 en
  `${config_dir}/amuleapi-passwords` (0600), se setean con
  `amuleapi --set-admin-pass=`. Sustituye a `amuleweb` (deprecado).
- **Guard 3.2 de carpetas remotas**: cambiar incoming/temp/shared/categorías
  por API exige la ruta en `allowed-remote-dirs.dat` (vacío por defecto) →
  `403 path_not_allowed`.

Pasos de subida (ejecución asistida: requiere el host/Portainer del usuario):

1. **Versión actual**: localizar el contenedor de amuled
   (`services.amule.*` en settings; lo reinicia el watchdog) y anotar imagen y
   `amuled --version` / `--version` del binario.
2. **Levantar 3.2.0**: binarios estáticos musl (`amuled`, `amulecmd`,
   `amuleapi`, pista #629) o paquete de la distro; conservar `amule.conf`,
   `ECPassword` (md5-hex) y el directorio de datos. Puertos: 4712 (EC),
   4713 (REST).
3. **EC entre contenedores**: en instalación nueva fijar dirección de
   remote-control que alcance a flow-controller; probar con el canary
   (`GET /api/amule/health`).
4. **`amuleapi`**: `amuleapi.conf [Server]/HttpPort=4713`,
   `[EC]/PasswordMD5` (QUICKSTART §amuleapi.conf), `amuleapi --set-admin-pass=…`,
   arrancar.
5. **Verificación**: `curl -s http://<host>:4713/api/v1/health` y
   `/api/v1/version` (200 sin credencial) → login con
   `Accept: application/jwt` → `GET /api/v1/status` con Bearer → prueba de
   búsqueda → canary EC → watchdog sigue reiniciando bien.
6. **Antes de 3.3.0** (futuro): toda la superficie activa debe estar ya en
   `amuleapi` (T3-T5); el cliente EC queda como rollback documentado.

## Log

- **L1 (verbatim)**: «estoy cansado bastante de no tener control sobre amule y
  de que se vaya rompiendo cada dos por tres. Hay alguna solucion o otro cliente
  de amule que pueda utilizar para conectarlo con flow-control para que funcione
  mejor o directamente es mejor implementar emule a nuestro proyecto para poder
  tocar lo que queramos?»
- **L2 (decisión)**: ask_user_choice → «Plan completo (recomendado)»
  (`plan-completo`): «P1 subir a 3.2.0 + P2 API amuleapi quitando aMuTorrent +
  P3 barrido automático y gracia sin mentira».
- **L3 (hallazgos)**: aMule revivió en 2026 (`amule-org`: 3.0.0→3.2.0; 893 PRs
  en 3.1.0 con `amuleapi` REST+SSE). No hay otro cliente eD2k mantenido (eMule
  parado; Ember, joven). «Implementar eMule» = reimplementar eD2k+Kad+AICH.
  Stack actual: ed2k → EC directo propio, magnet/http → qBittorrent nativo,
  búsqueda ed2k → aMuTorrent (façade), watchdog+canary → propios. La gracia de
  30 min miente para direct adds (reproducido en
  `backend/tests/legacy/tests_amule_mover_loop.py`, sin commitear: entra en T6).
- **L4 (límite)**: P1 se ejecuta en el host del usuario; este repo aporta
  runbook (T1), servicio+salud (T2) y el resto del código.
- **L5 (frontera de rebanada)**: rebanada 1 = T1+T2, 423 líneas en 2 commits
  (`8244826` doc, `1a00a41` código) — pasado el presupuesto de ~400: entrega
  por **PR único con disclosure** (estrategia establecida del usuario para
  features); la frontera queda anotada aquí antes de la siguiente rebanada.
- **L6 (frontera)**: rebanada 2 = T3 (cliente JWT amuleapi, 513 líneas: módulo
  222 + tests 291, RED por test observado, contratos/pyflakes/vulture limpios,
  backend completo 2164). Misma estrategia: PR único con disclosure; el
  contador de rama queda en ~936 líneas.
- **L7 (decisión + frontera)**: el swap de T4b **mantiene EC como fallback**
  cuando `services.amuleapi` no está configurado (búsqueda sigue funcionando
  antes de P1; la REST manda en cuanto haya url+contraseña) — así lo exige el
  orden P1-después-del-código. Borrado también el `torznab_client._search_query`
  dormiente (nunca cableado; vulture lo enmascaraba por referencia homónima):
  el shaping medido «Nombre Año» (30 s vs >40 s) queda en el docstring del
  módulo. Rebanada 3 = T4a+T4b (~1400 líneas de rama a la altura de
  `c1380f8`); estrategia invariable: PR único con disclosure.
- **L8 (límite interpretado de S3)**: «el primer barrido disponible las mueve»
  se cumplió **salvo la guarda D2**: si el destino es la biblioteca del arr y
  la sonda `arr_has_file` no puede responder, se sigue esperando (nunca copiar
  a ciegas a la biblioteca — eso CREA duplicados, el dolor del usuario). El
  destino 4K/3D fuera de raíz no sondea y se mueve siempre. Frontera pinneada
  por `test_a_direct_download_still_refuses_an_unknown_library_duplicate`.
- **L9 (T7 — cómo quedó)**: `intervals.sweep` (600 s, `0` = apagado) leído
  **en cada tick** junto a `SAFE_MODE` (una guardada aplica sin reinicio);
  `sweep_loop` junto a `sweep` en el driver, arrancado como el watchdog
  (refusal = tick saltado, nunca encolado; excepción = log y sigue);
  `GET /api/auto-copy/last` en memoria con estado vacío honesto sin conteos
  (paridad con el resumen manual, que nunca sobrevivió a un reinicio) y el
  panel de Seguimiento siembra por él al montar (`prev ?? result`: un seed
  lento no pisa un barrido manual). Ratchet MAX_LEGACY_LOC 3483 → 3569
  (deuda propia, disclosure en el commit). Rebanada 5 = T7a+T7b (~640 líneas).
- **L10 (entrega)**: PR **#306** → squash **`179ff5d`** en `main`
  (2026-11-06), rama borrada. CI verde antes de mergear: backend-tests,
  frontend-build, e2e, docker-verify y GitGuardian (docker-push salta en PRs).
  Evidencia final verificada: backend **2200**, frontend **1056** (135
  ficheros), build/`tsc`/eslint/vulture limpios. Las filas T1–T7 citan los
  hashes de rama: tras el squash sólo viven en el ref del PR
  (`gh pr view 306` / `refs/pull/306/head`); el commit de entrega es `179ff5d`.
  **Pendiente del usuario (fuera del repo)**: P1 en su host (runbook arriba),
  tarjeta «aMule API» y **modo seguro apagado** para que se mueva de verdad;
  y la captura/consola del bug de Seguimiento.
- **L11 (incremento T9, elección del usuario: 1+2)**: «estado visible del
  mover» — PR **#307** → squash **`16621c5`** en `main` (2026-11-06), CI verde
  (backend/frontend/e2e/docker-verify/GitGuardian). `record_sweep(summary,
  trigger)` sella el slot con `manual`/`auto` y responde con él, así que el
  POST devuelve `swept_at`+`trigger` y la línea meta no necesita segundo
  fetch; el GET vacío responde `trigger: null` (un barrido que nunca corrió
  no tiene origen); las refusals siguen sin clobber. El panel pinta «Último
  barrido: hace N min · automático/manual» con el `relativeTime` de la casa
  (sin línea en el estado vacío ni con `running`), y Seguimiento muestra la
  bandera «Modo seguro activo: nada se mueve, sólo se propone.» dentro del
  bloque del barrido al abrir — antes el estado sólo aparecía tras un
  resultado o en un `title`. Doctrina del «la cima de esta página es la
  lista» intacta (la bandera vive en `.sg-sweep`). RED→GREEN en ambos lados:
  backend 4+4 tests (2204), frontend 4 tests (1062), `tsc`/eslint/pyflakes/
  vulture limpios; `MAX_LEGACY_LOC` 3569 → 3576 (deuda +7 propia, disclosure).
