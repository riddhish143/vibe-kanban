export interface UserPresence {
  user_id: string;
  viewing_issue_id: string | null;
  dragging_over_status_id: string | null;
}

export type ServerPresenceMessage =
  | {
      type: 'presence_sync';
      users: UserPresence[];
    }
  | {
      type: 'user_joined';
      user_id: string;
    }
  | {
      type: 'user_left';
      user_id: string;
    };

export type ClientPresenceMessage =
  | {
      type: 'heartbeat';
      viewing_issue_id: string | null;
      dragging_over_status_id: string | null;
    }
  | {
      type: 'disconnect';
    };
