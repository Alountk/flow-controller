import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TraceStepper, stepStates } from '../../pages/TraceStepper.tsx'

type T = Parameters<typeof stepStates>[0]
const t = (stage: T['stage'], progress?: number): T => ({
  stage,
  torrent: progress === undefined ? null : ({ progress } as T['torrent']),
})

describe('stepStates', () => {
  it('marks the steps before the current one done and the rest todo', () => {
    expect(stepStates(t('downloading', 40))).toEqual(['done', 'current', 'todo', 'todo', 'todo'])
    expect(stepStates(t('importing', 100))).toEqual(['done', 'done', 'done', 'current', 'todo'])
  })

  it('completes every step once the item is sent', () => {
    expect(stepStates(t('sent'))).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('fails the import step for a blocked import', () => {
    expect(stepStates(t('import_blocked', 100))).toEqual(['done', 'done', 'done', 'fail', 'todo'])
  })

  it('fails the download step for a failed trace whose torrent never finished', () => {
    expect(stepStates(t('failed', 30))).toEqual(['done', 'fail', 'todo', 'todo', 'todo'])
  })

  it('fails the import step for a failed trace whose torrent finished', () => {
    expect(stepStates(t('failed', 100))).toEqual(['done', 'done', 'done', 'fail', 'todo'])
  })
})

describe('TraceStepper', () => {
  it('renders the five lifecycle labels in order', () => {
    render(<TraceStepper trace={t('downloading', 10)} />)
    const labels = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.sg-step-label')?.textContent)
    expect(labels).toEqual(['Buscado', 'Descargando', 'Descargado', 'Importado', 'Enviado'])
  })
})

describe('a running copy owns the live step', () => {
  it('shows Copiando as the current step with the earlier ones done', () => {
    const states = stepStates({ stage: 'import_blocked', torrent: null }, 'copying')
    expect(states).toEqual(['done', 'done', 'done', 'current', 'todo'])
  })
})
