use std::{
    collections::HashSet,
    fs,
    path::{Path as StdPath, PathBuf},
};

use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use db::models::repo::{Repo, SearchResult, UpdateRepo};
use deployment::Deployment;
use git::{GitBranch, GitCli, GitRemote, GitServiceError};
use git_host::{GitHostError, GitHostProvider, GitHostService, OpenPrInfo, ProviderKind};
use serde::{Deserialize, Serialize};
use services::services::file_search::SearchQuery;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(serde::Deserialize)]
pub struct OpenEditorRequest {
    pub editor_type: Option<String>,
    pub git_repo_path: Option<PathBuf>,
}

#[derive(Debug, serde::Serialize, ts_rs::TS)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct RegisterRepoRequest {
    pub path: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct InitRepoRequest {
    pub parent_path: String,
    pub folder_name: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct BatchRepoRequest {
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum RepoWorktreeStatus {
    Clean,
    Dirty,
    Locked,
}

#[derive(Debug, Serialize, TS)]
pub struct RepoWorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub status: RepoWorktreeStatus,
    pub is_primary: bool,
    #[ts(type = "Date | null")]
    pub last_activity: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, TS)]
pub struct RemoveRepoWorktreesRequest {
    pub paths: Vec<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Serialize, TS)]
pub struct WorktreeRemovalFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, TS)]
pub struct RemoveRepoWorktreesResponse {
    pub removed_paths: Vec<String>,
    pub failures: Vec<WorktreeRemovalFailure>,
    pub prune_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum BobShellScope {
    Project,
    Global,
}

impl Default for BobShellScope {
    fn default() -> Self {
        Self::Project
    }
}

#[derive(Debug, Deserialize, TS)]
pub struct BobShellConfigQuery {
    pub scope: Option<BobShellScope>,
}

#[derive(Debug, Serialize, TS)]
pub struct BobShellConfigFile {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Serialize, TS)]
pub struct BobShellConfigResponse {
    pub scope: BobShellScope,
    pub files: Vec<BobShellConfigFile>,
}

#[derive(Debug, Deserialize, TS)]
pub struct SaveBobShellConfigRequest {
    pub scope: BobShellScope,
    pub files: Vec<SaveBobShellConfigFile>,
}

#[derive(Debug, Deserialize, TS)]
pub struct SaveBobShellConfigFile {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub delete: bool,
}

#[derive(Debug, Serialize, TS)]
pub struct BobShellSaveFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, TS)]
pub struct SaveBobShellConfigResponse {
    pub saved_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
    pub failures: Vec<BobShellSaveFailure>,
}

fn normalized_path(path: &StdPath) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_primary_worktree_path(primary_path: &StdPath, candidate_path: &StdPath) -> bool {
    normalized_path(primary_path) == normalized_path(candidate_path)
}

fn parse_last_activity(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn sanitize_relative_path(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }

    let std_path = StdPath::new(path);
    if std_path.is_absolute() {
        return None;
    }

    let mut parts = Vec::new();
    for component in std_path.components() {
        match component {
            std::path::Component::Normal(part) => {
                parts.push(part.to_string_lossy().to_string());
            }
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn is_allowed_bob_file(scope: BobShellScope, rel_path: &str) -> bool {
    match scope {
        BobShellScope::Project => {
            rel_path == ".bob/settings.json"
                || rel_path == ".bob/custom_modes.yaml"
                || rel_path == ".bobignore"
                || rel_path == ".bobrules"
                || rel_path == ".bobrules-code"
                || rel_path.starts_with(".bob/rules/")
                || rel_path.starts_with(".bob/rules-code/")
                || rel_path.starts_with(".bob/rules-plan/")
                || rel_path.starts_with(".bob/rules-")
        }
        BobShellScope::Global => {
            rel_path == "settings.json"
                || rel_path == "custom_modes.yaml"
                || rel_path.starts_with("rules/")
        }
    }
}

fn bob_scope_root(repo_root: &StdPath, scope: BobShellScope) -> Result<PathBuf, ApiError> {
    match scope {
        BobShellScope::Project => Ok(repo_root.to_path_buf()),
        BobShellScope::Global => {
            let home = home_dir_path()
                .ok_or_else(|| ApiError::BadRequest("Home directory not found".to_string()))?;
            Ok(home.join(".bob"))
        }
    }
}

fn home_dir_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .filter(|home| !home.is_empty())
                .map(PathBuf::from)
        })
}

