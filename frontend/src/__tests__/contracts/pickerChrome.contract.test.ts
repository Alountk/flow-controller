import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * El chrome del explorador viaja con el componente que lo dibuja.
 *
 * Un solo explorador en toda la app: las cinco zonas (ruta, herramientas,
 * cabecera, filas y pie) se dibujan con `FileExplorer`, así que sus estilos
 * viven en `FileExplorer.css` y en ninguna otra hoja. Tener cinco exploradores
 * distintos salió justo de lo contrario: cada pantalla se llevó su copia.
 *
 * Vitest corre desde la raíz del paquete frontend, así que las rutas resuelven
 * desde `src/`.
 */

const CHROME_CLASSES = [
  'explorer-bar',
  'explorer-crumbs',
  'explorer-toolbar',
  'explorer-head',
  'explorer-row',
  'explorer-foot',
]

// Cada componente, resuelto por el bundler: sin recorrer carpetas ni globs.
const COMPONENTS = import.meta.glob('/src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function defines(source: string, className: string): boolean {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return new RegExp(`\\.${className}(?![a-z0-9-])`).test(withoutComments)
}

describe('el chrome del explorador de archivos', () => {
  it('vive en la hoja del componente que lo dibuja, y solo ahí', () => {
    const explorer = readFileSync('src/shared/ui/FileExplorer.css', 'utf8')
    for (const className of CHROME_CLASSES) {
      expect(defines(explorer, className), `${className} en FileExplorer.css`).toBe(true)
    }

    // Ninguna otra hoja declara chrome del explorador: el día que una lo haga,
    // vuelven a existir dos exploradores con el mismo nombre.
    const sheets = import.meta.glob('/src/**/*.css', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const offenders = Object.entries(sheets)
      .filter(([path]) => !path.endsWith('FileExplorer.css'))
      .filter(([, source]) => CHROME_CLASSES.some((className) => defines(source, className)))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('solo lo dibuja quien importa el componente', () => {
    const offenders = Object.entries(COMPONENTS)
      .filter(([path]) => !path.includes('__tests__'))
      .filter(([, source]) => CHROME_CLASSES.some((className) => source.includes(className)))
      .map(([path]) => path)
      .filter((path) => !COMPONENTS[path].includes('FileExplorer'))
    expect(offenders).toEqual([])
  })
})
