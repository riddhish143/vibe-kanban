'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleDashedIcon,
  DotsThreeIcon,
  PlusIcon,
  Sparkle,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { PriorityIcon, type PriorityLevel } from './PriorityIcon';
import { KanbanBadge } from './KanbanBadge';
import { KanbanAssignee, type KanbanAssigneeUser } from './KanbanAssignee';
import { PrBadge, type PrBadgeStatus } from './PrBadge';
import { Checkbox } from './Checkbox';
import {
  RelationshipBadge,
  type RelationshipDisplayType,
} from './RelationshipBadge';
import { Tooltip } from './Tooltip';
import {
  Tooltip as HoverPreview,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './RadixTooltip';

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

export interface KanbanIssueCreator {
  username: string;
  avatarUrl?: string | null;
}

export interface KanbanIssuePreview {
  title: string;
  description?: string | null;
  creator?: KanbanIssueCreator | null;
}

export interface TagEditRenderProps<TTag extends KanbanTag = KanbanTag> {
  allTags: TTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  onDeleteTag?: (tagId: string) => void;
  trigger: ReactNode;
}

export interface TagEditProps<TTag extends KanbanTag = KanbanTag> {
  allTags: TTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  onDeleteTag?: (tagId: string) => void;
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
  issueLabel?: string;
  issuePreview?: KanbanIssuePreview | null;
  title: string;
  addedLabel?: string;
  description?: string | null;
  priority: PriorityLevel | null;
  tags: KanbanTag[];
  assignees: KanbanAssigneeUser[];
  creator?: KanbanIssueCreator | null;
  pullRequests?: KanbanPullRequest[];
  relationships?: KanbanRelationship[];
  isSubIssue?: boolean;
  isLoading?: boolean;
  className?: string;
  onPriorityClick?: (e: MouseEvent) => void;
  onAssigneeClick?: (e: MouseEvent) => void;
  onMoreActionsClick?: () => void;
  onExplainClick?: (e: MouseEvent) => void;
  isSelected?: boolean;
  onSelectionChange?: (selected: boolean) => void;
  tagEditProps?: TagEditProps<TTag>;
  isMobile?: boolean;
};

export function KanbanCardContent<TTag extends KanbanTag = KanbanTag>({
  displayId,
  issueLink,
  issueLabel,
  issuePreview,
  title,
  addedLabel,
  description,
  priority,
  tags,
  assignees,
  creator,
  pullRequests = [],
  relationships = [],
  className,
  onPriorityClick,
  onAssigneeClick,
  onMoreActionsClick,
  onExplainClick,
  isSelected = false,
  onSelectionChange,
  tagEditProps,
  isMobile,
}: KanbanCardContentProps<TTag>) {
  const { t } = useTranslation('common');
  const creatorName = creator?.username?.trim() || null;
  const fallbackDisplayId = issueLabel ?? displayId;
  const issuePreviewCreatorName = issuePreview?.creator?.username?.trim() || null;
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
  const issuePreviewDescription = useMemo(() => {
    if (!issuePreview?.description) {
      return null;
    }

    const formatted = formatKanbanDescriptionPreview(issuePreview.description, {
      codeBlockLabel: t('kanban.previewCodeBlock'),
      imageLabel: t('kanban.previewImage'),
      imageWithNameLabel: (name: string) =>
        t('kanban.previewImageWithName', { name }),
      fileLabel: t('kanban.previewFile'),
      fileWithNameLabel: (name: string) =>
        t('kanban.previewFileWithName', { name }),
    });

    return formatted.length > 0 ? formatted : null;
  }, [issuePreview?.description, t]);

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

  const creatorInitial =
    creatorName?.charAt(0).toUpperCase() ??
    assignees[0]?.username?.charAt(0).toUpperCase() ??
    '?';

  const creatorAvatar = creatorName ? (
    <Tooltip content={creatorName}>
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary text-[10px] font-medium text-low ring-1 ring-background"
        aria-label={creatorName}
      >
        {creator?.avatarUrl ? (
          <img
            src={creator.avatarUrl}
            alt={creatorName}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={(event) => {
              const img = event.currentTarget;
              img.style.display = 'none';
              const fallback = img.nextElementSibling;
              if (fallback instanceof HTMLElement) {
                fallback.style.display = 'flex';
              }
            }}
          />
        ) : null}
        <span style={creator?.avatarUrl ? { display: 'none' } : undefined}>
          {creatorInitial}
        </span>
      </div>
    </Tooltip>
  ) : null;

  return (
    <div className={cn('flex flex-col gap-2 min-w-0 p-4', className)}>
      {/* Top Row: Tags + Priority (and More Actions on right) */}
      <div className="flex items-start justify-between">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
          {tagEditProps ? (
            (tagEditProps.renderTagEditor?.({
              allTags: tagEditProps.allTags,
              selectedTagIds: tagEditProps.selectedTagIds,
              onTagToggle: tagEditProps.onTagToggle,
              onCreateTag: tagEditProps.onCreateTag,
              onDeleteTag: tagEditProps.onDeleteTag,
              trigger: tagEditorTrigger,
            }) ?? tagEditorTrigger)
          ) : (
            tagsDisplay
          )}
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
        
        {(onMoreActionsClick || onExplainClick) && (
          <div className="flex items-center gap-1 shrink-0 ml-2">
            {onExplainClick && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onExplainClick(e);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  'p-1 -m-1 rounded-sm text-low hover:text-normal hover:bg-secondary shrink-0 transition-[opacity,color,background-color]',
                  isMobile ? '' : 'invisible opacity-0 group-hover:visible group-hover:opacity-100'
                )}
                aria-label="Explain issue"
                title="Explain issue"
              >
                <Sparkle className="size-icon-xs" weight="bold" />
              </button>
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
        )}
      </div>

      {/* Title */}
      <div className="flex items-start gap-2 min-w-0">
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

      {/* Description */}
      {previewDescription && (
        <p className="text-xs text-low leading-relaxed line-clamp-2 m-0 mt-0.5">
          {previewDescription}
        </p>
      )}

      {/* Footer: Assignees, Added, Links, PRs */}
      <div className="flex items-center justify-between mt-2 pt-3 border-t border-border/40">
        <div className="flex items-center gap-2">
           {creatorAvatar ? (
             creatorAvatar
           ) : onAssigneeClick ? (
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
        </div>
        
        <div className="flex items-center gap-2 flex-wrap min-w-0">
           {addedLabel && (
             <span className="text-[11px] font-medium text-low shrink-0">{addedLabel}</span>
           )}
           {issueLink ? (
             <TooltipProvider delayDuration={0}>
               <HoverPreview>
                 <TooltipTrigger asChild>
                   <a
                     href={issueLink}
                     target="_blank"
                     rel="noopener noreferrer"
                     className="font-ibm-plex-mono text-[11px] text-low hover:text-normal hover:underline transition-colors shrink-0"
                     onClick={(e) => e.stopPropagation()}
                     onMouseDown={(e) => e.stopPropagation()}
                   >
                     {fallbackDisplayId}
                   </a>
                 </TooltipTrigger>
                 <TooltipContent
                  side="top"
                  align="end"
                  sideOffset={8}
                  className="w-[320px] rounded-xl border border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur-md"
                 >
                    <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
                      <span className="font-ibm-plex-mono text-[11px] text-low">
                        {fallbackDisplayId}
                      </span>
                      <span className="text-[11px] text-low">
                        GitHub preview
                      </span>
                    </div>
                    <div className="flex flex-col gap-3 p-3">
                      {issuePreviewCreatorName && (
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary text-[11px] font-medium text-low">
                            {issuePreview?.creator?.avatarUrl ? (
                              <img
                                src={issuePreview.creator.avatarUrl}
                                alt={issuePreviewCreatorName}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                onError={(event) => {
                                  const img = event.currentTarget;
                                  img.style.display = 'none';
                                  const fallback = img.nextElementSibling;
                                  if (fallback instanceof HTMLElement) {
                                    fallback.style.display = 'flex';
                                  }
                                }}
                              />
                            ) : null}
                            <span
                              style={
                                issuePreview?.creator?.avatarUrl
                                  ? { display: 'none' }
                                  : undefined
                              }
                            >
                              {issuePreviewCreatorName.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <span className="text-sm font-medium text-normal">
                            {issuePreviewCreatorName}
                          </span>
                        </div>
                      )}
                      <div className="space-y-2">
                        <p className="text-sm font-medium leading-snug text-normal">
                          {issuePreview?.title ?? title}
                        </p>
                        {issuePreviewDescription ? (
                          <p className="line-clamp-5 text-xs leading-relaxed text-low">
                            {issuePreviewDescription}
                          </p>
                        ) : (
                          <div className="rounded-md border border-dashed border-border/70 bg-secondary/20 px-3 py-2 text-xs text-low">
                            Preview available from imported metadata.
                          </div>
                        )}
                      </div>
                    </div>
                 </TooltipContent>
               </HoverPreview>
             </TooltipProvider>
           ) : (
             <span className="font-ibm-plex-mono text-[11px] text-low shrink-0">
               {fallbackDisplayId}
             </span>
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
      </div>
    </div>
  );
}
