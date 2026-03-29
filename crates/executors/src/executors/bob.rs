use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use async_trait::async_trait;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::Command};
use ts_rs::TS;
use workspace_utils::{
    command_ext::GroupSpawnNoWindowExt, diff::create_unified_diff, msg_store::MsgStore,
};

use crate::{
    command::{CmdOverrides, CommandBuildError, CommandBuilder, apply_overrides},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, SlashCommandDescription,
        SpawnedChild, StandardCodingAgentExecutor,
    },
    logs::{
        ActionType, CommandRunResult, FileChange, NormalizedEntry, NormalizedEntryError,
        NormalizedEntryType, TokenUsageInfo, ToolResult, ToolStatus,
        stderr_processor::normalize_stderr_logs,
        utils::{
            EntryIndexProvider,
            patch::{add_normalized_entry, replace_normalized_entry},
            shell_command_parsing::CommandCategory,
        },
    },
    model_selector::{AgentInfo, ModelSelectorConfig, PermissionPolicy},
    profile::ExecutorConfig,
};

const DEFAULT_RUNTIME_CHAT_MODE: &str = "advanced";
const DEFAULT_APPROVAL_MODE: &str = "default";
const BOB_TOOL_CONTROL_TAGS: &[&str] = &[
    "attempt_completion",
    "command",
    "execute_command",
    "read_file",
    "search_file_content",
    "write_to_file",
    "apply_diff",
    "replace_regex",
    "search_and_replace",
    "insert_content",
    "ask_followup_question",
    "update_todo_list",
    "switch_mode",
];
const BUILTIN_BOB_MODES: &[(&str, &str, &str)] = &[
    ("advanced", "Advanced", "Use Bob's full advanced toolset."),
    ("code", "Code", "Use Bob's code-focused mode."),
    (
        "ask",
        "Ask",
        "Use Bob's ask mode for analysis and questions.",
    ),
    ("plan", "Plan", "Use Bob's plan mode before execution."),
];
const BOB_COMMAND_DIR: &str = ".bob/commands";
const BOB_MODE_FILES: &[&str] = &[".bob/custom_modes.yaml", ".bob/settings/custom_modes.yaml"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, Default)]
pub struct Bob {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Trust the current Bob workspace.")]
    pub trust: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Maximum Bob budget/coins for this run.")]
    pub max_coins: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Pre-check whether auto-approved commands are safe to run.")]
    pub pre_check_auto_approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Tools Bob may run without confirmation.")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Allowed MCP server names for Bob.")]
    pub allowed_mcp_server_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Extra directories Bob should include in the workspace.")]
    pub include_directories: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Bob approval mode: default, auto_edit, or yolo.")]
    pub approval_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Bob chat mode slug. Supports built-in modes (advanced, code, ask, plan) and custom mode slugs."
    )]
    pub chat_mode: Option<String>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
}

impl Bob {
    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new("bob").extend_params([
            "--accept-license",
            "--output-format",
            "stream-json",
            "--chat-mode",
            self.chat_mode(),
            "--approval-mode",
            self.approval_mode(),
        ]);

        if self.sandbox.unwrap_or(false) {
            builder = builder.extend_params(["--sandbox"]);
        }
        if self.trust.unwrap_or(false) {
            builder = builder.extend_params(["--trust"]);
        }

        if let Some(model) = &self.model {
            builder = builder.extend_params(["--model", model.as_str()]);
        }

        if let Some(instance_id) = &self.instance_id {
            builder = builder.extend_params(["--instance-id", instance_id.as_str()]);
        }

        if let Some(team_id) = &self.team_id {
            builder = builder.extend_params(["--team-id", team_id.as_str()]);
        }
        if let Some(max_coins) = self.max_coins {
            builder = builder.extend_params(["--max-coins", &max_coins.to_string()]);
        }
        if self.pre_check_auto_approved.unwrap_or(false) {
            builder = builder.extend_params(["--pre-check-auto-approved"]);
        }
        if let Some(allowed_tools) = &self.allowed_tools {
            for tool in allowed_tools {
                builder = builder.extend_params(["--allowed-tools", tool.as_str()]);
            }
        }
        if let Some(allowed_mcp_server_names) = &self.allowed_mcp_server_names {
            for server in allowed_mcp_server_names {
                builder = builder.extend_params(["--allowed-mcp-server-names", server.as_str()]);
            }
        }
        if let Some(include_directories) = &self.include_directories {
            for dir in include_directories {
                builder = builder.extend_params(["--include-directories", dir.as_str()]);
            }
        }

