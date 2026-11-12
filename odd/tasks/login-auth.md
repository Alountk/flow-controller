# Login de usuario + sesión en lugar de la API key

Objetivo: sustituir la API key del arranque por login usuario+contraseña con cookie de sesión HttpOnly (modelo «Un usuario + sesión»). Rama `feat/login-auth`. Entrega: `ask-on-risk` (se pregunta la estrategia de cadena al superar ~400 líneas). Tests: `backend/.venv` = `../.venv/bin/python -m pytest` desde `backend/`; frontend `npm test` en `frontend/`.

## Specs

- **S1** — «cambiar la apikey del principio por un auth de login» + elección del usuario «Un usuario + sesión (Recomendado)» → un único usuario (usuario + contraseña) protege la app; la sesión viaja en cookie `HttpOnly` + `SameSite=Strict` (`Secure` cuando la petición llega por https). Ya no se pide la API key al entrar.
- **S2** — Descripción de la opción elegida: «hash argon2/bcrypt en SQLite» → contraseña sólo como hash con sal en SQLite. *Assumption:* se usa `hashlib.scrypt` (stdlib) porque `requirements.txt` no tiene argon2/bcrypt y no se quiere una dependencia nueva para esto.
- **S3** — «Sirve también para el SSE sin poner la key en la URL» → `/api/events` autentica por cookie; desaparece `?key=` de la URL.
- **S4** — «La API key puede seguir como token opcional para scripts» → `X-Api-Key` sigue autorizando las rutas de datos si hay una key configurada; es opcional y ya no es la puerta de la UI.
- **S5** — *Assumption (instalaciones existentes):* si hay API key pero ningún usuario, la pantalla de entrada ofrece «crear usuario» y exige presentar la key actual para probar que eres el dueño. Sin key ni usuario sigue el flujo de Setup abierto de hoy (primer arranque).
- **S6** — *Assumption (abuso):* el login fallido devuelve 401 y cuenta contra el presupuesto de fallos por dirección que ya existe; la comprobación de sesión (`/api/auth/me`) devuelve 200 con `authenticated:false` para no gastar ese presupuesto. Las mutaciones con cookie comprueban `Origin` además de `SameSite`.

## Tasks

- [x] **T1** (S2) — `infrastructure/auth_store.py`: tablas `users`/`sessions` en `CONFIG_DIR/auth.db`, scrypt, token de sesión hasheado, caducidad. Route: inline. Commit: —
- [ ] **T2** (S1, S3, S4, S6) — rutas `login`/`logout`/`me`/`register`, `verify_api_key` acepta cookie o `X-Api-Key`, SSE por cookie, middleware, comprobación de `Origin`. Route: inline. **Risk: items 2 y 3** → verificador independiente + assess nativo. Commit: —
- [ ] **T3** (S1, S5) — `/api/config`, `/api/setup` (paso «proteger» con usuario/contraseña) y migración de instalaciones con key. Route: inline. Commit: —
- [ ] **T4** (S1, S3, S5) — frontend: `auth.ts`, `AuthGate`, `App`, `SetupPage`, `useEventStream` + tests. Route: inline. Commit: —
- [ ] **T5** (S1) — e2e (`auth.spec.ts`, `fixtures/app.ts`), compose, README. Route: inline. Commit: —

## Log

- **L1** (2026-11-12) — «mergea, y el siguiente step me gustaría cambiar la apikey del principio por un auth de login»
- **L2** (2026-11-12) — Respuesta a «¿Qué modelo de login quieres?»: «Un usuario + sesión (Recomendado)».
- **L3** — Mapa de la auth actual (explorador): clave en `settings.json` como HMAC+sal; ~140 rutas usan `Depends(verify_api_key)`; `/api/events` hace su propio `key_matches` con `?key=`; el frontend pasa por `apiFetch`. Decisión: conservar el nombre `verify_api_key` y cambiar su semántica (cookie o `X-Api-Key`) para no tocar los ~140 sitios.

