import { type ReactNode, useRef, useCallback, useEffect } from 'react';
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

/* ── Spring-physics state for the cursor spotlight ── */
interface SpringState {
  // Current smoothed position (0–1 normalized)
  x: number;
  y: number;
  // Velocity
  vx: number;
  vy: number;
  // Target
  tx: number;
  ty: number;
  // Whether the cursor is inside the box
  active: boolean;
}

const SPRING_STIFFNESS = 0.08;
const SPRING_DAMPING = 0.78;

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

  const containerRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const glowLeftRef = useRef<HTMLDivElement>(null);
  const glowRightRef = useRef<HTMLDivElement>(null);
  const glowBottomRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  const spring = useRef<SpringState>({
    x: 0.5,
    y: 0.5,
    vx: 0,
    vy: 0,
    tx: 0.5,
    ty: 0.5,
    active: false,
  });

  /* ── Physics tick (requestAnimationFrame loop) ── */
  const tick = useCallback(() => {
    const s = spring.current;
    const dx = s.tx - s.x;
    const dy = s.ty - s.y;
    s.vx = (s.vx + dx * SPRING_STIFFNESS) * SPRING_DAMPING;
    s.vy = (s.vy + dy * SPRING_STIFFNESS) * SPRING_DAMPING;
    s.x += s.vx;
    s.y += s.vy;

    // Update spotlight position
    if (spotlightRef.current) {
      spotlightRef.current.style.transform = `translate(${s.x * 100 - 50}%, ${s.y * 100 - 50}%)`;
      spotlightRef.current.style.opacity = s.active ? '1' : '0';
    }

    // Shift ambient glow orbs slightly toward cursor for a reactive feel
    if (glowLeftRef.current) {
      const pullX = (s.x - 0.5) * 12;
      const pullY = (s.y - 0.5) * 18;
      glowLeftRef.current.style.transform = `translate(${pullX}px, ${pullY}px)`;
    }
    if (glowRightRef.current) {
      const pullX = (s.x - 0.5) * 12;
      const pullY = (s.y - 0.5) * 18;
      glowRightRef.current.style.transform = `translate(${pullX}px, ${pullY}px)`;
    }
    if (glowBottomRef.current) {
      const pullX = (s.x - 0.5) * 16;
      glowBottomRef.current.style.transform = `translateX(${pullX}px)`;
    }

    // Keep ticking while there's visible motion
    const moving =
      Math.abs(s.vx) > 0.0001 ||
      Math.abs(s.vy) > 0.0001 ||
      Math.abs(dx) > 0.0001 ||
      Math.abs(dy) > 0.0001;

    if (moving || s.active) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  const startLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /* ── Mouse handlers ── */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      spring.current.tx = Math.max(0, Math.min(1, nx));
      spring.current.ty = Math.max(0, Math.min(1, ny));
      if (!spring.current.active) {
        spring.current.active = true;
        startLoop();
      }
    },
    [startLoop]
  );

  const handleMouseLeave = useCallback(() => {
    // On leave, send target back to center with current velocity (inertia)
    spring.current.active = false;
    spring.current.tx = 0.5;
    spring.current.ty = 0.5;
    // Keep the loop running so it drifts back smoothly
    startLoop();
  }, [startLoop]);

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div
      ref={containerRef}
      {...(dropzone?.getRootProps() ?? {})}
      className={cn(
        'relative flex w-full max-w-[56rem] flex-col rounded-xl p-[1px] transition-all duration-300 group',
        isRunning && 'chat-box-running'
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
          @keyframes edge-glow-shift {
            0%   { background-position: 0% 50%; }
            50%  { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes edge-glow-pulse {
            0%, 100% { opacity: ${theme === 'dark' ? '0.55' : '0.35'}; }
            50%      { opacity: ${theme === 'dark' ? '0.85' : '0.55'}; }
          }

          .edge-border-layer {
            position: absolute;
            inset: 0;
            border-radius: inherit;
            padding: 1.5px;
            pointer-events: none;
            background: linear-gradient(
              90deg,
              ${theme === 'dark'
                ? '#d4401a, #ff6b35, #ff8c42, transparent 38%, transparent 62%, #4f8ef7, #6366f1, #7b5ec6'
                : '#c53d19, #e06030, #e07838, transparent 38%, transparent 62%, #3b6fd9, #5558d0, #6d52b0'}
            );
            background-size: 200% 100%;
            animation: edge-glow-shift 8s ease-in-out infinite;
            -webkit-mask:
              linear-gradient(#fff 0 0) content-box,
              linear-gradient(#fff 0 0);
            mask:
              linear-gradient(#fff 0 0) content-box,
              linear-gradient(#fff 0 0);
            -webkit-mask-composite: xor;
            mask-composite: exclude;
            opacity: ${theme === 'dark' ? '0.85' : '0.7'};
            transition: opacity 0.6s ease;
          }
          .group:hover .edge-border-layer {
            opacity: 1;
          }
          .group:focus-within .edge-border-layer {
            opacity: 1;
            animation: edge-glow-shift 5s ease-in-out infinite;
          }

          .edge-glow-left,
          .edge-glow-right,
          .edge-glow-bottom {
            pointer-events: none;
            position: absolute;
            border-radius: 50%;
            will-change: transform;
            transition: opacity 0.6s ease, filter 0.6s ease;
          }

          .edge-glow-left {
            left: -18px;
            top: 10%;
            width: 40%;
            height: 80%;
            background: radial-gradient(
              ellipse at center,
              ${theme === 'dark'
                ? 'rgba(212, 64, 26, 0.45), rgba(255, 107, 53, 0.22), transparent 70%'
                : 'rgba(197, 61, 25, 0.30), rgba(224, 96, 48, 0.15), transparent 70%'}
            );
            filter: blur(22px);
            opacity: ${theme === 'dark' ? '0.5' : '0.35'};
            mix-blend-mode: ${theme === 'dark' ? 'screen' : 'multiply'};
          }
          .edge-glow-right {
            right: -18px;
            top: 10%;
            width: 40%;
            height: 80%;
            background: radial-gradient(
              ellipse at center,
              ${theme === 'dark'
                ? 'rgba(79, 142, 247, 0.45), rgba(99, 102, 241, 0.22), transparent 70%'
                : 'rgba(59, 111, 217, 0.30), rgba(85, 88, 208, 0.15), transparent 70%'}
            );
            filter: blur(22px);
            opacity: ${theme === 'dark' ? '0.5' : '0.35'};
            mix-blend-mode: ${theme === 'dark' ? 'screen' : 'multiply'};
          }
          .edge-glow-bottom {
            bottom: -10px;
            left: 20%;
            width: 60%;
            height: 40%;
            background: radial-gradient(
              ellipse at center,
              ${theme === 'dark'
                ? 'rgba(99, 102, 241, 0.18), rgba(79, 142, 247, 0.10), transparent 70%'
                : 'rgba(85, 88, 208, 0.12), rgba(59, 111, 217, 0.06), transparent 70%'}
            );
            filter: blur(18px);
            opacity: ${theme === 'dark' ? '0.4' : '0.25'};
            mix-blend-mode: ${theme === 'dark' ? 'screen' : 'multiply'};
          }

          .group:hover .edge-glow-left,
          .group:hover .edge-glow-right {
            opacity: ${theme === 'dark' ? '0.7' : '0.5'};
            filter: blur(28px);
          }
          .group:hover .edge-glow-bottom {
            opacity: ${theme === 'dark' ? '0.55' : '0.35'};
            filter: blur(24px);
          }
          .group:focus-within .edge-glow-left,
          .group:focus-within .edge-glow-right {
            opacity: ${theme === 'dark' ? '0.9' : '0.65'};
            filter: blur(32px);
            animation: edge-glow-pulse 3s ease-in-out infinite;
          }
          .group:focus-within .edge-glow-bottom {
            opacity: ${theme === 'dark' ? '0.7' : '0.45'};
            filter: blur(28px);
            animation: edge-glow-pulse 3.5s ease-in-out infinite;
          }

          /* Cursor-tracking spotlight */
          .edge-cursor-spotlight {
            position: absolute;
            width: 180px;
            height: 180px;
            border-radius: 50%;
            pointer-events: none;
            will-change: transform, opacity;
            opacity: 0;
            transition: opacity 0.4s ease;
            filter: blur(30px);
            mix-blend-mode: ${theme === 'dark' ? 'screen' : 'multiply'};
            z-index: 1;
            background: radial-gradient(
              circle at center,
              ${theme === 'dark'
                ? 'rgba(255, 140, 66, 0.5), rgba(99, 102, 241, 0.3), transparent 70%'
                : 'rgba(224, 96, 48, 0.35), rgba(85, 88, 208, 0.2), transparent 70%'}
            );
          }
        `,
        }}
      />

      {/* Cursor-tracking spotlight (positioned via spring physics) */}
      <div ref={spotlightRef} className="edge-cursor-spotlight" />

      {/* Ambient glow layers (shift with cursor via physics) */}
      <div ref={glowLeftRef} className="edge-glow-left" />
      <div ref={glowRightRef} className="edge-glow-right" />
      <div ref={glowBottomRef} className="edge-glow-bottom" />

      {/* Border gradient layer */}
      <div className="edge-border-layer" />
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
