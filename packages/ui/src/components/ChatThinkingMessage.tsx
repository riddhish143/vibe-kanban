import { type ReactNode, useState } from 'react';
import { ChatDotsIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';

export interface ChatThinkingMessageRenderProps {
  content: string;
  workspaceId?: string;
  className?: string;
}

interface ChatThinkingMessageProps {
  content: string;
  className?: string;
  workspaceId?: string;
  renderMarkdown: (props: ChatThinkingMessageRenderProps) => ReactNode;
}

export function ChatThinkingMessage({
  content,
  className,
  workspaceId,
  renderMarkdown,
}: ChatThinkingMessageProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={cn(
        'flex flex-col motion-safe:animate-chat-fade-in',
        'border border-border/100 bg-secondary/20 rounded-sm px-base py-base',
        className
      )}
    >
      {/* Header row - clickable to expand/collapse */}
      <div
        className="flex items-center gap-base text-sm text-low cursor-pointer group"
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        role="button"
        aria-expanded={expanded}
      >
        <span className="shrink-0 pt-0.5">
          {isHovered ? (
            <CaretRightIcon
              className={cn(
                'size-icon-base transition-transform duration-150',
                expanded && 'rotate-90'
              )}
            />
          ) : (
            <ChatDotsIcon className="size-icon-base" />
          )}
        </span>
        <span className="truncate">{t('conversation.thinking')}</span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="ml-base pt-1">
          {renderMarkdown({
            content,
            workspaceId,
            className: 'text-sm',
          })}
        </div>
      )}
    </div>
  );
}
