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
      {children}
    </button>
  );
}
