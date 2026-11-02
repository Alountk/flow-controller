import { Calendar } from '../features/calendar/Calendar.tsx'
import './Sections.css'

/**
 * Estrenos: the release calendar as its own page.
 *
 * It asks for BOTH types (no `type` prop), so movies and series episodes share
 * one range and one cache entry — the same behaviour the Calendario page had
 * before it lived inside the Películas/Series sub-view tabs. Making it a page
 * of its own is what lets those tabs go away without losing the calendar.
 *
 * The per-item action panel (release search for a card) is deliberately not
 * here yet: it arrives with the rest of the V2 migration.
 */
export function Estrenos() {
  return (
    <section className="section-shell sec-estrenos">
      <Calendar />
    </section>
  )
}
