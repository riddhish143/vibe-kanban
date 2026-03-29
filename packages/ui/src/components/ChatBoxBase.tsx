import { type ReactNode } from 'react';
import { ImageIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Toolbar } from './Toolbar';

export enum VisualVariant {
  NORMAL = 'NORMAL',
  FEEDBACK = 'FEEDBACK',
  EDIT = 'EDIT',
  PLAN = 'PLAN',
}

export interface DropzoneProps {
  getRootProps: () => Record<string, unknown>;
  getInputProps: () => Record<string, unknown>;
  isDragActive: boolean;
}

interface ChatBoxBaseProps {
  // Editor node (provided by frontend)
  editor: ReactNode;

  // Error display
  error?: string | null;

  // Header content (right side - session/executor dropdown)
  headerRight?: ReactNode;

  // Header content (left side - stats)
  headerLeft?: ReactNode;

  // Footer left content (additional toolbar items like attach button)
  footerLeft?: ReactNode;

  // Footer right content (action buttons)
  footerRight: ReactNode;

  // Model selector node (rendered with footer controls)
  modelSelector?: ReactNode;

  // Banner content (queued message indicator, feedback mode indicator)
  banner?: ReactNode;

  // visualVariant
  visualVariant: VisualVariant;

  // Whether the workspace is running (shows animated border)
  isRunning?: boolean;

  // Dropzone props for drag-and-drop image uploads
  dropzone?: DropzoneProps;

  // theme
  theme?: 'light' | 'dark';
}

/**
 * Base chat box layout component.
 * Provides shared structure for CreateChatBox and SessionChatBox.
 */
export function ChatBoxBase({
  editor,
  error,
  headerRight,
  headerLeft,
  footerLeft,
  footerRight,
  modelSelector,
  banner,
  visualVariant,
  isRunning,
  dropzone,
  theme = 'dark',
}: ChatBoxBaseProps) {
  const { t } = useTranslation(['common', 'tasks']);

  const isDragActive = dropzone?.isDragActive ?? false;

  return (
    <div
      {...(dropzone?.getRootProps() ?? {})}
      className={cn(
        'relative flex w-full max-w-[56rem] flex-col rounded-xl p-[1px] transition-all duration-300 group',
        isRunning && 'chat-box-running'
      )}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
          @keyframes neon-sweep {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes neon-glow-pulse {
            0% { opacity: 0.3; filter: blur(10px); }
            50% { opacity: 0.6; filter: blur(18px); }
            100% { opacity: 0.3; filter: blur(10px); }
          }
          .neon-wrapper {
            position: absolute;
            inset: 0;
            border-radius: inherit;
            overflow: hidden;
            pointer-events: none;
            opacity: ${theme === 'dark' ? '0.8' : '1'};
          }
          .neon-sweep {
            position: absolute;
            inset: -150%;
            background: conic-gradient(
              from 0deg,
              transparent 0deg,
              transparent 180deg,
              ${theme === 'dark' ? 'rgba(59, 130, 246, 0.4)' : 'rgba(37, 99, 235, 0.6)'} 240deg,
              ${theme === 'dark' ? 'rgba(168, 85, 247, 0.7)' : 'rgba(147, 51, 234, 0.8)'} 300deg,
              ${theme === 'dark' ? 'rgba(236, 72, 153, 0.4)' : 'rgba(219, 39, 119, 0.6)'} 360deg
            );
            animation: neon-sweep 6s linear infinite;
          }
          .neon-glow-container {
            position: absolute;
            inset: -6px;
            border-radius: 16px;
            overflow: hidden;
            pointer-events: none;
            filter: blur(12px);
            opacity: ${theme === 'dark' ? '0.2' : '0.4'};
            mix-blend-mode: ${theme === 'dark' ? 'screen' : 'multiply'};
            transition: all 0.8s ease;
          }
          .group:hover .neon-glow-container {
            opacity: ${theme === 'dark' ? '0.4' : '0.6'};
            filter: blur(20px);
          }
          .group:focus-within .neon-glow-container {
            opacity: ${theme === 'dark' ? '0.7' : '0.8'};
            filter: blur(25px);
            animation: neon-glow-pulse 3s ease-in-out infinite;
          }
          .group:focus-within .neon-sweep {
            animation-duration: 4s;
          }
        `,
        }}
      />

      {/* Glow Layer (Large blurred sweep) */}
      <div className="neon-glow-container">
        <div className="neon-sweep" />
      </div>

      {/* Border Layer (Tight sweep in overflow-hidden box) */}
      <div className="neon-wrapper">
        <div className="neon-sweep" />
      </div>
      <div
        className={cn(
          'relative flex flex-col w-full h-full rounded-[10px] bg-secondary overflow-hidden z-10',
          (visualVariant === VisualVariant.FEEDBACK ||
            visualVariant === VisualVariant.EDIT ||
            visualVariant === VisualVariant.PLAN) &&
            'bg-brand/10'
        )}
      >
        {dropzone && <input {...dropzone.getInputProps()} />}

        {isDragActive && (
          <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[10px] border-2 border-dashed border-brand bg-primary/80 backdrop-blur-sm pointer-events-none animate-in fade-in-0 duration-150">
            <div className="text-center">
              <div className="mx-auto mb-2 w-10 h-10 rounded-full bg-brand/10 flex items-center justify-center">
                <ImageIcon className="h-5 w-5 text-brand" />
              </div>
              <p className="text-sm font-medium text-high">
                {t('tasks:dropzone.dropImagesHere')}
              </p>
              <p className="text-xs text-low mt-0.5">
                {t('tasks:dropzone.supportedFormats')}
              </p>
            </div>
          </div>
        )}
        {/* Error alert */}
        {error && (
          <div className="bg-error/10 border-b px-double py-base">
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {/* Banner content (queued indicator, feedback mode, etc.) */}
        {banner}

        {/* Header - Stats and selector */}
        {visualVariant === VisualVariant.NORMAL && (
          <div className="flex items-center gap-3 border-b px-double py-[18px]">
            <div className="flex flex-1 items-center gap-3 text-sm min-w-0 overflow-hidden">
              {headerLeft}
            </div>
            <Toolbar className="gap-3">{headerRight}</Toolbar>
          </div>
        )}

        {/* Editor area */}
        <div className="flex flex-col gap-4 px-double py-double rounded-md">
          {editor}

          {/* Footer - Controls */}
          <div className="flex items-end justify-between gap-4">
            <Toolbar className="flex-1 min-w-0 flex-wrap !gap-3">
              {modelSelector}
              {footerLeft}
            </Toolbar>
            <div className="flex shrink-0 gap-3">{footerRight}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
