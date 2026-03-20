'use client';

import { useTranslation } from 'react-i18next';
import { LinkSimpleIcon, XIcon } from '@phosphor-icons/react';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import {
  RelationshipBadge,
  type RelationshipDisplayType,
} from './RelationshipBadge';

export interface IssueRelationshipsSectionRelationship {
  relationshipId: string;
  relatedIssueId: string;
  relatedIssueDisplayId: string;
  displayType: RelationshipDisplayType;
}

export interface IssueRelationshipsSectionProps {
  relationships: IssueRelationshipsSectionRelationship[];
  onRelationshipClick: (relatedIssueId: string) => void;
  onRemoveRelationship?: (relationshipId: string) => void;
  isLoading?: boolean;
  headerExtra?: React.ReactNode;
}

export function IssueRelationshipsSection({
  relationships,
  onRelationshipClick,
  onRemoveRelationship,
  isLoading,
  headerExtra,
}: IssueRelationshipsSectionProps) {
  const { t } = useTranslation('common');

  return (
    <CollapsibleSectionHeader
      title={t('kanban.relationships', 'Relationships')}
      persistKey="kanban-issue-relationships"
      defaultExpanded={true}
      headerExtra={headerExtra}
      titleIcon={LinkSimpleIcon}
      className="rounded-md border border-border/70 bg-panel/20"
      headerClassName="rounded-b-none"
    >
      <div className="flex flex-col gap-2 rounded-b-md bg-panel/35 p-base">
        {isLoading ? (
          <p className="text-low py-half">{t('states.loading')}</p>
        ) : relationships.length === 0 ? (
          <p className="text-low py-half">
            {t('kanban.noRelationships', 'No relationships')}
          </p>
        ) : (
          relationships.map((rel) => (
            <div
              key={rel.relationshipId}
              className="group flex items-center justify-between rounded-sm border border-border/60 bg-secondary/35 px-2 py-1.5"
            >
              <RelationshipBadge
                displayType={rel.displayType}
                relatedIssueDisplayId={rel.relatedIssueDisplayId}
                onClick={(e) => {
                  e.stopPropagation();
                  onRelationshipClick(rel.relatedIssueId);
                }}
              />
              {onRemoveRelationship && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRelationship(rel.relationshipId);
                  }}
                  className="p-half rounded-sm text-low hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
                  aria-label="Remove relationship"
                >
                  <XIcon className="size-icon-2xs" weight="bold" />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </CollapsibleSectionHeader>
  );
}
