use std::path::{Component, Path, PathBuf};

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use db::models::{repo::Repo, workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const MAX_EDITABLE_FILE_BYTES: u64 = 1_000_000;

#[derive(Debug, Deserialize)]
pub struct WorkspaceRepoTreeQuery {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceRepoFileQuery {
    pub repo_id: Uuid,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceRepoFileRequest {
    pub repo_id: Uuid,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceRepoTreeEntry {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceRepoTreeResponse {
    pub entries: Vec<WorkspaceRepoTreeEntry>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceRepoFileContentResponse {
    pub path: String,
    pub content: Option<String>,
    pub size_bytes: u64,
    pub is_binary: bool,
    pub is_too_large: bool,
}

#[derive(Debug, Serialize)]
pub struct UpdateWorkspaceRepoFileResponse {
    pub path: String,
    pub size_bytes: u64,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/tree", get(list_workspace_repo_tree))
        .route(
            "/content",
            get(get_workspace_repo_file_content).put(update_workspace_repo_file),
        )
}

pub async fn list_workspace_repo_tree(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<WorkspaceRepoTreeQuery>,
) -> Result<ResponseJson<ApiResponse<WorkspaceRepoTreeResponse>>, ApiError> {
    let repo_root = resolve_workspace_repo_root(&deployment, &workspace, query.repo_id).await?;
    let entries = build_repo_tree(&repo_root)?;

    Ok(ResponseJson(ApiResponse::success(
        WorkspaceRepoTreeResponse { entries },
    )))
}

pub async fn get_workspace_repo_file_content(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<WorkspaceRepoFileQuery>,
) -> Result<ResponseJson<ApiResponse<WorkspaceRepoFileContentResponse>>, ApiError> {
    let repo_root = resolve_workspace_repo_root(&deployment, &workspace, query.repo_id).await?;
    let relative_path = normalize_relative_path(&query.path)?;
    let target_path = resolve_existing_file_path(&repo_root, &relative_path).await?;
    let metadata = tokio::fs::metadata(&target_path).await?;

    if !metadata.is_file() {
        return Err(ApiError::BadRequest("Path is not a file".to_string()));
    }

    let size_bytes = metadata.len();
    if size_bytes > MAX_EDITABLE_FILE_BYTES {
        return Ok(ResponseJson(ApiResponse::success(
            WorkspaceRepoFileContentResponse {
                path: query.path,
                content: None,
                size_bytes,
                is_binary: false,
                is_too_large: true,
            },
        )));
    }

    let bytes = tokio::fs::read(&target_path).await?;
    let (content, is_binary) = decode_text_content(bytes);

    Ok(ResponseJson(ApiResponse::success(
        WorkspaceRepoFileContentResponse {
            path: query.path,
            content,
            size_bytes,
            is_binary,
            is_too_large: false,
        },
    )))
}

pub async fn update_workspace_repo_file(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<UpdateWorkspaceRepoFileRequest>,
) -> Result<ResponseJson<ApiResponse<UpdateWorkspaceRepoFileResponse>>, ApiError> {
    let repo_root = resolve_workspace_repo_root(&deployment, &workspace, payload.repo_id).await?;
    let relative_path = normalize_relative_path(&payload.path)?;
    let target_path = resolve_existing_file_path(&repo_root, &relative_path).await?;
    let metadata = tokio::fs::metadata(&target_path).await?;

    if !metadata.is_file() {
        return Err(ApiError::BadRequest("Path is not a file".to_string()));
    }

    tokio::fs::write(&target_path, payload.content.as_bytes()).await?;

    Ok(ResponseJson(ApiResponse::success(
        UpdateWorkspaceRepoFileResponse {
            path: payload.path,
            size_bytes: payload.content.len() as u64,
        },
    )))
}

async fn resolve_workspace_repo_root(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    repo_id: Uuid,
) -> Result<PathBuf, ApiError> {
    let pool = &deployment.db().pool;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, repo_id).await?;

    if workspace_repo.is_none() {
        return Err(ApiError::BadRequest(
            "Repository is not attached to this workspace".to_string(),
        ));
    }

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(workspace)
        .await?;
    let repo_root = Path::new(&container_ref).join(repo.name);

    Ok(repo_root)
}

fn build_repo_tree(repo_root: &Path) -> Result<Vec<WorkspaceRepoTreeEntry>, ApiError> {
    let mut entries = Vec::new();
    let mut builder = WalkBuilder::new(repo_root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");

    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(err) => {
                tracing::warn!("Skipping repo tree entry due to walk error: {}", err);
                continue;
            }
        };

        let path = entry.path();
        if path == repo_root {
            continue;
        }

        let relative_path = path
            .strip_prefix(repo_root)
            .map_err(|_| ApiError::BadRequest("Failed to resolve repo path".to_string()))?;
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let path_string = relative_path.to_string_lossy().replace('\\', "/");
        entries.push(WorkspaceRepoTreeEntry {
            path: path_string,
            is_directory: entry
                .file_type()
                .is_some_and(|file_type| file_type.is_dir()),
        });
    }

    Ok(entries)
}

fn normalize_relative_path(path: &str) -> Result<PathBuf, ApiError> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(ApiError::BadRequest(
            "Absolute paths are not allowed".to_string(),
        ));
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) | Component::ParentDir => {
                return Err(ApiError::BadRequest("Invalid file path".to_string()));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(ApiError::BadRequest("File path is required".to_string()));
    }

    Ok(normalized)
}

async fn resolve_existing_file_path(
    repo_root: &Path,
    relative_path: &Path,
) -> Result<PathBuf, ApiError> {
    let repo_root = tokio::fs::canonicalize(repo_root).await?;
    let target_path = repo_root.join(relative_path);
    let target_path = tokio::fs::canonicalize(target_path).await?;

    if !target_path.starts_with(&repo_root) {
        return Err(ApiError::Forbidden(
            "File path resolves outside the repository root".to_string(),
        ));
    }

    Ok(target_path)
}

fn decode_text_content(bytes: Vec<u8>) -> (Option<String>, bool) {
    if bytes.contains(&0) {
        return (None, true);
    }

    match String::from_utf8(bytes) {
        Ok(content) => (Some(content), false),
        Err(_) => (None, true),
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_text_content, normalize_relative_path};

    #[test]
    fn normalize_relative_path_rejects_parent_segments() {
        let err = normalize_relative_path("../secret.txt").unwrap_err();
        assert!(err.to_string().contains("Invalid file path"));
    }

    #[test]
    fn normalize_relative_path_keeps_nested_paths() {
        let path = normalize_relative_path("./src/lib.rs").unwrap();
        assert_eq!(path.to_string_lossy(), "src/lib.rs");
    }

    #[test]
    fn decode_text_content_flags_binary_files() {
        let (content, is_binary) = decode_text_content(vec![0, 159, 146, 150]);
        assert!(content.is_none());
        assert!(is_binary);
    }
}
