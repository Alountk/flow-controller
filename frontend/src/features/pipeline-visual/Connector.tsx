interface Props {
  flowing: boolean
}

export function Connector({ flowing }: Props) {
  return (
    <div className={`connector ${flowing ? 'flowing' : 'broken'}`}>
      <div className="connector-line" />
      {!flowing && <span className="connector-x">✕</span>}
    </div>
  )
}
