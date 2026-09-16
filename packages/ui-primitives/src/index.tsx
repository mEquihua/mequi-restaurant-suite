import type { ButtonHTMLAttributes } from 'react';

import { tokens } from '@restaurant-suite/ui-tokens';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** A small accessible foundation for later application-specific controls. */
export function Button({ style, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      style={{
        minHeight: '44px',
        border: 0,
        borderRadius: '8px',
        padding: `${tokens.space[2]} ${tokens.space[4]}`,
        background: tokens.color.brand,
        color: tokens.color.surface,
        fontFamily: tokens.font.sans,
        fontWeight: 700,
        cursor: 'pointer',
        ...style,
      }}
    />
  );
}
