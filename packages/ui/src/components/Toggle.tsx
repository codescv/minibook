import type { ReactElement } from 'react';

export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly isEink: boolean;
  readonly onText?: string;
  readonly offText?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  isEink,
  onText = 'On',
  offText = 'Off',
}: ToggleProps): ReactElement {
  if (isEink) {
    return (
      <div className="mb-eink-toggle-group" role="group" aria-label={label}>
        <button
          type="button"
          className="mb-eink-toggle-btn"
          data-active={checked ? 'true' : undefined}
          aria-pressed={checked}
          onClick={() => onChange(true)}
        >
          {onText}
        </button>
        <button
          type="button"
          className="mb-eink-toggle-btn"
          data-active={!checked ? 'true' : undefined}
          aria-pressed={!checked}
          onClick={() => onChange(false)}
        >
          {offText}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="mb-switch-hit"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="mb-switch" aria-checked={checked}>
        <span className="mb-switch-knob" />
      </span>
    </button>
  );
}