        apply_overrides(builder, &self.cmd)
    }

    fn chat_mode(&self) -> &str {
        self.chat_mode
            .as_deref()
            .unwrap_or(DEFAULT_RUNTIME_CHAT_MODE)
    }

    fn approval_mode(&self) -> &str {
        self.approval_mode
            .as_deref()
            .unwrap_or(DEFAULT_APPROVAL_MODE)
    }

    fn build_resume_command(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<crate::command::CommandParts, CommandBuildError> {
        self.build_command_builder()?.build_follow_up(&[
            "--resume".to_string(),
            session_id.to_string(),
            "--prompt".to_string(),
            prompt.to_string(),
        ])
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Bob {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(agent_id) = &executor_config.agent_id {
            self.chat_mode = Some(agent_id.clone());
        }

        match executor_config.permission_policy.clone() {
            Some(PermissionPolicy::Auto) => {
                self.approval_mode = Some("yolo".to_string());
                if executor_config.agent_id.is_none() {
                    self.chat_mode = Some(DEFAULT_RUNTIME_CHAT_MODE.to_string());
                }
            }
            Some(PermissionPolicy::Plan) => {
                self.approval_mode = Some(DEFAULT_APPROVAL_MODE.to_string());
                if executor_config.agent_id.is_none() {
                    self.chat_mode = Some("plan".to_string());
                }
            }
            Some(PermissionPolicy::Supervised) | None => {
                self.approval_mode = Some(DEFAULT_APPROVAL_MODE.to_string());
                if executor_config.agent_id.is_none() {
                    self.chat_mode = Some(DEFAULT_RUNTIME_CHAT_MODE.to_string());
                }
            }
        }
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        spawn_bob(
            self.build_command_builder()?.build_initial()?,
            Some(self.append_prompt.combine_prompt(prompt)),
            current_dir,
            env,
            &self.cmd,
        )
        .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        spawn_bob(
            self.build_resume_command(session_id, &self.append_prompt.combine_prompt(prompt))?,
            None,
            current_dir,
            env,
            &self.cmd,
        )
        .await
    }

    fn normalize_logs(
        &self,
        msg_store: Arc<MsgStore>,
        worktree_path: &Path,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        normalize_bob_logs(msg_store, worktree_path)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".bob").join("settings").join("mcp_settings.json"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        let Some(home) = dirs::home_dir() else {
            return AvailabilityInfo::NotFound;
        };

        let bob_home = home.join(".bob");
        if bob_home.join("installation_id").exists() || bob_home.join("settings.json").exists() {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        let permission_policy = if self.chat_mode() == "plan" {
            PermissionPolicy::Plan
        } else if self.approval_mode() == "yolo" {
            PermissionPolicy::Auto
        } else {
            PermissionPolicy::Supervised
        };

        ExecutorConfig {
            executor: BaseCodingAgent::Bob,
            variant: None,
            model_id: self.model.clone(),
            agent_id: self
                .chat_mode
                .as_ref()
                .filter(|mode| mode.as_str() != DEFAULT_RUNTIME_CHAT_MODE)
                .cloned(),
            reasoning_id: None,
            permission_policy: Some(permission_policy),
        }
    }

    async fn discover_options(
        &self,
        _workdir: Option<&Path>,
        _repo_path: Option<&Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let mut agents = bob_builtin_agents();
        agents.extend(discover_bob_custom_modes(_workdir.or(_repo_path)));
        dedupe_agents(&mut agents);

        let mut slash_commands = bob_builtin_slash_commands();
        slash_commands.extend(discover_bob_custom_slash_commands(_workdir.or(_repo_path)));
        slash_commands.extend(
            agents
                .iter()
                .filter(|agent| !is_builtin_mode(&agent.id))
                .map(|agent| SlashCommandDescription {
                    name: agent.id.clone(),
                    description: Some(format!(
                        "Switch directly to Bob custom mode '{}'.",
                        agent.label
                    )),
                }),
        );
        dedupe_slash_commands(&mut slash_commands);

        let options = ExecutorDiscoveredOptions {
            model_selector: ModelSelectorConfig {
                agents,
                permissions: vec![
                    PermissionPolicy::Auto,
                    PermissionPolicy::Supervised,
                    PermissionPolicy::Plan,
                ],
                ..Default::default()
            },
            slash_commands,
            ..Default::default()
        };

        Ok(Box::pin(futures::stream::once(async move {
            crate::logs::utils::patch::executor_discovered_options(options)
        })))
    }
}

async fn spawn_bob(
    command_parts: crate::command::CommandParts,
    prompt: Option<String>,
    current_dir: &Path,
    env: &ExecutionEnv,
    cmd_overrides: &CmdOverrides,
) -> Result<SpawnedChild, ExecutorError> {
    let (program_path, args) = command_parts.into_resolved().await?;

    let mut command = Command::new(program_path);
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(current_dir)
        .env("NPM_CONFIG_LOGLEVEL", "error")
        .args(args);

    env.clone()
        .with_profile(cmd_overrides)
        .apply_to_command(&mut command);

    let mut child = command.group_spawn_no_window()?;

    if let Some(prompt) = prompt
        && let Some(mut stdin) = child.inner().stdin.take()
    {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }

    Ok(child.into())
}

fn normalize_bob_logs(
    msg_store: Arc<MsgStore>,
    worktree_path: &Path,
) -> Vec<tokio::task::JoinHandle<()>> {
    let entry_index = EntryIndexProvider::start_from(&msg_store);
    let h1 = normalize_stderr_logs(msg_store.clone(), entry_index.clone());
    let worktree_path = worktree_path.to_path_buf();

    let h2 = tokio::spawn(async move {
        let mut state = BobLogState::new(entry_index, worktree_path);
        let mut stdout_lines = msg_store.stdout_lines_stream();

        while let Some(Ok(line)) = stdout_lines.next().await {
            state.handle_line(&msg_store, line.trim_end());
        }
    });

    vec![h1, h2]
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BobEvent {
    Init {
        session_id: String,
        #[serde(default)]
        model: Option<String>,
    },
    Message {
        role: String,
        content: String,
        #[serde(default)]
        _delta: bool,
    },
    ToolUse {
        tool_name: String,
        tool_id: String,
        #[serde(default)]
        parameters: Value,
    },
    ToolResult {
        tool_id: String,
        status: String,
        #[serde(default)]
        output: String,
    },
    Error {
        message: String,
        #[serde(default)]
        severity: Option<String>,
    },
    Result {
        status: String,
        #[serde(default)]
        stats: Option<BobResultStats>,
    },
}

#[derive(Debug, Deserialize)]
struct BobResultStats {
    #[serde(default)]
    total_tokens: Option<u32>,
    #[serde(default)]
    max_budget: Option<f64>,
    #[serde(default)]
    budget_spend: Option<f64>,
}

struct BobLogState {
    entry_index: EntryIndexProvider,
    worktree_path: PathBuf,
    assistant_index: Option<usize>,
    assistant_content: String,
    thinking_index: Option<usize>,
    thinking_content: String,
    in_thinking: bool,
    tool_entries: HashMap<String, BobToolState>,
    model_name: Option<String>,
}

impl BobLogState {
    fn new(entry_index: EntryIndexProvider, worktree_path: PathBuf) -> Self {
        Self {
            entry_index,
            worktree_path,
            assistant_index: None,
            assistant_content: String::new(),
            thinking_index: None,
            thinking_content: String::new(),
            in_thinking: false,
            tool_entries: HashMap::new(),
            model_name: None,
        }
    }

    fn handle_line(&mut self, msg_store: &Arc<MsgStore>, line: &str) {
        if line.trim().is_empty() {
            return;
        }

        match serde_json::from_str::<BobEvent>(line) {
            Ok(event) => self.handle_event(msg_store, event),
            Err(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty()
                    || self
                        .assistant_content
                        .lines()
                        .last()
                        .is_some_and(|last| last.trim() == trimmed)
                {
                    return;
                }
                self.append_assistant_text(msg_store, line.to_string());
            }
        }
    }

    fn handle_event(&mut self, msg_store: &Arc<MsgStore>, event: BobEvent) {
        match event {
            BobEvent::Init { session_id, model } => {
                msg_store.push_session_id(session_id);
                if let Some(model) = model {
                    self.model_name = Some(model.clone());
                    add_normalized_entry(
                        msg_store,
                        &self.entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: format!("System initialized with model: {model}"),
                            metadata: None,
                        },
                    );
                }
            }
            BobEvent::Message { role, content, .. } => match role.as_str() {
                "assistant" => self.process_assistant_segment(msg_store, &content),
                "user" => {
                    self.flush_streaming_entries(msg_store);
                    add_normalized_entry(
                        msg_store,
                        &self.entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::UserMessage,
                            content,
                            metadata: None,
                        },
                    );
                }
                _ => {
                    add_normalized_entry(
                        msg_store,
                        &self.entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content,
                            metadata: None,
                        },
                    );
                }
            },
            BobEvent::ToolUse {
                tool_name,
                tool_id,
                parameters,
            } => {
                if tool_name == "attempt_completion" {
                    if let Some(result) = parameters.get("result").and_then(Value::as_str) {
                        self.append_assistant_text(msg_store, result.to_string());
                    }
                    return;
                }

                self.flush_streaming_entries(msg_store);

                let state = BobToolState::new(&tool_name, parameters, &self.worktree_path);
                let index = add_normalized_entry(msg_store, &self.entry_index, state.to_entry());
                self.tool_entries.insert(
                    tool_id,
                    BobToolState {
                        index: Some(index),
                        ..state
                    },
                );
            }
            BobEvent::ToolResult {
                tool_id,
                status,
                output,
            } => {
                if let Some(state) = self.tool_entries.get_mut(&tool_id) {
                    state.status = if status.eq_ignore_ascii_case("success") {
                        ToolStatus::Success
                    } else {
                        ToolStatus::Failed
                    };
                    state.output = (!output.trim().is_empty()).then_some(output);

                    if let Some(index) = state.index {
                        replace_normalized_entry(msg_store, index, state.to_entry());
                    }
                }
            }
            BobEvent::Error { message, severity } => {
                self.flush_streaming_entries(msg_store);
                let content = match severity {
                    Some(severity) if !severity.is_empty() => format!("{severity}: {message}"),
                    _ => message,
                };
                add_normalized_entry(
                    msg_store,
                    &self.entry_index,
                    NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::ErrorMessage {
                            error_type: NormalizedEntryError::Other,
                        },
                        content,
                        metadata: None,
                    },
                );
            }
            BobEvent::Result { status, stats } => {
                self.maybe_add_token_usage_entry(msg_store, stats.as_ref());
                if !status.eq_ignore_ascii_case("success") {
                    self.flush_streaming_entries(msg_store);
                    add_normalized_entry(
                        msg_store,
                        &self.entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: format!("Bob execution finished with status: {status}"),
                            metadata: None,
                        },
                    );
                }
            }
        }
    }

    fn maybe_add_token_usage_entry(
        &self,
        msg_store: &Arc<MsgStore>,
        stats: Option<&BobResultStats>,
    ) {
        let Some(stats) = stats else {
            return;
        };
        let Some(total_tokens) = stats.total_tokens else {
            return;
        };
        let model_context_window = bob_model_context_window(self.model_name.as_deref());
        let content = match (stats.budget_spend, stats.max_budget) {
            (Some(spend), Some(max_budget)) => format!(
                "Tokens used: {total_tokens} / Context window: {model_context_window} / Bob coins: {spend:.2} / {max_budget:.2}"
            ),
            _ => format!("Tokens used: {total_tokens} / Context window: {model_context_window}"),
        };

        add_normalized_entry(
            msg_store,
            &self.entry_index,
            NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::TokenUsageInfo(TokenUsageInfo {
                    total_tokens,
                    model_context_window,
                }),
                content,
                metadata: None,
            },
        );
    }

    fn process_assistant_segment(&mut self, msg_store: &Arc<MsgStore>, content: &str) {
        let mut remaining = content;
        while !remaining.is_empty() {
            if self.in_thinking {
                if let Some(idx) = remaining.find("</thinking>") {
                    let (before, after) = remaining.split_at(idx);
                    self.append_thinking_text(msg_store, before.to_string());
                    remaining = after.trim_start_matches("</thinking>");
                    self.in_thinking = false;
                } else {
                    self.append_thinking_text(msg_store, remaining.to_string());
                    break;
                }
            } else if let Some(idx) = remaining.find("<thinking>") {
                let (before, after) = remaining.split_at(idx);
                self.append_assistant_text(msg_store, before.to_string());
                remaining = after.trim_start_matches("<thinking>");
                self.in_thinking = true;
            } else {
                self.append_assistant_text(msg_store, remaining.to_string());
                break;
            }
        }
    }

    fn append_assistant_text(&mut self, msg_store: &Arc<MsgStore>, text: String) {
        let filtered = sanitize_assistant_text(&text);
        if filtered.is_empty() {
            return;
        }

        self.assistant_content.push_str(&filtered);
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::AssistantMessage,
            content: self.assistant_content.clone(),
            metadata: None,
        };

        match self.assistant_index {
            Some(index) => replace_normalized_entry(msg_store, index, entry),
            None => {
                let index = add_normalized_entry(msg_store, &self.entry_index, entry);
                self.assistant_index = Some(index);
            }
        }
    }

    fn append_thinking_text(&mut self, msg_store: &Arc<MsgStore>, text: String) {
        let filtered = sanitize_assistant_text(&text);
        if filtered.is_empty() {
            return;
        }

        self.thinking_content.push_str(&filtered);
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::Thinking,
            content: self.thinking_content.clone(),
            metadata: None,
        };

        match self.thinking_index {
            Some(index) => replace_normalized_entry(msg_store, index, entry),
            None => {
                let index = add_normalized_entry(msg_store, &self.entry_index, entry);
                self.thinking_index = Some(index);
            }
        }
    }

    fn flush_streaming_entries(&mut self, _msg_store: &Arc<MsgStore>) {
        self.assistant_index = None;
        self.assistant_content.clear();
        self.thinking_index = None;
        self.thinking_content.clear();
    }
}

