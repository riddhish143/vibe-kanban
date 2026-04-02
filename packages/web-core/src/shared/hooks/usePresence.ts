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
