use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);
pub const STALE_TIMEOUT: Duration = Duration::from_secs(10);
pub const BROADCAST_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientPresenceMessage {
    Heartbeat {
        viewing_issue_id: Option<Uuid>,
        dragging_over_status_id: Option<Uuid>,
    },
    Disconnect,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserPresence {
    pub user_id: Uuid,
    pub viewing_issue_id: Option<Uuid>,
    pub dragging_over_status_id: Option<Uuid>,
    #[serde(skip)]
    pub last_seen: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerPresenceMessage {
    PresenceSync { users: Vec<UserPresence> },
    UserJoined { user_id: Uuid },
    UserLeft { user_id: Uuid },
}

#[derive(Debug, Default)]
struct Room {
    users: HashMap<Uuid, UserPresence>,
}

#[derive(Debug)]
pub struct PresenceManager {
    rooms: RwLock<HashMap<Uuid, Room>>,
    change_notify: broadcast::Sender<Uuid>,
}

impl PresenceManager {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        let manager = Arc::new(Self {
            rooms: RwLock::new(HashMap::new()),
            change_notify: tx,
        });

        let manager_clone = Arc::clone(&manager);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(STALE_TIMEOUT);
            loop {
                interval.tick().await;
                manager_clone.cleanup_stale().await;
            }
        });

        manager
    }

    pub async fn upsert(
        &self,
        project_id: Uuid,
        user_id: Uuid,
        viewing_issue_id: Option<Uuid>,
        dragging_over_status_id: Option<Uuid>,
    ) {
        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(project_id).or_default();
        room.users.insert(
            user_id,
            UserPresence {
                user_id,
                viewing_issue_id,
                dragging_over_status_id,
                last_seen: Instant::now(),
            },
        );
        let _ = self.change_notify.send(project_id);
    }

    pub async fn remove(&self, project_id: Uuid, user_id: Uuid) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(&project_id) {
            room.users.remove(&user_id);
            if room.users.is_empty() {
                rooms.remove(&project_id);
            }
        }
        let _ = self.change_notify.send(project_id);
    }

    pub async fn get_room_users(
        &self,
        project_id: Uuid,
        exclude_user_id: Uuid,
    ) -> Vec<UserPresence> {
        let rooms = self.rooms.read().await;
        rooms
            .get(&project_id)
            .map(|room| {
                room.users
                    .values()
                    .filter(|u| u.user_id != exclude_user_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Uuid> {
        self.change_notify.subscribe()
    }

    async fn cleanup_stale(&self) {
        let now = Instant::now();
        let mut rooms = self.rooms.write().await;
        let mut empty_rooms = Vec::new();

        for (project_id, room) in rooms.iter_mut() {
            room.users
                .retain(|_, user| now.duration_since(user.last_seen) < STALE_TIMEOUT);
            if room.users.is_empty() {
                empty_rooms.push(*project_id);
            }
        }

        for project_id in empty_rooms {
            rooms.remove(&project_id);
        }
    }
}
