# Real-Time Collaboration (Multiplayer Kanban) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time multiplayer presence to the Kanban board so team members can see who's online, what they're viewing, and where they're dragging issues — like Figma/Linear, but for agent-driven development.

**Architecture:** We use a lightweight **WebSocket presence channel** on the remote Axum server. Each connected user sends heartbeats + cursor/view state. The server broadcasts presence to all org members on the same project. Issue CRUD remains unchanged (ElectricSQL handles data sync already). Presence is **ephemeral** — stored only in-memory on the server, not in Postgres.

**Tech Stack:** Axum WebSocket (server), React hooks + context (client), Zustand store (client state), existing JWT auth, existing `AppState`.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (React)                          │
│                                                                 │
│  PresenceProvider ──► usePresence() hook                        │
│       │                   │                                     │
│       │ WebSocket         │ Read presenceStore (Zustand)        │
│       ▼                   ▼                                     │
│  ws://host/v1/presence?project_id=xxx&token=yyy                 │
│       │                                                         │
│       │  Sends: { type: "heartbeat", viewingIssueId, cursor }   │
│       │  Receives: { type: "presence_sync", users: [...] }      │
└───────┼─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Remote Server (Axum)                           │
│                                                                 │
│  routes/presence.rs                                             │
│       │                                                         │
│       ▼                                                         │
│  PresenceManager (in-memory, Arc<RwLock<HashMap>>)              │
│       │                                                         │
│       │  Per-project room of connected users                    │
│       │  Broadcasts state every 2s or on change                 │
│       │  Cleans up stale connections after 10s                  │
│       │                                                         │
│  NO database writes — purely ephemeral                          │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

### Backend (Rust — `crates/remote/src/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `presence.rs` | **Create** | `PresenceManager` struct: in-memory room state, broadcast logic, stale cleanup |
| `routes/presence.rs` | **Create** | Axum WebSocket upgrade handler, JWT auth from query param, message parsing |
| `state.rs` | **Modify** | Add `Arc<PresenceManager>` to `AppState` |
| `app.rs` | **Modify** | Instantiate `PresenceManager`, pass to `AppState` |
| `routes/mod.rs` | **Modify** | Mount `/v1/presence` WebSocket route |

### Frontend (TypeScript — `packages/web-core/src/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/lib/presence/types.ts` | **Create** | TypeScript types for presence messages |
| `shared/lib/presence/presenceStore.ts` | **Create** | Zustand store: connected users map, selectors |
| `shared/lib/presence/usePresenceSocket.ts` | **Create** | WebSocket connection hook: connect, heartbeat, reconnect |
| `shared/providers/PresenceProvider.tsx` | **Create** | React context provider: manages socket lifecycle per project |
| `shared/hooks/usePresence.ts` | **Create** | Public API hook: `usePresence()` returns online users, who's viewing what |
| `shared/components/presence/PresenceAvatars.tsx` | **Create** | Avatar stack component showing online users |
| `shared/components/presence/PresenceIndicator.tsx` | **Create** | Small dot/badge on kanban cards showing who's viewing |

### Modified existing files

| File | Change |
|------|--------|
| `packages/web-core/src/features/kanban/ui/KanbanContainer.tsx` | Wrap with `PresenceProvider`, add `PresenceAvatars` to header |
| `packages/remote-web/src/app/layout/RemoteAppShell.tsx` | Mount `PresenceProvider` at layout level |

---

## Task 1: Backend — PresenceManager (In-Memory State)

**Files:**
- Create: `crates/remote/src/presence.rs`

This is the core data structure. No database, no persistence — purely in-memory.

- [ ] **Step 1: Create the presence types and manager**