fn path_to_slash(path: &StdPath) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn read_text_file_lossy(path: &StdPath) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
}

fn collect_files_recursive(base_dir: &StdPath, rel_dir: &str, out: &mut Vec<String>) {
    let start = base_dir.join(rel_dir);
    if !start.exists() || !start.is_dir() {
        return;
    }

    let mut stack = vec![start];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file()
                && let Ok(relative) = path.strip_prefix(base_dir)
            {
                out.push(path_to_slash(relative));
            }
        }
    }
}

fn gather_bob_config_paths(root: &StdPath, scope: BobShellScope) -> Vec<String> {
    let mut paths = match scope {
        BobShellScope::Project => vec![
            ".bob/settings.json".to_string(),
            ".bob/custom_modes.yaml".to_string(),
            ".bobignore".to_string(),
            ".bobrules".to_string(),
            ".bobrules-code".to_string(),
        ],
        BobShellScope::Global => vec!["settings.json".to_string(), "custom_modes.yaml".to_string()],
    };

    match scope {
        BobShellScope::Project => {
            collect_files_recursive(root, ".bob/rules", &mut paths);
            collect_files_recursive(root, ".bob/rules-code", &mut paths);
            collect_files_recursive(root, ".bob/rules-plan", &mut paths);

            let bob_dir = root.join(".bob");
            if let Ok(entries) = fs::read_dir(bob_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                        continue;
                    };
                    if name.starts_with("rules-") && path.is_dir() {
                        collect_files_recursive(root, &format!(".bob/{name}"), &mut paths);
                    }
                }
            }
        }
        BobShellScope::Global => {
            collect_files_recursive(root, "rules", &mut paths);
        }
    }

    let mut uniq = HashSet::new();
    paths.retain(|p| uniq.insert(p.clone()));
    paths.sort();
    paths
}

