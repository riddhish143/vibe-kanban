import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropzone } from 'react-dropzone';
import { useCreateMode } from '@/features/create-mode/model/useCreateMode';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { useCreateWorkspace } from '@/shared/hooks/useCreateWorkspace';
import { useCreateAttachments } from '@/shared/hooks/useCreateAttachments';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { saveProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import { getSortedExecutorVariantKeys } from '@/shared/lib/executor';
import {
  toPrettyCase,
  splitMessageToTitleDescription,
} from '@/shared/lib/string';
import type { BaseCodingAgent, Repo } from 'shared/types';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { CreateModeRepoPickerBar } from './CreateModeRepoPickerBar';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';

function getRepoDisplayName(repo: Repo) {
  return repo.display_name || repo.name;
}

const BRANCH_LABEL_MAX_CHARS = 15;

function truncateBranchLabel(branch: string) {
  return branch.length > BRANCH_LABEL_MAX_CHARS
    ? `${branch.slice(0, BRANCH_LABEL_MAX_CHARS)}...`
    : branch;
}

interface CreateChatBoxContainerProps {
  onWorkspaceCreated: (workspaceId: string) => void;
}

export function CreateChatBoxContainer({
  onWorkspaceCreated,
}: CreateChatBoxContainerProps) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const resolvedTheme = getResolvedTheme(theme);
  const { profiles, config } = useUserSystem();
  const {
    repos,
    targetBranches,
    message,
    setMessage,
    clearDraft,
    hasInitialValue,
    hasResolvedInitialRepoDefaults,
    linkedIssue,
    clearLinkedIssue,
    preferredExecutorConfig,
    executorConfig: draftConfig,
    setExecutorConfig: setDraftConfig,
    attachments: draftAttachments,
    setAttachments: setDraftAttachments,
  } = useCreateMode();

  const { createWorkspace } = useCreateWorkspace();
  const hasSelectedRepos = repos.length > 0;
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [hasInitializedStep, setHasInitializedStep] = useState(false);
  const [isSelectingRepos, setIsSelectingRepos] = useState(true);

  useEffect(() => {
    if (!hasInitialValue || hasInitializedStep) return;
    if (!hasSelectedRepos && !hasResolvedInitialRepoDefaults) return;

    setIsSelectingRepos(!hasSelectedRepos);
    setHasInitializedStep(true);
  }, [
    hasInitialValue,
    hasInitializedStep,
    hasSelectedRepos,
    hasResolvedInitialRepoDefaults,
  ]);

  const showRepoPickerStep = !hasSelectedRepos || isSelectingRepos;
  const showChatStep = hasSelectedRepos && !isSelectingRepos;

  // Attachment handling - insert markdown and track attachment IDs
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      const newMessage = message.trim()
        ? `${message}\n\n${markdown}`
        : markdown;
      setMessage(newMessage);
    },
    [message, setMessage]
  );

  const { uploadFiles, getAttachmentIds, clearAttachments, localAttachments } =
    useCreateAttachments(
      handleInsertMarkdown,
      draftAttachments,
      setDraftAttachments
    );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        uploadFiles(acceptedFiles);
      }
    },
    [uploadFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: createWorkspace.isPending || !hasSelectedRepos,
    noClick: true,
    noKeyboard: true,
  });

  const scratchConfig = useMemo(() => {
    if (!hasInitialValue) return undefined; // still loading
    return draftConfig ?? null;
  }, [hasInitialValue, draftConfig]);

  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setOverrides: setExecutorOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: preferredExecutorConfig,
    scratchConfig,
    configExecutorProfile: config?.executor_profile,
    onPersist: (cfg) => setDraftConfig(cfg),
  });

  const repoId = repos.length === 1 ? repos[0]?.id : undefined;
  const repoSummaryLabel = useMemo(() => {
    if (repos.length === 1) {
      const repo = repos[0];
      if (!repo) return '0 repositories selected';
      const selectedBranch = targetBranches[repo.id];
      const branch = selectedBranch
        ? truncateBranchLabel(selectedBranch)
        : 'Select branch';
      return `${getRepoDisplayName(repo)} · ${branch}`;
    }

    return `${repos.length} repositories selected`;
  }, [repos, targetBranches]);

  const repoSummaryTitle = useMemo(
    () =>
      repos
        .map((repo) => {
          const branch = targetBranches[repo.id] ?? 'Select branch';
          return `${getRepoDisplayName(repo)} (${branch})`;
        })
        .join('\n'),
    [repos, targetBranches]
  );

  const hasSelectedBranchesForAllRepos = repos.every(
    (repo) => !!targetBranches[repo.id]
  );

  // Determine if we can submit
  const canSubmit =
    hasSelectedRepos &&
    hasSelectedBranchesForAllRepos &&
    message.trim().length > 0 &&
    effectiveExecutor !== null;

  const handlePresetSelect = (presetId: string | null) => {
    if (!effectiveExecutor) return;
    setDraftConfig({
      ...draftConfig,
      executor: effectiveExecutor,
      variant: presetId,
    });
  };

  const handleCustomise = () => {
    SettingsDialog.show({ initialSection: 'agents' });
  };

  // Handle executor change - use saved variant if switching to default executor
  const handleExecutorChange = useCallback(
    (executor: BaseCodingAgent) => {
      const executorProfile = profiles?.[executor];
      if (!executorProfile) {
        setDraftConfig({ executor, variant: null });
        return;
      }

      const variants = getSortedExecutorVariantKeys(executorProfile);
      let targetVariant: string | null = null;

      // If switching to user's default executor, use their saved variant
      if (
        config?.executor_profile?.executor === executor &&
        config?.executor_profile?.variant
      ) {
        const savedVariant = config.executor_profile.variant;
        if (variants.includes(savedVariant)) {
          targetVariant = savedVariant;
        }
      }

      // Fallback to DEFAULT or first available
      if (!targetVariant) {
        targetVariant = variants.includes('DEFAULT')
          ? 'DEFAULT'
          : (variants[0] ?? null);
      }

      setDraftConfig({ executor, variant: targetVariant });
    },
    [profiles, setDraftConfig, config?.executor_profile]
  );

  // Handle submit
  const handleSubmit = useCallback(async () => {
    setHasAttemptedSubmit(true);
    if (!canSubmit || !executorConfig) return;

    const { title } = splitMessageToTitleDescription(message);
    const data = {
      executor_config: executorConfig,
      name: title,
      prompt: message,
      repos: repos.map((r) => ({
        repo_id: r.id,
        target_branch: targetBranches[r.id]!,
      })),
      linked_issue: linkedIssue
        ? {
            remote_project_id: linkedIssue.remoteProjectId,
            issue_id: linkedIssue.issueId,
          }
        : null,
      attachment_ids: getAttachmentIds(),
    };
    const linkToIssue = linkedIssue
      ? {
          remoteProjectId: linkedIssue.remoteProjectId,
          issueId: linkedIssue.issueId,
        }
      : undefined;

    const result = await createWorkspace.mutateAsync({
      data,
      linkToIssue,
    });

    if (result.workspace) {
      onWorkspaceCreated(result.workspace.id);
    }

    if (linkedIssue?.remoteProjectId) {
      saveProjectRepoDefaults(linkedIssue.remoteProjectId, data.repos).catch(
        (err) => console.warn('Failed to save project repo defaults:', err)
      );
    }

    clearAttachments();
    await clearDraft();
  }, [
    canSubmit,
    executorConfig,
    message,
    repos,
    targetBranches,
    createWorkspace,
    onWorkspaceCreated,
    getAttachmentIds,
    clearAttachments,
    clearDraft,
    linkedIssue,
  ]);

  // Determine error to display
  const displayError =
    hasAttemptedSubmit && repos.length === 0
      ? 'Add at least one repository to create a workspace'
      : hasAttemptedSubmit && !hasSelectedBranchesForAllRepos
        ? 'Select a branch for every repository before creating a workspace'
        : createWorkspace.error
          ? createWorkspace.error instanceof Error
            ? createWorkspace.error.message
            : 'Failed to create workspace'
          : null;

  // Wait for initial value to be applied before rendering
  // This ensures the editor mounts with content ready, so autoFocus works correctly
  if (!hasInitialValue) {
    return null;
  }

  const AsicBackground = () => {
    const isDark = resolvedTheme === 'dark';

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ripplesRef = useRef<{ x: number; y: number; startTime: number }[]>(
      []
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let animationFrameId: number;
      const resizeCanvas = () => {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
      };

      window.addEventListener('resize', resizeCanvas);
      resizeCanvas();

      const chars = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
      const baseColors = [
        '#000000',
        '#000000',
        '#000000',
        '#111111',
        '#333333',
        '#666666',
        '#999999',
        '#cccccc',
        '#ffffff',
      ];
      const colors = isDark ? baseColors : [...baseColors].reverse();
      const canvasBg = isDark ? '#000000' : '#ffffff';

      const noise = (x: number, y: number, t: number) => {
        return (
          (Math.sin(x * 0.04 + t * 0.8) +
            Math.cos(y * 0.04 - t * 0.6) +
            Math.sin((x + y) * 0.02 + t * 1.2)) /
          3
        );
      };

      const render = (time: number) => {
        const elapsed = time / 1000;

        ctx.fillStyle = canvasBg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const fontSize = 12;
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';

        const cols = Math.ceil(canvas.width / fontSize);
        const rows = Math.ceil(canvas.height / fontSize);

        const currentRipples = ripplesRef.current;
        const activeRipples = currentRipples.filter(
          (r) => time - r.startTime < 2500
        );
        if (activeRipples.length !== currentRipples.length) {
          ripplesRef.current = activeRipples;
        }

        for (let y = 0; y <= rows; y++) {
          for (let x = 0; x <= cols; x++) {
            const dx = x / cols - 0.5;
            const dy = y / rows - 0.5;
            const dist = Math.sqrt(dx * dx + dy * dy);

            const n = noise(x, y, elapsed);
            let v = ((n + 1) / 2) * (dist * 2.8);
            if (v < 0) v = 0;

            const cellX = x * fontSize + fontSize / 2;
            const cellY = y * fontSize;
            let rippleBoost = 0;

            for (let i = 0; i < activeRipples.length; i++) {
              const r = activeRipples[i];
              const age = (time - r.startTime) / 1000;
              const currentRadius = age * 800;

              const rdx = cellX - r.x;
              const rdy = cellY - r.y;
              const rdist = Math.sqrt(rdx * rdx + rdy * rdy);
              const ringDist = Math.abs(rdist - currentRadius);

              if (ringDist < 80) {
                const strength =
                  Math.max(0, 1 - ringDist / 80) * Math.max(0, 1 - age / 2.5);
                rippleBoost += strength * 1.5;
              }
            }

            v += rippleBoost;
            if (v > 1) v = 1;

            if (v > 0.05) {
              const charIndex = Math.floor(v * chars.length);
              const colorIndex = Math.floor(v * colors.length);
              const char = chars[Math.min(charIndex, chars.length - 1)];
              const color = colors[Math.min(colorIndex, colors.length - 1)];

              ctx.fillStyle = color;
              ctx.fillText(char, cellX, cellY);
            }
          }
        }
        animationFrameId = requestAnimationFrame(render);
      };

      animationFrameId = requestAnimationFrame(render);

      return () => {
        window.removeEventListener('resize', resizeCanvas);
        cancelAnimationFrame(animationFrameId);
      };
    }, []);

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      ripplesRef.current.push({ x, y, startTime: performance.now() });
    };

    const isCreating = createWorkspace.isPending;

    return (
      <div
        className={`absolute inset-0 overflow-hidden select-none z-0 transition-all duration-1000 ${
          isDark ? 'bg-black' : 'bg-white'
        } ${
          isCreating
            ? 'blur-[10px] opacity-70 scale-[1.05]'
            : 'blur-0 opacity-100 scale-100'
        }`}
      >
        <style
          dangerouslySetInnerHTML={{
            __html: `
            @keyframes asic-wave-pan {
              0% { transform: scale(1); }
              50% { transform: scale(1.15); }
              100% { transform: scale(1); }
            }
            @keyframes asic-pulse-blur {
              0% { filter: blur(10px); }
              50% { filter: blur(15px); }
              100% { filter: blur(10px); }
            }
            .animate-asic-wave {
              animation: asic-wave-pan 12s ease-in-out infinite;
            }
            .animate-creating-blur {
              animation: asic-pulse-blur 3s ease-in-out infinite;
            }
          `,
          }}
        />
        <div
          className={`absolute inset-[-15%] animate-asic-wave ${
            isCreating ? 'animate-creating-blur' : ''
          }`}
        >
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            onPointerDown={handlePointerDown}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="relative flex flex-1 flex-col bg-primary h-full z-0 overflow-hidden">
      <AsicBackground />
      <div
        className={`relative z-10 flex flex-1 items-center justify-center px-base pointer-events-none transition-all duration-700 ${
          createWorkspace.isPending
            ? 'blur-[4px] opacity-60 scale-[0.98]'
            : 'blur-0 opacity-100 scale-100'
        }`}
      >
        <div className="flex w-chat max-w-full flex-col gap-base pointer-events-auto">
          {showRepoPickerStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.repoStep')}
              </h2>
              <CreateModeRepoPickerBar
                onContinueToPrompt={() => setIsSelectingRepos(false)}
              />
            </>
          )}

          {showChatStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.chatStep')}
              </h2>

              <div className="flex justify-center @container">
                <CreateChatBox
                  theme={resolvedTheme}
                  editor={{
                    value: message,
                    onChange: setMessage,
                  }}
                  renderEditor={({
                    value,
                    onChange,
                    onCmdEnter,
                    disabled,
                    repoIds,
                    repoId,
                    executor,
                    onPasteFiles,
                    localAttachments,
                  }) => (
                    <WYSIWYGEditor
                      placeholder="Describe the task..."
                      value={value}
                      onChange={onChange}
                      onCmdEnter={onCmdEnter}
                      disabled={disabled}
                      className="min-h-double max-h-[50vh] overflow-y-auto"
                      repoIds={repoIds}
                      repoId={repoId}
                      executor={executor}
                      autoFocus
                      onPasteFiles={onPasteFiles}
                      localAttachments={localAttachments}
                      sendShortcut={config?.send_message_shortcut}
                    />
                  )}
                  agentIcon={
                    <AgentIcon
                      agent={effectiveExecutor}
                      className="size-icon-xl"
                    />
                  }
                  onSend={handleSubmit}
                  isSending={createWorkspace.isPending}
                  disabled={!hasSelectedRepos}
                  executor={{
                    selected: effectiveExecutor,
                    options: executorOptions,
                    onChange: handleExecutorChange,
                  }}
                  formatExecutorLabel={toPrettyCase}
                  error={displayError}
                  repoIds={repos.map((r) => r.id)}
                  repoId={repoId}
                  modelSelector={
                    effectiveExecutor ? (
                      <ModelSelectorContainer
                        agent={effectiveExecutor}
                        workspaceId={undefined}
                        onAdvancedSettings={handleCustomise}
                        presets={variantOptions}
                        selectedPreset={selectedVariant}
                        onPresetSelect={handlePresetSelect}
                        onOverrideChange={setExecutorOverrides}
                        executorConfig={executorConfig}
                        presetOptions={presetOptions}
                      />
                    ) : undefined
                  }
                  onPasteFiles={uploadFiles}
                  localAttachments={localAttachments}
                  dropzone={{ getRootProps, getInputProps, isDragActive }}
                  onEditRepos={() => setIsSelectingRepos(true)}
                  repoSummaryLabel={repoSummaryLabel}
                  repoSummaryTitle={repoSummaryTitle}
                  linkedIssue={
                    linkedIssue?.simpleId
                      ? {
                          simpleId: linkedIssue.simpleId,
                          title: linkedIssue.title ?? '',
                          onRemove: clearLinkedIssue,
                        }
                      : null
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
