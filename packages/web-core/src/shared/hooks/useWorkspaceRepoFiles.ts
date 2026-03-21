import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type {
  UpdateWorkspaceRepoFileRequest,
  WorkspaceRepoFileContentResponse,
  WorkspaceRepoTreeResponse,
} from '@/shared/types/workspaceFiles';

export const workspaceRepoFileKeys = {
  all: ['workspaceRepoFiles'] as const,
  tree: (workspaceId: string | undefined, repoId: string | null) =>
    ['workspaceRepoFiles', 'tree', workspaceId, repoId] as const,
  content: (
    workspaceId: string | undefined,
    repoId: string | null,
    path: string | null
  ) => ['workspaceRepoFiles', 'content', workspaceId, repoId, path] as const,
};

export function useWorkspaceRepoFileTree(
  workspaceId?: string,
  repoId?: string | null
) {
  return useQuery<WorkspaceRepoTreeResponse>({
    queryKey: workspaceRepoFileKeys.tree(workspaceId, repoId ?? null),
    queryFn: () => workspacesApi.getRepoTree(workspaceId!, repoId!),
    enabled: !!workspaceId && !!repoId,
    staleTime: 30_000,
  });
}

export function useWorkspaceRepoFileContent(
  workspaceId?: string,
  repoId?: string | null,
  path?: string | null
) {
  return useQuery<WorkspaceRepoFileContentResponse>({
    queryKey: workspaceRepoFileKeys.content(
      workspaceId,
      repoId ?? null,
      path ?? null
    ),
    queryFn: () =>
      workspacesApi.getRepoFileContent(workspaceId!, repoId!, path!),
    enabled: !!workspaceId && !!repoId && !!path,
  });
}

export function useSaveWorkspaceRepoFile(workspaceId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateWorkspaceRepoFileRequest) => {
      return workspacesApi.updateRepoFile(workspaceId!, payload);
    },
    onSuccess: (_, variables) => {
      queryClient.setQueryData<WorkspaceRepoFileContentResponse>(
        workspaceRepoFileKeys.content(
          workspaceId,
          variables.repo_id,
          variables.path
        ),
        (current) => ({
          path: variables.path,
          content: variables.content,
          size_bytes: variables.content.length,
          is_binary: current?.is_binary ?? false,
          is_too_large: false,
        })
      );
    },
  });
}
