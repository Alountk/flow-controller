# Sección «Renombrar» — el renombrado 4K/3D sale del explorador

L1: *"no hemos hablado del rename, donde lo has implementado? deberia ser en otra
seccion del menu lateral, renombrar tal vez o donde crees que podria encajar?"*
Decisión (L2): **«Moverlo a la sección y quitarlo del explorador»**.

El motor existe desde #275 (preview/apply con plantilla de Radarr, sidecars,
colisiones, guarda de semillas). Lo que falta es un sitio donde ver **todas** las
copias que no siguen la plantilla y arreglarlas de una vez: renombrar de una en una
en el explorador no sirve para una biblioteca.

## Specs

- **S1** Entrada propia en el menú lateral llamada **«Renombrar»**, con su ruta y su
  carga por vista (el corte ya existe: `React.lazy` por página).
- **S2** La sección lista las copias **4K/3D** cuya carpeta o nombre **no** siguen la
  plantilla de Radarr; una copia que ya la sigue no aparece. (L2)
- **S3** La acción `🏷` del explorador **se retira**, junto con su montaje: la sección
  es el único sitio donde se renombra. (L2)
- **S4** **Vista previa obligatoria**: cada fila muestra el par viejo → nuevo antes de
  aplicar, y solo se aplica lo seleccionado, con el mismo motor de #275 (sidecars,
  colisiones rechazadas, guarda de semillas) y el rastro de cada archivo movido.
- **S5** Una copia para la que **no se puede proponer** nada (plantilla no
  reproducible) se muestra con su aviso, **no** se selecciona por defecto, y la UI
  no la esconde: esconderla haría creer que la biblioteca está entera.
- **S6** La sección **no inventa identidad**: sin Radarr (o sin coincidencia en el
  catálogo) la lista aparece vacía **con la explicación**, nunca con nombres
  propuestos a ciegas.

## Tasks

- **T1** Backend: `GET /api/files/rename-candidates` — recorre las raíces 4K/3D, se
  queda con los vídeos y devuelve, por copia, carpeta/nombre propuestos, sidecars,
  avisos y `ok`; **una sola** lectura del catálogo de Radarr (nada de N+1 por
  archivo). Respeta el contrato de #275 (`proposal`, `refusal`).
- **T2** Frontend: entrada en el menú, ruta con `lazy`, página `Renombrar`
  (`features/rename/`) con lista, selección, vista previa y «Aplicar a las
  seleccionadas»; reutiliza `LibraryRenameDialog` para editar una fila concreta.
- **T3** Quitar `🏷` y el montaje del diálogo de `FileManager.tsx`; migrar los tests
  del explorador que asumían esa acción (no borrarlos).
- **T4** Tests: backend de candidatos (vídeo suelto, dentro de carpeta ya correcta,
  sin Radarr, plantilla no reproducible) y frontend de la página (lista, vista
  previa, selección, aplicar, lista vacía con explicación).
- **T5** Docs: `BACKLOG.md` (la entrada F-14 pasa a describir la sección) y la tabla
  del `README.md`.

## Log

- **L1** — verbatim arriba.
- **L2** Decisiones del cuestionario: «Moverlo a la sección y quitarlo del
  explorador»; carpeta y nombre editables siguen como en #275.
- **Base**: esta rama nace de `feat/renombrar-4k-3d` (#275) porque el motor vive
  ahí; el PR se abre contra esa rama y tras el merge de #275 el diff queda limpio
  contra `main`.
