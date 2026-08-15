import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-bold leading-none min-w-[42px] text-center',
  {
    variants: {
      variant: {
        neutral: 'border-input bg-muted text-muted-foreground',
        ok: 'border-success/60 bg-success/15 text-success',
        fail: 'border-destructive/60 bg-destructive/15 text-destructive',
        warn: 'border-warning/60 bg-warning/15 text-warning',
        solid: 'border-transparent text-white',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Color de fondo sólido cuando `variant="solid"` (p. ej. por método HTTP). */
  solidColor?: string;
}

export function Badge({ className, variant, solidColor, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant, className }))}
      style={variant === 'solid' && solidColor ? { backgroundColor: solidColor, ...style } : style}
      {...props}
    />
  );
}
