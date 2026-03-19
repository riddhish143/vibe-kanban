'use client';

import { cn } from '../lib/cn';

export type KanbanBadgeProps = {
  name: string;
  color?: string;
  className?: string;
};

export const KanbanBadge = ({ name, color, className }: KanbanBadgeProps) => {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center',
        'h-[22px] px-2 gap-1.5',
        'bg-secondary/40 rounded-full border border-border/10',
        'text-[11px] text-normal font-medium tracking-wide',
        'whitespace-nowrap',
        className
      )}
    >
      {color && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: `hsl(${color})` }}
        />
      )}
      {name}
    </span>
  );
};
