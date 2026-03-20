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
        'inline-flex items-center justify-center gap-1.5',
        'h-5 min-w-[20px] px-2',
        'bg-secondary/60 rounded-full border border-border/20',
        'text-[10px] text-normal font-bold tracking-tight',
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
