import { invoke } from '@tauri-apps/api/core';
import { isTauriApp } from '@/shared/lib/platform';

export type DesktopSupportPathKind =
  | 'dataDir'
  | 'cacheDir'
  | 'tempDir'
  | 'configFile'
  | 'profilesFile'
  | 'credentialsFile';

export interface DesktopSupportInfo {
  appVersion: string;
  packageIdentifier: string;
  platform: string;
  arch: string;
  buildProfile: string;
  frontendSource: string;
  backendSource: string;
  updaterEnabled: boolean;
  closeAction: string;
  dataDir: string;
  cacheDir: string;
  tempDir: string;
  configFile: string;
  profilesFile: string;
  credentialsFile: string;
}

export async function loadDesktopSupportInfo(): Promise<DesktopSupportInfo | null> {
  if (!isTauriApp()) {
    return null;
  }

  return invoke<DesktopSupportInfo>('get_desktop_support_info');
}

export async function revealDesktopSupportPath(
  kind: DesktopSupportPathKind
): Promise<boolean> {
  if (!isTauriApp()) {
    return false;
  }

  try {
    await invoke('reveal_desktop_support_path', { kind });
    return true;
  } catch (error) {
    console.error('Failed to reveal desktop support path:', error);
    return false;
  }
}
