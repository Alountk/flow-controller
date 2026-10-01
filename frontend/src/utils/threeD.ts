/**
 * Is this release a 3D rip?
 *
 * A **suggestion**, never a truth. Every token below is what indexers actually
 * put in the title, and the UI lets a human correct it — because that is the
 * only part a heuristic cannot get right: the release that says nothing, or
 * says something this list has not heard of.
 *
 * The tokens are bounded by word edges on purpose. `ABSORB` contains `sbs`,
 * and an unbounded substring test would file it as 3D — shipping a film to the
 * wrong folder because of a word that happens to contain five letters.
 */
const THREE_D_TOKENS = /\b(3d|hsbs|htab|sbs|3dtv)\b/i

export function looksThreeD(title: string): boolean {
  return THREE_D_TOKENS.test(title)
}
