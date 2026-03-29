import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CheckIcon, PaperclipIcon, XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Checkbox } from './Checkbox';
import { ChatBoxBase, VisualVariant, type DropzoneProps } from './ChatBoxBase';
import { DropdownMenuItem, DropdownMenuLabel } from './Dropdown';
import { PrimaryButton } from './PrimaryButton';
import type { LocalAttachmentMetadata } from './WorkspaceContext';
import { ToolbarDropdown, ToolbarIconButton } from './Toolbar';

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
}

export interface ModelSelectorProps<TExecutorConfig = unknown> {
  onAdvancedSettings: () => void;
  presets: string[];
  selectedPreset: string | null;
  onPresetSelect: (presetId: string | null) => void;
  onOverrideChange: (partial: Partial<TExecutorConfig>) => void;
  executorConfig: TExecutorConfig | null;
  presetOptions: TExecutorConfig | null | undefined;
}

export interface ExecutorProps<TExecutor extends string = string> {
  selected: TExecutor | null;
  options: TExecutor[];
  onChange: (executor: TExecutor) => void;
}

export interface SaveAsDefaultProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  visible: boolean;
}

export interface LinkedIssueBadgeProps {
  simpleId: string;
  title: string;
  onRemove: () => void;
}

export interface CreateChatBoxEditorRenderProps<
  TExecutor extends string = string,
> {
  value: string;
  onChange: (value: string) => void;
  onCmdEnter: () => void;
  disabled: boolean;
  repoIds?: string[];
  repoId?: string;
  executor: TExecutor | null;
  onPasteFiles?: (files: File[]) => void;
  localAttachments?: LocalAttachmentMetadata[];
}

interface CreateChatBoxProps<TExecutor extends string = string> {
  editor: EditorProps;
  renderEditor: (props: CreateChatBoxEditorRenderProps<TExecutor>) => ReactNode;
  agentIcon?: ReactNode;
  onSend: () => void;
  isSending: boolean;
  disabled?: boolean;
  executor: ExecutorProps<TExecutor>;
  formatExecutorLabel?: (executor: TExecutor) => string;
  emptyExecutorLabel?: string;
  saveAsDefault?: SaveAsDefaultProps;
  error?: string | null;
  repoIds?: string[];
  repoId?: string;
  modelSelector?: ReactNode;
  onPasteFiles?: (files: File[]) => void;
  localAttachments?: LocalAttachmentMetadata[];
  dropzone?: DropzoneProps;
  onEditRepos: () => void;
  repoSummaryLabel: string;
  repoSummaryTitle: string;
  linkedIssue?: LinkedIssueBadgeProps | null;
  theme?: 'light' | 'dark';
}

/**
 * Lightweight chat box for create mode.
 * Supports sending and attachments - no queue, stop, or feedback functionality.
 */
