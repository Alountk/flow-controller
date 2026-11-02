# Mixer — tercera salida: una carpeta elegida

L1: *"en el mixer en la parte del final deberiamos dar una opcion de mover el archivo generado a una carpeta que escojamos, ahora mismo solo tenemos carpeta de a o de b y eso hace sustituccion del cual este ahi, pero hay ocasiones que no querremos eso"*

Hoy la fila de acciones solo ofrece **sustituir** A o B (`destination_path`).
El backend ya sabe **no sustituir** (`start_mux` sin `destination_path` escribe en
`output_dir` con nombre generado) pero la UI nunca lo pide: la puerta de entrada no
existe. Este trabajo la abre, con nombre editable y sin pisar nada.

## Specs

- **S1** Tercera opción de destino junto a «Carpeta de A» y «Carpeta de B»: **«Otra
  carpeta…»**. En ese modo **no se sustituye nada**: A y B quedan como están.
  (L2: "Navegador de carpetas (reutilizado)", "Editable, con rechazo si existe")
- **S2** La carpeta se elige con el **navegador de carpetas que ya usa el mixer**
  (`FileNavigator`, `mode="folder"`), no con una ruta escrita a mano. (L2)
- **S3** El nombre del archivo es **editable**; por defecto
  `<stem>_<AAAAMMDDTHHMMSS>_mixed<ext>`. Si ya existe un archivo con ese nombre en
  esa carpeta, **se rechaza y no se escribe nada** — nunca se sobrescribe. (L2)
- **S4** El backend **valida la carpeta destino** contra las raíces permitidas antes
  de crear o escribir nada, y no crea carpetas fuera de ellas. Hoy `output_path` no
  se valida y `_generate_output_path` hace `mkdir(parents=True)`: es un hueco real.
- **S5** La UI dice la verdad antes de empezar: en modo carpeta «Se creará `<nombre>`
  en `<carpeta>`»; en modo A/B sigue diciendo «Sustituirá `<archivo>`». Sin destino
  elegido, «Mezclar» está deshabilitado, como ahora.
- **S6** Un nombre vacío, con `/`, con `..` o con caracteres de control se rechaza
  con un mensaje en español, no con un 500.

## Tasks

- **T1** Backend: `POST /api/mixer/start` acepta `output_path` de carpeta y un
  `output_name` explícito; valida raíz permitida, valida el nombre, y responde
  `409 {"code": "output_exists", ...}` si el destino ya existe. `start_mux` escribe
  en la ruta exacta pedida cuando llega el nombre. Sin `output_name` se mantiene el
  nombre generado (compatibilidad con lo que ya existe).
- **T2** Frontend: tercera opción + diálogo de carpeta + campo de nombre editable con
  el valor por defecto ya rellenado + línea de resumen veraz.
- **T3** Tests: backend (raíz no permitida, nombre inválido, destino existente,
  nombre explícito feliz) y frontend (la opción aparece, el resumen no miente, sin
  carpeta el botón está apagado).
- **T4** Ayuda y docs: nota bajo la fila de acciones y entrada en `BACKLOG.md`.

## Log

- **L1** (verbatim arriba) — petición original.
- **L2** Decisiones del cuestionario: «Navegador de carpetas (reutilizado)»,
  «Editable, con rechazo si existe».