fn sanitize_assistant_text(text: &str) -> String {
    let mut filtered = text.to_string();
    if filtered.trim_start().starts_with("[using tool ") {
        return String::new();
    }

    for tag in BOB_TOOL_CONTROL_TAGS {
        filtered = filtered.replace(&format!("<{tag}>"), "");
        filtered = filtered.replace(&format!("</{tag}>"), "");
    }

    filtered
}

fn bob_builtin_agents() -> Vec<AgentInfo> {
    BUILTIN_BOB_MODES
        .iter()
        .map(|(id, label, description)| AgentInfo {
            id: (*id).to_string(),
            label: (*label).to_string(),
            description: Some((*description).to_string()),
            is_default: *id == DEFAULT_RUNTIME_CHAT_MODE,
        })
        .collect()
}

fn is_builtin_mode(id: &str) -> bool {
    BUILTIN_BOB_MODES
        .iter()
        .any(|(builtin, _, _)| *builtin == id)
}

fn bob_builtin_slash_commands() -> Vec<SlashCommandDescription> {
    vec![
        SlashCommandDescription {
            name: "help".to_string(),
            description: Some("Show Bob slash command help.".to_string()),
        },
        SlashCommandDescription {
            name: "mode".to_string(),
            description: Some(
                "Switch Bob mode. Usage: /mode code|ask|plan|advanced|<custom-mode>.".to_string(),
            ),
        },
        SlashCommandDescription {
            name: "code".to_string(),
            description: Some("Switch Bob to Code mode.".to_string()),
        },
        SlashCommandDescription {
            name: "ask".to_string(),
            description: Some("Switch Bob to Ask mode.".to_string()),
        },
        SlashCommandDescription {
            name: "plan".to_string(),
            description: Some("Switch Bob to Plan mode.".to_string()),
        },
        SlashCommandDescription {
            name: "advanced".to_string(),
            description: Some("Switch Bob to Advanced mode.".to_string()),
        },
        SlashCommandDescription {
            name: "instance".to_string(),
            description: Some("Select or switch the active Bob instance/team.".to_string()),
        },
        SlashCommandDescription {
            name: "restore".to_string(),
            description: Some("List or restore Bob checkpoints.".to_string()),
        },
        SlashCommandDescription {
            name: "memory".to_string(),
            description: Some(
                "Manage memory/context. Use /memory refresh or /memory show.".to_string(),
            ),
        },
        SlashCommandDescription {
            name: "editor".to_string(),
            description: Some("Configure Bob's external editor integration.".to_string()),
        },
    ]
}