pub async fn register_repo(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<RegisterRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .register(
            &deployment.db().pool,
            &payload.path,
            payload.display_name.as_deref(),
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn init_repo(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<InitRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .init_repo(
            &deployment.db().pool,
            deployment.git(),
            &payload.parent_path,
            &payload.folder_name,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn get_repo_branches(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<GitBranch>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let branches = deployment.git().get_all_branches(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(branches)))
}

pub async fn get_repo_remotes(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<GitRemote>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let remotes = deployment.git().list_remotes(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(remotes)))
}

pub async fn get_repos_batch(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<BatchRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::find_by_ids(&deployment.db().pool, &payload.ids).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::list_all(&deployment.db().pool).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_recent_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::list_by_recent_workspace_usage(&deployment.db().pool).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;
    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn list_repo_worktrees(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoWorktreeInfo>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let git_cli = GitCli::new();
    let worktrees = git_cli
        .list_worktrees(&repo.path)
        .map_err(|err| ApiError::GitService(GitServiceError::InvalidRepository(err.to_string())))?;

    let worktree_infos = worktrees
        .into_iter()
        .map(|worktree| {
            let worktree_path = PathBuf::from(&worktree.path);
            let is_primary = is_primary_worktree_path(&repo.path, &worktree_path);

            let status = if worktree.is_locked {
                RepoWorktreeStatus::Locked
            } else {
                match git_cli.has_changes(&worktree_path) {
                    Ok(true) => RepoWorktreeStatus::Dirty,
                    Ok(false) => RepoWorktreeStatus::Clean,
                    Err(_) => RepoWorktreeStatus::Locked,
                }
            };

            let last_activity = git_cli
                .git(&worktree_path, ["log", "-1", "--format=%cI"])
                .ok()
                .and_then(|timestamp| parse_last_activity(&timestamp));

            RepoWorktreeInfo {
                path: worktree.path,
                branch: worktree.branch,
                status,
                is_primary,
                last_activity,
            }
        })
        .collect();

    Ok(ResponseJson(ApiResponse::success(worktree_infos)))
}

pub async fn remove_repo_worktrees(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<RemoveRepoWorktreesRequest>,
) -> Result<ResponseJson<ApiResponse<RemoveRepoWorktreesResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let requested_paths: Vec<String> = payload
        .paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect();

    if requested_paths.is_empty() {
        return Ok(ResponseJson(ApiResponse::error(
            "At least one worktree path is required",
        )));
    }

    let git_cli = GitCli::new();
    let mut removed_paths = Vec::new();
    let mut failures = Vec::new();
    let mut seen = HashSet::new();

    for path in requested_paths {
        if !seen.insert(path.clone()) {
            continue;
        }

        let worktree_path = PathBuf::from(&path);
        if is_primary_worktree_path(&repo.path, &worktree_path) {
            failures.push(WorktreeRemovalFailure {
                path,
                message: "Primary worktree cannot be removed".to_string(),
            });
            continue;
        }

        match git_cli.worktree_remove(&repo.path, &worktree_path, payload.force) {
            Ok(()) => removed_paths.push(path),
            Err(err) => failures.push(WorktreeRemovalFailure {
                path,
                message: err.to_string(),
            }),
        }
    }

    let prune_error = if removed_paths.is_empty() {
        None
    } else {
        git_cli
            .worktree_prune(&repo.path)
            .err()
            .map(|err| err.to_string())
    };

    Ok(ResponseJson(ApiResponse::success(
        RemoveRepoWorktreesResponse {
            removed_paths,
            failures,
            prune_error,
        },
    )))
}

pub async fn get_repo_bob_shell_config(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<BobShellConfigQuery>,
) -> Result<ResponseJson<ApiResponse<BobShellConfigResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;
    let scope = query.scope.unwrap_or_default();
    let root = bob_scope_root(&repo.path, scope)?;

    let files = gather_bob_config_paths(&root, scope)
        .into_iter()
        .filter(|path| is_allowed_bob_file(scope, path))
        .map(|path| {
            let abs_path = root.join(&path);
            let exists = abs_path.is_file();
            let content = read_text_file_lossy(&abs_path).unwrap_or_default();
            BobShellConfigFile {
                path,
                content,
                exists,
            }
        })
        .collect();

    Ok(ResponseJson(ApiResponse::success(BobShellConfigResponse {
        scope,
        files,
    })))
}

pub async fn save_repo_bob_shell_config(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<SaveBobShellConfigRequest>,
) -> Result<ResponseJson<ApiResponse<SaveBobShellConfigResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let root = bob_scope_root(&repo.path, payload.scope)?;
    let mut seen = HashSet::new();
    let mut saved_paths = Vec::new();
    let mut deleted_paths = Vec::new();
    let mut failures = Vec::new();

    for file in payload.files {
        let Some(rel_path) = sanitize_relative_path(&file.path) else {
            failures.push(BobShellSaveFailure {
                path: file.path,
                message: "Invalid relative path".to_string(),
            });
            continue;
        };

        if !seen.insert(rel_path.clone()) {
            continue;
        }

        if !is_allowed_bob_file(payload.scope, &rel_path) {
            failures.push(BobShellSaveFailure {
                path: rel_path,
                message: "Path is not allowed for Bob Shell configuration".to_string(),
            });
            continue;
        }

        let abs_path = root.join(&rel_path);
        if file.delete {
            match fs::remove_file(&abs_path) {
                Ok(()) => deleted_paths.push(rel_path),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => failures.push(BobShellSaveFailure {
                    path: rel_path,
                    message: err.to_string(),
                }),
            }
            continue;
        }

        if let Some(parent) = abs_path.parent()
            && let Err(err) = fs::create_dir_all(parent)
        {
            failures.push(BobShellSaveFailure {
                path: rel_path,
                message: err.to_string(),
            });
            continue;
        }

        match fs::write(&abs_path, file.content) {
            Ok(()) => saved_paths.push(rel_path),
            Err(err) => failures.push(BobShellSaveFailure {
                path: rel_path,
                message: err.to_string(),
            }),
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        SaveBobShellConfigResponse {
            saved_paths,
            deleted_paths,
            failures,
        },
    )))
}

pub async fn update_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<UpdateRepo>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = Repo::update(&deployment.db().pool, repo_id, &payload).await?;
    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn open_repo_in_editor(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<Option<OpenEditorRequest>>,
) -> Result<ResponseJson<ApiResponse<OpenEditorResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let editor_config = {
        let config = deployment.config().read().await;
        let editor_type_str = payload.as_ref().and_then(|req| req.editor_type.as_deref());
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(&repo.path).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for repo {} at path: {}{}",
                repo_id,
                repo.path.to_string_lossy(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            deployment
                .track_if_analytics_allowed(
                    "repo_editor_opened",
                    serde_json::json!({
                        "repo_id": repo_id.to_string(),
                        "editor_type": payload.as_ref().and_then(|req| req.editor_type.as_ref()),
                        "remote_mode": url.is_some(),
                    }),
                )
                .await;

            Ok(ResponseJson(ApiResponse::success(OpenEditorResponse {
                url,
            })))
        }
        Err(e) => {
            tracing::error!("Failed to open editor for repo {}: {:?}", repo_id, e);
            Err(ApiError::EditorOpen(e))
        }
    }
}

