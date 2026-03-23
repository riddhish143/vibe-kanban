import * as React from 'react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

interface AppBarButtonProps {
  icon?: Icon;
  label: string;
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
  children?: React.ReactNode;
}

export function AppBarButton({
  icon: IconComponent,
  label,
  isActive = false,
  onClick,
  className,
  children,
}: AppBarButtonProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'app-nav-button app-icon-control h-10 w-10 cursor-pointer',
        className
      )}
      aria-label={label}
    >
      {IconComponent && (
        <IconComponent className="size-icon-base" weight="bold" />
      )}
      {children}
    </button>
  );

  return (
    <Tooltip content={label} side="right">
      {button}
    </Tooltip>
  );
}
