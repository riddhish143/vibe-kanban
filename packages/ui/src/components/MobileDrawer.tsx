import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../lib/cn';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  return createPortal(
    <>
      {/* Backdrop overlay */}
      <div
        data-tauri-drag-region
        className={cn(
          'app-overlay-backdrop fixed inset-0 z-[100]',
          'transition-opacity duration-200 ease-out',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer panel */}
      <div
        className={cn(
          'app-drawer-shell fixed left-0 top-0 z-[101] h-full w-[300px]',
          'pb-[env(safe-area-inset-bottom)]',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full pointer-events-none'
        )}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
