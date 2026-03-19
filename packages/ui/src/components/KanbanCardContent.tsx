'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleDashedIcon,
  DotsThreeIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { PriorityIcon, type PriorityLevel } from './PriorityIcon';
import { KanbanBadge } from './KanbanBadge';
import { KanbanAssignee, type KanbanAssigneeUser } from './KanbanAssignee';
import { RunningDots } from './RunningDots';
import { PrBadge, type PrBadgeStatus } from './PrBadge';
import { Checkbox } from './Checkbox';
import {
  RelationshipBadge,
  type RelationshipDisplayType,
} from './RelationshipBadge';

export interface KanbanTag {
  id: string;
  name: string;
  color: string;
}

export interface KanbanRelationship {
  relationshipId: string;
  displayType: RelationshipDisplayType;
  relatedIssueDisplayId: string;
}

export interface KanbanPullRequest {
  id: string;
  number: number;
  url: string;
  status: PrBadgeStatus;
}

export interface TagEditRenderProps<TTag extends KanbanTag = KanbanTag> {
  allTags: TTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  trigger: ReactNode;
}

export interface TagEditProps<TTag extends KanbanTag = KanbanTag> {
  allTags: TTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  renderTagEditor?: (props: TagEditRenderProps<TTag>) => ReactNode;
}

const IMAGE_FILE_EXTENSION_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;

function isImageLikeAttachmentName(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) {
    return false;
  }

  return IMAGE_FILE_EXTENSION_REGEX.test(normalized);
}

function formatKanbanDescriptionPreview(
  markdown: string,
  options: {
    codeBlockLabel: string;
    imageLabel: string;
    imageWithNameLabel: (name: string) => string;
    fileLabel: string;
    fileWithNameLabel: (name: string) => string;
  }
): string {
  return markdown
    .replace(/```[\s\S]*?```/g, options.codeBlockLabel)
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, altText: string, url: string) => {
        const normalizedAlt = altText.trim();
        const normalizedUrl = url.trim();
        const isImageAttachment =
          normalizedUrl.startsWith('attachment://') &&
          isImageLikeAttachmentName(normalizedAlt);

        if (isImageAttachment) {
          return normalizedAlt
            ? options.imageWithNameLabel(normalizedAlt)
            : options.imageLabel;
        }

        return normalizedAlt
          ? options.fileWithNameLabel(normalizedAlt)
          : options.fileLabel;
      }
    )
    .replace(
      /(?<!!)\[([^\]]*)\]\((attachment:\/\/[^)]+|\.vibe-attachments\/[^)]+)\)/g,
      (_match, label: string) => {
        const normalizedLabel = label.trim();
        return normalizedLabel
          ? options.fileWithNameLabel(normalizedLabel)
          : options.fileLabel;
      }
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export type KanbanCardContentProps<TTag extends KanbanTag = KanbanTag> = {
  displayId: string;
  /** Optional URL to the external issue (e.g. GitHub). When provided, the
   * displayId is rendered as a clickable link opening in a new tab. */
  issueLink?: string;
  title: string;
  addedLabel?: string;
  description?: string | null;
  priority: PriorityLevel | null;
  tags: KanbanTag[];
  assignees: KanbanAssigneeUser[];
  pullRequests?: KanbanPullRequest[];
  relationships?: KanbanRelationship[];
  isSubIssue?: boolean;
  isLoading?: boolean;
  className?: string;
  onPriorityClick?: (e: MouseEvent) => void;
  onAssigneeClick?: (e: MouseEvent) => void;
  onMoreActionsClick?: () => void;
  isSelected?: boolean;
  onSelectionChange?: (selected: boolean) => void;
  tagEditProps?: TagEditProps<TTag>;
  isMobile?: boolean;
};

