import { useEffect, useState, useRef } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2, Sparkle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal } from '@/shared/lib/modals';
import { IssueProvider } from '@/integrations/remote/IssueProvider';
import { useIssueContext } from '@/shared/hooks/useIssueContext';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';

export interface ExplainIssueDialogProps {
  issueId: string;
  issueTitle: string;
  issueDescription: string | null;
}

function ExplainIssueDialogContent({
  issueTitle,
  issueDescription,
}: ExplainIssueDialogProps) {
  const modal = useModal();
  const { t } = useTranslation('common');
  const { comments, isLoading: isCommentsLoading } = useIssueContext();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (!modal.visible) {
      setExplanation(null);
      setError(null);
      setIsGenerating(false);
      hasFetched.current = false;
    }
  }, [modal.visible]);

  useEffect(() => {
    // Only fetch once, and wait until comments are loaded to get the full context
    if (!modal.visible || isCommentsLoading || hasFetched.current) {
      return;
    }

    const fetchExplanation = async () => {
      hasFetched.current = true;
      setIsGenerating(true);
      setError(null);

      try {
        // Find default model (e.g. llama3.2, llama3, qwen2.5) by checking Ollama tags
        let modelName = 'llama3.2';
        try {
          const tagsResponse = await fetch('http://localhost:11434/api/tags');
          if (tagsResponse.ok) {
            const data = await tagsResponse.json();
            if (data.models && data.models.length > 0) {
              modelName = data.models[0].name;
            }
          }
        } catch (e) {
          // Ignore tags fetch failure, fallback to try generation which will cleanly surface the connection error
        }

        const commentsText = comments.length > 0
          ? comments.map(c => `- ${c.message}`).join('\n')
          : 'No comments yet.';

        const prompt = `You are an AI assistant helping summarize a kanban issue.

Issue Title: ${issueTitle}
Description:
${issueDescription || 'No description provided.'}

Comments:
${commentsText}

Please provide a clean, structured markdown explanation. Use '## ' for section headers. Ensure there is clear spacing between headers and content. Use standard markdown bullet points ('- ').

Four sections to include:
## 1. Simplified summary of the issue
## 2. Key points from description and comments
## 3. Expected outcome / goal to be achieved
## 4. A practical example of what solving the issue looks like`;

        const response = await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            prompt,
            options: {
              temperature: 0.1, // Lower temperature for more consistent formatting
            },
            stream: false,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to generate explanation. Is Ollama running?');
        }

        const data = await response.json();
        setExplanation(data.response);
      } catch (err) {
        if (err instanceof TypeError && err.message.includes('fetch')) {
          setError(
            'Ollama is not running locally or could not be reached. Please install Ollama, run a local model, and ensure cross-origin (CORS) access is permitted.'
          );
        } else {
          setError(err instanceof Error ? err.message : 'Unknown error occurred');
        }
      } finally {
        setIsGenerating(false);
      }
    };

    void fetchExplanation();
  }, [modal.visible, isCommentsLoading, issueTitle, issueDescription, comments]);

  const handleClose = () => {
    modal.resolve();
    modal.hide();
  };

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => !open && handleClose()}
      uncloseable
      className="p-0 overflow-hidden sm:max-w-2xl bg-background border-border/50 shadow-2xl"
    >
      <div className="relative w-full">
        <div className="relative px-8 pt-8 pb-6 border-b border-border/40 bg-gradient-to-br from-indigo-500/10 via-brand/5 to-transparent">
          <div className="flex items-start gap-5">
            <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-500/15 text-indigo-500 border border-indigo-500/20 shadow-sm shrink-0">
              <Sparkle className="h-6 w-6" />
            </div>
            <div className="flex flex-col gap-1.5 pt-0.5">
              <DialogTitle className="text-2xl font-bold tracking-tight text-high">
                {t('kanban.explainIssueTitle', 'Explain Issue')}
              </DialogTitle>
              <DialogDescription className="text-sm text-low max-w-md">
                {t(
                  'kanban.explainIssueDescription',
                  'AI-powered summary of the issue details and team discussion.'
                )}
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto max-h-[55vh] min-h-[400px] px-8 py-6 bg-background/50">
          {isCommentsLoading ? (
            <div className="flex flex-col h-[400px] items-center justify-center text-low space-y-4">
              <Loader2 className="h-10 w-10 animate-spin text-brand/40" />
              <p className="font-medium animate-pulse">Loading issue context...</p>
            </div>
          ) : isGenerating ? (
            <div className="flex flex-col h-[400px] items-center justify-center text-low space-y-4">
              <Loader2 className="h-10 w-10 animate-spin text-brand/40" />
              <p className="font-medium animate-pulse">Ollama is analyzing the issue...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col h-[400px] items-center justify-center text-destructive text-center space-y-3 p-8 border border-destructive/20 rounded-xl bg-destructive/5 mx-4">
              <p className="text-lg font-bold">Connection Error</p>
              <p className="text-sm leading-relaxed opacity-90">{error}</p>
            </div>
          ) : explanation ? (
            <div className="w-full animate-in fade-in slide-in-from-bottom-2 duration-500">
              <WYSIWYGEditor
                value={explanation}
                disabled
                hideActions
                className="text-sm leading-relaxed"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter className="px-8 py-5 shrink-0 border-t border-border/40 bg-secondary/10 flex items-center justify-end">
          <Button onClick={handleClose} size="lg" className="min-w-[100px]">
            {t('buttons.close', 'Done')}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

const ExplainIssueDialogImpl = create<ExplainIssueDialogProps>(
  (props) => {
    return (
      <IssueProvider issueId={props.issueId}>
        <ExplainIssueDialogContent {...props} />
      </IssueProvider>
    );
  }
);

export const ExplainIssueDialog = defineModal<
  ExplainIssueDialogProps,
  void
>(ExplainIssueDialogImpl);
