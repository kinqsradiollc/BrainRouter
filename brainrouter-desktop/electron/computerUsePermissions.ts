import { shell, systemPreferences } from 'electron';

export interface ComputerUsePermissionStatus {
  platform: NodeJS.Platform;
  accessibility: { granted: boolean; supported: boolean };
  screen: { granted: boolean; status: string; supported: boolean };
}

export function checkComputerUsePermissions(): ComputerUsePermissionStatus {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      accessibility: { granted: true, supported: false },
      screen: { granted: true, status: 'granted', supported: false },
    };
  }
  let accessibility = false;
  let screenStatus = 'unknown';
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    accessibility = false;
  }
  try {
    screenStatus = systemPreferences.getMediaAccessStatus('screen' as any);
  } catch {
    screenStatus = 'unknown';
  }
  return {
    platform: process.platform,
    accessibility: { granted: accessibility, supported: true },
    screen: {
      granted: screenStatus === 'granted',
      status: screenStatus,
      supported: true,
    },
  };
}

export async function openAccessibilitySettings(): Promise<{ ok: boolean }> {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }
  return { ok: true };
}

export async function openScreenRecordingSettings(): Promise<{ ok: boolean }> {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return { ok: true };
}
