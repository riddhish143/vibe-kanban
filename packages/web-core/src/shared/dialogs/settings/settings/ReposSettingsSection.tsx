import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isEqual } from 'lodash';
import { GitBranchIcon, PlusIcon, SpinnerIcon } from '@phosphor-icons/react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { create, useModal } from '@ebay/nice-modal-react';
import { useRepoBranches } from '@/shared/hooks/useRepoBranches';
import { useScriptPlaceholders } from '@/shared/hooks/useScriptPlaceholders';
import { useAllOrganizationProjects } from '@/shared/hooks/useAllOrganizationProjects';
import { getProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import {
  repoApi,
  ApiError,
  type RepoWorktreeInfo,
  type RepoWorktreeStatus,
  type BobShellScope,
  type SaveBobShellConfigFile,
} from '@/shared/lib/api';
import { defineModal } from '@/shared/lib/modals';
import type { Repo, UpdateRepo } from 'shared/types';
import { SearchableDropdownContainer } from '@/shared/components/ui-new/containers/SearchableDropdownContainer';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuTriggerButton,
} from '@vibe/ui/components/Dropdown';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import {
  SettingsCard,
  SettingsField,
  SettingsInput,
  SettingsTextarea,
  SettingsCheckbox,
  SettingsSaveBar,
} from './SettingsComponents';

interface RepoScriptsFormState {
  display_name: string;
  default_working_dir: string;
  default_target_branch: string;
  setup_script: string;
  parallel_setup_script: boolean;
  cleanup_script: string;
  archive_script: string;
  copy_files: string;
  dev_server_script: string;
}

function repoToFormState(repo: Repo): RepoScriptsFormState {
  return {
    display_name: repo.display_name,
    default_working_dir: repo.default_working_dir ?? '',
    default_target_branch: repo.default_target_branch ?? '',
    setup_script: repo.setup_script ?? '',
    parallel_setup_script: repo.parallel_setup_script,
    cleanup_script: repo.cleanup_script ?? '',
    archive_script: repo.archive_script ?? '',
    copy_files: repo.copy_files ?? '',
    dev_server_script: repo.dev_server_script ?? '',
  };
}

// ── Remove Repo confirmation dialog ──────────────────────────────────
interface RemoveRepoDialogProps {
  repoName: string;
}

type RemoveRepoResult = 'removed' | 'canceled';