```rust
// crates/remote/src/presence.rs

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

/// How often clients should send heartbeats
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);
/// How long before a user is considered disconnected
pub const STALE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the server broadcasts presence state
pub const BROADCAST_INTERVAL: Duration = Duration::from_secs(2);

/// Message sent FROM client TO server
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientPresenceMessage {
    Heartbeat {
        /// Which issue the user is currently viewing/editing (None = board view)
        viewing_issue_id: Option<Uuid>,
        /// Which kanban column the user is dragging over (None = not dragging)
        dragging_over_status_id: Option<Uuid>,
    },
    Disconnect,
}

/// Per-user presence state stored server-side
#[derive(Debug, Clone, Serialize)]
pub struct UserPresence {
    pub user_id: Uuid,
    pub viewing_issue_id: Option<Uuid>,
    pub dragging_over_status_id: Option<Uuid>,
    #[serde(skip)]
    pub last_seen: Instant,
}

/// Message sent FROM server TO client
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerPresenceMessage {
    PresenceSync { users: Vec<UserPresence> },
    UserJoined { user_id: Uuid },
    UserLeft { user_id: Uuid },
}

/// A project-scoped room of connected users
#[derive(Debug, Default)]
struct Room {
    users: HashMap<Uuid, UserPresence>,
}

/// Manages presence state for all projects. Fully in-memory.
#[derive(Debug)]
pub struct PresenceManager {
    rooms: RwLock<HashMap<Uuid, Room>>,
    /// Broadcast channel for notifying background tasks of changes
    change_notify: broadcast::Sender<Uuid>,
}

impl PresenceManager {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        let manager = Arc::new(Self {
            rooms: RwLock::new(HashMap::new()),
            change_notify: tx,
        });

        // Spawn stale-user cleanup task
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

    /// Update a user's presence in a project room
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

    /// Remove a user from a project room
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

    /// Get current presence for a project (excludes requesting user)
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

    /// Subscribe to change notifications for a project
    pub fn subscribe(&self) -> broadcast::Receiver<Uuid> {
        self.change_notify.subscribe()
    }

    /// Remove users who haven't sent a heartbeat within STALE_TIMEOUT
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
```

- [ ] **Step 2: Register the module in lib.rs**

Add to `crates/remote/src/lib.rs`:

```rust
pub mod presence;
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check --manifest-path crates/remote/Cargo.toml`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add crates/remote/src/presence.rs crates/remote/src/lib.rs
git commit -m "feat(presence): add in-memory PresenceManager for multiplayer kanban"
```

---

## Task 2: Backend — WebSocket Route Handler

**Files:**
- Create: `crates/remote/src/routes/presence.rs`
- Modify: `crates/remote/src/routes/mod.rs`

- [ ] **Step 1: Create the WebSocket presence route**

```rust
// crates/remote/src/routes/presence.rs

use std::sync::Arc;

