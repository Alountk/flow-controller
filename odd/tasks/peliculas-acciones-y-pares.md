# peliculas-acciones-y-pares

Dos huecos que el operador encontró usando el deployment recién mergeado: el
detalle de la película se quedó sin desplegable de acciones, y la tabla de
releases no enseña cuánta gente comparte un archivo en aMule.

## Specs

**S1** — En la V2, el detalle de una película tiene su propio desplegable
«Acciones rápidas» con **exactamente** dos acciones: «Buscar releases» y
«Escanear carpeta». La lista conserva el suyo, con «Ver detalle», «Buscar
releases», «Escanear carpeta» y «Analizar biblioteca». Un solo dueño del estado
de los dos modales: abrirlos desde la lista y desde el detalle es el mismo gesto.

**S2** — La cuarta columna de la tabla de releases se llama «Pares» y muestra,
por fila, el número que **esa fuente** declaró: los seeders del torrent o las
fuentes ED2K de aMule. Una fila sin ninguno de los dos sigue mostrando «—».

**S3** — El backend emite `sources` en la fila de release cuando la fuente lo
declara, y **nunca** lo convierte en `seeders`: son magnitudes distintas.

**S4** — El filtro mínimo de la tabla y su ordenación usan el mismo número que
la columna muestra, no solo los seeders.

## Tasks

- **T1** — `_release_row` de `backend/interfaces/http/routes/calendar.py` emite
  `sources`. → S3
- **T2** — Frontend: `Release.sources`, columna «Pares», orden interno `peers`,
  filtro `minPeers`. → S2, S4
- **T3** — Menú del detalle y un solo dueño de los modales. → S1
- **T4** — Gates (pytest, vitest, `tsc -b`, `eslint`, build) y PR.

## Log

- **L1** — «-acabo de mergear y ya veo bastantes cambios pero falta el dropdown
  de las acciones en los detalles de la pelicula. -veo los seeds de los
  indexadores que vamos agregando, pero no veo la gente que lo esta compartiendo
  en amule(supongo porque hay que trasformar la gente que tiene el archivo a seed
  para que se vea aquí).»
- **L2** — Decisión sobre el menú del detalle: «Solo las de esa película:
  releases y escanear». Decisión sobre el contador de aMule: «Renombrar la
  columna a «Pares»».
- **L3** — Diagnosticado antes de tocar código: el menú vive en la lista y la
  lista queda oculta al abrir el detalle (S8 del pulido), así que el detalle no
  tenía de dónde colgarse. Y `_release_row` descartaba `sources` en el backend,
  no solo la UI: la cifra no llegaba al navegador.
- **L4** — Rebanadas entregadas (total 508 líneas, ninguna por encima de ~400):
  `cab9652` el backend que no descartaba `sources`; `882b39a` la columna
  «Pares» con el filtro y el orden leyendo el mismo número; `6e6ed48` el menú
  del detalle con un solo dueño de los modales.
- **L5** — Verificación visual con `/tmp/biblio-visual.mjs` (desechable, fuera
  del repo): el detalle enseña «Buscar releases» y «Escanear carpeta» y nada
  más, y las cards de Archivos siguen intactas. El color de la columna «Pares»
  solo se aplica a seeders de torrent: 17 fuentes ED2K y 17 seeders no son la
  misma cosa, y pintarlas en la misma escala sería afirmar algo que el número no
  puede sostener.
