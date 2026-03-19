import { useEffect, useMemo, useState, useRef } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Label } from '@vibe/ui/components/Label';
import { Alert, AlertDescription, AlertTitle } from '@vibe/ui/components/Alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal, getErrorMessage } from '@/shared/lib/modals';
import { remoteProjectsApi } from '@/shared/lib/api';
import type { ImportGitHubIssuesResponse } from 'shared/types';

export interface ImportGitHubIssuesDialogProps {
  projectId: string;
}

export type ImportGitHubIssuesDialogResult = ImportGitHubIssuesResponse | null;

function validateGitHubRepoUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== 'github.com') {
      return 'Only github.com repository URLs are supported.';
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return 'Enter a valid GitHub repository or issue URL.';
    }

    return null;
  } catch {
    return 'Enter a valid GitHub repository or issue URL.';
  }
}

const ImportGitHubIssuesDialogImpl = create<ImportGitHubIssuesDialogProps>(
  ({ projectId }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const [repositoryUrl, setRepositoryUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ImportGitHubIssuesResponse | null>(
      null
    );
    const [isImporting, setIsImporting] = useState(false);
    const isCancelled = useRef(false);
    const [stats, setStats] = useState<{ loaded: number }>({ loaded: 0 });

    useEffect(() => {
      if (!modal.visible) {
        return;
      }

      setRepositoryUrl('');
      setError(null);
      setResult(null);
      setIsImporting(false);
      isCancelled.current = false;
      setStats({ loaded: 0 });
    }, [modal.visible]);

    const validationError = useMemo(() => {
      if (!repositoryUrl.trim()) {
        return null;
      }

      return validateGitHubRepoUrl(repositoryUrl);
    }, [repositoryUrl]);

    const handleClose = () => {
      modal.resolve(result);
      modal.hide();
    };

    const handleCancel = () => {
      if (isImporting) {
        isCancelled.current = true;
      } else {
        handleClose();
      }
    };

    const handleSubmit = async () => {
      const nextError = validateGitHubRepoUrl(repositoryUrl);
      if (nextError) {
        setError(nextError);
        return;
      }

      setIsImporting(true);
      setError(null);
      isCancelled.current = false;
      setStats({ loaded: 0 });

      let currentPage = 1;
      let hasMore = true;
      const aggResult: ImportGitHubIssuesResponse = {
        created_count: 0,
        updated_count: 0,
        failed_count: 0,
        created_issue_ids: [],
        failures: [],
        has_more: false,
      };

      try {
        while (hasMore && !isCancelled.current) {
          const response = await remoteProjectsApi.importGitHubIssues({
            project_id: projectId,
            repository_url: repositoryUrl.trim(),
            page: currentPage,
          });

          aggResult.created_count += response.created_count;
          aggResult.updated_count += response.updated_count;
          aggResult.failed_count += response.failed_count;
          aggResult.created_issue_ids.push(...response.created_issue_ids);
          aggResult.failures.push(...response.failures);
          hasMore = response.has_more ?? false;

          setStats({
            loaded:
              aggResult.created_count +
              aggResult.updated_count +
              aggResult.failed_count,
          });

          currentPage++;
        }
        setResult(aggResult);
      } catch (err) {
        setError(getErrorMessage(err));
        if (currentPage > 1) {
          setResult(aggResult);
        }
      } finally {
        setIsImporting(false);
      }
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => !open && handleClose()}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t(
                'kanban.importIssuesFromRepo',
                'Import Issues from Repository'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                'kanban.importIssuesFromRepoDescription',
                'Paste a GitHub repository URL or a specific issue URL to import into this board.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="github-repository-url">
                {t('kanban.repositoryLink', 'Repository or issue link')}
              </Label>
              <Input
                id="github-repository-url"
                value={repositoryUrl}
                onChange={(event) => {
                  setRepositoryUrl(event.target.value);
                  setError(null);
                }}
                placeholder={t(
                  'kanban.importIssuesPlaceholder',
                  'Paste your repository or issue link here (e.g., GitHub URL)'
                )}
                disabled={isImporting}
                autoFocus
                onCommandEnter={(event) => {
                  event.preventDefault();
                  void handleSubmit();
                }}
              />
              {validationError && (
                <p className="text-sm text-destructive">{validationError}</p>
              )}
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {result && (
              <Alert variant="success">
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>
                  {t('kanban.importComplete', 'Import complete')}
                </AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    {result.created_count} created, {result.updated_count}{' '}
                    updated, {result.failed_count} failed.
                  </p>
                  {result.failures.length > 0 && (
                    <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
                      {result.failures.map((failure) => (
                        <p
                          key={`${failure.github_issue_number}-${failure.message}`}
                        >
                          #{failure.github_issue_number} {failure.title}:{' '}
                          {failure.message}
                        </p>
                      ))}
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isImporting && isCancelled.current}
            >
              {result
                ? t('buttons.close', 'Close')
                : t('buttons.cancel', 'Cancel')}
            </Button>
            {!result && (
              <Button
                onClick={() => void handleSubmit()}
                disabled={
                  !repositoryUrl.trim() || !!validationError || isImporting
                }
              >
                {isImporting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {stats.loaded > 0
                      ? t(
                          'kanban.importingIssuesWithStats',
                          `Importing... (${stats.loaded} loaded)`
                        )
                      : t('kanban.importingIssues', 'Importing...')}
                  </>
                ) : (
                  t('kanban.importIssuesAction', 'Import Issues')
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const ImportGitHubIssuesDialog = defineModal<
  ImportGitHubIssuesDialogProps,
  ImportGitHubIssuesDialogResult
>(ImportGitHubIssuesDialogImpl);
