import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly active?: boolean;
  readonly children: ReactNode;
}

export function IconButton({
  label,
  active = false,
  className,
  children,
  ...rest
}: IconButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={className ? `mb-icon-btn ${className}` : 'mb-icon-btn'}
      aria-label={label}
      data-active={active ? 'true' : undefined}
      {...rest}
    >
      {rest.disabled && (
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
      )}
      {children}
    </button>
  );
}
