import { WarningCircleIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';

interface ChatErrorMessageProps {
  content: string;
  className?: string;
  expanded?: boolean;
  onToggle?: () => void;
}

export function ChatErrorMessage({
  content,
  className,
  expanded,
  onToggle,
}: ChatErrorMessageProps) {
  return (
    <div
      className={cn(
        'motion-safe:animate-chat-entry-in',
        'flex items-start gap-base text-sm text-error cursor-pointer',
        'border border-error/50 bg-error/5 rounded-sm px-double py-base',
        className
      )}
      onClick={onToggle}
      role="button"
    >
      <WarningCircleIcon className="shrink-0 size-icon-base pt-0.5" />
      <span
        className={cn(
          !expanded && 'truncate',
          expanded && 'whitespace-pre-wrap break-all'
        )}
      >
        {content}
      </span>
    </div>
  );
}
