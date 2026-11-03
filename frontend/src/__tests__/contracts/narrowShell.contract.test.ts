import { describe, it, expect } from 'vitest'

/**
 * El armazón en pantallas estrechas: dos reglas que existen pero no ganan.
 *
 * jsdom no calcula layout, así que aquí no se puede medir geometría; lo que sí
 * se puede fijar es la ESTRUCTURA que hace que el CSS se aplique, porque los
 * dos defectos que esto cubre eran invisibles a los tests y visibles a ojo:
 *
 *  - `.main` reserva 240px para el sidebar con `margin-left`. Por debajo de
 *    768px el sidebar se oculta y ese margen sobrevive: 240px de nada a la
 *    izquierda en todas las vistas (medido: el contenido arrancaba en x=272 a
 *    480px de ancho).
 *  - El `@media` que apila el raíl de Configuración se escribió ANTES de la
 *    regla base `.settings-rail { width: 320px }`. Igual especificidad: gana la
 *    última del archivo, así que la media query nunca se aplicó y el raíl
 *    seguía robándole 320px al panel (medido: panel de 176px a 480px).
 *
 * El orden de fuente es la trampa: por eso el segundo test compara POSICIONES,
 * no presencia. Una regla que está pero pierde no arregla nada.
 */

const SOURCES = import.meta.glob('/src/**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const globalCss = SOURCES['/src/styles/global.css'] ?? ''
const settingsCss = SOURCES['/src/features/settings/Settings.css'] ?? ''
const topbarCss = SOURCES['/src/app/Topbar.css'] ?? ''

/** El bloque `@media (max-width: N)` con su contenido, o cadena vacía. */
function mediaBlock(css: string, maxWidth: number): string {
  const start = css.indexOf(`@media (max-width: ${maxWidth}px)`)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

/** Declaraciones del último `.selector { … }` de un trozo de CSS. */
function rule(css: string, selector: string): string {
  return blocks(css, selector).at(-1) ?? ''
}

/** Todas las declaraciones del selector: la del archivo y las de sus `@media`. */
function blocks(css: string, selector: string): string[] {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  return [...css.matchAll(pattern)].map((match) => match[1])
}

describe('armazón por debajo de 768px', () => {
  it('no reserva el ancho del sidebar cuando lo oculta', () => {
    const narrow = mediaBlock(globalCss, 768)
    // El sidebar se oculta ahí mismo; si el margen no se repone, el contenido
    // arranca 240px a la derecha sin nada a la izquierda.
    expect(narrow).toContain('.sidebar')
    expect(rule(narrow, '.main')).toMatch(/margin-left:\s*0/)
  })

  it('no deja que las píldoras de la barra se salgan del viewport', () => {
    // `flex-shrink: 0` sin `max-width` las dejaba en 627px de ancho dentro de
    // una barra de 480: se salían por la derecha en lugar de envolver.
    const right = blocks(topbarCss, '.topbar-right').join('\n')
    expect(right).toMatch(/max-width:\s*100%/)
    expect(right).toMatch(/flex-wrap:\s*wrap/)
  })

  it('apila el raíl de Configuración con una regla que gana por orden', () => {
    // `flex-direction: column` es el apilado; `.settings-rail { width: 320px }`
    // es la regla base que lo derrotaba por venir después.
    const stacking = settingsCss.indexOf('flex-direction: column')
    const baseRail = settingsCss.indexOf('.settings-rail {')
    expect(stacking, 'falta el apilado de .settings-page').toBeGreaterThan(-1)
    expect(baseRail, 'falta la regla base de .settings-rail').toBeGreaterThan(-1)
    expect(stacking).toBeGreaterThan(baseRail)
    // Y dentro del apilado, el raíl deja de tener ancho fijo.
    const narrow = mediaBlock(settingsCss, 1024)
    expect(rule(narrow, '.settings-rail')).toMatch(/width:\s*(100%|auto)/)
  })
})