fn dedupe_slash_commands(commands: &mut Vec<SlashCommandDescription>) {
    let mut seen = std::collections::HashSet::new();
    commands.retain(|command| seen.insert(command.name.to_lowercase()));
}

fn dedupe_agents(agents: &mut Vec<AgentInfo>) {
    let mut seen = std::collections::HashSet::new();
    agents.retain(|agent| seen.insert(agent.id.to_lowercase()));
}

fn discover_bob_custom_slash_commands(base_path: Option<&Path>) -> Vec<SlashCommandDescription> {
    let mut commands = Vec::new();
    let mut dirs = Vec::new();

    if let Some(path) = base_path {
        dirs.push(path.join(BOB_COMMAND_DIR));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".bob").join("commands"));
    }

    for dir in dirs {
        if !dir.exists() {
            continue;
        }

        for entry in walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let Some(content) = fs::read_to_string(path).ok() else {
                continue;
            };
            let (description, argument_hint) = extract_bob_command_frontmatter(&content);
            let description = match (description, argument_hint) {
                (Some(description), Some(argument_hint)) => {
                    Some(format!("{description} Usage: /{stem} {argument_hint}"))
                }
                (Some(description), None) => Some(description),
                (None, Some(argument_hint)) => Some(format!("Usage: /{stem} {argument_hint}")),
                (None, None) => None,
            };

            commands.push(SlashCommandDescription {
                name: stem.to_lowercase(),
                description,
            });
        }
    }

    commands
}

