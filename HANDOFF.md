# HANDOFF.md — flow-controller · continuidad de sesión

> Última actualización: 2026-10-12 · main = `56bd09d` · RDD **off** (global) · specs: 1113 backend / 529 frontend
> Público: el agente de la próxima sesión + Raul. Artefactos en español, código/UI en inglés.

## Estado actual

**Desplegado en producción**: la instancia del usuario corre hasta `56bd09d` (6 PRs del
2026-10-11/12: #193 timeout · #194 async grab · #195 SSE · #196 B1 · #197 B2) con NPM
proxyando `/api/events` (bloque location copiado en `routes/events.py` docstring). Usuario
validó en vivo: eventos llegan y disparan la UI.

**Verde**: `main` en `56bd09d`, CI (backend/frontend/docker/e2e) pass, sin PRs abiertos,
working tree limpia salvo ruido no tracked (`.opencode/`, `graphify-out/`).

**Stitch**: proyecto `FlowController — Diseños` (`projects/4305330220058954866`) con design
system "FlowController" (`assets/5781956853225900110`) + 9 pantallas numeradas 01–09
(ids en `odd/tasks/stitch-*.md` de la sesión 2026-10-11). Sirven como fuente de diseño para
ports futuros; los ids y nombres están en los feature docs.

## Patrones no negociables (aprobados en esta saga)

- **Grab = task**: `POST /api/calendar/grab` devuelve `task_id` (refusals síncronas sin
  task_id). Worker en `application/use_cases/grab_release.py`. No reintroducir trabajo lento
  (ED2K ~30-60s) en la request HTTP — nginx corta a ~60s.
- **SSE**: `GET /api/events` (auth por `?key=` via `key_matches`), wire `event: <kind>` +
  `data: {json}`, heartbeat `: ping` /15s. Publicadores: TaskManager (transiciones
  done/error, con `channel`), `check_all` (status, en finally), `get_traces` (trace, tras
  refresh real), downloads poller. `subscriber_count()` gasta el refresher de traces.
- **Polls**: apagados con `connected ? false : interval` (EventStreamContext, default
  disconnected = fallback). **NO** apagar sin cubrir por evento: `['queue']` 2/10s
  (`/api/queue`), `['actions']` 60s, `DiskSpace` 30s quedan; `actions`/`queue` no tienen
  publisher (candidatos a B3 si se quiere).
- **trace_cache**: refresh lectura-driven, 9 HTTP + SQLite por build, `TRACE_TTL=10` →
  nunca cadencias <10s. El refresher backend existe (`trace_refresher`, lifespan).
- **Honestidad de datos**: la app no muestra speed/ETA/% que no conoce — pinned por tests,
  también en mockups/diseños.
- **Sidebar/nav de diseño**: solo Seguimiento con badge numérico (rojo, bloqueadas).

## Entorno local (repro/diagnóstico)

```bash
# backend (settings.json con prioridad > .env; sembrado en config/)
set -a; source .env.local; set +a          # load_dotenv() NO lee .env.local
CONFIG_DIR=$PWD/config PYTHONPATH=$PWD/backend \
  .venv/bin/python -m uvicorn app:app --app-dir backend --port 8000
# frontend
cd frontend && ./node_modules/.bin/vite --host   # proxy /api → :8000
```
- `.env.local:32` requiere comillas (requoteada en sesión). API key = `API_KEY` de ese fichero.
- `.local-config` no existe: se usa `config/` (gitignored).
- Venv en la RAÍZ: `../.venv/bin/python -m pytest` desde `backend/`.

## Reglas de trabajo (usuario)

- **Delivery**: 1 rama = 1 PR → main, merge `--merge` + `--delete-branch`, **single PR
  aunque >400 líneas** (decisión explícita repetida), merge al estar CI verde sin preguntar.
- **Gate (RDD off)**: `gentle-ai review assess --committed-only --base-ref main
  --untracked-scope=exclude --expected-untracked-inventory=sha256:b2105ec83cec8310c64135ad4562fa847a1b4003090d8721a04a0e886ebcc6ac --json`
  → tier medium = self-verification del writer + spot-check del padre (1 comando por suite).
- Writers `gentle-ai-worker`: **no ejecutan git** (reportan `partial` si toca commitear) →
  el padre commitea. TDD RED→GREEN obligatorio; e2e de CI = gate.
- Runner frontend **nunca `npm`** (alias pnpm): `./node_modules/.bin/{vitest,tsc,eslint}`.

## Pendientes (orden sugerido)

1. **Bloque 🟡 de diseño** — decisión de usuario antes de tocar: árbol izquierdo Series +
   estados de episodio con cola (backend), tabla densa Archivos (choca con dual-pane),
   secciones Calidad/Avisos (no existen en backend = feature nueva), redesign del Mixer
   (feature grande), y 3 namings donde la recomendación es NO cambiar ("Archivos"≠"Ficheros",
   chips F-07 backend-owned, 8 dots de Setup). Evidencia completa: sesión 2026-10-11.
2. **C-06 revisión visual humana** — #191 ajustó `--text-dim/--text-dim2` dark a `#8b8b93`
   (pendiente de su aprobación visual).
3. Backlog menores: C-01 canal de avisos, dedupe `formatBytes` (3 copias), dark/light toggle,
   un-ack `Descartar bloqueo`, knobs rate limit, fila C-08, F-06(b) GPL.
4. Posibles B3: publishers para `/api/queue` y `/api/actions` (apagar 2/10s y 60s);
   query key de `/api/downloads` si la vista de descargas vuelve (hoy: 0 consumidores
   frontend — decisión de producto del BACKLOG:737).
5. Operaciones: health de Radarr sigue con `RemotePathMappingCheck` (qBittorrent-novpn) y
   carpeta de colección ausente — no es del código, revisar en su Radarr.

## Gotchas que costaron esta sesión

- **Stitch MCP en OpenCode roto**: tools con parámetro objeto → "invalid argument";
  `generate` timeout a ~60s. Solución: JSON-RPC directo `https://stitch.googleapis.com/mcp`
  + `STITCH_API_KEY` (script temporal `stitch_mcp.py`, 900s). `edit_screens` NO edita in
  situ; HTML de `get_screen` cacheado → verificar por captura (recorte PIL).
- **Radarr**: valida conexión al guardar indexador (cuelga ~200s → 400 si la IP no es
  alcanzable desde SU host); circuito "All indexers unavailable" **no se autocura** →
  toggle enable/disable del indexador. `PUT` idéntico = 202 instantáneo (sonda barata).
- **`str(TimeoutError())` = ""** → mensajes "TimeoutError: " vacíos; usar el helper
  `_empty_answer_detail` (arr_client.py).
- **TestClient de Starlette mata workers fire-and-forget** → `post_grab_and_settle`
  (`backend/tests/_stubs.py`, httpx ASGITransport en un loop).
- **Ratchet `MAX_LEGACY_LOC`** (`tests/contracts/tests_architecture.py`): event_bus/app.py
  son legacy; cualquier línea nueva exige subir el máximo CON comentario dated y owned en
  el PR (2578→2730→2750 hecho).
- zsh se come backticks en `gh pr create --body` → siempre `--body-file`.
- Engram: si `mem_save` falla con "multiple active runtime sessions" → `engram doctor
  --json` y `mem_session_end` de la sesión runtime zombie (funcionó: `ses_ee284984...`).
- Baselines de test: si un writer discute el baseline, creerle y recalcular (los míos
  viajaron 1064→1113 backend, 441→529 frontend durante la sesión).

## Mapa de docs

- `BACKLOG.md` — tabla C/F con estado real (reconciliado 2026-10-11).
- `odd/tasks/sse-poll-off.md` — inventario completo de polls + reglas B1/B2.
- `odd/tasks/async-grab.md`, `sse-events.md` — contratos del grab async y del bus.
- `odd/tasks/stitch-*.md` (4) — puertos de diseño con evidencia.
- `prototypes/DESIGN.md` — handoff original de Stitch (tokens C-06 + briefs).
