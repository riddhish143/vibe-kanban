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
        const member = membersWithProfilesById.get(viewer.user_id);
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
