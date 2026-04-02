import { useEffect, useRef, useCallback } from 'react';
import { usePresenceStore } from './presenceStore';
import type { ClientPresenceMessage, ServerPresenceMessage } from './types';
import { tokenManager } from '@/shared/lib/auth/tokenManager';
import { getRemoteApiUrl } from '@/shared/lib/remoteApi';

const HEARTBEAT_INTERVAL_MS = 3_000;
const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface UsePresenceSocketOptions {
  projectId: string;
  enabled: boolean;
}

export function usePresenceSocket({
  projectId,
  enabled,
}: UsePresenceSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewingIssueIdRef = useRef<string | null>(null);
  const draggingOverStatusIdRef = useRef<string | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const syncUsers = usePresenceStore((s) => s.syncUsers);
  const removeUser = usePresenceStore((s) => s.removeUser);
  const setConnected = usePresenceStore((s) => s.setConnected);
  const reset = usePresenceStore((s) => s.reset);

  const cleanup = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        const msg: ClientPresenceMessage = { type: 'disconnect' };
        ws.send(JSON.stringify(msg));
      } catch {
        // Socket may already be closed
      }
      ws.close();
    }
  }, []);

  const connect = useCallback(async () => {
    if (!enabledRef.current) return;

    cleanup();

    const accessToken = await tokenManager.getToken();
    if (!accessToken) return;

    const apiBase = getRemoteApiUrl();
    if (!apiBase) return;

    const wsProtocol = apiBase.startsWith('https') ? 'wss' : 'ws';
    const host = apiBase.replace(/^https?:\/\//, '');
    const url = `${wsProtocol}://${host}/v1/presence?project_id=${projectId}&token=${encodeURIComponent(accessToken)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0;

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

      if (enabledRef.current) {
        const delay = Math.min(
          RECONNECT_DELAY_MS * 2 ** reconnectAttemptRef.current,
          MAX_RECONNECT_DELAY_MS
        );
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [projectId, cleanup, syncUsers, removeUser, setConnected]);

  useEffect(() => {
    if (enabled) {
      connect();
    }

    return () => {
      cleanup();
      reset();
    };
  }, [enabled, connect, cleanup, reset]);

  const setViewingIssue = useCallback((issueId: string | null) => {
    viewingIssueIdRef.current = issueId;
  }, []);

  const setDraggingOverStatus = useCallback((statusId: string | null) => {
    draggingOverStatusIdRef.current = statusId;
  }, []);

  return { setViewingIssue, setDraggingOverStatus };
}