pub async fn search_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(search_query): Query<SearchQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<SearchResult>>>, StatusCode> {
    if search_query.q.trim().is_empty() {
        return Ok(ResponseJson(ApiResponse::error(
            "Query parameter 'q' is required and cannot be empty",
        )));
    }

    let repo = match deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await
    {
        Ok(repo) => repo,
        Err(e) => {
            tracing::error!("Failed to get repo {}: {}", repo_id, e);
            return Err(StatusCode::NOT_FOUND);
        }
    };

    match deployment
        .file_search_cache()
        .search_repo(&repo.path, &search_query.q, search_query.mode)
        .await
    {
        Ok(results) => Ok(ResponseJson(ApiResponse::success(results))),
        Err(e) => {
            tracing::error!("Failed to search files in repo {}: {}", repo_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ListPrsError {
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
}

#[derive(Debug, Deserialize)]
pub struct ListPrsQuery {
    pub remote: Option<String>,
}

pub async fn list_open_prs(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<ListPrsQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<OpenPrInfo>, ListPrsError>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let remote = match query.remote {
        Some(name) => GitRemote {
            url: deployment.git().get_remote_url(&repo.path, &name)?,
            name,
        },
        None => deployment.git().get_default_remote(&repo.path)?,
    };

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                ListPrsError::UnsupportedProvider,
            )));
        }
        Err(e) => {
            tracing::error!("Failed to create git host service: {}", e);
            return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
        }
    };

    match git_host.list_open_prs(&repo.path, &remote.url).await {
        Ok(prs) => Ok(ResponseJson(ApiResponse::success(prs))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(ListPrsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(message)) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::AuthFailed { message },
        ))),
        Err(GitHostError::UnsupportedProvider) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::UnsupportedProvider,
        ))),
        Err(e) => {
            tracing::error!("Failed to list open PRs for repo {}: {}", repo_id, e);
            Ok(ResponseJson(ApiResponse::error(&e.to_string())))
        }
    }
}

#[derive(Debug, Serialize, TS)]
pub struct DeleteRepoConflict {
    pub message: String,
    pub workspaces: Vec<String>,
}

pub async fn delete_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<
    (
        StatusCode,
        ResponseJson<ApiResponse<(), DeleteRepoConflict>>,
    ),
    ApiError,
> {
    let active = Repo::active_workspace_names(&deployment.db().pool, repo_id).await?;
    if !active.is_empty() {
        return Ok((
            StatusCode::CONFLICT,
            ResponseJson(ApiResponse::error_with_data(DeleteRepoConflict {
                message: format!("Repository is used by {} active workspace(s)", active.len()),
                workspaces: active,
            })),
        ));
    }

    Repo::delete(&deployment.db().pool, repo_id).await?;
    Ok((StatusCode::OK, ResponseJson(ApiResponse::success(()))))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/repos", get(get_repos).post(register_repo))
        .route("/repos/recent", get(get_recent_repos))
        .route("/repos/init", post(init_repo))
        .route("/repos/batch", post(get_repos_batch))
        .route(
            "/repos/{repo_id}",
            get(get_repo).put(update_repo).delete(delete_repo),
        )
        .route("/repos/{repo_id}/branches", get(get_repo_branches))
        .route("/repos/{repo_id}/remotes", get(get_repo_remotes))
        .route("/repos/{repo_id}/prs", get(list_open_prs))
        .route("/repos/{repo_id}/worktrees", get(list_repo_worktrees))
        .route(
            "/repos/{repo_id}/worktrees/remove",
            post(remove_repo_worktrees),
        )
        .route(
            "/repos/{repo_id}/bob-shell/config",
            get(get_repo_bob_shell_config).put(save_repo_bob_shell_config),
        )
        .route("/repos/{repo_id}/search", get(search_repo))
        .route("/repos/{repo_id}/open-editor", post(open_repo_in_editor))
}
