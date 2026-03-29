import type { ReactNode } from 'react';

export interface ChatAssistantMessageRenderProps {
  content: string;
  workspaceId?: string;
}

interface ChatAssistantMessageProps {
  content: string;
  workspaceId?: string;
  renderMarkdown: (props: ChatAssistantMessageRenderProps) => ReactNode;
}

export function ChatAssistantMessage({
  content,
  workspaceId,
  renderMarkdown,
}: ChatAssistantMessageProps) {
  return (
    <div className="motion-safe:animate-chat-entry-in">
      {renderMarkdown({ content, workspaceId })}
    </div>
  );
}
