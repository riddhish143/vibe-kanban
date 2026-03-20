import { useTranslation } from 'react-i18next';
import { FolderNotchOpenIcon } from '@phosphor-icons/react';
import {
  IssueWorkspaceCard,
  IssueWorkspaceCreateCard,
  type WorkspaceWithStats,
} from './IssueWorkspaceCard';
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from './CollapsibleSectionHeader';

export interface IssueWorkspacesSectionProps {
  workspaces: WorkspaceWithStats[];
  isLoading?: boolean;
  actions?: SectionAction[];
  onWorkspaceClick?: (localWorkspaceId: string | null) => void;
  onCreateWorkspace?: () => void;
  onUnlinkWorkspace?: (localWorkspaceId: string) => void;
  onDeleteWorkspace?: (localWorkspaceId: string) => void;
  shouldAnimateCreateButton?: boolean;
}

/**
 * View component for the workspaces section in the issue panel.
 * Displays a collapsible list of workspace cards.
 */
export function IssueWorkspacesSection({
  workspaces,
  isLoading,
  actions = [],
  onWorkspaceClick,
  onCreateWorkspace,
  onUnlinkWorkspace,
  onDeleteWorkspace,
  shouldAnimateCreateButton = false,
}: IssueWorkspacesSectionProps) {
  const { t } = useTranslation('common');

  return (
    <CollapsibleSectionHeader
      title={t('workspaces.title')}
      persistKey="kanban-issue-workspaces"
      defaultExpanded={true}
      actions={actions}
      titleIcon={FolderNotchOpenIcon}
      className="rounded-md border border-border/70 bg-panel/20"
      headerClassName="rounded-b-none"
    >
      <div className="flex flex-col gap-base rounded-b-md bg-panel/35 p-base">
        {isLoading ? (
          <p className="text-low py-half">{t('workspaces.loading')}</p>
        ) : workspaces.length === 0 ? (
          <IssueWorkspaceCreateCard
            onClick={onCreateWorkspace}
            shouldAnimateCreateButton={shouldAnimateCreateButton}
          />
        ) : (
          workspaces.map((workspace) => {
            const { localWorkspaceId } = workspace;
            return (
              <IssueWorkspaceCard
                key={workspace.id}
                workspace={workspace}
                onClick={
                  onWorkspaceClick &&
                  localWorkspaceId &&
                  workspace.isOwnedByCurrentUser
                    ? () => onWorkspaceClick(localWorkspaceId)
                    : undefined
                }
                onUnlink={
                  onUnlinkWorkspace && localWorkspaceId
                    ? () => onUnlinkWorkspace(localWorkspaceId)
                    : undefined
                }
                onDelete={
                  onDeleteWorkspace &&
                  localWorkspaceId &&
                  workspace.isOwnedByCurrentUser
                    ? () => onDeleteWorkspace(localWorkspaceId)
                    : undefined
                }
              />
            );
          })
        )}
      </div>
    </CollapsibleSectionHeader>
  );
}
