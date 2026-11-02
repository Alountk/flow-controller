# Películas V2 — las copias reales, el análisis en Acciones rápidas y Archivos en cards

Tres correcciones sobre la V2 entregada, con una regla común: la verdad la da el
disco (las carpetas configuradas de 4K y 3D) y el detalle deja de cargar con
utilidades que pertenecen a la biblioteca entera.

## Specs

- **S1** — «hay peliculas que debe señalizar que deberia estar en 1080 y 4k e
  incluso 3d y no lo esta cogiendo. Recordemos que tenemos configurados en que
  carpetas estan las peliculas de 4k y 3d.» Cada fila enciende las resoluciones
  de las que hay **copia real**: la del propio archivo de Radarr (su clase) y las
  que aparecen en las carpetas configuradas de 4K y 3D. Una película con copia
  1080, otra en la carpeta 4K y otra en la 3D enciende las tres.
- **S2** — «dentro de detalles de la pelicula el analizar deberiamos tenerlo
  justamente dentro de acciones rapidas asi aprovechamos el dropdown de peliculas
  y iremos metiendo ahí acciones interesantes». El desplegable Acciones rápidas
  deja de exigir una fila seleccionada: siempre ofrece las acciones de la
  biblioteca, y añade las de la fila cuando hay selección.
- **S3** — «en la vista de detalles en archivos deberia salir lo que tenemos en
  la primera version de peliculas las tres raices 1080 / 4k / 3d con sus archivos
  encapsulados en cards de exploracion de archivos y en las que son de
  extensiones de peliculas con el analisis del archivo»: cada raíz es una card
  (título, ruta, número de archivos) y los archivos de vídeo llevan su análisis
  dentro de la card.
- **S4** — «analizar biblioteca deberia desaparecer ya que esto deberia estar
  solo en acciones rapidas en la vista general de la biblioteca»: `ProbeLibraryCard`
  sale del detalle; su única entrada es Acciones rápidas de la lista.
- **S5** — El progreso del barrido se queda **dentro del propio menú** (decisión
  del usuario), no en la cabecera ni en un panel aparte.

## Tasks

- **T1** — `backend/domain/library_class.py`: `available_resolutions()` puro
  (clase propia + copias en las raíces) y `root_children()` (listar una raíz,
  nunca lanzar). Tests de dominio primero. `S1`.
- **T2** — `backend/interfaces/http/routes/wanted.py`: cada item lleva
  `libraries`, con las raíces leídas una vez por petición. Tests de ruta. `S1`.
  Commit propio (contrato del backend).
- **T3** — `frontend/src/pages/PeliculasV2List.tsx`: los chips leen `libraries`
  del backend; `availableResolutions`/`insideFolder` se retiran. `S1`.
- **T4** — Acciones rápidas: menú siempre disponible, «Analizar biblioteca»
  dentro con su progreso, `ProbeLibraryCard` fuera del detalle. `S2`, `S4`, `S5`.
- **T5** — `PanelFiles`: las secciones pasan a cards de exploración con el
  análisis del archivo dentro. `S3`.
- **T6** — Gates completos, medición visual y PR.

## Detalle

### S1 — de dónde sale cada chip

| Chip | Prueba |
|---|---|
| Clase propia | La que ya calcula `library_class`: 3D por carpeta, 4K por `2160p`, 1080 por `1080p`, resto SD. |
| 4K | El archivo vive en `PATH_4K`, o la raíz contiene una carpeta que empieza por el nombre de la carpeta de la película. |
| 3D | Igual contra `PATH_3D`. |

Una raíz sin configurar (`""`) o ilegible **no prueba nada**: no apaga chips, no
los enciende. La lista de hijos de cada raíz se lee **una vez por petición** y se
cruza con cada película; el coste es dos `listdir`, no dos lecturas por fila.

### S3 — qué es una card

`<section class="sec-file-card">` con cabecera (nombre de la raíz, su ruta y el
recuento), la tabla de archivos de esa raíz y, bajo cada archivo de vídeo, el
bloque de especificaciones que ya existe (`probeSpec`). Las cards de una raíz no
configurada no se pintan: mentirían con «0 archivos».

## Log

