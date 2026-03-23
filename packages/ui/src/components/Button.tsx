import * as React from 'react';
import { twMerge } from 'tailwind-merge';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap font-medium ring-offset-background focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'app-control app-control-brand text-primary-foreground',
        destructive: 'app-control app-control-destructive',
        outline: 'app-control app-control-outline text-accent-foreground',
        secondary:
          'app-control app-control-secondary text-secondary-foreground',
        ghost: 'app-control app-control-ghost',
        link: 'text-normal underline-offset-4 transition-colors hover:text-high hover:underline',
        icon: 'app-control app-control-ghost app-icon-control text-muted-foreground hover:text-foreground',
      },
      size: {
        default: 'h-10 px-4 py-2 text-sm',
        xs: 'h-8 px-3 text-xs',
        sm: 'h-9 px-3.5 text-sm',
        lg: 'h-11 px-5 text-sm',
        icon: 'h-10 w-10',
      },
    },
    compoundVariants: [
      {
        variant: 'icon',
        class: 'p-0',
      },
      {
        variant: 'link',
        class: 'h-auto px-0 py-0 shadow-none',
      },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={twMerge(cn(buttonVariants({ variant, size, className })))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