fn extract_bob_command_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    if !content.starts_with("---") {
        return (None, None);
    }

    let Some(end) = content[3..].find("---") else {
        return (None, None);
    };
    let frontmatter = &content[3..3 + end];
    let mut description = None;
    let mut argument_hint = None;

    for line in frontmatter.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = line.strip_prefix("argument-hint:") {
            argument_hint = Some(value.trim().trim_matches('"').to_string());
        }
    }

    (description, argument_hint)
}

#[derive(Debug, Deserialize)]
struct BobCustomModesFile {
    #[serde(default, rename = "customModes", alias = "custom_modes")]
    custom_modes: Vec<BobCustomMode>,
}

#[derive(Debug, Deserialize)]
struct BobCustomMode {
    slug: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "whenToUse", alias = "when_to_use")]
    when_to_use: Option<String>,
}

fn discover_bob_custom_modes(base_path: Option<&Path>) -> Vec<AgentInfo> {
    let mut agents = Vec::new();
    let mut candidate_files = Vec::new();

    if let Some(path) = base_path {
        for relative in BOB_MODE_FILES {
            candidate_files.push(path.join(relative));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidate_files.push(home.join(".bob").join("custom_modes.yaml"));
        candidate_files.push(home.join(".bob").join("settings").join("custom_modes.yaml"));
    }

    for path in candidate_files {
        let Some(content) = fs::read_to_string(path).ok() else {
            continue;
        };
        let Ok(parsed) = serde_yaml::from_str::<BobCustomModesFile>(&content) else {
            continue;
        };
        for mode in parsed.custom_modes {
            let label = mode.name.clone().unwrap_or_else(|| mode.slug.clone());
            let description = mode.description.or(mode.when_to_use);
            agents.push(AgentInfo {
                id: mode.slug,
                label,
                description,
                is_default: false,
            });
        }
    }

    agents
}

#[derive(Debug, Clone)]
struct BobToolState {
    index: Option<usize>,
    tool_name: String,
    arguments: Value,
    content: String,
    action_type: ActionType,
    status: ToolStatus,
    output: Option<String>,
}

impl BobToolState {
    fn new(tool_name: &str, arguments: Value, worktree_path: &Path) -> Self {
        let (content, action_type) = bob_tool_action(tool_name, &arguments, worktree_path);
        Self {
            index: None,
            tool_name: tool_name.to_string(),
            arguments,
            content,
            action_type,
            status: ToolStatus::Created,
            output: None,
        }
    }

    fn to_entry(&self) -> NormalizedEntry {
        let action_type = match &self.action_type {
            ActionType::CommandRun {
                command, category, ..
            } => ActionType::CommandRun {
                command: command.clone(),
                category: *category,
                result: self.output.as_ref().map(|output| CommandRunResult {
                    exit_status: None,
                    output: Some(output.clone()),
                }),
            },
            ActionType::Tool { tool_name, .. } => ActionType::Tool {
                tool_name: tool_name.clone(),
                arguments: Some(self.arguments.clone()),
                result: self
                    .output
                    .as_ref()
                    .map(|output| ToolResult::markdown(output.clone())),
            },
            other => other.clone(),
        };

        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: self.tool_name.clone(),
                action_type,
                status: self.status.clone(),
            },
            content: self.content.clone(),
            metadata: None,
        }
    }
}