use axum::{
    Router,
    extract::{Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::time;
use uuid::Uuid;

use crate::{
    AppState,
    auth::JwtService,
    presence::{
        ClientPresenceMessage, PresenceManager, ServerPresenceMessage,
        BROADCAST_INTERVAL, HEARTBEAT_INTERVAL,
    },
};

#[derive(Debug, Deserialize)]
pub struct PresenceQuery {
    project_id: Uuid,
    token: String,
}

/// WebSocket upgrade handler for presence.
/// Auth is done via query param `token` (JWT) since WebSocket
/// upgrade requests cannot carry Authorization headers in browsers.
async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<PresenceQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Validate JWT from query param
    let user_id = match state.jwt().verify_access_token(&query.token) {
        Ok(claims) => claims.sub,
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

    // Register user as present
    presence.upsert(project_id, user_id, None, None).await;

    // Subscribe to changes for broadcast
    let mut change_rx = presence.subscribe();

    // Spawn a task that periodically sends presence state to this client
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

    // Process incoming messages from this client
    let presence_for_recv = presence.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(client_msg) =
                        serde_json::from_str::<ClientPresenceMessage>(&text)
                    {
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

    // Wait for either task to finish, then clean up
    tokio::select! {
        _ = &mut broadcast_task => {
            recv_task.abort();
        }
        _ = &mut recv_task => {
            broadcast_task.abort();
        }
    }

    // Remove user from presence
    presence.remove(project_id, user_id).await;
    tracing::debug!(%user_id, %project_id, "presence: user disconnected");
}

pub fn router() -> Router<AppState> {
    Router::new().route("/presence", axum::routing::get(ws_handler))
}
```

- [ ] **Step 2: Mount the presence route in the router**

In `crates/remote/src/routes/mod.rs`, add to the module declarations near the top:

```rust
mod presence;
```

Then in the `router()` function, add the presence WebSocket route to the **v1_protected** section (before the `.layer(middleware::from_fn_with_state(...))`):

```rust
.merge(presence::router())
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check --manifest-path crates/remote/Cargo.toml`
Expected: May fail because `state.presence()` doesn't exist yet on `AppState`. That's Task 3.

- [ ] **Step 4: Commit**

```bash
git add crates/remote/src/routes/presence.rs crates/remote/src/routes/mod.rs
git commit -m "feat(presence): add WebSocket presence route handler"
```

---

## Task 3: Backend — Wire PresenceManager into AppState

**Files:**
- Modify: `crates/remote/src/state.rs`
- Modify: `crates/remote/src/app.rs`

- [ ] **Step 1: Add presence to AppState**

In `crates/remote/src/state.rs`, add the field and accessor:

```rust
// Add import at top
use crate::presence::PresenceManager;

// Add field to AppState struct:
presence: Arc<PresenceManager>,

// Add parameter to AppState::new():
presence: Arc<PresenceManager>,

// Set in constructor body:
presence,

// Add accessor method:
pub fn presence(&self) -> &Arc<PresenceManager> {
    &self.presence
}
```

- [ ] **Step 2: Instantiate PresenceManager in app.rs**

In `crates/remote/src/app.rs`, before the `AppState::new(...)` call:

```rust
use crate::presence::PresenceManager;

let presence = PresenceManager::new();
```

Then pass `presence` to `AppState::new(...)` as the last argument.

- [ ] **Step 3: Verify it compiles**

Run: `cargo check --manifest-path crates/remote/Cargo.toml`
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add crates/remote/src/state.rs crates/remote/src/app.rs
git commit -m "feat(presence): wire PresenceManager into AppState"
```

---

## Task 4: Backend — Auth Fix for WebSocket (JWT from Query Param)

**Files:**
- Modify: `crates/remote/src/auth/jwt.rs` (verify `verify_access_token` is public and returns `sub` as `Uuid`)

- [ ] **Step 1: Check existing JWT verify method**

Read `crates/remote/src/auth/jwt.rs` and confirm `verify_access_token` exists with a public signature that returns a claims struct containing `sub: Uuid`. The WebSocket handler in Task 2 calls `state.jwt().verify_access_token(&query.token)`.

If the method signature differs (e.g., returns a different claims type or the field is named differently), update the WebSocket handler in `routes/presence.rs` to match.

- [ ] **Step 2: Verify the presence route is NOT behind `require_session` middleware**

WebSocket upgrade requests from browsers cannot carry `Authorization` headers. The presence route authenticates via query parameter `?token=JWT`. Verify that in `routes/mod.rs`, the presence route is added to `v1_public` (not `v1_protected`), OR that the `require_session` middleware allows WebSocket upgrades with query-param tokens to pass through.

The simplest approach: move `presence::router()` into `v1_public`:

```rust
let v1_public = Router::<AppState>::new()
    .route("/health", get(health))
    .merge(oauth::public_router())
    .merge(organization_members::public_router())
    .merge(tokens::public_router())
    .merge(review::public_router())
    .merge(github_app::public_router())
    .merge(billing::public_router())
    .merge(presence::router());  // <-- Auth handled inside the handler
```

- [ ] **Step 3: Verify it compiles and run tests**

Run: `cargo check --manifest-path crates/remote/Cargo.toml`
Run: `cargo test --manifest-path crates/remote/Cargo.toml`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add crates/remote/src/routes/mod.rs crates/remote/src/auth/jwt.rs
git commit -m "feat(presence): configure WebSocket auth via query-param JWT"
```

---

## Task 5: Frontend — Presence Types

**Files:**
- Create: `packages/web-core/src/shared/lib/presence/types.ts`

- [ ] **Step 1: Create the TypeScript types**

```typescript
// packages/web-core/src/shared/lib/presence/types.ts

export interface UserPresence {
  user_id: string;
  viewing_issue_id: string | null;
  dragging_over_status_id: string | null;
}

// Messages FROM server TO client
export type ServerPresenceMessage = {
  type: 'presence_sync';
  users: UserPresence[];
} | {
  type: 'user_joined';
  user_id: string;
} | {
  type: 'user_left';
  user_id: string;
};

// Messages FROM client TO server
export type ClientPresenceMessage = {
  type: 'heartbeat';
  viewing_issue_id: string | null;
  dragging_over_status_id: string | null;
} | {
  type: 'disconnect';
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/web-core/src/shared/lib/presence/types.ts
git commit -m "feat(presence): add frontend TypeScript types"
```

---

## Task 6: Frontend — Presence Zustand Store

**Files:**
- Create: `packages/web-core/src/shared/lib/presence/presenceStore.ts`

- [ ] **Step 1: Create the Zustand store**

```typescript
// packages/web-core/src/shared/lib/presence/presenceStore.ts

import { create } from 'zustand';
import type { UserPresence } from './types';

interface PresenceState {
  /** Map of user_id -> presence state */
  users: Map<string, UserPresence>;
  /** Whether the WebSocket is connected */
  isConnected: boolean;

  // Actions
  syncUsers: (users: UserPresence[]) => void;
  removeUser: (userId: string) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  users: new Map(),
  isConnected: false,

  syncUsers: (users) =>
    set(() => {
      const map = new Map<string, UserPresence>();
      for (const user of users) {
        map.set(user.user_id, user);
      }
      return { users: map };
    }),

  removeUser: (userId) =>
    set((state) => {
      const next = new Map(state.users);
      next.delete(userId);
      return { users: next };
    }),

  setConnected: (connected) => set({ isConnected: connected }),

  reset: () => set({ users: new Map(), isConnected: false }),
}));

// ── Selectors ──

export const selectOnlineUsers = (state: PresenceState) =>
  Array.from(state.users.values());

export const selectUsersViewingIssue = (issueId: string) =>
  (state: PresenceState) =>
    Array.from(state.users.values()).filter(
      (u) => u.viewing_issue_id === issueId
    );

export const selectUsersDraggingOverStatus = (statusId: string) =>
  (state: PresenceState) =>
    Array.from(state.users.values()).filter(
      (u) => u.dragging_over_status_id === statusId
    );
```

- [ ] **Step 2: Commit**

```bash
git add packages/web-core/src/shared/lib/presence/presenceStore.ts
git commit -m "feat(presence): add Zustand presence store with selectors"
```

---

## Task 7: Frontend — WebSocket Connection Hook

**Files:**
- Create: `packages/web-core/src/shared/lib/presence/usePresenceSocket.ts`

- [ ] **Step 1: Create the WebSocket hook**

```typescript
// packages/web-core/src/shared/lib/presence/usePresenceSocket.ts

import { useEffect, useRef, useCallback } from 'react';
import { usePresenceStore } from './presenceStore';
import type {
  ClientPresenceMessage,
  ServerPresenceMessage,
} from './types';

const HEARTBEAT_INTERVAL_MS = 3_000;
const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface UsePresenceSocketOptions {
  /** Base URL for the remote API (e.g., https://cloud.vibekanban.com) */
  apiBaseUrl: string;
  /** JWT access token */
  accessToken: string | null;
  /** Project to join */
  projectId: string;
  /** Current user ID (excluded from presence list) */
  userId: string;
  /** Whether to enable the connection */
  enabled: boolean;
}

export function usePresenceSocket({
  apiBaseUrl,
  accessToken,
  projectId,
  userId,
  enabled,
}: UsePresenceSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const viewingIssueIdRef = useRef<string | null>(null);
  const draggingOverStatusIdRef = useRef<string | null>(null);

  const { syncUsers, removeUser, setConnected, reset } = usePresenceStore();

  const connect = useCallback(() => {
    if (!accessToken || !enabled) return;

    // Build WebSocket URL
    const wsProtocol = apiBaseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = apiBaseUrl.replace(/^https?:\/\//, '');
    const url = `${wsProtocol}://${host}/v1/presence?project_id=${projectId}&token=${accessToken}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0;

      // Start heartbeat
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const msg: ClientPresenceMessage = {
            type: 'heartbeat',
            viewing_issue_id: viewingIssueIdRef.current,
            dragging_over_status_id: draggingOverStatusIdRef.current,
          };
          ws.send(JSON.stringify(msg));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerPresenceMessage;
        switch (msg.type) {
          case 'presence_sync':
            syncUsers(msg.users);
            break;
          case 'user_left':
            removeUser(msg.user_id);
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }

      // Reconnect with exponential backoff
      if (enabled) {
        const delay = Math.min(
          RECONNECT_DELAY_MS * 2 ** reconnectAttemptRef.current,
          MAX_RECONNECT_DELAY_MS
        );
        reconnectAttemptRef.current += 1;
        setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [
    apiBaseUrl,
    accessToken,
    projectId,
    enabled,
    syncUsers,
    removeUser,
    setConnected,
  ]);

  // Connect on mount / reconnect on dependency change
  useEffect(() => {
    connect();

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
      }
      if (wsRef.current) {
        const msg: ClientPresenceMessage = { type: 'disconnect' };
        try {
          wsRef.current.send(JSON.stringify(msg));
        } catch {
          // Socket may already be closed
        }
        wsRef.current.close();
      }
      reset();
    };
  }, [connect, reset]);

  // Public API to update what this user is viewing/dragging
  const setViewingIssue = useCallback((issueId: string | null) => {
    viewingIssueIdRef.current = issueId;
  }, []);

  const setDraggingOverStatus = useCallback(
    (statusId: string | null) => {
      draggingOverStatusIdRef.current = statusId;
    },
    []
  );

  return { setViewingIssue, setDraggingOverStatus };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web-core/src/shared/lib/presence/usePresenceSocket.ts
git commit -m "feat(presence): add WebSocket connection hook with heartbeat and reconnect"
```

---

## Task 8: Frontend — PresenceProvider and usePresence Hook

**Files:**
- Create: `packages/web-core/src/shared/providers/PresenceProvider.tsx`
- Create: `packages/web-core/src/shared/hooks/usePresence.ts`

- [ ] **Step 1: Create the PresenceProvider**

```tsx
// packages/web-core/src/shared/providers/PresenceProvider.tsx

import {
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { usePresenceSocket } from '../lib/presence/usePresenceSocket';
import { useAuth } from '../hooks/auth/useAuth';

interface PresenceContextValue {
  setViewingIssue: (issueId: string | null) => void;
  setDraggingOverStatus: (statusId: string | null) => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

interface PresenceProviderProps {
  projectId: string;
  apiBaseUrl: string;
  children: ReactNode;
}

export function PresenceProvider({
  projectId,
  apiBaseUrl,
  children,
}: PresenceProviderProps) {
  const { accessToken, userId } = useAuth();

  const { setViewingIssue, setDraggingOverStatus } = usePresenceSocket({
    apiBaseUrl,
    accessToken,
    projectId,
    userId: userId ?? '',
    enabled: !!accessToken && !!userId,
  });

  return (
    <PresenceContext.Provider
      value={{ setViewingIssue, setDraggingOverStatus }}
    >
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresenceActions() {
  const ctx = useContext(PresenceContext);
  if (!ctx) {
    throw new Error('usePresenceActions must be used within PresenceProvider');
  }
  return ctx;
}
```

- [ ] **Step 2: Create the usePresence hook**

```typescript
// packages/web-core/src/shared/hooks/usePresence.ts

import {
  usePresenceStore,
  selectOnlineUsers,
  selectUsersViewingIssue,
  selectUsersDraggingOverStatus,
} from '../lib/presence/presenceStore';

export function useOnlineUsers() {
  return usePresenceStore(selectOnlineUsers);
}

export function useUsersViewingIssue(issueId: string) {
  return usePresenceStore(selectUsersViewingIssue(issueId));
}

export function useUsersDraggingOverStatus(statusId: string) {
  return usePresenceStore(selectUsersDraggingOverStatus(statusId));
}

export function usePresenceConnected() {
  return usePresenceStore((s) => s.isConnected);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web-core/src/shared/providers/PresenceProvider.tsx packages/web-core/src/shared/hooks/usePresence.ts
git commit -m "feat(presence): add PresenceProvider and usePresence hooks"
```

---

## Task 9: Frontend — PresenceAvatars UI Component

**Files:**
- Create: `packages/web-core/src/shared/components/presence/PresenceAvatars.tsx`

- [ ] **Step 1: Create the avatar stack component**

```tsx
// packages/web-core/src/shared/components/presence/PresenceAvatars.tsx

import { useOnlineUsers, usePresenceConnected } from '../../hooks/usePresence';
import { useOrgContext } from '../../hooks/useOrgContext';
import { cn } from '../../lib/utils';

const MAX_VISIBLE_AVATARS = 5;

export function PresenceAvatars() {
  const onlineUsers = useOnlineUsers();
  const isConnected = usePresenceConnected();
  const { membersWithProfilesById } = useOrgContext();

  if (!isConnected || onlineUsers.length === 0) return null;

  const visibleUsers = onlineUsers.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = onlineUsers.length - MAX_VISIBLE_AVATARS;

  return (
    <div className="flex items-center gap-1">
      <div className="flex -space-x-2">
        {visibleUsers.map((user) => {
          const member = membersWithProfilesById?.[user.user_id];
          const initials = member
            ? `${(member.first_name?.[0] ?? '').toUpperCase()}${(member.last_name?.[0] ?? '').toUpperCase()}`
            : '?';
          const displayName = member
            ? [member.first_name, member.last_name].filter(Boolean).join(' ') ||
              member.username ||
              'Unknown'
            : 'Unknown';

          return (
            <div
              key={user.user_id}
              title={`${displayName}${user.viewing_issue_id ? ' (viewing issue)' : ''}`}
              className={cn(
                'relative flex h-7 w-7 items-center justify-center rounded-full border-2 border-primary bg-brand text-[10px] font-semibold text-on-brand',
                user.viewing_issue_id && 'ring-2 ring-green-400'
              )}
            >
              {member?.avatar_url ? (
                <img
                  src={member.avatar_url}
                  alt={displayName}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                initials
              )}
              {/* Online dot */}
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-primary bg-green-500" />
            </div>
          );
        })}
      </div>
      {overflowCount > 0 && (
        <span className="text-xs text-low">+{overflowCount}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web-core/src/shared/components/presence/PresenceAvatars.tsx
git commit -m "feat(presence): add PresenceAvatars component"
```

---

## Task 10: Frontend — PresenceIndicator on Kanban Cards

**Files:**
- Create: `packages/web-core/src/shared/components/presence/PresenceIndicator.tsx`

- [ ] **Step 1: Create the indicator component**

```tsx
// packages/web-core/src/shared/components/presence/PresenceIndicator.tsx

import { useUsersViewingIssue } from '../../hooks/usePresence';
import { useOrgContext } from '../../hooks/useOrgContext';

interface PresenceIndicatorProps {
  issueId: string;
}

export function PresenceIndicator({ issueId }: PresenceIndicatorProps) {
  const viewers = useUsersViewingIssue(issueId);
  const { membersWithProfilesById } = useOrgContext();

  if (viewers.length === 0) return null;

  return (
    <div className="flex -space-x-1">
      {viewers.slice(0, 3).map((viewer) => {
        const member = membersWithProfilesById?.[viewer.user_id];
        const displayName = member
          ? [member.first_name, member.last_name].filter(Boolean).join(' ') ||
            member.username ||
            'Unknown'
          : 'Unknown';

        return (
          <div
            key={viewer.user_id}
            title={`${displayName} is viewing`}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-primary bg-amber-500 text-[8px] font-bold text-white"
          >
            {member?.avatar_url ? (
              <img
                src={member.avatar_url}
                alt={displayName}
                className="h-full w-full rounded-full object-cover"
              />
            ) : (
              (member?.first_name?.[0] ?? '?').toUpperCase()
            )}
          </div>
        );
      })}
      {viewers.length > 3 && (
        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-primary bg-secondary text-[8px] text-low">
          +{viewers.length - 3}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web-core/src/shared/components/presence/PresenceIndicator.tsx
git commit -m "feat(presence): add PresenceIndicator for kanban cards"
```

---

## Task 11: Frontend — Integrate Presence into Kanban Board

**Files:**
- Modify: `packages/web-core/src/features/kanban/ui/KanbanContainer.tsx`

This is the final integration step. We add `PresenceAvatars` to the board header and `PresenceIndicator` to each card. We also call `setViewingIssue()` when the user opens an issue panel.

- [ ] **Step 1: Import presence components**

At the top of `KanbanContainer.tsx`, add:

```typescript
import { PresenceAvatars } from '@/shared/components/presence/PresenceAvatars';
import { PresenceIndicator } from '@/shared/components/presence/PresenceIndicator';
```

- [ ] **Step 2: Add PresenceAvatars to the board header**

Find the filter bar / header area in the JSX (the area with `<KanbanFilterBar` or the board title). Add `<PresenceAvatars />` next to it. The exact location depends on the layout — place it in the top-right of the kanban board header:

Look for the area where the filter bar or board controls are rendered. Add:

```tsx
<PresenceAvatars />
```

In the header section, right-aligned next to existing controls.

- [ ] **Step 3: Add PresenceIndicator to each KanbanCard**

Inside the `KanbanCard` render, next to the card title or at the top-right, add:

```tsx
<PresenceIndicator issueId={issue.id} />
```

Place it inside the `<KanbanCardContent>` area or just after it, within the `<KanbanCard>` wrapper.

- [ ] **Step 4: Hook up setViewingIssue when user opens an issue**

Import and call the presence actions when the user clicks on an issue:

```typescript
import { usePresenceActions } from '@/shared/providers/PresenceProvider';

// Inside the component:
const presenceActions = usePresenceActions();

// In openIssue callback, add:
presenceActions.setViewingIssue(issueId);

// When issue panel closes, add:
presenceActions.setViewingIssue(null);
```

Wrap this in a try/catch or optional check in case `PresenceProvider` is not mounted (local mode).

- [ ] **Step 5: Run type checks**

Run: `pnpm run check`
Expected: No type errors.

- [ ] **Step 6: Run format and lint**

Run: `pnpm run format`
Run: `pnpm run lint`

- [ ] **Step 7: Commit**

```bash
git add packages/web-core/src/features/kanban/ui/KanbanContainer.tsx
git commit -m "feat(presence): integrate presence avatars and indicators into kanban board"
```

---

## Task 12: Frontend — Mount PresenceProvider in Remote App Shell

**Files:**
- Modify: `packages/remote-web/src/app/layout/RemoteAppShell.tsx` (or the nearest project-scoped layout)

Presence should only be active in the **remote/cloud** app (not the local desktop app). Mount `PresenceProvider` at the project layout level.

- [ ] **Step 1: Find the project-scoped layout in remote-web**

The provider needs `projectId` and `apiBaseUrl`. Mount it where both are available — likely inside the project route layout.

```tsx
import { PresenceProvider } from '@vibe/web-core/shared/providers/PresenceProvider';

// Wrap the project content:
<PresenceProvider
  projectId={projectId}
  apiBaseUrl={import.meta.env.VITE_API_BASE_URL}
>
  {children}
</PresenceProvider>
```

- [ ] **Step 2: Provide a no-op fallback for local-web**

In `packages/local-web`, the `PresenceProvider` is never mounted. Ensure `usePresenceActions` is called safely (with optional chaining or a try/catch) in `KanbanContainer.tsx`, or provide a no-op wrapper in local-web.

- [ ] **Step 3: Run full check**

Run: `pnpm run check`
Run: `pnpm run format`

- [ ] **Step 4: Commit**

```bash
git add packages/remote-web/src/app/layout/RemoteAppShell.tsx
git commit -m "feat(presence): mount PresenceProvider in remote app shell"
```

---

## Task 13: Backend — Verify Axum WebSocket Dependency

**Files:**
- Modify: `crates/remote/Cargo.toml` (if needed)

- [ ] **Step 1: Check that axum websocket feature is enabled**

The presence route uses `axum::extract::ws::WebSocketUpgrade`. Check `crates/remote/Cargo.toml` for the axum dependency and ensure the `ws` feature is enabled:

```toml
axum = { version = "0.8", features = ["ws"] }
```

If the `ws` feature is missing, add it.

- [ ] **Step 2: Check that `futures-util` is available**

The WebSocket handler uses `futures_util::{SinkExt, StreamExt}`. Verify `futures-util` (or `futures`) is in `Cargo.toml`:

```toml
futures-util = "0.3"
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check --manifest-path crates/remote/Cargo.toml`
Expected: Clean compile.

- [ ] **Step 4: Commit (if Cargo.toml changed)**

```bash
git add crates/remote/Cargo.toml
git commit -m "feat(presence): add ws feature to axum dependency"
```

---

## Task 14: End-to-End Smoke Test

- [ ] **Step 1: Start the remote dev stack**

```bash
pnpm run remote:dev
```

- [ ] **Step 2: Open two browser tabs to the same project**

Navigate to the same project in both tabs, logged in as different users (or the same user for initial testing).

- [ ] **Step 3: Verify WebSocket connects**

Open DevTools → Network → WS tab. Confirm a connection to `/v1/presence?project_id=...&token=...` is established.

- [ ] **Step 4: Verify presence avatars appear**

In tab 1, check that tab 2's user avatar appears in the `PresenceAvatars` component on the kanban board header.

- [ ] **Step 5: Verify issue viewing indicator**

Click on an issue in tab 1. In tab 2, verify a small indicator appears on that issue's kanban card.

- [ ] **Step 6: Verify disconnect cleanup**

Close tab 1. Within ~10 seconds, verify tab 2's presence avatars no longer show the disconnected user.

---

## Summary of Changes

| Layer | Files Changed | What It Does |
|-------|--------------|---------------|
| **Backend** | `presence.rs`, `routes/presence.rs`, `state.rs`, `app.rs`, `routes/mod.rs` | In-memory presence rooms, WebSocket handler, JWT auth |
| **Frontend Store** | `types.ts`, `presenceStore.ts` | Types + Zustand state management |
| **Frontend Socket** | `usePresenceSocket.ts` | WebSocket lifecycle, heartbeat, reconnect |
| **Frontend Provider** | `PresenceProvider.tsx`, `usePresence.ts` | React context + public API hooks |
| **Frontend UI** | `PresenceAvatars.tsx`, `PresenceIndicator.tsx` | Visual components |
| **Integration** | `KanbanContainer.tsx`, `RemoteAppShell.tsx` | Wire everything together |

**What is NOT changed:** Issue CRUD, ElectricSQL sync, database schema, existing API routes. Presence is purely additive and ephemeral.