const RemoveRepoDialogImpl = create<RemoveRepoDialogProps>(({ repoName }) => {
  const modal = useModal();
  const { t } = useTranslation(['settings', 'common']);

  const handleRemove = () => {
    modal.resolve('removed' as RemoveRepoResult);
    modal.hide();
  };

  const handleCancel = () => {
    modal.resolve('canceled' as RemoveRepoResult);
    modal.hide();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) handleCancel();
  };

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('settings:settings.repos.remove.dialogTitle', {
              name: repoName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t('settings:settings.repos.remove.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('common:buttons.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleRemove}>
            {t('settings:settings.repos.remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

const RemoveRepoDialog = defineModal<RemoveRepoDialogProps, RemoveRepoResult>(
  RemoveRepoDialogImpl
);

interface RemoveWorktreesDialogProps {
  worktrees: RepoWorktreeInfo[];
  requireForce: boolean;
}

interface RemoveWorktreesDialogResult {
  action: 'confirm' | 'cancel';
  force: boolean;
}

const RemoveWorktreesDialogImpl = create<RemoveWorktreesDialogProps>(
  ({ worktrees, requireForce }) => {
    const modal = useModal();
    const [force, setForce] = useState(requireForce);
    const displayRows = worktrees.slice(0, 5);
    const hiddenCount = Math.max(0, worktrees.length - displayRows.length);

    const handleConfirm = () => {
      modal.resolve({
        action: 'confirm',
        force,
      } satisfies RemoveWorktreesDialogResult);
      modal.hide();
    };

    const handleCancel = () => {
      modal.resolve({
        action: 'cancel',
        force: false,
      } satisfies RemoveWorktreesDialogResult);
      modal.hide();
    };

    const handleOpenChange = (open: boolean) => {
      if (!open) handleCancel();
    };

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {worktrees.length === 1
                ? 'Delete worktree?'
                : `Delete ${worktrees.length} worktrees?`}
            </DialogTitle>
            <DialogDescription>
              This removes the selected git worktrees from disk. The primary
              repository worktree cannot be removed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {displayRows.map((worktree) => (
              <div
                key={worktree.path}
                className="rounded-sm border border-border bg-secondary/40 p-2"
              >
                <p className="text-sm font-medium text-normal">
                  {worktree.branch ?? 'detached'}
                </p>
                <p className="font-mono text-xs text-low break-all">
                  {worktree.path}
                </p>
              </div>
            ))}
            {hiddenCount > 0 && (
              <p className="text-sm text-low">+ {hiddenCount} more…</p>
            )}
          </div>

          {requireForce && (
            <label className="flex items-start gap-2 rounded-sm border border-error/40 bg-error/10 p-2">
              <input
                type="checkbox"
                checked={force}
                onChange={(event) => setForce(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border bg-secondary text-brand focus:ring-brand focus:ring-offset-0"
              />
              <span className="text-sm text-normal">
                Force delete dirty/locked worktrees (`git worktree remove
                --force`).
              </span>
            </label>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={requireForce && !force}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

const RemoveWorktreesDialog = defineModal<
  RemoveWorktreesDialogProps,
  RemoveWorktreesDialogResult
>(RemoveWorktreesDialogImpl);

const WORKTREE_STATUS_PRIORITY: Record<RepoWorktreeStatus, number> = {
  locked: 0,
  dirty: 1,
  clean: 2,
};

function getWorktreeStatusBadgeClass(status: RepoWorktreeStatus): string {
  switch (status) {
    case 'locked':
      return 'border-error/50 bg-error/10 text-error';
    case 'dirty':
      return 'border-brand/50 bg-brand/10 text-brand';
    case 'clean':
    default:
      return 'border-success/50 bg-success/10 text-success';
  }
}

function formatWorktreeActivity(timestamp: string | null): string {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString();
}

const BOB_SETTINGS_TEMPLATE = `{
  "tools": {
    "allowed": [],
    "core": [
      "read_file",
      "search_files",
      "list_files",
      "execute_command"
    ],
    "exclude": []
  },
  "context": {
    "fileFiltering": {
      "respectGitIgnore": true,
      "respectBobIgnore": true
    }
  }
}`;

const BOB_CUSTOM_MODES_TEMPLATE = `customModes:
  - slug: shell-debug
    name: Shell Debugger
    description: Debug command-line issues quickly.
    roleDefinition: Focus on shell diagnosis and minimal-risk fixes.
    groups:
      - read
      - command
    whenToUse: Use for build/test/CI command failures.
    customInstructions: Ask before running destructive commands.`;

const BOBIGNORE_TEMPLATE = `# Secrets
.env
*.pem
*.key

# Build outputs
dist/
build/
target/

# Logs
*.log

# Keep sample env file
!.env.example
`;

// ── Main section ─────────────────────────────────────────────────────
interface ReposSettingsSectionProps {
  initialState?: { repoId?: string };
}

export function ReposSettingsSection({
  initialState,
}: ReposSettingsSectionProps) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();

  // Fetch all repos
  const {
    data: repos,
    isLoading: reposLoading,
    error: reposError,
  } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });

  // Selected repo state - initialize from props if provided
  const [selectedRepoId, setSelectedRepoId] = useState<string>(
    initialState?.repoId ?? ''
  );

  // Fetch branches for the selected repo
  const { data: branches = [], isLoading: branchesLoading } = useRepoBranches(
    selectedRepoId || null,
    { enabled: !!selectedRepoId }
  );

  const {
    data: repoWorktrees = [],
    isLoading: worktreesLoading,
    isFetching: worktreesFetching,
    error: worktreesError,
  } = useQuery({
    queryKey: ['repo-worktrees', selectedRepoId],
    queryFn: () => repoApi.listWorktrees(selectedRepoId),
    enabled: !!selectedRepoId,
  });

  // Add "Use current branch" option at the top of branches list
  const branchItems = useMemo(() => {
    const clearOption = {
      name: '',
      is_current: false,
      is_remote: false,
      last_commit_date: new Date(),
    };
    return [clearOption, ...branches];
  }, [branches]);

  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);

  // Form state
  const [draft, setDraft] = useState<RepoScriptsFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Get OS-appropriate script placeholders
  const placeholders = useScriptPlaceholders();

  // Linked projects: find which remote projects reference this repo
  const { data: allProjects, isLoading: projectsLoading } =
    useAllOrganizationProjects();
  const [linkedProjectNames, setLinkedProjectNames] = useState<string[]>([]);
  const [linkedProjectsLoading, setLinkedProjectsLoading] = useState(false);

  useEffect(() => {
    if (!selectedRepoId || allProjects.length === 0) {
      setLinkedProjectNames([]);
      return;
    }

    let cancelled = false;
    setLinkedProjectsLoading(true);

    (async () => {
      const names: string[] = [];
      for (const project of allProjects) {
        const defaults = await getProjectRepoDefaults(project.id);
        if (cancelled) return;
        if (defaults?.some((r) => r.repo_id === selectedRepoId)) {
          names.push(project.name);
        }
      }
      if (!cancelled) {
        setLinkedProjectNames(names);
        setLinkedProjectsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, allProjects]);

  // Check for unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !selectedRepo) return false;
    return !isEqual(draft, repoToFormState(selectedRepo));
  }, [draft, selectedRepo]);

  // Handle repo selection
  const handleRepoSelect = useCallback(
    (id: string) => {
      if (id === selectedRepoId) return;

      if (hasUnsavedChanges) {
        const confirmed = window.confirm(
          t('settings.repos.save.confirmSwitch')
        );
        if (!confirmed) return;
        setDraft(null);
        setSelectedRepo(null);
        setSuccess(false);
        setError(null);
      }

      setSelectedRepoId(id);
    },
    [hasUnsavedChanges, selectedRepoId, t]
  );

  const [removing, setRemoving] = useState(false);
  const [removingWorktrees, setRemovingWorktrees] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [worktreeFailedPaths, setWorktreeFailedPaths] = useState<string[]>([]);
  const [worktreeSearch, setWorktreeSearch] = useState('');
  const [worktreeStatusFilter, setWorktreeStatusFilter] = useState<
    'all' | RepoWorktreeStatus
  >('all');
  const [worktreeSortBy, setWorktreeSortBy] = useState<
    'activity' | 'status' | 'branch' | 'path'
  >('activity');
  const [selectedWorktreePaths, setSelectedWorktreePaths] = useState<string[]>(
    []
  );
  const [bobScope, setBobScope] = useState<BobShellScope>('project');
  const [bobShellDraftFiles, setBobShellDraftFiles] = useState<
    SaveBobShellConfigFile[]
  >([]);
  const [bobShellSaving, setBobShellSaving] = useState(false);
  const [bobShellError, setBobShellError] = useState<string | null>(null);
  const [bobShellSuccess, setBobShellSuccess] = useState<string | null>(null);
  const [newBobRuleFilePath, setNewBobRuleFilePath] = useState('');

  const selectedWorktreePathSet = useMemo(
    () => new Set(selectedWorktreePaths),
    [selectedWorktreePaths]
  );

  const {
    data: bobShellConfig,
    isLoading: bobShellLoading,
    isFetching: bobShellFetching,
    error: bobShellQueryError,
  } = useQuery({
    queryKey: ['repo-bob-shell', selectedRepoId, bobScope],
    queryFn: () => repoApi.getBobShellConfig(selectedRepoId, bobScope),
    enabled: !!selectedRepoId,
  });

  useEffect(() => {
    setSelectedWorktreePaths([]);
    setWorktreeError(null);
    setWorktreeFailedPaths([]);
    setWorktreeSearch('');
    setWorktreeStatusFilter('all');
    setWorktreeSortBy('activity');
    setBobScope('project');
    setBobShellDraftFiles([]);
    setBobShellError(null);
    setBobShellSuccess(null);
    setNewBobRuleFilePath('');
  }, [selectedRepoId]);

  useEffect(() => {
    if (!bobShellConfig) return;
    const nextFiles = bobShellConfig.files.map((file) => ({
      path: file.path,
      content: file.content ?? '',
      delete: false,
    }));
    setBobShellDraftFiles(nextFiles);
    setBobShellError(null);
  }, [bobShellConfig]);

  useEffect(() => {
    if (!repoWorktrees.length) {
      setSelectedWorktreePaths([]);
      return;
    }

    const availablePaths = new Set(
      repoWorktrees.map((worktree) => worktree.path)
    );
    setSelectedWorktreePaths((previous) =>
      previous.filter((path) => availablePaths.has(path))
    );
  }, [repoWorktrees]);

  const visibleWorktrees = useMemo(() => {
    const query = worktreeSearch.trim().toLowerCase();
    const rows = repoWorktrees.filter((worktree) => {
      if (
        worktreeStatusFilter !== 'all' &&
        worktree.status !== worktreeStatusFilter
      ) {
        return false;
      }

      if (!query) return true;
      const branch = worktree.branch?.toLowerCase() ?? '';
      return (
        branch.includes(query) || worktree.path.toLowerCase().includes(query)
      );
    });

    rows.sort((left, right) => {
      switch (worktreeSortBy) {
        case 'status':
          return (
            WORKTREE_STATUS_PRIORITY[left.status] -
            WORKTREE_STATUS_PRIORITY[right.status]
          );
        case 'branch':
          return (left.branch ?? '').localeCompare(right.branch ?? '');
        case 'path':
          return left.path.localeCompare(right.path);
        case 'activity':
        default: {
          const leftTs = left.last_activity
            ? new Date(left.last_activity).getTime()
            : 0;
          const rightTs = right.last_activity
            ? new Date(right.last_activity).getTime()
            : 0;
          return rightTs - leftTs;
        }
      }
    });

    return rows;
  }, [repoWorktrees, worktreeSearch, worktreeSortBy, worktreeStatusFilter]);

  const selectableVisiblePaths = useMemo(
    () =>
      visibleWorktrees
        .filter((worktree) => !worktree.is_primary)
        .map((worktree) => worktree.path),
    [visibleWorktrees]
  );

  const allVisibleSelected =
    selectableVisiblePaths.length > 0 &&
    selectableVisiblePaths.every((path) => selectedWorktreePathSet.has(path));

  const toggleSelectVisibleWorktrees = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedWorktreePaths((previous) =>
          Array.from(new Set([...previous, ...selectableVisiblePaths]))
        );
        return;
      }
      const visibleSet = new Set(selectableVisiblePaths);
      setSelectedWorktreePaths((previous) =>
        previous.filter((path) => !visibleSet.has(path))
      );
    },
    [selectableVisiblePaths]
  );

  const toggleSingleWorktreeSelection = useCallback((path: string) => {
    setSelectedWorktreePaths((previous) => {
      if (previous.includes(path)) {
        return previous.filter((value) => value !== path);
      }
      return [...previous, path];
    });
  }, []);

  const removeWorktreePaths = useCallback(
    async (
      paths: string[],
      options?: {
        force?: boolean;
        skipConfirmation?: boolean;
      }
    ) => {
      if (!selectedRepo || paths.length === 0) return;

      const uniquePaths = Array.from(
        new Set(paths.map((path) => path.trim()).filter(Boolean))
      );
      if (uniquePaths.length === 0) return;

      const worktreesByPath = new Map(
        repoWorktrees.map((worktree) => [worktree.path, worktree])
      );
      const selectedRows = uniquePaths
        .map((path) => worktreesByPath.get(path))
        .filter((row): row is RepoWorktreeInfo => Boolean(row));
      const requiresForce = selectedRows.some(
        (row) => row.status === 'dirty' || row.status === 'locked'
      );

      let force = options?.force ?? requiresForce;
      if (!options?.skipConfirmation) {
        const result = await RemoveWorktreesDialog.show({
          worktrees: selectedRows,
          requireForce: requiresForce,
        });
        if (!result || result.action !== 'confirm') return;
        force = result.force || requiresForce;
      }

      setRemovingWorktrees(true);
      setWorktreeError(null);

      try {
        const response = await repoApi.removeWorktrees(selectedRepo.id, {
          paths: uniquePaths,
          force,
        });
        await queryClient.invalidateQueries({
          queryKey: ['repo-worktrees', selectedRepo.id],
        });

        if (response.removed_paths.length > 0) {
          setSelectedWorktreePaths((previous) =>
            previous.filter((path) => !response.removed_paths.includes(path))
          );
        }

        const failedPaths = response.failures.map((failure) => failure.path);
        setWorktreeFailedPaths(failedPaths);

        const messageParts: string[] = [];
        if (response.failures.length > 0) {
          messageParts.push(
            `Failed to remove ${response.failures.length} worktree(s).`
          );
        }
        if (response.prune_error) {
          messageParts.push(`Prune failed: ${response.prune_error}`);
        }
        setWorktreeError(
          messageParts.length > 0 ? messageParts.join(' ') : null
        );
      } catch (err) {
        setWorktreeError(err instanceof Error ? err.message : 'Removal failed');
      } finally {
        setRemovingWorktrees(false);
      }
    },
    [queryClient, repoWorktrees, selectedRepo]
  );

  const handleRetryFailedWorktrees = useCallback(async () => {
    if (worktreeFailedPaths.length === 0) return;
    await removeWorktreePaths(worktreeFailedPaths, {
      force: true,
      skipConfirmation: true,
    });
  }, [removeWorktreePaths, worktreeFailedPaths]);

  const sortedBobShellDraftFiles = useMemo(() => {
    return [...bobShellDraftFiles].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
  }, [bobShellDraftFiles]);

  const updateBobShellFile = useCallback((path: string, content: string) => {
    setBobShellDraftFiles((previous) =>
      previous.map((file) => (file.path === path ? { ...file, content } : file))
    );
    setBobShellSuccess(null);
  }, []);

  const toggleDeleteBobShellFile = useCallback(
    (path: string, checked: boolean) => {
      setBobShellDraftFiles((previous) =>
        previous.map((file) =>
          file.path === path ? { ...file, delete: checked } : file
        )
      );
      setBobShellSuccess(null);
    },
    []
  );

  const applyTemplateToBobFile = useCallback((path: string) => {
    let template = '';
    if (path.endsWith('.bob/settings.json')) {
      template = BOB_SETTINGS_TEMPLATE;
    } else if (path.endsWith('custom_modes.yaml')) {
      template = BOB_CUSTOM_MODES_TEMPLATE;
    } else if (path.endsWith('.bobignore')) {
      template = BOBIGNORE_TEMPLATE;
    }

    if (!template) return;
    setBobShellDraftFiles((previous) =>
      previous.map((file) =>
        file.path === path
          ? { ...file, content: template, delete: false }
          : file
      )
    );
    setBobShellSuccess(null);
  }, []);

  const addBobRuleFile = useCallback(() => {
    const sanitized = newBobRuleFilePath.trim();
    if (!sanitized) return;

    if (bobShellDraftFiles.some((file) => file.path === sanitized)) {
      return;
    }

    setBobShellDraftFiles((previous) => [
      ...previous,
      { path: sanitized, content: '', delete: false },
    ]);
    setNewBobRuleFilePath('');
    setBobShellSuccess(null);
  }, [bobShellDraftFiles, newBobRuleFilePath]);

  const saveBobShellConfig = useCallback(async () => {
    if (!selectedRepo) return;

    setBobShellSaving(true);
    setBobShellError(null);
    setBobShellSuccess(null);

    try {
      const response = await repoApi.saveBobShellConfig(selectedRepo.id, {
        scope: bobScope,
        files: bobShellDraftFiles,
      });

      await queryClient.invalidateQueries({
        queryKey: ['repo-bob-shell', selectedRepo.id, bobScope],
      });

      if (response.failures.length > 0) {
        setBobShellError(
          `Some files failed: ${response.failures.map((f) => `${f.path}: ${f.message}`).join(' | ')}`
        );
      } else {
        setBobShellSuccess(
          `Saved ${response.saved_paths.length} file(s), deleted ${response.deleted_paths.length}.`
        );
      }
    } catch (err) {
      setBobShellError(
        err instanceof Error ? err.message : 'Failed to save Bob Shell config'
      );
    } finally {
      setBobShellSaving(false);
    }
  }, [bobScope, bobShellDraftFiles, queryClient, selectedRepo]);

  const handleRemoveRepo = useCallback(async () => {
    if (!selectedRepo) return;

    try {
      const result = await RemoveRepoDialog.show({
        repoName: selectedRepo.display_name,
      });
      if (result !== 'removed') return;

      setRemoving(true);
      setError(null);

      await repoApi.delete(selectedRepo.id);
      await queryClient.invalidateQueries({ queryKey: ['repos'] });
      setSelectedRepoId('');
      setSelectedRepo(null);
      setDraft(null);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      }
    } finally {
      setRemoving(false);
    }
  }, [selectedRepo, queryClient]);

  // Handle adding a new repo via folder picker
  const handleAddRepo = useCallback(async () => {
    try {
      const selectedPath = await FolderPickerDialog.show({
        title: t('settings.repos.addRepo.dialogTitle'),
        description: t('settings.repos.addRepo.dialogDescription'),
      });
      if (!selectedPath) return;

      const repo = await repoApi.register({ path: selectedPath });
      await queryClient.invalidateQueries({ queryKey: ['repos'] });
      setSelectedRepoId(repo.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('settings.repos.addRepo.error')
      );
    }
  }, [queryClient, t]);

  // Populate draft from server data
  useEffect(() => {
    if (!repos) return;

    const nextRepo = selectedRepoId
      ? repos.find((r) => r.id === selectedRepoId)
      : null;

    setSelectedRepo((prev) =>
      prev?.id === nextRepo?.id ? prev : (nextRepo ?? null)
    );

    if (!nextRepo) {
      if (!hasUnsavedChanges) setDraft(null);
      return;
    }

    if (hasUnsavedChanges) return;

    setDraft(repoToFormState(nextRepo));
  }, [repos, selectedRepoId, hasUnsavedChanges]);

  const handleSave = async () => {
    if (!draft || !selectedRepo) return;

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const updateData: UpdateRepo = {
        display_name: draft.display_name.trim() || null,
        default_working_dir: draft.default_working_dir.trim() || null,
        default_target_branch: draft.default_target_branch.trim() || null,
        setup_script: draft.setup_script.trim() || null,
        cleanup_script: draft.cleanup_script.trim() || null,
        archive_script: draft.archive_script.trim() || null,
        copy_files: draft.copy_files.trim() || null,
        parallel_setup_script: draft.parallel_setup_script,
        dev_server_script: draft.dev_server_script.trim() || null,
      };

      const updatedRepo = await repoApi.update(selectedRepo.id, updateData);
      setSelectedRepo(updatedRepo);
      setDraft(repoToFormState(updatedRepo));
      queryClient.setQueryData(['repos'], (old: Repo[] | undefined) =>
        old?.map((r) => (r.id === updatedRepo.id ? updatedRepo : r))
      );
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('settings.repos.save.error')
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!selectedRepo) return;
    setDraft(repoToFormState(selectedRepo));
  };

  const updateDraft = (updates: Partial<RepoScriptsFormState>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, ...updates };
    });
  };

  if (reposLoading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <SpinnerIcon
          className="size-icon-lg animate-spin text-brand"
          weight="bold"
        />
        <span className="text-normal">{t('settings.repos.loading')}</span>
      </div>
    );
  }

  if (reposError) {
    return (
      <div className="py-8">
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {reposError instanceof Error
            ? reposError.message
            : t('settings.repos.loadError')}
        </div>
      </div>
    );
  }

  const repoOptions =
    repos?.map((r) => ({ value: r.id, label: r.display_name })) ?? [];

  return (
    <>
      {/* Status messages */}
      {error && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-success/10 border border-success/50 rounded-sm p-4 text-success font-medium">
          {t('settings.repos.save.success')}
        </div>
      )}

      {/* Repo selector */}
      <SettingsCard
        title={t('settings.repos.title')}
        description={t('settings.repos.description')}
      >
        <SettingsField
          label={t('settings.repos.selector.label')}
          description={t('settings.repos.selector.helper')}
        >
          <div className="flex gap-2 items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <DropdownMenuTriggerButton
                  label={
                    repoOptions.find((r) => r.value === selectedRepoId)
                      ?.label || t('settings.repos.selector.placeholder')
                  }
                  className="w-full justify-between"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
                {repoOptions.length > 0 ? (
                  repoOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => handleRepoSelect(option.value)}
                    >
                      {option.label}
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    {t('settings.repos.selector.noRepos')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <PrimaryButton variant="default" onClick={handleAddRepo}>
              <PlusIcon className="size-icon-sm" weight="bold" />
              {t('common:buttons.add')}
            </PrimaryButton>
          </div>
        </SettingsField>
      </SettingsCard>

      {selectedRepo && draft && (
        <>
          {/* General settings */}
          <SettingsCard
            title={t('settings.repos.general.title')}
            description={t('settings.repos.general.description')}
          >
            <SettingsField
              label={t('settings.repos.general.displayName.label')}
              description={t('settings.repos.general.displayName.helper')}
            >
              <SettingsInput
                value={draft.display_name}
                onChange={(value) => updateDraft({ display_name: value })}
                placeholder={t(
                  'settings.repos.general.displayName.placeholder'
                )}
              />
            </SettingsField>

            <SettingsField
              label={t('settings.repos.general.path.label')}
              description=""
            >
              <div className="text-sm text-low font-mono bg-secondary px-base py-half rounded-sm">
                {selectedRepo.path}
              </div>
            </SettingsField>

            <SettingsField
              label={t('settings.repos.general.defaultWorkingDir.label')}
              description={t('settings.repos.general.defaultWorkingDir.helper')}
            >
              <SettingsInput
                value={draft.default_working_dir}
                onChange={(value) =>
                  updateDraft({ default_working_dir: value })
                }
                placeholder={t(
                  'settings.repos.general.defaultWorkingDir.placeholder'
                )}
              />
            </SettingsField>

            <SettingsField
              label={t('settings.repos.general.defaultTargetBranch.label')}
              description={t(
                'settings.repos.general.defaultTargetBranch.helper'
              )}
            >
              <SearchableDropdownContainer
                items={branchItems}
                selectedValue={draft.default_target_branch || null}
                getItemKey={(b) => b.name || '__clear__'}
                getItemLabel={(b) =>
                  b.name ||
                  t('settings.repos.general.defaultTargetBranch.useCurrent')
                }
                filterItem={(b, query) =>
                  b.name === '' ||
                  b.name.toLowerCase().includes(query.toLowerCase())
                }
                getItemBadge={(b) => (b.is_current ? 'Current' : undefined)}
                getItemIcon={null}
                onSelect={(b) => updateDraft({ default_target_branch: b.name })}
                placeholder={t(
                  'settings.repos.general.defaultTargetBranch.search'
                )}
                emptyMessage={t(
                  'settings.repos.general.defaultTargetBranch.noBranches'
                )}
                contentClassName="w-[var(--radix-dropdown-menu-trigger-width)]"
                trigger={
                  <DropdownMenuTriggerButton
                    icon={GitBranchIcon}
                    label={
                      branchesLoading
                        ? t(
                            'settings.repos.general.defaultTargetBranch.loading'
                          )
                        : draft.default_target_branch ||
                          t(
                            'settings.repos.general.defaultTargetBranch.placeholder'
                          )
                    }
                    className="w-full justify-between"
                    disabled={branchesLoading}
                  />
                }
              />
            </SettingsField>

            <div className="border-t border-primary pt-base mt-base">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-normal">
                    {t('settings.repos.remove.title')}
                  </p>
                  <p className="text-sm text-low">
                    {t('settings.repos.remove.description')}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  onClick={handleRemoveRepo}
                  disabled={removing}
                >
                  {removing && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t('settings.repos.remove.button')}
                </Button>
              </div>
            </div>
          </SettingsCard>

          <SettingsCard
            title={t('settings.repos.worktrees.title', {
              defaultValue: 'Worktree Management',
            })}
            description={t('settings.repos.worktrees.description', {
              defaultValue:
                'List and remove git worktrees for this repository.',
            })}
            headerAction={
              <Button
                variant="outline"
                onClick={() =>
                  queryClient.invalidateQueries({
                    queryKey: ['repo-worktrees', selectedRepo.id],
                  })
                }
                disabled={worktreesFetching || removingWorktrees}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${worktreesFetching ? 'animate-spin' : ''}`}
                />
                Refresh
              </Button>
            }
          >
            {worktreeError && (
              <div className="bg-error/10 border border-error/50 rounded-sm p-3 text-error text-sm space-y-2">
                <p>{worktreeError}</p>
                {worktreeFailedPaths.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={handleRetryFailedWorktrees}
                    disabled={removingWorktrees}
                  >
                    Retry Failed
                  </Button>
                )}
              </div>
            )}

            <div className="grid gap-2 md:grid-cols-3">
              <input
                value={worktreeSearch}
                onChange={(event) => setWorktreeSearch(event.target.value)}
                placeholder="Search by branch or path"
                className="w-full bg-secondary border border-foreground/20 rounded-sm px-base py-half text-sm text-high placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <select
                value={worktreeStatusFilter}
                onChange={(event) =>
                  setWorktreeStatusFilter(
                    event.target.value as 'all' | RepoWorktreeStatus
                  )
                }
                className="w-full bg-secondary border border-foreground/20 rounded-sm px-base py-half text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="all">All statuses</option>
                <option value="clean">Clean</option>
                <option value="dirty">Dirty</option>
                <option value="locked">Locked</option>
              </select>
              <select
                value={worktreeSortBy}
                onChange={(event) =>
                  setWorktreeSortBy(
                    event.target.value as
                      | 'activity'
                      | 'status'
                      | 'branch'
                      | 'path'
                  )
                }
                className="w-full bg-secondary border border-foreground/20 rounded-sm px-base py-half text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="activity">Sort by activity</option>
                <option value="status">Sort by status</option>
                <option value="branch">Sort by branch</option>
                <option value="path">Sort by path</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-low">
                Showing {visibleWorktrees.length} of {repoWorktrees.length}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 text-sm text-normal">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) =>
                      toggleSelectVisibleWorktrees(event.target.checked)
                    }
                    disabled={
                      selectableVisiblePaths.length === 0 || removingWorktrees
                    }
                    className="h-4 w-4 rounded border-border bg-secondary text-brand focus:ring-brand focus:ring-offset-0"
                  />
                  Select visible
                </label>
                <Button
                  variant="destructive"
                  onClick={() =>
                    removeWorktreePaths(selectedWorktreePaths, {
                      skipConfirmation: false,
                    })
                  }
                  disabled={
                    selectedWorktreePaths.length === 0 || removingWorktrees
                  }
                >
                  {removingWorktrees && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Selected ({selectedWorktreePaths.length})
                </Button>
              </div>
            </div>

            {worktreesLoading ? (
              <div className="flex items-center gap-2 py-half">
                <SpinnerIcon
                  className="size-icon-xs animate-spin text-low"
                  weight="bold"
                />
                <span className="text-sm text-low">Loading worktrees…</span>
              </div>
            ) : worktreesError ? (
              <div className="bg-error/10 border border-error/50 rounded-sm p-3 text-error text-sm">
                {worktreesError instanceof Error
                  ? worktreesError.message
                  : 'Failed to load worktrees'}
              </div>
            ) : visibleWorktrees.length === 0 ? (
              <p className="text-sm text-low">No worktrees found.</p>
            ) : (
              <div className="rounded-sm border border-border divide-y divide-border">
                {visibleWorktrees.map((worktree) => (
                  <div
                    key={worktree.path}
                    className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selectedWorktreePathSet.has(worktree.path)}
                        onChange={() =>
                          toggleSingleWorktreeSelection(worktree.path)
                        }
                        disabled={worktree.is_primary || removingWorktrees}
                        className="mt-0.5 h-4 w-4 rounded border-border bg-secondary text-brand focus:ring-brand focus:ring-offset-0 disabled:opacity-40"
                      />
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-normal">
                            {worktree.branch ?? 'detached'}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium ${getWorktreeStatusBadgeClass(worktree.status)}`}
                          >
                            {worktree.status}
                          </span>
                          {worktree.is_primary && (
                            <span className="inline-flex items-center rounded-sm border border-brand/40 bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                              Primary / active
                            </span>
                          )}
                        </div>
                        <p className="font-mono text-xs text-low break-all">
                          {worktree.path}
                        </p>
                        <p className="text-xs text-low">
                          Last activity:{' '}
                          {formatWorktreeActivity(worktree.last_activity)}
                        </p>
                      </div>
                    </div>

                    {!worktree.is_primary && (
                      <Button
                        variant="destructive"
                        onClick={() => removeWorktreePaths([worktree.path])}
                        disabled={removingWorktrees}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SettingsCard>

          <SettingsCard
            title="Bob Shell Setup"
            description="Configure Bob shell project/global files from one place: settings, custom modes, rules, and .bobignore."
            headerAction={
              <Button
                variant="outline"
                onClick={() =>
                  queryClient.invalidateQueries({
                    queryKey: ['repo-bob-shell', selectedRepo.id, bobScope],
                  })
                }
                disabled={bobShellFetching || bobShellSaving}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${bobShellFetching ? 'animate-spin' : ''}`}
                />
                Refresh
              </Button>
            }
          >
            <div className="grid gap-2 md:grid-cols-3">
              <select
                value={bobScope}
                onChange={(event) =>
                  setBobScope(event.target.value as BobShellScope)
                }
                className="w-full bg-secondary border border-foreground/20 rounded-sm px-base py-half text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="project">Project Scope</option>
                <option value="global">Global Scope (~/.bob)</option>
              </select>
              <input
                value={newBobRuleFilePath}
                onChange={(event) => setNewBobRuleFilePath(event.target.value)}
                placeholder={
                  bobScope === 'project'
                    ? '.bob/rules/custom.md'
                    : 'rules/custom.md'
                }
                className="w-full bg-secondary border border-foreground/20 rounded-sm px-base py-half text-sm text-high placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <Button variant="outline" onClick={addBobRuleFile}>
                Add Rule File
              </Button>
            </div>

            <div className="rounded-sm border border-brand/30 bg-brand/5 p-3 text-sm text-low">
              Precedence reminder: CLI args override project/user/system files.
              Use project scope for repo-local behavior (`.bob/*`, `.bobrules*`,
              `.bobignore`).
            </div>

            {bobShellError && (
              <div className="bg-error/10 border border-error/50 rounded-sm p-3 text-error text-sm">
                {bobShellError}
              </div>
            )}
            {bobShellSuccess && (
              <div className="bg-success/10 border border-success/50 rounded-sm p-3 text-success text-sm">
                {bobShellSuccess}
              </div>
            )}
            {bobShellQueryError && (
              <div className="bg-error/10 border border-error/50 rounded-sm p-3 text-error text-sm">
                {bobShellQueryError instanceof Error
                  ? bobShellQueryError.message
                  : 'Failed to load Bob shell config'}
              </div>
            )}

            {bobShellLoading ? (
              <div className="flex items-center gap-2 py-half">
                <SpinnerIcon
                  className="size-icon-xs animate-spin text-low"
                  weight="bold"
                />
                <span className="text-sm text-low">
                  Loading Bob shell configuration…
                </span>
              </div>
            ) : sortedBobShellDraftFiles.length === 0 ? (
              <p className="text-sm text-low">No Bob shell files discovered.</p>
            ) : (
              <div className="space-y-3">
                {sortedBobShellDraftFiles.map((file) => (
                  <div
                    key={file.path}
                    className="rounded-sm border border-border bg-secondary/20 p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-normal font-mono">
                          {file.path}
                        </p>
                        <p className="text-xs text-low">
                          {bobShellConfig?.files.find(
                            (f) => f.path === file.path
                          )?.exists
                            ? 'Existing file'
                            : 'New file'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {(file.path.endsWith('.bob/settings.json') ||
                          file.path.endsWith('custom_modes.yaml') ||
                          file.path.endsWith('.bobignore')) && (
                          <Button
                            variant="outline"
                            onClick={() => applyTemplateToBobFile(file.path)}
                          >
                            Use Template
                          </Button>
                        )}
                        <label className="inline-flex items-center gap-2 text-sm text-low">
                          <input
                            type="checkbox"
                            checked={!!file.delete}
                            onChange={(event) =>
                              toggleDeleteBobShellFile(
                                file.path,
                                event.target.checked
                              )
                            }
                            className="h-4 w-4 rounded border-border bg-secondary text-brand focus:ring-brand focus:ring-offset-0"
                          />
                          Delete
                        </label>
                      </div>
                    </div>

                    <textarea
                      value={file.content}
                      onChange={(event) =>
                        updateBobShellFile(file.path, event.target.value)
                      }
                      disabled={!!file.delete}
                      rows={Math.max(
                        6,
                        Math.min(16, file.content.split('\n').length + 2)
                      )}
                      className="w-full bg-panel border border-border rounded-sm px-base py-half text-sm text-high font-mono placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                variant="default"
                onClick={saveBobShellConfig}
                disabled={bobShellSaving || bobShellLoading}
              >
                {bobShellSaving && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save Bob Shell Files
              </Button>
            </div>
          </SettingsCard>

          {/* Linked projects (read-only) */}
          <SettingsCard
            title={t('settings.repos.linkedProjects.title')}
            description={t('settings.repos.linkedProjects.description')}
          >
            {linkedProjectsLoading || projectsLoading ? (
              <div className="flex items-center gap-2 py-half">
                <SpinnerIcon
                  className="size-icon-xs animate-spin text-low"
                  weight="bold"
                />
                <span className="text-sm text-low">
                  {t('settings.repos.linkedProjects.loading')}
                </span>
              </div>
            ) : linkedProjectNames.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {linkedProjectNames.map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center rounded-sm bg-secondary px-2 py-0.5 text-sm text-normal"
                  >
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-low">
                {t('settings.repos.linkedProjects.none')}
              </p>
            )}
          </SettingsCard>

          {/* Scripts settings */}
          <SettingsCard
            title={t('settings.repos.scripts.title')}
            description={t('settings.repos.scripts.description')}
          >
            <SettingsField
              label={t('settings.repos.scripts.devServer.label')}
              description={t('settings.repos.scripts.devServer.helper')}
            >
              <SettingsTextarea
                value={draft.dev_server_script}
                onChange={(value) => updateDraft({ dev_server_script: value })}
                placeholder={placeholders.dev}
                monospace
              />
            </SettingsField>

            <SettingsField
              label={t('settings.repos.scripts.setup.label')}
              description={t('settings.repos.scripts.setup.helper')}
            >
              <SettingsTextarea
                value={draft.setup_script}
                onChange={(value) => updateDraft({ setup_script: value })}
                placeholder={placeholders.setup}
                monospace
              />
            </SettingsField>

            <SettingsCheckbox
              id="parallel-setup-script"
              label={t('settings.repos.scripts.setup.parallelLabel')}
              description={t('settings.repos.scripts.setup.parallelHelper')}
              checked={draft.parallel_setup_script}
              onChange={(checked) =>
                updateDraft({ parallel_setup_script: checked })
              }
              disabled={!draft.setup_script.trim()}
            />

            <SettingsField
              label={t('settings.repos.scripts.cleanup.label')}
              description={t('settings.repos.scripts.cleanup.helper')}
            >
              <SettingsTextarea
                value={draft.cleanup_script}
                onChange={(value) => updateDraft({ cleanup_script: value })}
                placeholder={placeholders.cleanup}
                monospace
              />
            </SettingsField>

            <SettingsField
              label={t('settings.repos.scripts.archive.label')}
              description={t('settings.repos.scripts.archive.helper')}
            >
              <SettingsTextarea
                value={draft.archive_script}
                onChange={(value) => updateDraft({ archive_script: value })}
                placeholder={placeholders.archive}
                monospace
              />
            </SettingsField>

            <SettingsField
              label={t('settings.repos.scripts.copyFiles.label')}
              description={t('settings.repos.scripts.copyFiles.helper')}
            >
              <SettingsTextarea
                value={draft.copy_files}
                onChange={(value) => updateDraft({ copy_files: value })}
                placeholder={t('settings.repos.scripts.copyFiles.placeholder')}
                rows={3}
              />
            </SettingsField>
          </SettingsCard>

          <SettingsSaveBar
            show={hasUnsavedChanges}
            saving={saving}
            onSave={handleSave}
            onDiscard={handleDiscard}
          />
        </>
      )}
    </>
  );
}

// Alias for backwards compatibility
export { ReposSettingsSection as ReposSettingsSectionContent };
