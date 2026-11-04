# Buscador de películas duplicadas

Encontrar el mismo título repetido en la biblioteca y poder borrar el que sobra
desde la propia pantalla, con confirmación.

## Specs

**S1 — la misma película es el mismo `tmdbId`.** «clave por `tmdbId`, títulos
ru/es/en» (L2). `tmdbId` es el identificador de TMDB que Radarr ya guarda por
película: dos entradas con el mismo `tmdbId` son la misma película aunque sus
títulos difieran. Los títulos en ruso, español e inglés se muestran cuando
Radarr los trae (`title`, `originalTitle`, `alternateTitles`); si solo hay uno,
se muestra el que haya — nunca se inventa ni se translitera.

**S2 — calidades distintas no son duplicado.** «Calidades distintas NO son
duplicado» (L2, literal de la opción elegida). La agrupación es
(`tmdbId`, clase de biblioteca), con la clase que ya calcula
`domain/library_class.py` — no una segunda definición de «4K». Un 4K y un 1080p
de la misma película conviven sin avisar.

**S3 — el tamaño no decide.** «sin exigir mismo tamaño» (L2 original). Dos
ficheros de la misma película y la misma clase son duplicados aunque sus bytes
no coincidan; el tamaño se **muestra** para que el usuario elija cuál sobra, no
se usa para comparar.

**S4 — la pantalla lista y borra, con confirmación.** «Listar + borrar desde
aquí, con confirmación» (L2). Cada par muestra ruta, tamaño y calidad, y cada
fichero suyo un botón de borrar que exige confirmación explícita.

**S5 — borrar es irreversible, así que se comprueba antes.** El borrado:

- sólo actúa sobre una **ruta de archivo**, nunca sobre un directorio entero;
- exige que la ruta esté dentro de una raíz permitida (`paths.allowed_roots`),
  resuelta con `realpath` para que un `..` o un symlink no la saquen de ahí;
- exige que el fichero exista y sea un fichero regular en el momento de borrar
  (no se borra a ciegas por lo que dijo un listado de hace un minuto);
- devuelve el error tal cual si el sistema de ficheros lo rechaza.

**S6 — nada de sondear al montar.** La búsqueda no recorre la biblioteca al
abrir la vista: la lista sale de los datos que Radarr ya tiene (`tmdbId`,
`path`, `sizeOnDisk`) y la carpeta sólo se toca al borrar. Sin esto, entrar en
la pantalla lanzaría una lectura por película.

**S7 — sin duplicados falsos por datos que faltan.** Una película sin `tmdbId`
(0 o ausente) **no se agrupa con nadie**: un identificador ausente no es una
coincidencia. Lo mismo con una entrada sin ruta.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2, S3, S7 | inline | `b8ea74f` (#293) |
| T2 | S1 | inline | `b8ea74f` (#293) |
| T3 | S1, S3, S6 | inline | `b8ea74f` (#293) |
| T4 | S4, S6 | inline | `551b7c3` (#295) |
| T5 | S4, S5 | inline | `04294af` (#294) |
| T6 | S5, S6 | inline | verificado: `/etc/hosts` rechazado con motivo; 1 petición al montar |

## Log

**L1** (petición original, literal): «buscador de películas duplicadas».

**L2** (2026-11-04, decisiones del usuario):

- «clave por `tmdbId`, títulos ru/es/en, sin exigir mismo tamaño» (contexto
  original de la petición).
- Pregunta «¿Tu biblioteca tiene la misma película en 4K y en 1080p a
  propósito. ¿Eso cuenta como duplicado?» → **«Calidades distintas NO son
  duplicado»**: «Solo es duplicado si comparten tmdbId Y calidad. Un 4K y un
  1080p de la misma película conviven sin avisar.»
- Pregunta «Cuando encuentre duplicados, ¿qué quieres que haga la pantalla?» →
  **«Listar + borrar desde aquí»**: «Añadir un botón de borrar en la propia
  pantalla de duplicados, con confirmación.» (Se descartó «solo listar» y
  «listar + abrir en Archivos».)

**L3** (2026-11-04, evidencia del código).

- `fetch_all_movies_detailed` (`backend/infrastructure/arr_client.py:1619`)
  arma el ítem con `id`, `title`, `year`, `path`, `path_exists`, `has_file`,
  `quality`, `file_name`, `media_info`, `languages`, `monitored`… y **no
  expone `tmdbId`**. El dato está en la respuesta de Radarr y ya se usa en tres
  sitios (`arr_client.py:2046`, `:2072`, `:2115`, `routes/calendar.py:120`):
  solo hay que pasarlo por el ítem en vez de re-derivarlo.
- La clase de biblioteca ya existe en `domain/library_class.py` (4K/1080/SD) y
  es la que usa la vista de Calidad: S2 se apoya en ella, no en una regla nueva.
- El borrado ya tiene diálogo en Archivos (`LibraryRenameDialog`-style); esta
  pantalla necesita el suyo, con las comprobaciones de S5, porque borra por
  ruta y no por selección de carpeta.
