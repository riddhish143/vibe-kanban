use std::{
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use executors::{
    executors::{BaseCodingAgent, StandardCodingAgentExecutor, bob::Bob},
    model_selector::PermissionPolicy,
    profile::ExecutorConfig,
};
use futures::StreamExt;

#[test]
fn bob_base_coding_agent_deserializes() {
    let result = BaseCodingAgent::from_str("BOB");
    assert!(result.is_ok(), "BOB should be a valid executor");
    assert_eq!(result.unwrap(), BaseCodingAgent::Bob);
}

#[test]
fn bob_mcp_config_path_points_to_bob_settings() {
    let bob = Bob::default();
    let config_path = bob.default_mcp_config_path();

    assert_eq!(
        config_path,
        dirs::home_dir().map(|home| home.join(".bob").join("settings").join("mcp_settings.json"))
    );
}

#[test]
fn bob_availability_detects_installation_files() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp = std::env::temp_dir().join(format!("bob-test-{unique}"));
    let bob_home = tmp.join(".bob");
    std::fs::create_dir_all(&bob_home).unwrap();
    std::fs::write(bob_home.join("installation_id"), "installed").unwrap();
    std::fs::write(bob_home.join("settings.json"), "{}").unwrap();

    let old_home = std::env::var_os("HOME");
    unsafe {
        std::env::set_var("HOME", &tmp);
    }

    let bob = Bob::default();
    let availability = bob.get_availability_info();

    match old_home {
        Some(home) => unsafe {
            std::env::set_var("HOME", home);
        },
        None => unsafe {
            std::env::remove_var("HOME");
        },
    }
    let _ = std::fs::remove_dir_all(&tmp);

    assert!(matches!(
        availability,
        executors::executors::AvailabilityInfo::InstallationFound
    ));
}

#[tokio::test]
async fn bob_discovered_options_include_expected_permissions() {
    let bob = Bob::default();
    let mut stream = bob.discover_options(None, None).await.unwrap();
    let patch = stream.next().await.expect("patch");
    let value = serde_json::to_value(&patch).unwrap();
    let permissions = value[0]["value"]["model_selector"]["permissions"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    assert_eq!(
        permissions,
        vec![
            serde_json::Value::String("AUTO".to_string()),
            serde_json::Value::String("SUPERVISED".to_string()),
            serde_json::Value::String("PLAN".to_string()),
        ]
    );
}

#[test]
fn bob_preset_options_map_auto_to_permission_policy() {
    let bob = Bob {
        model: Some("premium".to_string()),
        approval_mode: Some("yolo".to_string()),
        ..Default::default()
    };

    let options = bob.get_preset_options();
    assert_eq!(options.executor, BaseCodingAgent::Bob);
    assert_eq!(options.model_id.as_deref(), Some("premium"));
    assert_eq!(options.permission_policy, Some(PermissionPolicy::Auto));
}

#[test]
fn bob_executor_config_can_apply_model_override() {
    let config = ExecutorConfig {
        executor: BaseCodingAgent::Bob,
        variant: None,
        model_id: Some("premium".to_string()),
        agent_id: None,
        reasoning_id: None,
        permission_policy: Some(PermissionPolicy::Plan),
    };

    let mut bob = Bob::default();
    bob.apply_overrides(&config);

    assert_eq!(bob.model.as_deref(), Some("premium"));
    assert_eq!(bob.chat_mode.as_deref(), Some("plan"));
    assert_eq!(bob.approval_mode.as_deref(), Some("default"));
}

#[test]
fn bob_session_fixture_is_captured() {
    let fixture = include_str!("../src/executors/bob/fixtures/basic_stream_json.txt");

    assert!(fixture.contains("\"type\":\"init\""));
    assert!(fixture.contains("\"type\":\"tool_use\""));
    assert!(fixture.contains("\"type\":\"result\""));
    assert!(fixture.contains("\"session_id\":\"215a3282-5669-4e89-9825-8bea9216e074\""));
}
