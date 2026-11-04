# Una sola regla de resolución

La clase de resolución de un fichero se decide hoy en siete sitios, con tres
vocabularios y dos umbrales. El bug de John Wick 3 es la consecuencia: el nombre
dice `720p` y el frame mide 1920×800, así que unas rutas lo llaman 1080 y otras SD.

## Specs

**S1.** La medida manda; el nombre es el respaldo. Un fichero cuyo nombre dice
`720p` y mide 1920×800 es **1080**. La medida gana también al revés: un nombre
`1080p` sobre un frame de 720 no es un 1080.

**S2.** Una sola regla por lado. Backend: `domain/resolution.py` es la única
fuente de `from_dimensions`, `from_name` y la precedencia. `media_info`,
`library_class` y `duplicates_folders` dejan de tener su copia. Frontend:
`shared/utils/resolution.ts` refleja los mismos umbrales, y quien tenga el dato
del backend (`resolution`, `libraries`) lo **lee** en vez de adivinarlo.

**S3.** Vocabulario del encabezado de Películas V2: `sin archivo`, `4K`, `3D`,
`1080`, `SD`, `otros`. `SD` es lo que la medida o el nombre sitúan **por debajo
de 1080**; `otros` es lo que no se puede demostrar (ni medido ni declarado).

**S4.** Archivos tiene sección propia `SD`, fuera de `otros`. `otros` se queda
para lo que no prueba clase (carátulas, subtítulos, nombres sin resolución).

**S5.** La fila de release enseña el chip `SD` y el `1080` se enciende con lo
medido, no con el texto del nombre.

**S6.** Una tabla de casos en `contracts/resolution-cases.json` la leen **las dos
suites**. Si un lado deriva del otro, ese lado falla en CI.

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1, S2 | inline | `360685f` (squash de #300, «una sola regla») |
| T2 | S3 | inline | `360685f` (`library_class` gana `SD`) |
| T3 | S4 | inline | `360685f` (sección SD en `PanelFiles`) |
| T4 | S5 | inline | `360685f` (chip SD en V2 y en la fila) |
| T5 | S6 | inline | `360685f` + `fix(tests)` (`contracts/resolution-cases.json`) |

Squash: los hashes de rama dejan de ser alcanzables; la evidencia apunta al
commit de `main`. El bug de paso en `route_helpers` (gateway congelado en
`None`) va en su propio commit dentro del mismo PR.

## Log

**L1** (petición literal): «he hayado un bug en Peliculas V2 y cuando vas a
detalles de una pelicula, hay que agregar el chip de SD en release cuando porque
solo esta 1080 / 4k / 3d y en archivos el archivo de SD tiene que tener una
seccion propia porque si no sale en otros. Además se esta detectando como sd
cuando realmente es 1080, por ejemplo con este archivo:
/mnt/storage/movies/es/John Wick - Chapter 3 - Parabellum (2019)/John Wick -
Chapter 3 - Parabellum (2019) Bluray-720p - h265 AC3 - [ES+EN].mkv aunque el
archivo ponga 720p, esto es erroneo ya que cuando analizas el archivo sale
1920x800(con bandas recortadas)».

**L2** (corrección): «he pensado que este problema debemos tenerlo resuelto en
otro lado, no podriamos abstraerlo como una regla?» — el arreglo del síntoma no
basta; la regla se abstrae.

**L3** (decisión): encabezado de V2 con chip `SD` propio y `otros` para lo
desconocido.

### L4 — el detalle de V2 apagaba los chips de release

Reporte del usuario: «ahora dentro de los chips de release no se "iluminan" los que hay descargados».

No era la regla: eran **dos traducciones** película → ítem de release. `rowData.catalogMovieRelease` llevaba calidad, resolución medida, nombre y ruta; `PeliculasV2List.movieRelease` —la que usa el panel de detalle— no llevaba **ninguna**, así que los cuatro chips salían apagados y el nombre del fichero decía «no disponible» sobre una película descargada. Se borra la segunda; queda una sola.

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T6 | S5 | inline | una sola traducción película → release en el detalle de V2 |
