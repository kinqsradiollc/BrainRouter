import { shell, systemPreferences } from 'electron';
export function checkComputerUsePermissions() {
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
    }
    catch {
        accessibility = false;
    }
    try {
        screenStatus = systemPreferences.getMediaAccessStatus('screen');
    }
    catch {
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
export async function openAccessibilitySettings() {
    if (process.platform === 'darwin') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
    return { ok: true };
}
export async function openScreenRecordingSettings() {
    if (process.platform === 'darwin') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    return { ok: true };
}
