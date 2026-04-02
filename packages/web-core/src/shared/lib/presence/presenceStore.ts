import { create } from 'zustand';
import type { UserPresence } from './types';

type PresenceState = {
  users: Map<string, UserPresence>;
  isConnected: boolean;
  syncUsers: (users: UserPresence[]) => void;
  removeUser: (userId: string) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
};

export const usePresenceStore = create<PresenceState>()((set) => ({
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

export const selectOnlineUsers = (state: PresenceState) =>
  Array.from(state.users.values());

export const selectUsersViewingIssue =
  (issueId: string) => (state: PresenceState) =>
    Array.from(state.users.values()).filter(
      (u) => u.viewing_issue_id === issueId
    );

export const selectUsersDraggingOverStatus =
  (statusId: string) => (state: PresenceState) =>
    Array.from(state.users.values()).filter(
      (u) => u.dragging_over_status_id === statusId
    );