fn bob_tool_action(
    tool_name: &str,
    arguments: &Value,
    worktree_path: &Path,
) -> (String, ActionType) {
    let worktree_str = worktree_path.to_string_lossy();
    match tool_name {
        "read_file" => {
            let path = arguments
                .get("file_path")
                .or_else(|| arguments.get("absolute_path"))
                .and_then(Value::as_str)
                .map(|path| make_path_relative(path, &worktree_str))
                .unwrap_or_default();

            (path.clone(), ActionType::FileRead { path })
        }
        "write_to_file" => {
            let path = arguments
                .get("file_path")
                .or_else(|| arguments.get("path"))
                .and_then(Value::as_str)
                .map(|p| make_path_relative(p, &worktree_str))
                .unwrap_or_default();
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let changes = vec![FileChange::Write { content }];
            (path.clone(), ActionType::FileEdit { path, changes })
        }
        "apply_diff" => {
            let path = arguments
                .get("file_path")
                .or_else(|| arguments.get("path"))
                .and_then(Value::as_str)
                .map(|p| make_path_relative(p, &worktree_str))
                .unwrap_or_default();
            let diff = arguments
                .get("diff")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let changes = vec![FileChange::Edit {
                unified_diff: diff,
                has_line_numbers: true,
            }];
            (path.clone(), ActionType::FileEdit { path, changes })
        }
        "search_and_replace" => {
            let path = arguments
                .get("file_path")
                .or_else(|| arguments.get("path"))
                .and_then(Value::as_str)
                .map(|p| make_path_relative(p, &worktree_str))
                .unwrap_or_default();
            let old_str = arguments
                .get("old_str")
                .or_else(|| arguments.get("search"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let new_str = arguments
                .get("new_str")
                .or_else(|| arguments.get("replace"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let changes = vec![FileChange::Edit {
                unified_diff: create_unified_diff(&path, old_str, new_str),
                has_line_numbers: false,
            }];
            (path.clone(), ActionType::FileEdit { path, changes })
        }
        "insert_content" => {
            let path = arguments
                .get("file_path")
                .or_else(|| arguments.get("path"))
                .and_then(Value::as_str)
                .map(|p| make_path_relative(p, &worktree_str))
                .unwrap_or_default();
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let changes = vec![FileChange::Edit {
                unified_diff: create_unified_diff(&path, "", content),
                has_line_numbers: false,
            }];
            (path.clone(), ActionType::FileEdit { path, changes })
        }
        "replace_regex" => {
            let path = arguments
                .get("file_path")
                .or_else(|| arguments.get("path"))
                .and_then(Value::as_str)
                .map(|p| make_path_relative(p, &worktree_str))
                .unwrap_or_default();
            let pattern = arguments
                .get("regex")
                .or_else(|| arguments.get("pattern"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let replacement = arguments
                .get("replacement")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let changes = vec![FileChange::Edit {
                unified_diff: format!("regex: s/{pattern}/{replacement}/g"),
                has_line_numbers: false,
            }];
            (path.clone(), ActionType::FileEdit { path, changes })
        }
        "search_file_content" => {
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .or_else(|| arguments.get("regex").and_then(Value::as_str))
                .unwrap_or(tool_name)
                .to_string();

            (query.clone(), ActionType::Search { query })
        }
        "execute_command" | "run_shell_command" | "command" => {
            let command = arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let category = CommandCategory::from_command(&command);
            (
                command.clone(),
                ActionType::CommandRun {
                    command,
                    result: None,
                    category,
                },
            )
        }
        other => {
            let path = arguments
                .get("path")
                .or_else(|| arguments.get("file_path"))
                .and_then(Value::as_str)
                .map(|path| make_path_relative(path, &worktree_str));

            let content = path.unwrap_or_else(|| other.replace('_', " "));
            (
                content,
                ActionType::Tool {
                    tool_name: other.to_string(),
                    arguments: Some(arguments.clone()),
                    result: None,
                },
            )
        }
    }
}

fn make_path_relative(path: &str, worktree_path: &str) -> String {
    workspace_utils::path::make_path_relative(path, worktree_path)
}

fn bob_model_context_window(model_name: Option<&str>) -> u32 {
    match model_name.unwrap_or_default().to_ascii_lowercase().as_str() {
        // Bob's "premium" model currently maps to a large-context backend model.
        "premium" => 200_000,
        _ => 200_000,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

    use super::*;

    fn patches_to_entries(history: &[LogMsg]) -> Vec<NormalizedEntry> {
        history
            .iter()
            .filter_map(|msg| match msg {
                LogMsg::JsonPatch(patch) => {
                    crate::logs::utils::patch::extract_normalized_entry_from_patch(patch)
                        .map(|(_, entry)| entry)
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn bob_builds_supervised_runtime_command() {
        let bob = Bob::default();
        let command = bob
            .build_command_builder()
            .unwrap()
            .build_initial()
            .unwrap();
        assert_eq!(
            format!("{command:?}"),
            r#"CommandParts { program: "bob", args: ["--accept-license", "--output-format", "stream-json", "--chat-mode", "advanced", "--approval-mode", "default"] }"#
        );
    }

    #[test]
    fn bob_builds_auto_mode_command_after_overrides() {
        let mut bob = Bob::default();
        bob.apply_overrides(&ExecutorConfig {
            executor: BaseCodingAgent::Bob,
            variant: None,
            model_id: Some("premium".to_string()),
            agent_id: None,
            reasoning_id: None,
            permission_policy: Some(PermissionPolicy::Auto),
        });

        let command = bob
            .build_command_builder()
            .unwrap()
            .build_initial()
            .unwrap();
        assert_eq!(
            format!("{command:?}"),
            r#"CommandParts { program: "bob", args: ["--accept-license", "--output-format", "stream-json", "--chat-mode", "advanced", "--approval-mode", "yolo", "--model", "premium"] }"#
        );
    }

    #[test]
    fn bob_builds_plan_mode_command_after_overrides() {
        let mut bob = Bob::default();
        bob.apply_overrides(&ExecutorConfig {
            executor: BaseCodingAgent::Bob,
            variant: None,
            model_id: None,
            agent_id: None,
            reasoning_id: None,
            permission_policy: Some(PermissionPolicy::Plan),
        });

        let command = bob
            .build_command_builder()
            .unwrap()
            .build_initial()
            .unwrap();
        assert_eq!(
            format!("{command:?}"),
            r#"CommandParts { program: "bob", args: ["--accept-license", "--output-format", "stream-json", "--chat-mode", "plan", "--approval-mode", "default"] }"#
        );
    }

    #[test]
    fn bob_builds_resume_command() {
        let bob = Bob::default();
        let command = bob
            .build_resume_command("session-123", "follow up")
            .unwrap();
        assert_eq!(
            format!("{command:?}"),
            r#"CommandParts { program: "bob", args: ["--accept-license", "--output-format", "stream-json", "--chat-mode", "advanced", "--approval-mode", "default", "--resume", "session-123", "--prompt", "follow up"] }"#
        );
    }

    #[test]
    fn bob_builds_extra_settings_flags() {
        let bob = Bob {
            sandbox: Some(true),
            trust: Some(true),
            max_coins: Some(42),
            pre_check_auto_approved: Some(true),
            allowed_tools: Some(vec!["git status".to_string(), "npm test".to_string()]),
            allowed_mcp_server_names: Some(vec!["github".to_string(), "notion".to_string()]),
            include_directories: Some(vec!["../shared".to_string(), "../docs".to_string()]),
            chat_mode: Some("ask".to_string()),
            approval_mode: Some("auto_edit".to_string()),
            ..Default::default()
        };

        let command = bob
            .build_command_builder()
            .unwrap()
            .build_initial()
            .unwrap();
        assert_eq!(
            format!("{command:?}"),
            r#"CommandParts { program: "bob", args: ["--accept-license", "--output-format", "stream-json", "--chat-mode", "ask", "--approval-mode", "auto_edit", "--sandbox", "--trust", "--max-coins", "42", "--pre-check-auto-approved", "--allowed-tools", "git status", "--allowed-tools", "npm test", "--allowed-mcp-server-names", "github", "--allowed-mcp-server-names", "notion", "--include-directories", "../shared", "--include-directories", "../docs"] }"#
        );
    }

    #[test]
    fn bob_agent_override_sets_chat_mode_from_agent_id() {
        let config = ExecutorConfig {
            executor: BaseCodingAgent::Bob,
            variant: None,
            model_id: None,
            agent_id: Some("ask".to_string()),
            reasoning_id: None,
            permission_policy: Some(PermissionPolicy::Supervised),
        };

        let mut bob = Bob::default();
        bob.apply_overrides(&config);

        assert_eq!(bob.chat_mode.as_deref(), Some("ask"));
        assert_eq!(bob.approval_mode.as_deref(), Some("default"));
    }

    #[tokio::test]
    async fn bob_discovery_includes_builtin_custom_commands_and_modes() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!("bob-discovery-{unique}"));
        let project_commands_dir = temp_root.join(".bob").join("commands");
        let project_modes_path = temp_root.join(".bob").join("custom_modes.yaml");
        std::fs::create_dir_all(&project_commands_dir).unwrap();
        std::fs::write(
            project_commands_dir.join("review-readme.md"),
            "---\ndescription: Review the README changes\nargument-hint: <path>\n---\nReview README.\n",
        )
        .unwrap();
        std::fs::create_dir_all(project_modes_path.parent().unwrap()).unwrap();
        std::fs::write(
            &project_modes_path,
            "customModes:\n  - slug: repo-audit\n    name: Repo Audit\n    description: Audit repository quality\n",
        )
        .unwrap();

        let bob = Bob::default();
        let mut stream = bob.discover_options(Some(&temp_root), None).await.unwrap();
        let patch = stream.next().await.expect("patch");
        let value = serde_json::to_value(&patch).unwrap();
        let slash_commands = value[0]["value"]["slash_commands"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let agents = value[0]["value"]["model_selector"]["agents"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let slash_names: Vec<String> = slash_commands
            .iter()
            .filter_map(|item| {
                item.get("name")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect();
        let agent_ids: Vec<String> = agents
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect();

        assert!(slash_names.iter().any(|name| name == "mode"));
        assert!(slash_names.iter().any(|name| name == "instance"));
        assert!(slash_names.iter().any(|name| name == "review-readme"));
        assert!(slash_names.iter().any(|name| name == "repo-audit"));

        assert!(agent_ids.iter().any(|id| id == "advanced"));
        assert!(agent_ids.iter().any(|id| id == "plan"));
        assert!(agent_ids.iter().any(|id| id == "repo-audit"));

        let _ = std::fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn bob_normalizer_captures_session_id_and_plain_text_output() {
        let msg_store = Arc::new(MsgStore::new());
        let worktree = PathBuf::from("/tmp/test-worktree");

        for line in include_str!("bob/fixtures/basic_stream_json.txt").lines() {
            msg_store.push_stdout(format!("{line}\n"));
        }
        msg_store.push_finished();

        normalize_bob_logs(msg_store.clone(), &worktree);
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

        let history = msg_store.get_history();
        let session_ids: Vec<String> = history
            .iter()
            .filter_map(|msg| match msg {
                LogMsg::SessionId(id) => Some(id.clone()),
                _ => None,
            })
            .collect();

        assert_eq!(
            session_ids,
            vec!["215a3282-5669-4e89-9825-8bea9216e074".to_string()]
        );

        let entries = patches_to_entries(&history);
        assert!(entries.iter().any(|entry| matches!(
            entry.entry_type,
            NormalizedEntryType::AssistantMessage
        ) && entry.content.contains("OK")));
        assert!(entries.iter().any(|entry| matches!(
            entry.entry_type,
            NormalizedEntryType::TokenUsageInfo(TokenUsageInfo {
                total_tokens: 53148,
                model_context_window: 200000
            })
        )
            && entry.content.contains("Bob coins: 4.06 / 100.00")));
    }

    #[tokio::test]
    async fn bob_normalizer_handles_streamed_thinking_and_read_file_tool() {
        let msg_store = Arc::new(MsgStore::new());
        let worktree =
            PathBuf::from("/Users/riddhishganeshmahajan/Desktop/All in One/Hackathon/vibe-kanban");

        for line in include_str!("bob/fixtures/read_file_stream_json.txt").lines() {
            msg_store.push_stdout(format!("{line}\n"));
        }
        msg_store.push_finished();

        normalize_bob_logs(msg_store.clone(), &worktree);
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        let entries = patches_to_entries(&msg_store.get_history());
        assert!(
            entries
                .iter()
                .any(|entry| matches!(entry.entry_type, NormalizedEntryType::UserMessage))
        );
        assert!(entries.iter().any(|entry| matches!(
            entry.entry_type,
            NormalizedEntryType::Thinking
        ) && entry.content.contains("Task complete")));
        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::ToolUse {
                action_type: ActionType::FileRead { path },
                status: ToolStatus::Success,
                ..
            } if path == "AGENTS.md"
        )));
        assert!(entries.iter().any(|entry| {
            matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                && entry
                    .content
                    .contains("Rust + TypeScript monorepo for Vibe Kanban")
        }));
        assert!(entries.iter().any(|entry| matches!(
            entry.entry_type,
            NormalizedEntryType::TokenUsageInfo(TokenUsageInfo {
                total_tokens: 45957,
                model_context_window: 200000
            })
        )
            && entry.content.contains("Bob coins: 4.17 / 100.00")));
    }

    #[tokio::test]
    async fn bob_normalizer_maps_write_and_edit_tools_to_file_edit_action() {
        let msg_store = Arc::new(MsgStore::new());
        let worktree = PathBuf::from("/tmp/test-worktree");

        for line in include_str!("bob/fixtures/write_file_stream_json.txt").lines() {
            msg_store.push_stdout(format!("{line}\n"));
        }
        msg_store.push_finished();

        normalize_bob_logs(msg_store.clone(), &worktree);
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        let entries = patches_to_entries(&msg_store.get_history());

        // write_to_file should produce FileEdit with the path
        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::ToolUse {
                action_type: ActionType::FileEdit { path, .. },
                status: ToolStatus::Success,
                ..
            } if path == "hello.txt"
        )));

        // search_and_replace should also produce FileEdit (succeeded)
        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::ToolUse {
                tool_name,
                action_type: ActionType::FileEdit { path, .. },
                status: ToolStatus::Success,
                ..
            } if tool_name == "search_and_replace" && path == "hello.txt"
        )));

        // attempt_completion result should appear as assistant message
        assert!(entries.iter().any(|entry| {
            matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                && entry.content.contains("created hello.txt")
        }));
    }
}
