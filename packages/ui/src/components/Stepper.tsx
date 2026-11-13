import type { ReactElement } from 'react';

export interface StepperProps {
  readonly valueLabel: string;
  readonly onDecrement: () => void;
  readonly onIncrement: () => void;
  readonly canDecrement?: boolean;
  readonly canIncrement?: boolean;
  readonly decrementLabel: string;
  readonly incrementLabel: string;
  readonly decText?: string;
  readonly incText?: string;
  readonly wide?: boolean;
}

function DisabledDashFrame(): ReactElement {
  return (
    <svg
      className="mb-eink-disabled-dash"
      width="100%"
      height="100%"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="4 4"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

export function Stepper({
  valueLabel,
  onDecrement,
  onIncrement,
  canDecrement = true,
  canIncrement = true,
  decrementLabel,
  incrementLabel,
  decText = '−',
  incText = '+',
  wide = false,
}: StepperProps): ReactElement {
  return (
    <div className={wide ? 'mb-stepper mb-stepper-wide' : 'mb-stepper'}>
      <button
        type="button"
        className="mb-stepper-btn"
        aria-label={decrementLabel}
        disabled={!canDecrement}
        onClick={onDecrement}
      >
        {!canDecrement && <DisabledDashFrame />}
        {decText}
      </button>
      <span className="mb-stepper-value">{valueLabel}</span>
      <button
        type="button"
        className="mb-stepper-btn"
        aria-label={incrementLabel}
        disabled={!canIncrement}
        onClick={onIncrement}
      >
        {!canIncrement && <DisabledDashFrame />}
        {incText}
      </button>
    </div>
  );
}
