/**
 * Minimal ambient typing for node:fs.
 *
 * The frontend package does not depend on @types/node, and the CSS contract
 * test only needs a synchronous utf8 file read. Declared here (inside the
 * test surface) so `tsc -b --noEmit` stays green without new dependencies.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}
