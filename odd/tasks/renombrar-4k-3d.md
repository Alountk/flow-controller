# renombrar-4k-3d

Las copias 4K y 3D viven sueltas en sus raíces, con el nombre que traía la
descarga, y Radarr no puede renombrarlas: solo renombra lo que él rastrea y
esos archivos están fuera de su biblioteca. El renombrado es nuestro, con la
plantilla de Radarr y **sin confiar en ella**: `domain/naming.py` ya valida una
plantilla reproduciendo el nombre que Radarr calculó para un archivo suyo.

## Specs

**S1** — Crear la carpeta «Título (Año)» y mover el archivo dentro se ofrece
**solo cuando el archivo está suelto** en una raíz 4K/3D. Un archivo que ya
vive dentro de una carpeta se renombra sin tocar la carpeta.

**S2** — En el diálogo, la carpeta y el nombre del archivo son **editables**
antes de aplicar; lo que se aplica es lo que se ve, no lo que calculó la
plantilla.

**S3** — Acompañan al vídeo los archivos con **el mismo nombre base y una
extensión de sidecar conocida** (`.srt`, `.nfo`, `-thumb.jpg`, …). Un archivo de
esa misma carpeta con otro nombre base no se toca.

**S4** — El nombre propuesto sale de `standardMovieFormat` y la carpeta de
`movieFolderFormat`, ambos de Radarr, y **solo se ofrecen como plantilla** si
`naming.reproduced_radarr` reproduce el nombre que Radarr ya calculó para el
archivo de esa película. Sin esa validación el diálogo lo dice, propone el
nombre que el archivo ya tiene y deja editarlo.

**S5** — Nunca se sobreescribe un destino: si el archivo o la carpeta de destino
ya existen, se niega y se nombra qué estorba. Hoy `place_file.rename_path` llama
a `os.rename`, que sobreescribe en silencio; eso no puede llegar a esta ruta.

**S6** — La guarda de semillas (`place_file.seed_block_reason`) aplica al
renombrado igual que al movimiento, y el destino tiene que quedar dentro de la
misma raíz 4K/3D que el origen.

**S7** — Cada renombrado deja rastro del par viejo → nuevo, para poder
deshacerlo a mano si algo salió mal.

**S8** — El vídeo y sus sidecars se mueven y renombran en **una sola
operación**: o se aplica el conjunto, o se informa archivo por archivo de lo que
sí y lo que no. Un sidecar que falla no deja el vídeo con el nombre nuevo y los
subtipos con el viejo sin decirlo.

## Tasks

- **T1** ✅ `1cc1d23` — `domain/rename_plan.py` (sidecars, validación de nombres)
  y `application/use_cases/library_rename.py` (`match_movie`, `proposal`): la
  calidad sale del nombre de la copia y la carpeta de `movie.path` de Radarr (S3, S4).
- **T2** ✅ `1cc1d23` — `GET /api/files/rename-preview`: no escribe nada; sin
  plantilla reproducible devuelve el nombre actual y el aviso (S4).
- **T3** ✅ `1cc1d23` — `POST /api/files/rename-apply`: mkdir + rename del
  conjunto, colisiones rechazadas antes del primer rename, guarda de semillas,
  contención en la raíz y `moved`/`failed` por archivo (S5–S8).
- **T4** ✅ — acción `🏷 Renombrar como Radarr` solo para vídeos bajo una raíz
  4K/3D (`isVideo === true`, nunca por ausencia) y `LibraryRenameDialog` con
  carpeta + nombre editables y la lista de sidecars (S1, S2).
- **T5** ✅ — 70 tests backend (36 dominio, 24 caso de uso, 10 rutas) y 5 de
  interfaz para el diálogo.
- **T6** ✅ — F-14 en `BACKLOG.md` y la tabla del `README.md`.

## Log

- **L1** — «hay que añadir una opcion de renombrar los archivos 4k y 3d, pero
  hay que estudiar como hacerlo, me gustaria hacerlo como lo hace radarr, es
  posible?»
- **L2** — «creo que B es el camino a Seguir, pero la cosa es que tenemos es que
  dentro de 4k y 3d los archivos no estan en carpetas, me imagino que el camino
  a seguir seria seleccionar el archivo y cuando se vaya a renombrar dar la
  opcion de crear la carpeta tambien y meterlo dentro.»
- **L3** — Decisiones del usuario: carpeta solo cuando el archivo está suelto;
  carpeta y nombre editables; sidecars por mismo nombre base y extensión.
- **L4** — Estudio previo (informe, sin código): Radarr solo renombra lo que
  rastrea, así que la parte reutilizable es su plantilla, no su motor.
  `backend/domain/naming.py:210` ya valida una plantilla reproduciendo el nombre
  que Radarr eligió; `copy_engine._radarr_pattern_destination` ya usa ese camino
  para nombrar copias. Falta la carpeta, que sí se puede renderizar:
  `{Movie Title}` y `{Release Year}` están en `naming._TOKENS`.
- **L5** — Matiz que fija S4: `file_provenance` es **display-only por decisión**
  (`BACKLOG F-07`), así que no puede ser la autoridad de identidad de un
  renombrado. La identidad se propone desde el nombre del propio archivo y la
  fila del catálogo, y el usuario la corrige; la plantilla se valida contra
  Radarr antes de ofrecerse.

## Slices

- **Slice 1 — el backend (T1–T3), commit `1cc1d23`**: 1228 líneas authored, casi
  todas tests (36 del módulo puro, 24 del caso de uso, 10 de las rutas). Es una
  sola unidad de comportamiento — proponer y aplicar no se pueden separar sin
  dejar una de las dos sin su prueba — y va divulgada por encima del corte de
  ~400 líneas.
- **Slice 2 — el diálogo (T4–T6)**: cerrará la feature.
