use std::sync::Arc;

use axum::{
    Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::time;
use uuid::Uuid;

use crate::{
    AppState,
    presence::{BROADCAST_INTERVAL, ClientPresenceMessage, PresenceManager, ServerPresenceMessage},
};

#[derive(Debug, Deserialize)]
pub struct PresenceQuery {
    project_id: Uuid,
    token: String,
}

async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<PresenceQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let user_id = match state.jwt().decode_access_token(&query.token) {
        Ok(details) => details.user_id,
        Err(_) => {
            return (axum::http::StatusCode::UNAUTHORIZED, "invalid token").into_response();
        }
    };

    ws.on_upgrade(move |socket| {
        handle_socket(socket, state.presence().clone(), query.project_id, user_id)
    })
}

async fn handle_socket(
    socket: WebSocket,
    presence: Arc<PresenceManager>,
    project_id: Uuid,
    user_id: Uuid,
) {
    let (mut sender, mut receiver) = socket.split();

    presence.upsert(project_id, user_id, None, None).await;

    let mut change_rx = presence.subscribe();

    let presence_for_broadcast = presence.clone();
    let mut broadcast_task = tokio::spawn(async move {
        let mut interval = time::interval(BROADCAST_INTERVAL);
        loop {
            tokio::select! {
                _ = interval.tick() => {},
                Ok(changed_project_id) = change_rx.recv() => {
                    if changed_project_id != project_id {
                        continue;
                    }
                },
            }

            let users = presence_for_broadcast
                .get_room_users(project_id, user_id)
                .await;
            let msg = ServerPresenceMessage::PresenceSync { users };
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(_) => continue,
            };
            if sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    let presence_for_recv = presence.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(client_msg) = serde_json::from_str::<ClientPresenceMessage>(&text) {
                        match client_msg {
                            ClientPresenceMessage::Heartbeat {
                                viewing_issue_id,
                                dragging_over_status_id,
                            } => {
                                presence_for_recv
                                    .upsert(
                                        project_id,
                                        user_id,
                                        viewing_issue_id,
                                        dragging_over_status_id,
                                    )
                                    .await;
                            }
                            ClientPresenceMessage::Disconnect => {
                                break;
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut broadcast_task => {
            recv_task.abort();
        }
        _ = &mut recv_task => {
            broadcast_task.abort();
        }
    }

    presence.remove(project_id, user_id).await;
    tracing::debug!(%user_id, %project_id, "presence: user disconnected");
}

pub fn router() -> Router<AppState> {
    Router::new().route("/presence", axum::routing::get(ws_handler))
}