function defaultExecutorLabel(executor: string) {
  return executor
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function CreateChatBox<TExecutor extends string = string>({
  editor,
  renderEditor,
  agentIcon,
  onSend,
  isSending,
  disabled = false,
  executor,
  formatExecutorLabel = defaultExecutorLabel,
  emptyExecutorLabel = 'Select Executor',
  saveAsDefault,
  error,
  repoIds,
  repoId,
  modelSelector,
  onPasteFiles,
  localAttachments,
  dropzone,
  onEditRepos,
  repoSummaryLabel,
  repoSummaryTitle,
  linkedIssue,
  theme,
}: CreateChatBoxProps<TExecutor>) {
  const { t } = useTranslation(['common', 'tasks']);
  const prefersReducedMotion = useReducedMotion();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const sendButtonAnchorRef = useRef<HTMLDivElement>(null);
  const sendTimerRef = useRef<number | null>(null);

  const isDisabled = disabled || isSending;
  const canSend = editor.value.trim().length > 0 && !isDisabled;
  const [isPromptActivated, setIsPromptActivated] = useState(false);
  const [activationPulseKey, setActivationPulseKey] = useState(0);
  const [isSubmitAnimating, setIsSubmitAnimating] = useState(false);
  const [travel, setTravel] = useState<{
    startX: number;
    startY: number;
    dx: number;
    dy: number;
  } | null>(null);

  useEffect(
    () => () => {
      if (sendTimerRef.current !== null) {
        window.clearTimeout(sendTimerRef.current);
      }
    },
    []
  );

  const activatePrompt = useCallback(() => {
    if (isPromptActivated) return;
    setIsPromptActivated(true);
    setActivationPulseKey((n) => n + 1);
  }, [isPromptActivated]);

  const computeTravelVector = useCallback(() => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const editorRect = editorShellRef.current?.getBoundingClientRect();
    const sendRect = sendButtonAnchorRef.current?.getBoundingClientRect();
    if (!containerRect || !editorRect || !sendRect) return null;

    const startX = editorRect.left - containerRect.left + 24;
    const startY = editorRect.top - containerRect.top + editorRect.height / 2;
    const endX = sendRect.left - containerRect.left + sendRect.width / 2;
    const endY = sendRect.top - containerRect.top + sendRect.height / 2;

    return {
      startX,
      startY,
      dx: endX - startX,
      dy: endY - startY,
    };
  }, []);

  const runSendSequence = useCallback(() => {
    if (!canSend || isSubmitAnimating) return;

    if (prefersReducedMotion) {
      onSend();
      return;
    }

    const vector = computeTravelVector();
    setTravel(vector);
    setIsSubmitAnimating(true);

    sendTimerRef.current = window.setTimeout(() => {
      onSend();
      setIsSubmitAnimating(false);
      setTravel(null);
      sendTimerRef.current = null;
    }, 260);
  }, [canSend, computeTravelVector, isSubmitAnimating, onSend, prefersReducedMotion]);

  const handleCmdEnter = () => {
    runSendSequence();
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0 && onPasteFiles) {
      onPasteFiles(files);
    }
    e.target.value = '';
  };

  const executorLabel = executor.selected
    ? formatExecutorLabel(executor.selected)
    : emptyExecutorLabel;

  return (
    <div ref={containerRef} className="relative">
      <AnimatePresence>
        {travel && (
          <motion.div
            className="pointer-events-none absolute z-20 h-8 w-24 rounded-full"
            style={{
              left: travel.startX,
              top: travel.startY,
              background:
                theme === 'dark'
                  ? 'linear-gradient(95deg, rgba(107,114,255,0.0) 0%, rgba(111,222,255,0.78) 40%, rgba(167,139,250,0.0) 100%)'
                  : 'linear-gradient(95deg, rgba(59,130,246,0.0) 0%, rgba(37,99,235,0.55) 45%, rgba(14,165,233,0.0) 100%)',
              filter: 'blur(0.35px)',
              transformOrigin: 'left center',
            }}
            initial={{ opacity: 0, scaleX: 0.6, scaleY: 0.8 }}
            animate={{
              opacity: [0, 0.95, 0.2, 0],
              scaleX: [0.7, 1.05, 1.2, 0.78],
              scaleY: [0.9, 1, 0.88, 0.6],
              x: travel.dx,
              y: travel.dy,
            }}
            exit={{ opacity: 0 }}
            transition={{
              duration: 0.42,
              times: [0, 0.22, 0.7, 1],
              ease: [0.22, 1, 0.36, 1],
            }}
          />
        )}
      </AnimatePresence>

      <ChatBoxBase
        editor={
          <motion.div
            ref={editorShellRef}
            className="relative rounded-md"
            onPointerDownCapture={activatePrompt}
            onFocusCapture={activatePrompt}
            animate={
              isSubmitAnimating
                ? {
                    scale: 0.995,
                    y: 2,
                  }
                : {
                    scale: 1,
                    y: 0,
                  }
            }
            transition={{
              type: 'spring',
              stiffness: 430,
              damping: 34,
              mass: 0.5,
            }}
            style={{ willChange: 'transform' }}
          >
            <AnimatePresence>
              {activationPulseKey > 0 && !isSubmitAnimating && (
                <motion.div
                  key={activationPulseKey}
                  className="pointer-events-none absolute -inset-1 z-10 rounded-[10px]"
                  style={{
                    background:
                      theme === 'dark'
                        ? 'radial-gradient(130% 120% at 8% 50%, rgba(110,231,255,0.22), rgba(129,140,248,0.12) 46%, rgba(0,0,0,0) 76%)'
                        : 'radial-gradient(130% 120% at 8% 50%, rgba(37,99,235,0.2), rgba(56,189,248,0.14) 46%, rgba(255,255,255,0) 76%)',
                    boxShadow:
                      theme === 'dark'
                        ? '0 0 0 1px rgba(125,211,252,0.24), 0 16px 40px -28px rgba(99,102,241,0.65)'
                        : '0 0 0 1px rgba(59,130,246,0.2), 0 16px 38px -30px rgba(37,99,235,0.35)',
                  }}
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: [0, 0.95, 0], scale: [0.985, 1, 1.012] }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: 0.56,
                    times: [0, 0.36, 1],
                    ease: [0.2, 0.95, 0.2, 1],
                  }}
                />
              )}
            </AnimatePresence>

            {isSubmitAnimating && (
              <motion.div
                className="pointer-events-none absolute -inset-1 z-10 rounded-[10px]"
                style={{
                  background:
                    theme === 'dark'
                      ? 'linear-gradient(105deg, rgba(56,189,248,0.16) 0%, rgba(99,102,241,0.18) 50%, rgba(244,114,182,0.12) 100%)'
                      : 'linear-gradient(105deg, rgba(59,130,246,0.14) 0%, rgba(14,165,233,0.18) 56%, rgba(99,102,241,0.08) 100%)',
                }}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: [0, 0.95, 0], x: [0, 10, 24] }}
                transition={{
                  duration: 0.34,
                  times: [0, 0.42, 1],
                  ease: [0.18, 0.98, 0.24, 1],
                }}
              />
            )}

            {renderEditor({
              value: editor.value,
              onChange: editor.onChange,
              onCmdEnter: handleCmdEnter,
              disabled: isDisabled || isSubmitAnimating,
              repoIds,
              repoId,
              executor: executor.selected ?? null,
              onPasteFiles,
              localAttachments,
            })}
          </motion.div>
        }
        error={error}
        visualVariant={VisualVariant.NORMAL}
        dropzone={dropzone}
        modelSelector={modelSelector}
        theme={theme}
        headerLeft={
          <>
            {agentIcon}
            <ToolbarDropdown label={executorLabel} disabled={isDisabled}>
              <DropdownMenuLabel>
                {t('tasks:conversation.executors')}
              </DropdownMenuLabel>
              {executor.options.map((exec) => (
                <DropdownMenuItem
                  key={exec}
                  icon={executor.selected === exec ? CheckIcon : undefined}
                  onClick={() => executor.onChange(exec)}
                >
                  {formatExecutorLabel(exec)}
                </DropdownMenuItem>
              ))}
            </ToolbarDropdown>
            {saveAsDefault?.visible && (
              <label className="flex items-center gap-1.5 text-sm text-low cursor-pointer ml-2">
                <Checkbox
                  checked={saveAsDefault.checked}
                  onCheckedChange={saveAsDefault.onChange}
                  className="h-3.5 w-3.5"
                  disabled={isDisabled}
                />
                <span>{t('tasks:conversation.saveAsDefault')}</span>
              </label>
            )}
          </>
        }
        footerLeft={
          <>
            <ToolbarIconButton
              icon={PaperclipIcon}
              aria-label={t('tasks:taskFormDialog.attachFile')}
              title={t('tasks:taskFormDialog.attachFile')}
              onClick={handleAttachClick}
              disabled={isDisabled}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={onEditRepos}
              title={repoSummaryTitle}
              disabled={isDisabled}
              className="max-w-[320px] truncate text-sm text-normal hover:text-high disabled:cursor-not-allowed disabled:opacity-50"
            >
              {repoSummaryLabel}
            </button>
            {linkedIssue && (
              <>
                <div
                  className="inline-flex items-center gap-half whitespace-nowrap text-sm text-low"
                  title={linkedIssue.title}
                >
                  <span className="font-mono text-xs text-normal">
                    {linkedIssue.simpleId}
                  </span>
                  <button
                    type="button"
                    onClick={linkedIssue.onRemove}
                    disabled={isDisabled}
                    className="inline-flex items-center text-low hover:text-error transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Remove link to ${linkedIssue.simpleId}`}
                  >
                    <XIcon className="size-icon-xs" weight="bold" />
                  </button>
                </div>
              </>
            )}
          </>
        }
        footerRight={
          <div ref={sendButtonAnchorRef}>
            <PrimaryButton
              onClick={runSendSequence}
              disabled={!canSend || isSubmitAnimating}
              actionIcon={isSending ? 'spinner' : undefined}
              value={
                isSending
                  ? t('tasks:conversation.workspace.creating')
                  : t('tasks:conversation.workspace.create')
              }
            />
          </div>
        }
      />
    </div>
  );
}
