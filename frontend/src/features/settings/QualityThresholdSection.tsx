import { Field } from '../../shared/ui/Field.tsx'
import {
  RESOLUTION_CLASSES,
  RESOLUTION_LABELS,
} from '../../shared/utils/resolution.ts'

/**
 * S2 («umbral-calidad»): the threshold as a slider over the resolution
 * classes, plus a manual width in pixels that overrides it.
 *
 * A slider (not free text) keeps the default honest: every stop is a class
 * the backend can actually measure, so the rule can never be set to something
 * nobody's probe reports.
 */
export function QualityThresholdSection({
  minClass,
  minWidth,
  onClass,
  onWidth,
}: {
  minClass: string
  minWidth: number
  onClass: (value: string) => void
  onWidth: (value: number) => void
}) {
  const index = Math.max(0, RESOLUTION_CLASSES.indexOf(minClass as never))

  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor="quality-threshold-slider">
        Umbral de calidad
      </label>
      <input
        className="settings-input settings-slider"
        type="range"
        id="quality-threshold-slider"
        name="quality-threshold-slider"
        aria-label="Umbral de calidad"
        aria-valuetext={RESOLUTION_CLASSES[index]}
        min={0}
        max={RESOLUTION_CLASSES.length - 1}
        step={1}
        value={index}
        onChange={(event) => onClass(RESOLUTION_CLASSES[Number(event.target.value)])}
      />
      <div className="settings-slider-marks" aria-hidden="true">
        {RESOLUTION_CLASSES.map((name) => (
          <span key={name} className={name === minClass ? 'is-current' : ''}>
            {RESOLUTION_LABELS[name]}
          </span>
        ))}
      </div>
      <Field
        label="Ancho manual (px)"
        ariaLabel="Ancho manual (px)"
        type="number"
        value={minWidth || ''}
        placeholder="0 = usa la clase"
        onChange={(value) => onWidth(Number(value) || 0)}
      />
      {minWidth > 0 && (
        <p className="sec-tab-note">
          Con un ancho manual, ese valor manda sobre la clase elegida.
        </p>
      )}
    </div>
  )
}
