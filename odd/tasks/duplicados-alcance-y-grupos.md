# Duplicados — elegir dónde buscar y agrupar por película

La regla de detección no cambia (dos ficheros de vídeo de la misma clase en la
misma carpeta). Cambia dónde se busca y cómo se presenta: el usuario elige la
carpeta, y el resultado se agrupa por **película**, no por carpeta y clase.

## Specs

- **S1 — alcance elegible.** La pantalla ofrece un selector con las raíces
  conocidas, un pan de migas de la carpeta elegida dentro de su raíz, un botón
  `Subir` y un botón `Raíz` (todas las raíces). La elección **se recuerda** entre
  visitas (`localStorage`, clave `duplicados.scope`) y viaja al backend como
  `?path=`. La nota «Se recuerda para la próxima búsqueda» está a la vista.
- **S2 — el alcance se valida en el backend.** `path` tiene que estar dentro de
  las raíces permitidas: fuera de ellas la ruta responde `403` con el motivo, no
  con una lista vacía.
- **S3 — un grupo por película.** El backend sigue detectando por carpeta y
  clase y después agrupa por título (`group_by_title`). Una película con dos
  clases repetidas es **una** entrada con todas sus copias; cada copia lleva su
  clase. Las carpetas que Radarr no nombró se agrupan por su propia ruta: unirlas
  por título juntaría dos carpetas distintas que se llaman igual.
- **S4 — el sobrante sigue yendo primero.** Dentro del grupo, el orden es el de
  la carpeta: el fichero que Radarr no conoce antes que el suyo.
- **S5 — nada de borrados en masa.** El grupo muestra cuánto se recuperaría, pero
  sólo hay `Borrar` por fichero, con la confirmación de siempre. Borrar el que
  Radarr conoce sigue avisando de que la película quedará «faltante».
- **S6 — sin datos del arr no se afirma nada.** Si Radarr no respondió, ninguna
  copia se marca como sobrante, el grupo lo dice por escrito y no se promete
  ninguna cifra recuperable.
- **S7 — sin recorrido al montar.** La búsqueda sigue siendo a botón: el disco no
  se camina hasta que el usuario lo pide.

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S2, S3 | backend: `group_by_title` puro, `?path=` validado, `folders`/`scope` en la respuesta | «duplicados por película» |
| T2 | S1, S5, S6 | frontend: barra de alcance recordada y grupos por película | «duplicados por película» |

Squash `a6d3dfc` en `main` (PR #303), CI verde **antes** de mergear; los commits
de rama quedaron inalcanzables, así que se citan por asunto.

**Frontera de rebanada**: T1+T2 se entregaron juntos (735 líneas autoradas, por
encima de las ~400). Se mantuvieron en un solo commit porque el contrato de la
respuesta y la pantalla que lo consume cambian a la vez: partir por backend y
frontend habría dejado la pantalla roja entre dos commits.

## Log

### L1 — petición del usuario (verbatim)

> 2-luego el duplicado deberiamos poder escoger en que carpeta buscarlos, luego
> reagruparlos por peliculas y por ultimos rediseñar con stitch.

### L2 — decisiones

- El selector es **raíz + subcarpeta, recordada** (elegido entre tres formas).
- Diseño: **misma familia visual, diseño nuevo** (Stitch).
- Fuente de diseño: proyecto `4305330220058954866`, pantalla
  `d7411992633140cc856a26e1e25b2630` — «Duplicados — FlowController» (barra
  `Buscar en` con raíz y pan de migas, tarjeta de resumen, grupos con insignias
  `en el catálogo` / `sobra` / `sin datos` y el aviso de arr caído).

### L3 — lo que el diseño pedía y NO se hizo

- **`Liberar N GB` por grupo** (borrado en masa): el diseño lo dibuja; no se
  implementa. Un botón que borra varias copias de golpe sobre una heurística es
  justo lo que el propio historial de esta pantalla desaconseja (el script que
  pulsó el índice 2 y borró el fichero de Radarr). Se muestra la cifra, no el
  botón.
- **Miniatura de póster** en la cabecera del grupo: el título y la ruta son datos
  que el backend ya tiene; el póster exigiría arrastrarlo por el dominio. Queda
  fuera, y en su lugar no se inventa nada.

### L4 — verificación real (2026-11-04)

Dos carpetas de verdad en `/private/tmp/dup/movies` (2 ficheros de 2 MB cada una)
y un Radarr falso con las dos películas:

- API: `total 2`, `carpetas 2`, `radarr true`; `Dune: Parte Dos` con clase `4K`
  y el sobrante primero; `Now You See Me` con `1080`.
- Navegador: `Buscar en` ofrece las raíces, la elección se guarda en
  `localStorage` (`/private/tmp/dup`), `Buscar duplicados` devuelve los dos
  grupos con `2 copias · 4K · 1.9 MB` y las insignias `sobra` / `en el catálogo`.
- Borrar el sobrante del primer grupo lo deja en **1 grupo** sin volver a
  recorrer el disco, y el aviso dice la ruta borrada.