export function KanbanCardContent<TTag extends KanbanTag = KanbanTag>({
  displayId,
  issueLink,
  title,
  addedLabel,
  description,
  priority,
  tags,
  assignees,
  pullRequests = [],
  relationships = [],
  isLoading = false,
  className,
  onPriorityClick,
  onAssigneeClick,
  onMoreActionsClick,
  isSelected = false,
  onSelectionChange,
  tagEditProps,
  isMobile,
}: KanbanCardContentProps<TTag>) {
  const { t } = useTranslation('common');
  const previewDescription = useMemo(() => {
    if (!description) {
      return null;
    }

    const formatted = formatKanbanDescriptionPreview(description, {
      codeBlockLabel: t('kanban.previewCodeBlock'),
      imageLabel: t('kanban.previewImage'),
      imageWithNameLabel: (name: string) =>
        t('kanban.previewImageWithName', { name }),
      fileLabel: t('kanban.previewFile'),
      fileWithNameLabel: (name: string) =>
        t('kanban.previewFileWithName', { name }),
    });
    return formatted.length > 0 ? formatted : null;
  }, [description, t]);

  const tagsDisplay = (
    <>
      {tags.slice(0, 2).map((tag) => (
        <KanbanBadge key={tag.id} name={tag.name} color={tag.color} />
      ))}
      {tags.length > 2 && (
        <span className="text-sm text-low">+{tags.length - 2}</span>
      )}
      {tagEditProps && tags.length === 0 && (
        <PlusIcon className="size-icon-xs text-low" weight="bold" />
      )}
    </>
  );
  const tagEditorTrigger = (
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-half cursor-pointer hover:bg-secondary rounded-sm transition-colors"
    >
      {tagsDisplay}
    </button>
  );

  return (
    <div className={cn('flex flex-col gap-3 min-w-0 p-3.5', className)}>
      {/* Top Meta Row (Added Date + Actions) */}
      <div className="flex items-start justify-between">
        {addedLabel ? (
          <span className="text-xs text-low">{addedLabel}</span>
        ) : (
          <span /> // Spacer
        )}
        
        {onMoreActionsClick && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoreActionsClick();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={cn(
              'p-1 -m-1 rounded-sm text-low hover:text-normal hover:bg-secondary shrink-0 transition-[opacity,color,background-color]',
              isMobile ? '' : 'invisible opacity-0 group-hover:visible group-hover:opacity-100'
            )}
            aria-label="More actions"
            title="More actions"
          >
            <DotsThreeIcon className="size-icon-xs" weight="bold" />
          </button>
        )}
      </div>

      {/* Title & Selection */}
      <div className="flex items-start gap-2 min-w-0 -mt-1">
        {onSelectionChange && (
          <div
            className="flex shrink-0 items-center mt-1"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={onSelectionChange}
              className="border-low h-4 w-4"
            />
          </div>
        )}
        <span className="text-[15px] font-medium text-normal tracking-tight leading-snug break-words">
          {title}
        </span>
      </div>

      {/* Inner Bubble / Comment Box (Only show if there is description or assignees) */}
      {(previewDescription || assignees.length > 0) && (
        <div className="flex flex-col gap-2 bg-secondary dark:bg-[#2a2a2a] rounded-lg p-3">
          {/* Header of bubble: Assignee & Priority */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {onAssigneeClick ? (
                <button
                  type="button"
                  onClick={onAssigneeClick}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="cursor-pointer hover:bg-secondary rounded-sm transition-colors"
                >
                  <KanbanAssignee assignees={assignees} />
                </button>
              ) : (
                <KanbanAssignee assignees={assignees} />
              )}
              {assignees.length > 0 && (
                <span className="text-sm font-medium text-normal">
                  {[assignees[0].first_name, assignees[0].last_name].filter(Boolean).join(' ') || assignees[0].username || 'User'}
                </span>
              )}
            </div>

            {/* Display ID in bubble top right */}
            <div className="flex items-center gap-1 shrink-0">
              {isLoading && <RunningDots />}
              {issueLink ? (
                <a
                  href={issueLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-ibm-plex-mono text-xs text-low hover:text-normal hover:underline transition-colors"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {displayId}
                </a>
              ) : (
                <span className="font-ibm-plex-mono text-xs text-low">
                  {displayId}
                </span>
              )}

              {/* Priority Icon inline */}
              {onPriorityClick ? (
                <button
                  type="button"
                  onClick={onPriorityClick}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="flex items-center cursor-pointer hover:bg-secondary rounded-sm transition-colors ml-1"
                >
                  <PriorityIcon priority={priority} />
                  {!priority && (
                    <CircleDashedIcon
                      className="size-icon-xs text-low"
                      weight="bold"
                    />
                  )}
                </button>
              ) : (
                <div className="ml-1"><PriorityIcon priority={priority} /></div>
              )}
            </div>
          </div>

          {/* Description Body */}
          {previewDescription && (
            <p
              className={cn(
                'text-sm text-low m-0',
                isMobile
                  ? 'leading-tight line-clamp-3'
                  : 'leading-relaxed line-clamp-5'
              )}
            >
              {previewDescription}
            </p>
          )}

          {/* Timestamp inside bubble to match mockup */}
          {addedLabel && (
            <span className="text-xs text-low/60 mt-1">{addedLabel}</span>
          )}
        </div>
      )}

      {/* Row: Tags, PRs, Relationships */}
      {(tags.length > 0 ||
        tagEditProps ||
        pullRequests.length > 0 ||
        relationships.length > 0) && (
        <div className="flex items-center gap-2 flex-wrap min-w-0 mt-1">
          {tagEditProps ? (
            (tagEditProps.renderTagEditor?.({
              allTags: tagEditProps.allTags,
              selectedTagIds: tagEditProps.selectedTagIds,
              onTagToggle: tagEditProps.onTagToggle,
              onCreateTag: tagEditProps.onCreateTag,
              trigger: tagEditorTrigger,
            }) ?? tagEditorTrigger)
          ) : (
            <>
              {tags.slice(0, 2).map((tag) => (
                <KanbanBadge key={tag.id} name={tag.name} color={tag.color} />
              ))}
              {tags.length > 2 && (
                <span className="text-sm text-low">+{tags.length - 2}</span>
              )}
            </>
          )}
          {pullRequests.slice(0, 2).map((pr) => (
            <PrBadge
              key={pr.id}
              number={pr.number}
              url={pr.url}
              status={pr.status}
            />
          ))}
          {pullRequests.length > 2 && (
            <span className="text-xs text-low">+{pullRequests.length - 2}</span>
          )}
          {relationships.slice(0, 2).map((rel) => (
            <RelationshipBadge
              key={rel.relationshipId}
              displayType={rel.displayType}
              relatedIssueDisplayId={rel.relatedIssueDisplayId}
              compact
            />
          ))}
          {relationships.length > 2 && (
            <span className="text-xs text-low">
              +{relationships.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
