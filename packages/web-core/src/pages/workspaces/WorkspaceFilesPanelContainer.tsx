import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  SpinnerIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { FileTree } from '@vibe/ui/components/FileTree';
import { IconButton } from '@vibe/ui/components/IconButton';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { Textarea } from '@vibe/ui/components/Textarea';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import {
  useSaveWorkspaceRepoFile,
  useWorkspaceRepoFileContent,
  useWorkspaceRepoFileTree,
  workspaceRepoFileKeys,
} from '@/shared/hooks/useWorkspaceRepoFiles';
import { useTheme } from '@/shared/hooks/useTheme';
import { getActualTheme } from '@/shared/lib/theme';
import { getFileIcon } from '@/shared/lib/fileTypeIcon';
import {
  filterFileTree,
  getAllFolderPaths,
  getExpandedPathsForSearch,
} from '@/shared/lib/fileTreeUtils';
import { buildWorkspaceFileTree } from '@/shared/lib/workspaceFileTreeUtils';
import { cn } from '@/shared/lib/utils';

interface WorkspaceFilesPanelContainerProps {
  workspaceId: string;
}

export function WorkspaceFilesPanelContainer({
  workspaceId,
}: WorkspaceFilesPanelContainerProps) {
  const queryClient = useQueryClient();
  const { theme } = useTheme();
  const actualTheme = getActualTheme(theme);
  const {
    repos,
    selectedRepoId,
    setSelectedRepoId,
    isLoading: isReposLoading,
  } = useWorkspaceRepo(workspaceId);
  const treeQuery = useWorkspaceRepoFileTree(workspaceId, selectedRepoId);
  const [searchQuery, setSearchQuery] = useState('');
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);
  const [selectedPathsByRepo, setSelectedPathsByRepo] = useState<
    Record<string, string | null>
  >({});
  const [collapsedPathsByRepo, setCollapsedPathsByRepo] = useState<
    Record<string, string[]>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const loadedContentsRef = useRef<Record<string, string>>({});

  const selectedPath = selectedRepoId
    ? (selectedPathsByRepo[selectedRepoId] ?? null)
    : null;
  const editorKey =
    selectedRepoId && selectedPath ? `${selectedRepoId}:${selectedPath}` : null;

  const fileContentQuery = useWorkspaceRepoFileContent(
    workspaceId,
    selectedRepoId,
    selectedPath
  );
  const saveFileMutation = useSaveWorkspaceRepoFile(workspaceId);

  const treeNodes = useMemo(
    () => buildWorkspaceFileTree(treeQuery.data?.entries ?? []),
    [treeQuery.data?.entries]
  );
  const filteredTree = useMemo(
    () => filterFileTree(treeNodes, searchQuery),
    [treeNodes, searchQuery]
  );
  const allFolderPaths = useMemo(
    () => getAllFolderPaths(treeNodes),
    [treeNodes]
  );
  const collapsedPaths = useMemo(
    () =>
      new Set(
        selectedRepoId ? (collapsedPathsByRepo[selectedRepoId] ?? []) : []
      ),
    [collapsedPathsByRepo, selectedRepoId]
  );
  const isAllExpanded = collapsedPaths.size === 0;

  const currentDraft =
    editorKey == null
      ? ''
      : (drafts[editorKey] ?? loadedContentsRef.current[editorKey] ?? '');
  const loadedContent =
    editorKey == null ? undefined : loadedContentsRef.current[editorKey];
  const isDirty =
    editorKey != null &&
    typeof loadedContent === 'string' &&
    currentDraft !== loadedContent;
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;

  useEffect(() => {
    setSearchQuery('');
  }, [selectedRepoId]);

  useEffect(() => {
    if (!selectedRepoId || !selectedPath) {
      return;
    }

    if (!treeQuery.data) {
      return;
    }

    const fileStillExists = treeQuery.data.entries.some(
      (entry) => !entry.is_directory && entry.path === selectedPath
    );

    if (!fileStillExists) {
      setSelectedPathsByRepo((current) => ({
        ...current,
        [selectedRepoId]: null,
      }));
    }
  }, [selectedPath, selectedRepoId, treeQuery.data?.entries]);

  useEffect(() => {
    if (!selectedRepoId || !searchQuery) {
      return;
    }

    setCollapsedPathsByRepo((current) => {
      const next = new Set(current[selectedRepoId] ?? []);
      for (const path of getExpandedPathsForSearch(treeNodes, searchQuery)) {
        next.delete(path);
      }

      return {
        ...current,
        [selectedRepoId]: Array.from(next),
      };
    });
  }, [searchQuery, selectedRepoId, treeNodes]);

  useEffect(() => {
    if (!editorKey) {
      return;
    }

    const nextContent = fileContentQuery.data?.content;
    if (typeof nextContent !== 'string') {
      return;
    }

    setDrafts((current) => {
      const previousLoaded = loadedContentsRef.current[editorKey];
      loadedContentsRef.current[editorKey] = nextContent;

      if (
        current[editorKey] === undefined ||
        current[editorKey] === previousLoaded
      ) {
        return {
          ...current,
          [editorKey]: nextContent,
        };
      }

      return current;
    });
  }, [editorKey, fileContentQuery.data?.content]);

  const updateCollapsedPaths = useCallback(
    (updater: (current: Set<string>) => Set<string>) => {
      if (!selectedRepoId) {
        return;
      }

      setCollapsedPathsByRepo((current) => {
        const next = updater(new Set(current[selectedRepoId] ?? []));
        return {
          ...current,
          [selectedRepoId]: Array.from(next),
        };
      });
    },
    [selectedRepoId]
  );

  const handleToggleExpand = useCallback(
    (path: string) => {
      updateCollapsedPaths((current) => {
        if (current.has(path)) {
          current.delete(path);
        } else {
          current.add(path);
        }
        return current;
      });
    },
    [updateCollapsedPaths]
  );

  const handleToggleExpandAll = useCallback(() => {
    updateCollapsedPaths(() =>
      isAllExpanded ? new Set(allFolderPaths) : new Set<string>()
    );
  }, [allFolderPaths, isAllExpanded, updateCollapsedPaths]);

  const handleSelectFile = useCallback(
    (path: string) => {
      if (!selectedRepoId) {
        return;
      }

      setSelectedPathsByRepo((current) => ({
        ...current,
        [selectedRepoId]: path,
      }));
    },
    [selectedRepoId]
  );

  const handleRepoChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setSelectedRepoId(event.target.value || null);
    },
    [setSelectedRepoId]
  );

  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      if (!editorKey) {
        return;
      }

      const nextValue = event.target.value;
      setDrafts((current) => ({
        ...current,
        [editorKey]: nextValue,
      }));
    },
    [editorKey]
  );

  const handleDiscard = useCallback(() => {
    if (!editorKey) {
      return;
    }

    setDrafts((current) => ({
      ...current,
      [editorKey]: loadedContentsRef.current[editorKey] ?? '',
    }));
  }, [editorKey]);

  const handleReload = useCallback(async () => {
    if (!editorKey || !selectedRepoId || !selectedPath) {
      return;
    }

    const result = await fileContentQuery.refetch();
    if (typeof result.data?.content !== 'string') {
      return;
    }

    loadedContentsRef.current[editorKey] = result.data.content;
    setDrafts((current) => ({
      ...current,
      [editorKey]: result.data!.content!,
    }));
    queryClient.setQueryData(
      workspaceRepoFileKeys.content(workspaceId, selectedRepoId, selectedPath),
      result.data
    );
  }, [
    editorKey,
    fileContentQuery,
    queryClient,
    selectedPath,
    selectedRepoId,
    workspaceId,
  ]);

  const handleSave = useCallback(async () => {
    if (!editorKey || !selectedRepoId || !selectedPath) {
      return;
    }

    const content = drafts[editorKey] ?? '';
    await saveFileMutation.mutateAsync({
      repo_id: selectedRepoId,
      path: selectedPath,
      content,
    });
    loadedContentsRef.current[editorKey] = content;
  }, [drafts, editorKey, saveFileMutation, selectedPath, selectedRepoId]);

  const renderFileIcon = useCallback(
    (fileName: string) => {
      const FileIcon = getFileIcon(fileName, actualTheme);
      return FileIcon ? <FileIcon size={14} /> : null;
    },
    [actualTheme]
  );

  const contentUnavailableReason = useMemo(() => {
    if (!fileContentQuery.data) {
      return null;
    }

    if (fileContentQuery.data.is_binary) {
      return 'This file looks binary and cannot be edited in the app.';
    }

    if (fileContentQuery.data.is_too_large) {
      return `This file is ${formatFileSize(
        fileContentQuery.data.size_bytes
      )} and is too large to edit inline.`;
    }

    return null;
  }, [fileContentQuery.data]);

  const hasFiles = (treeQuery.data?.entries.length ?? 0) > 0;

  return (
    <div className="flex h-full min-h-0 bg-primary">
      <div
        className={cn(
          'border-r bg-secondary transition-[width] duration-150 ease-out shrink-0 flex flex-col',
          isExplorerCollapsed ? 'w-12' : 'w-[320px]'
        )}
      >
        <div className="flex items-center gap-half border-b p-base">
          <IconButton
            icon={isExplorerCollapsed ? CaretRightIcon : CaretLeftIcon}
            aria-label={
              isExplorerCollapsed
                ? 'Expand file explorer'
                : 'Collapse file explorer'
            }
            title={
              isExplorerCollapsed
                ? 'Expand file explorer'
                : 'Collapse file explorer'
            }
            onClick={() => setIsExplorerCollapsed((current) => !current)}
          />

          {!isExplorerCollapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-sm text-normal truncate">
                {selectedRepo?.display_name ?? 'Repository files'}
              </div>
              {repos.length > 1 && (
                <select
                  className="mt-half w-full rounded border bg-primary px-base py-half text-sm text-normal focus:outline-none focus:ring-1 focus:ring-brand"
                  value={selectedRepoId ?? ''}
                  onChange={handleRepoChange}
                >
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.display_name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {!isExplorerCollapsed && (
          <div className="flex-1 min-h-0">
            {treeQuery.isLoading || isReposLoading ? (
              <div className="flex h-full items-center justify-center text-low">
                <SpinnerIcon className="size-5 animate-spin" />
              </div>
            ) : treeQuery.isError ? (
              <div className="p-base text-sm text-error">
                {treeQuery.error instanceof Error
                  ? treeQuery.error.message
                  : 'Failed to load repository files.'}
              </div>
            ) : !hasFiles && !searchQuery ? (
              <div className="p-base text-sm text-low">
                No files available for the selected repository.
              </div>
            ) : (
              <FileTree
                nodes={filteredTree}
                collapsedPaths={collapsedPaths}
                onToggleExpand={handleToggleExpand}
                selectedPath={selectedPath}
                onSelectFile={handleSelectFile}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                renderFileIcon={renderFileIcon}
                isAllExpanded={isAllExpanded}
                onToggleExpandAll={handleToggleExpandAll}
                className="h-full"
              />
            )}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-base border-b px-double py-base">
          <div className="min-w-0">
            <div className="truncate text-sm text-normal">
              {selectedPath ?? 'Select a file to open it beside the chat.'}
            </div>
            <div className="text-sm text-low">
              {selectedRepo?.display_name ?? 'No repository selected'}
              {isDirty && (
                <span className="ml-half text-brand">Unsaved changes</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-half">
            <IconButton
              icon={ArrowClockwiseIcon}
              aria-label="Reload file"
              title="Reload file"
              onClick={() => {
                void handleReload();
              }}
              disabled={!selectedPath || fileContentQuery.isLoading}
            />
            <IconButton
              icon={XIcon}
              aria-label="Discard changes"
              title="Discard changes"
              onClick={handleDiscard}
              disabled={!selectedPath || !isDirty}
            />
            <PrimaryButton
              variant={isDirty ? 'default' : 'tertiary'}
              value="Save"
              actionIcon={saveFileMutation.isPending ? 'spinner' : CheckIcon}
              onClick={() => {
                void handleSave();
              }}
              disabled={!selectedPath || !isDirty || saveFileMutation.isPending}
            />
          </div>
        </div>

        {saveFileMutation.error && (
          <div className="flex items-center gap-half border-b border-error/30 bg-error/10 px-double py-base text-sm text-error">
            <WarningCircleIcon
              className="size-icon-sm shrink-0"
              weight="fill"
            />
            <span className="truncate">
              {saveFileMutation.error instanceof Error
                ? saveFileMutation.error.message
                : 'Failed to save file.'}
            </span>
          </div>
        )}

        <div className="flex-1 min-h-0">
          {!selectedPath ? (
            <div className="flex h-full items-center justify-center px-double text-sm text-low">
              Pick any file from the explorer to view and edit it here.
            </div>
          ) : fileContentQuery.isLoading ? (
            <div className="flex h-full items-center justify-center text-low">
              <SpinnerIcon className="size-5 animate-spin" />
            </div>
          ) : fileContentQuery.isError ? (
            <div className="p-double text-sm text-error">
              {fileContentQuery.error instanceof Error
                ? fileContentQuery.error.message
                : 'Failed to load file contents.'}
            </div>
          ) : contentUnavailableReason ? (
            <div className="flex h-full items-center justify-center px-double">
              <div className="max-w-md rounded border bg-secondary p-double text-sm text-low">
                {contentUnavailableReason}
              </div>
            </div>
          ) : (
            <Textarea
              value={currentDraft}
              onChange={handleDraftChange}
              spellCheck={false}
              wrap="off"
              className="h-full min-h-0 resize-none border-0 bg-primary px-double py-double font-ibm-plex-mono text-sm text-normal focus-visible:ring-0"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
