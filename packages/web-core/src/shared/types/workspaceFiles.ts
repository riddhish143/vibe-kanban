export interface WorkspaceRepoTreeEntry {
  path: string;
  is_directory: boolean;
}

export interface WorkspaceRepoTreeResponse {
  entries: WorkspaceRepoTreeEntry[];
}

export interface WorkspaceRepoFileContentResponse {
  path: string;
  content: string | null;
  size_bytes: number;
  is_binary: boolean;
  is_too_large: boolean;
}

export interface UpdateWorkspaceRepoFileRequest {
  repo_id: string;
  path: string;
  content: string;
}

export interface UpdateWorkspaceRepoFileResponse {
  path: string;
  size_bytes: number;
}
