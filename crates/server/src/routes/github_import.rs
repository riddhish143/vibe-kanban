use std::sync::OnceLock;

use axum::{
    Router,
    extract::{Json, State},
    response::Json as ResponseJson,
    routing::post,
};
use chrono::Utc;
use deployment::Deployment;
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const IMPORT_METADATA_KEY: &str = "github_import";
const TODO_STATUS_NAME: &str = "To do";

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn github_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent("vibe-kanban-server")
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build GitHub import client")
    })
}

fn clamp_github_issue_number(issue_number: i64) -> i32 {
    if issue_number > i32::MAX as i64 {
        i32::MAX
    } else if issue_number < i32::MIN as i64 {
        i32::MIN
    } else {
        issue_number as i32
    }
}

#[derive(Debug, Deserialize, TS)]
pub struct ImportGitHubIssuesRequest {
    pub project_id: Uuid,
    pub repository_url: String,
    pub page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ImportGitHubIssueFailure {
    pub github_issue_number: i32,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ImportGitHubIssuesResponse {
    pub created_count: usize,
    pub updated_count: usize,
    pub failed_count: usize,
    pub created_issue_ids: Vec<Uuid>,
    pub failures: Vec<ImportGitHubIssueFailure>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubRepoRef {
    owner: String,
    repo: String,
    issue_number: Option<i64>,
}

impl GitHubRepoRef {
    fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Deserialize)]
struct GitHubIssue {
    number: i64,
    title: String,
    body: Option<String>,
    html_url: String,
    node_id: Option<String>,
    comments_url: String,
    user: GitHubUser,
    #[serde(default)]
    pull_request: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct GitHubComment {
    body: Option<String>,
    user: GitHubUser,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubApiError {
    message: Option<String>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/github/import/issues", post(import_github_issues))
}

async fn import_github_issues(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ImportGitHubIssuesRequest>,
) -> Result<ResponseJson<ApiResponse<ImportGitHubIssuesResponse>>, ApiError> {
    let repo_ref =
        parse_github_repository_url(&payload.repository_url).map_err(ApiError::BadRequest)?;
    let github_token = {
        let config = deployment.config().read().await;
        config.github.token()
    };

    let client = deployment.remote_client()?;
    let issues_response = client.list_issues(payload.project_id).await?;
    let statuses_response = client.list_project_statuses(payload.project_id).await?;

    let target_status = resolve_target_status_id(&statuses_response.project_statuses)
        .ok_or_else(|| ApiError::BadRequest("Project has no available statuses".to_string()))?;

    let existing_imports = build_existing_import_index(&issues_response.issues);
    let mut max_sort_order = issues_response
        .issues
        .iter()
        .filter(|issue| issue.status_id == target_status)
        .map(|issue| issue.sort_order)
        .fold(0.0_f64, f64::max);

    let page_index = payload.page.unwrap_or(1);
    let (github_issues, has_more) =
        fetch_open_github_issues(&repo_ref, github_token.as_deref(), page_index).await?;

    let mut created_issue_ids = Vec::new();
    let mut updated_count = 0;
    let mut failures = Vec::new();

    for github_issue in github_issues {
        let import_key = make_import_key(&repo_ref.full_name(), github_issue.number);
        let description = build_issue_description(&repo_ref, &github_issue);
        let extension_metadata = build_extension_metadata(&repo_ref, &github_issue);

        if let Some(&existing_issue_id) = existing_imports.get(&import_key) {
            // Issue already imported — update title, description, and metadata
            // to reflect any changes made upstream on GitHub.
            if let Err(err) = client
                .update_issue(
                    existing_issue_id,
                    &api_types::UpdateIssueRequest {
                        title: Some(github_issue.title.clone()),
                        description: Some(Some(description)),
                        extension_metadata: Some(extension_metadata),
                        status_id: None,
                        priority: None,
                        start_date: None,
                        target_date: None,
                        completed_at: None,
                        sort_order: None,
                        parent_issue_id: None,
                        parent_issue_sort_order: None,
                    },
                )
                .await
            {
                failures.push(ImportGitHubIssueFailure {
                    github_issue_number: clamp_github_issue_number(github_issue.number),
                    title: github_issue.title.clone(),
                    message: format!("Failed to update existing issue: {err}"),
                });
            } else {
                updated_count += 1;
            }

            // Re-sync comments: fetch existing comments, then import any new ones
            // from GitHub that haven't been imported yet.
            let existing_comments = client
                .list_issue_comments(existing_issue_id)
                .await
                .map(|r| r.issue_comments)
                .unwrap_or_default();
            let existing_messages: std::collections::HashSet<String> = existing_comments
                .iter()
                .map(|c| c.message.clone())
                .collect();

            if let Ok(gh_comments) =
                fetch_issue_comments(&github_issue.comments_url, github_token.as_deref()).await
            {
                for comment in &gh_comments {
                    let message = build_comment_message(comment);
                    if existing_messages.contains(&message) {
                        continue;
                    }
                    if let Err(err) = client
                        .create_issue_comment(&api_types::CreateIssueCommentRequest {
                            id: None,
                            issue_id: existing_issue_id,
                            message,
                            parent_id: None,
                        })
                        .await
                    {
                        failures.push(ImportGitHubIssueFailure {
                            github_issue_number: clamp_github_issue_number(github_issue.number),
                            title: github_issue.title.clone(),
                            message: format!("Failed to sync a comment on re-import: {err}"),
                        });
                    }
                }
            }

            continue;
        }

        max_sort_order += 1.0;

        let issue_response = match client
            .create_issue(&api_types::CreateIssueRequest {
                id: None,
                project_id: payload.project_id,
                status_id: target_status,
                title: github_issue.title.clone(),
                description: Some(description),
                priority: None,
                start_date: None,
                target_date: None,
                completed_at: None,
                sort_order: max_sort_order,
                parent_issue_id: None,
                parent_issue_sort_order: None,
                extension_metadata,
            })
            .await
        {
            Ok(response) => response,
            Err(err) => {
                failures.push(ImportGitHubIssueFailure {
                    github_issue_number: clamp_github_issue_number(github_issue.number),
                    title: github_issue.title.clone(),
                    message: err.to_string(),
                });
                continue;
            }
        };

        let issue_id = issue_response.data.id;
        created_issue_ids.push(issue_id);

        let comments =
            match fetch_issue_comments(&github_issue.comments_url, github_token.as_deref()).await {
                Ok(comments) => comments,
                Err(err) => {
                    failures.push(ImportGitHubIssueFailure {
                        github_issue_number: clamp_github_issue_number(github_issue.number),
                        title: github_issue.title.clone(),
                        message: format!("Issue imported, but failed to import comments: {err}"),
                    });
                    continue;
                }
            };

        for comment in &comments {
            if let Err(err) = client
                .create_issue_comment(&api_types::CreateIssueCommentRequest {
                    id: None,
                    issue_id,
                    message: build_comment_message(comment),
                    parent_id: None,
                })
                .await
            {
                failures.push(ImportGitHubIssueFailure {
                    github_issue_number: clamp_github_issue_number(github_issue.number),
                    title: github_issue.title.clone(),
                    message: format!("Issue imported, but failed to import a comment: {err}"),
                });
            }
        }
    }

    let response = ImportGitHubIssuesResponse {
        created_count: created_issue_ids.len(),
        updated_count,
        failed_count: failures.len(),
        created_issue_ids,
        failures,
        has_more,
    };

    Ok(ResponseJson(ApiResponse::success(response)))
}

fn resolve_target_status_id(statuses: &[api_types::ProjectStatus]) -> Option<Uuid> {
    statuses
        .iter()
        .find(|status| status.name.eq_ignore_ascii_case(TODO_STATUS_NAME))
        .or_else(|| {
            statuses
                .iter()
                .filter(|status| !status.hidden)
                .min_by_key(|status| status.sort_order)
        })
        .or_else(|| statuses.iter().min_by_key(|status| status.sort_order))
        .map(|status| status.id)
}

fn make_import_key(repository: &str, issue_number: i64) -> String {
    format!("{repository}#{issue_number}")
}

/// Maps import keys to the IDs of already-imported issues so we can update
/// them when re-importing instead of skipping.
fn build_existing_import_index(
    issues: &[api_types::Issue],
) -> std::collections::HashMap<String, Uuid> {
    issues
        .iter()
        .filter_map(|issue| {
            extract_import_key(&issue.extension_metadata).map(|key| (key, issue.id))
        })
        .collect()
}

fn extract_import_key(metadata: &Value) -> Option<String> {
    let import = metadata.get(IMPORT_METADATA_KEY)?;
    let provider = import.get("provider")?.as_str()?;
    if provider != "github" {
        return None;
    }

    let repository = import.get("repository")?.as_str()?;
    let issue_number = import.get("issue_number")?.as_i64()?;
    Some(make_import_key(repository, issue_number))
}

fn build_issue_description(_repo_ref: &GitHubRepoRef, issue: &GitHubIssue) -> String {
    issue
        .body
        .as_deref()
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .unwrap_or("No description provided.")
        .to_string()
}

fn build_extension_metadata(repo_ref: &GitHubRepoRef, issue: &GitHubIssue) -> Value {
    json!({
        IMPORT_METADATA_KEY: {
            "provider": "github",
            "repository": repo_ref.full_name(),
            "issue_number": issue.number,
            "issue_node_id": issue.node_id,
            "issue_url": issue.html_url,
            "creator": {
                "username": issue.user.login,
                "avatar_url": issue.user.avatar_url,
            },
            "imported_at": Utc::now(),
        }
    })
}

fn build_comment_message(comment: &GitHubComment) -> String {
    let body = comment
        .body
        .as_deref()
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .unwrap_or("No comment body provided.");

    format!("**@{}**:\n\n{}", comment.user.login, body)
}

fn parse_github_repository_url(raw: &str) -> Result<GitHubRepoRef, String> {
    let parsed = url::Url::parse(raw.trim())
        .map_err(|_| "Enter a valid GitHub repository URL".to_string())?;

    if parsed.host_str() != Some("github.com") {
        return Err("Only github.com repository URLs are supported".to_string());
    }

    let segments: Vec<_> = parsed
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();

    if segments.len() < 2 {
        return Err("Repository URL must include both owner and repository name".to_string());
    }

    let owner = segments[0].to_string();
    let repo = segments[1].trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err("Repository URL must include both owner and repository name".to_string());
    }

    let mut issue_number = None;
    if segments.len() >= 4 && segments[2] == "issues" {
        issue_number = segments[3].parse::<i64>().ok();
    }

    Ok(GitHubRepoRef {
        owner,
        repo,
        issue_number,
    })
}

async fn fetch_open_github_issues(
    repo_ref: &GitHubRepoRef,
    github_token: Option<&str>,
    page: u32,
) -> Result<(Vec<GitHubIssue>, bool), ApiError> {
    if let Some(issue_number) = repo_ref.issue_number {
        if page > 1 {
            return Ok((Vec::new(), false));
        }

        let request = github_request(
            github_client().get(format!(
                "{GITHUB_API_BASE}/repos/{}/{}/issues/{}",
                repo_ref.owner, repo_ref.repo, issue_number
            )),
            github_token,
        );

        let issue: GitHubIssue = send_github_request(request).await?;
        return Ok((vec![issue], false));
    }

    let request = github_request(
        github_client()
            .get(format!(
                "{GITHUB_API_BASE}/repos/{}/{}/issues",
                repo_ref.owner, repo_ref.repo
            ))
            .query(&[
                ("state", "open".to_string()),
                ("per_page", "100".to_string()),
                ("page", page.to_string()),
            ]),
        github_token,
    );

    let page_items: Vec<GitHubIssue> = send_github_request(request).await?;
    let count = page_items.len();
    let issues: Vec<GitHubIssue> = page_items
        .into_iter()
        .filter(|item| item.pull_request.is_none())
        .collect();

    Ok((issues, count == 100))
}

async fn fetch_issue_comments(
    comments_url: &str,
    github_token: Option<&str>,
) -> Result<Vec<GitHubComment>, ApiError> {
    let mut page = 1;
    let mut comments = Vec::new();

    loop {
        let request = github_request(
            github_client()
                .get(comments_url)
                .query(&[("per_page", "100".to_string()), ("page", page.to_string())]),
            github_token,
        );

        let page_items: Vec<GitHubComment> = send_github_request(request).await?;
        let count = page_items.len();
        comments.extend(page_items);

        if count < 100 {
            break;
        }
        page += 1;
    }

    Ok(comments)
}

fn github_request(builder: RequestBuilder, github_token: Option<&str>) -> RequestBuilder {
    let builder = builder
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);

    if let Some(token) = github_token {
        builder.bearer_auth(token)
    } else {
        builder
    }
}

async fn send_github_request<T: for<'de> Deserialize<'de>>(
    request: RequestBuilder,
) -> Result<T, ApiError> {
    let response = request
        .send()
        .await
        .map_err(|err| ApiError::BadRequest(format!("GitHub request failed: {err}")))?;

    let status = response.status();
    if !status.is_success() {
        let error = response
            .json::<GitHubApiError>()
            .await
            .ok()
            .and_then(|body| body.message)
            .unwrap_or_else(|| "GitHub request failed".to_string());

        let message = match status {
            StatusCode::NOT_FOUND => "GitHub repository not found or inaccessible".to_string(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                format!("GitHub access denied: {error}")
            }
            _ => format!("GitHub request failed: {error}"),
        };

        return Err(ApiError::BadRequest(message));
    }

    response
        .json::<T>()
        .await
        .map_err(|err| ApiError::BadRequest(format!("Failed to parse GitHub response: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_github_repository_url() {
        let repo = parse_github_repository_url("https://github.com/example-org/sample-project")
            .expect("expected valid repo URL");

        assert_eq!(
            repo,
            GitHubRepoRef {
                owner: "example-org".to_string(),
                repo: "sample-project".to_string(),
                issue_number: None,
            }
        );
    }

    #[test]
    fn parses_valid_github_issue_url() {
        let repo =
            parse_github_repository_url("https://github.com/riddhish143/Natural-CLI/issues/12")
                .expect("expected valid repo URL");

        assert_eq!(
            repo,
            GitHubRepoRef {
                owner: "riddhish143".to_string(),
                repo: "Natural-CLI".to_string(),
                issue_number: Some(12),
            }
        );
    }

    #[test]
    fn rejects_non_github_repository_url() {
        let error = parse_github_repository_url("https://gitlab.com/example-org/sample-project")
            .expect_err("expected invalid host");

        assert_eq!(error, "Only github.com repository URLs are supported");
    }

    #[test]
    fn extracts_import_key_from_extension_metadata() {
        let metadata = json!({
            "github_import": {
                "provider": "github",
                "repository": "example-org/sample-project",
                "issue_number": 42
            }
        });

        assert_eq!(
            extract_import_key(&metadata),
            Some("example-org/sample-project#42".to_string())
        );
    }

    #[test]
    fn resolves_todo_status_before_visible_fallback() {
        let backlog_id = Uuid::new_v4();
        let todo_id = Uuid::new_v4();
        let statuses = vec![
            api_types::ProjectStatus {
                id: backlog_id,
                project_id: Uuid::new_v4(),
                name: "Backlog".to_string(),
                color: "0 0% 0%".to_string(),
                sort_order: 0,
                hidden: true,
                created_at: Utc::now(),
            },
            api_types::ProjectStatus {
                id: todo_id,
                project_id: Uuid::new_v4(),
                name: "To do".to_string(),
                color: "0 0% 0%".to_string(),
                sort_order: 10,
                hidden: false,
                created_at: Utc::now(),
            },
        ];

        assert_eq!(resolve_target_status_id(&statuses), Some(todo_id));
    }
}