- **L1** — Pedido del usuario, literal (tres puntos en un mensaje): «-hay peliculas
  que debe señalizar que deberia estar en 1080 y 4k e incluso 3d y no lo esta
  cogiendo. Recordemos que tenemos configurados en que carpetas estan las
  peliculas de 4k y 3d. -dentro de detalles de la pelicula el analizar deberiamos
  tenerlo justamente dentro de acciones rapidas asi aprovechamos el dropdown de
  peliculas y iremos metiendo ahí acciones interesantes -en la vista de detalles
  en archivos deberia salir lo que tenemos en la primera version de peliculas las
  tres raices 1080 / 4k / 3d con sus archivos encapsulados en cards de exploracion
  de archivos y en las que son de extensiones de peliculas con el analisis del
  archivo (analizar biblioteca deberia desaparecer ya que esto deberia estar solo
  en acciones rapidas en la vista general de la biblioteca)».
- **L2** — El bug de S1 está acotado: `PeliculasV2List.availableResolutions`
  enciende la clase más `insideFolder(movie.path, path_4k|path_3d)`, y como una
  película vive en **un** sitio, el archivo propio nunca está a la vez en la raíz
  4K y en la 3D. Las copias de las otras raíces nunca se miran.
- **L3** — Decisión del usuario sobre el significado del chip: «Ambas, en dos
  fases» — ahora «lo que hay» (copia real), y **fase 2** (marcar la resolución que
  falta y que debería existir) queda fuera de este trabajo: exige definir qué se
  espera por película (perfil de Radarr, lista manual, regla por año), que hoy no
  existe. Se abre aparte cuando se decida de dónde sale.
- **L4** — Decisión del usuario sobre el progreso: «Dentro del propio menú».
- **L5** — Fuera de alcance consciente: «Otros» sigue siendo una cuarta card.
  Quitar las tres raíces y borrar el resto escondería archivos que existen y no
  prueban clase (subtítulos, samples), que es justo lo que el operador mira
  cuando algo no cuadra.
- **L6** — El panel de detalle es compartido por la V1 y la V2: las cards de S3 se
  ven en las dos, y la V1 conserva sus pestañas. Series no cambia, porque pasa
  `PanelFiles` sin raíces y sigue con su tabla plana.
- **L7** — T1/T2 cerradas: 10 tests de dominio y 4 de ruta (dominio 11→21,
  suite 1858→1872). La regla del prefijo tiene una trampa real: `Alien` matchea
  `Aliens (1986)` con un `startswith` a secas, así que el carácter siguiente al
  prefijo debe cerrar el nombre o abrir un marcador (` -_.[(`). El módulo
  `library_class` sigue puro (lo vigila su test): el `listdir` vive en la ruta,
  que es quien conoce el despliegue.
- **L8** — T3/T4 cerradas (commit `6fb6360`): `ProbeLibraryCard` gana una
  lectura de estado al montar — el menú se abre y se cierra, y un barrido en
  marcha no puede leerse como «no pasa nada» al volver a abrirlo.
- **L9** — T5 encontró un bug de la V2 que no era de este pedido:
  `selectedRowFacts` buscaba la fila seleccionada en `all-movies-infinite`,
  `calidad-movies` y `wanted-movies-infinite`, pero la lista V2 guarda su página
  en `['v2-movies', …]`. Abrir un detalle y entrar en Archivos decía «No se pudo
  leer la fila seleccionada» — y sin ruta no hay cards que pintar. Se corrigió
  con la clave de la V2; el test de S3 es el que lo fija (antes pasaba por
  casualidad, porque solo miraba que no estuviera el botón del barrido).
- **L10** — T5: las cards son `section.sec-file-card` con la cabecera (etiqueta,
  ruta cuando la hay, recuento y «Analizar» de la sección) y **la misma tabla**
  dentro; «Otros» no enseña ruta porque sus archivos vienen de las tres raíces y
  nombrar una sería mentir. Verificado con arnés desechable (`/tmp/biblio-visual.mjs`):
  las tres raíces con 1 archivo cada una, Alien con `4K✓ 3D✓ 1080p✓ SD·`, menú con
  «Analizar biblioteca» sin selección, y el detalle sin el barrido.
