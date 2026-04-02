import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';

interface DiffusionTextProps {
  enabled: boolean;
  content: string;
  /** Stable unique key for this message entry (e.g. expansionKey) */
  entryKey: string;
  children: ReactNode;
}

// Characters used to generate "noise" during diffusion steps
const NOISE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*!?~+=<>';

// Animation configuration
const TOTAL_DURATION_MS = 1000;
const STEPS = 14;
const STEP_INTERVAL = TOTAL_DURATION_MS / STEPS;

/**
 * Global set of entry keys that have already been animated.
 * Persists across mount/unmount cycles caused by virtualised scrolling.
 */
const animatedEntries = new Set<string>();

/**
 * Generates a "noisy" version of text where a percentage of characters
 * are replaced with random noise characters. Whitespace and newlines
 * are always preserved to maintain text structure.
 */
function generateNoisyText(original: string, noiseRatio: number): string {
  const len = original.length;
  const result: string[] = new Array(len);

  for (let i = 0; i < len; i++) {
    const ch = original[i];
    // Preserve whitespace and newlines so layout stays stable
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      result[i] = ch;
    } else if (Math.random() < noiseRatio) {
      result[i] = NOISE_CHARS[Math.floor(Math.random() * NOISE_CHARS.length)];
    } else {
      result[i] = ch;
    }
  }

  return result.join('');
}

/**
 * DiffusionText simulates a diffusion/denoising text effect.
 *
 * When enabled, NEW messages are shown through progressive denoising:
 *   1. Start with scrambled/noisy text + slight blur
 *   2. Characters progressively resolve in parallel
 *   3. Final step reveals the real rendered markdown
 *
 * Messages that have already been animated (tracked globally by entryKey)
 * are rendered immediately — no re-animation on scroll.
 */
export function DiffusionText({
  enabled,
  content,
  entryKey,
  children,
}: DiffusionTextProps) {
  // Determine up front if this entry was already seen
  const alreadyAnimated = animatedEntries.has(entryKey);

  const [phase, setPhase] = useState<'animating' | 'done'>(
    enabled && !alreadyAnimated ? 'animating' : 'done'
  );
  const [noisyContent, setNoisyContent] = useState('');
  const [opacity, setOpacity] = useState(1);
  const [blurAmount, setBlurAmount] = useState(0);
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    // Disabled or already shown → render normally
    if (!enabled || animatedEntries.has(entryKey)) {
      cleanup();
      setPhase('done');
      return;
    }

    // Start diffusion animation
    stepRef.current = 0;
    setPhase('animating');
    setNoisyContent(generateNoisyText(content, 1.0));
    setBlurAmount(3);
    setOpacity(0.4);

    const runStep = () => {
      stepRef.current++;
      const step = stepRef.current;

      if (step >= STEPS) {
        // Mark as animated so scroll won't re-trigger
        animatedEntries.add(entryKey);
        setPhase('done');
        cleanup();
        return;
      }

      const progress = step / STEPS;

      // Quadratic ease-out: fast initial denoising, fine refinement later
      const noiseRatio = Math.pow(1 - progress, 2.5);

      // Blur fades out in the first ~60% of the animation
      const blur = Math.max(0, 3 * (1 - progress * 1.7));

      // Opacity eases in smoothly
      const alpha = 0.4 + 0.6 * Math.min(1, progress * 1.4);

      rafRef.current = requestAnimationFrame(() => {
        setNoisyContent(generateNoisyText(contentRef.current, noiseRatio));
        setBlurAmount(blur);
        setOpacity(alpha);

        timerRef.current = setTimeout(runStep, STEP_INTERVAL);
      });
    };

    timerRef.current = setTimeout(runStep, STEP_INTERVAL);

    return cleanup;
  }, [enabled, entryKey, content, cleanup]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  // Not enabled or animation complete → show real content
  if (!enabled || phase === 'done') {
    return <>{children}</>;
  }

  // During animation: scrambled overlay on top of invisible real content
  return (
    <div className="relative">
      {/* Invisible real content keeps correct layout height */}
      <div className="invisible" aria-hidden="true">
        {children}
      </div>
      {/* Scrambled text overlay */}
      <div
        className="absolute inset-0 text-sm whitespace-pre-wrap break-words text-normal overflow-hidden"
        style={{
          opacity,
          filter: blurAmount > 0 ? `blur(${blurAmount}px)` : undefined,
          transition: 'opacity 70ms linear, filter 70ms linear',
        }}
        aria-hidden="true"
      >
        {noisyContent}
      </div>
    </div>
  );
}
