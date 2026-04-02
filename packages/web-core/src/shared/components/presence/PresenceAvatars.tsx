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
          const member = membersWithProfilesById.get(user.user_id);
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
