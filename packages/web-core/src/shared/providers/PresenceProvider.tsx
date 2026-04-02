import { createContext, useContext, type ReactNode } from 'react';
import { usePresenceSocket } from '../lib/presence/usePresenceSocket';
import { useAuth } from '../hooks/auth/useAuth';

interface PresenceContextValue {
  setViewingIssue: (issueId: string | null) => void;
  setDraggingOverStatus: (statusId: string | null) => void;
}

const noop = () => {};

const defaultValue: PresenceContextValue = {
  setViewingIssue: noop,
  setDraggingOverStatus: noop,
};

const PresenceContext = createContext<PresenceContextValue>(defaultValue);

interface PresenceProviderProps {
  projectId: string;
  children: ReactNode;
}

export function PresenceProvider({
  projectId,
  children,
}: PresenceProviderProps) {
  const { isSignedIn } = useAuth();

  const { setViewingIssue, setDraggingOverStatus } = usePresenceSocket({
    projectId,
    enabled: isSignedIn,
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
  return useContext(PresenceContext);
}
