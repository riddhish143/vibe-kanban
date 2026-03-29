import { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
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

const AsicBackground = memo(function AsicBackground({
  isDark,
  isCreating,
}: {
  isDark: boolean;
  isCreating: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({
    x: -1000,
    y: -1000,
    active: false,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let animationFrameId: number;
    let width = 0;
    let height = 0;
    let mouseTimeout: ReturnType<typeof setTimeout> | undefined;

    const RESOLUTION_FACTOR = 2;
    const CELL_SIZE = 6;

    const initCanvas = () => {
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = width * RESOLUTION_FACTOR;
      canvas.height = height * RESOLUTION_FACTOR;
      ctx.scale(RESOLUTION_FACTOR, RESOLUTION_FACTOR);
    };

    initCanvas();

    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrameId);
      initCanvas();
      animationFrameId = requestAnimationFrame(render);
    });
    resizeObserver.observe(canvas);

    // Coherent value noise
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (t: number, a: number, b: number) => a + t * (b - a);

    const grad = (hash: number, x: number, y: number) => {
      const h = hash & 15;
      const u = h < 8 ? x : y;
      const v = h < 4 ? y : h === 12 || h === 14 ? x : 0;
      return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    };

    const noise2D = (x: number, y: number) => {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      x -= Math.floor(x);
      y -= Math.floor(y);
      const u = fade(x);
      const v = fade(y);
      const A = perm[X] + Y;
      const B = perm[X + 1] + Y;
      return lerp(
        v,
        lerp(u, grad(perm[A], x, y), grad(perm[B], x - 1, y)),
        lerp(u, grad(perm[A + 1], x, y - 1), grad(perm[B + 1], x - 1, y - 1))
      );
    };

    // Fractal brownian motion for richer, layered noise
    const fbm = (x: number, y: number, octaves = 4) => {
      let value = 0;
      let amp = 0.5;
      let freq = 1;
      for (let i = 0; i < octaves; i++) {
        value += noise2D(x * freq, y * freq) * amp;
        amp *= 0.5;
        freq *= 2;
      }
      return value;
    };

    // Rich multi-stop color palette
    const palette = isDark
      ? ([
          [6, 6, 12],
          [12, 16, 32],
          [22, 30, 55],
          [35, 48, 82],
          [55, 40, 90],
          [75, 55, 110],
          [110, 75, 60],
          [140, 95, 55],
        ] as number[][])
      : ([
          [245, 248, 255],
          [215, 228, 245],
          [175, 198, 228],
          [135, 168, 210],
          [98, 136, 185],
          [72, 108, 155],
          [52, 78, 122],
          [30, 48, 88],
        ] as number[][]);

    const lerpColor = (a: number[], b: number[], t: number) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];

    const bgFill = isDark ? '#060610' : '#f8f6f3';
    const mouseInfluenceRadius = 250;

    const smoothMouse = { x: -1000, y: -1000, intensity: 0 };

    const render = (time: number) => {
      const elapsed = time / 1000;

      if (mouseRef.current.active) {
        smoothMouse.x += (mouseRef.current.x - smoothMouse.x) * 0.08;
        smoothMouse.y += (mouseRef.current.y - smoothMouse.y) * 0.08;
        smoothMouse.intensity += (1 - smoothMouse.intensity) * 0.1;
      } else {
        smoothMouse.intensity += (0 - smoothMouse.intensity) * 0.04;
      }

      ctx.fillStyle = bgFill;
      ctx.fillRect(0, 0, width, height);

      const cols = Math.ceil(width / CELL_SIZE);
      const rows = Math.ceil(height / CELL_SIZE);

      for (let y = 0; y <= rows; y++) {
        for (let x = 0; x <= cols; x++) {
          const px = x * CELL_SIZE;
          const py = y * CELL_SIZE;

          const n1 = fbm(
            x * 0.06 + elapsed * 0.12,
            y * 0.06 - elapsed * 0.08,
            3
          );
          const n2 = fbm(
            x * 0.12 - elapsed * 0.06,
            y * 0.12 + elapsed * 0.1,
            2
          );
          let value = (n1 * 0.65 + n2 * 0.35 + 1) / 2;

          const cx = px / width - 0.5;
          const cy = py / height - 0.5;
          const radialDist = Math.sqrt(cx * cx + cy * cy);
          value *= 1 - radialDist * 0.6;

          if (smoothMouse.intensity > 0.01) {
            const mdx = px - smoothMouse.x;
            const mdy = py - smoothMouse.y;
            const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
            if (mDist < mouseInfluenceRadius) {
              const glow = 1 - mDist / mouseInfluenceRadius;
              value = Math.min(
                1,
                value + glow * glow * 0.5 * smoothMouse.intensity
              );
            }
          }

          if (value < 0.03) continue;

          const t = Math.min(value, 1) * (palette.length - 1);
          const idx = Math.floor(t);
          const frac = t - idx;
          const color = lerpColor(
            palette[Math.min(idx, palette.length - 1)],
            palette[Math.min(idx + 1, palette.length - 1)],
            frac
          );

          const alpha = isDark
            ? Math.min(value * 1.2, 0.85)
            : Math.min(value * 1.6, 0.92);
          ctx.fillStyle = `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha.toFixed(3)})`;
          ctx.fillRect(px, py, CELL_SIZE - 1, CELL_SIZE - 1);
        }
      }

      const vignette = ctx.createRadialGradient(
        width / 2,
        height / 2,
        height * 0.25,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.65
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(
        1,
        isDark ? 'rgba(4,4,10,0.7)' : 'rgba(255,255,255,0.35)'
      );
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    const handlePointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
      mouseRef.current.active = true;

      clearTimeout(mouseTimeout);
      mouseTimeout = setTimeout(() => {
        mouseRef.current.active = false;
      }, 1000);
    };

    window.addEventListener('pointermove', handlePointerMove);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      resizeObserver.disconnect();
      cancelAnimationFrame(animationFrameId);
      clearTimeout(mouseTimeout);
    };
  }, [isDark]);

  return (
    <div
      className={`absolute inset-0 overflow-hidden select-none z-0 transition-all duration-1000 ${
        isDark ? 'bg-[#060610]' : 'bg-[#f8f6f3]'
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
              50% { transform: scale(1.05); }
              100% { transform: scale(1); }
            }
            .animate-asic-wave {
              animation: asic-wave-pan 20s ease-in-out infinite;
            }
          `,
        }}
      />
      <div className="absolute inset-[-5%] animate-asic-wave">
        <canvas ref={canvasRef} className="w-full h-full pointer-events-none" />
      </div>
    </div>
  );
});

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

  return (
    <div className="relative flex flex-1 flex-col bg-primary h-full z-0 overflow-hidden">
      <AsicBackground
        isDark={resolvedTheme === 'dark'}
        isCreating={createWorkspace.isPending}
      />
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .create-mode-geist,
            .create-mode-geist * {
              font-family: "Geist Mono", "IBM Plex Mono", monospace;
            }
            .create-mode-heading {
              font-family: "Geist Mono", "IBM Plex Mono", monospace;
              letter-spacing: -0.05em;
            }
          `,
        }}
      />
      <div
        className={`relative z-10 flex flex-1 items-center justify-center px-base pointer-events-none transition-all duration-700 ${
          createWorkspace.isPending
            ? 'blur-[4px] opacity-60 scale-[0.98]'
            : 'blur-0 opacity-100 scale-100'
        }`}
      >
        <div className="create-mode-geist flex w-chat max-w-full flex-col gap-base pointer-events-auto">
          {showRepoPickerStep && (
            <>
              <h2 className="create-mode-heading mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.repoStep')}
              </h2>
              <CreateModeRepoPickerBar
                onContinueToPrompt={() => setIsSelectingRepos(false)}
              />
            </>
          )}

          {showChatStep && (
            <>
              <h2 className="create-mode-heading mb-double text-center text-4xl font-medium tracking-tight text-high">
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
