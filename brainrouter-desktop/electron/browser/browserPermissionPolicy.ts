export interface BrowserPermissionScope {
  /** Stable value shown to the user and echoed by permission.respond. */
  promptPermission: string;
  /** Exact grants persisted in memory for subsequent Chromium checks. */
  grants: string[];
}

const SUPPORTED_SIMPLE_PERMISSIONS = new Set([
  'fullscreen',
  'geolocation',
  'idle-detection',
  'notifications',
  'pointerLock',
]);

/** Translate an Electron permission request into the deliberately small set the
 * embedded browser supports. Device APIs, screen capture, raw MIDI, filesystem,
 * serial/HID/USB, external-open, and unknown permissions fail closed. */
export function browserPermissionRequestScope(permission: string, mediaTypes: readonly string[] = []): BrowserPermissionScope | null {
  if (permission === 'media') {
    const types = [...new Set(mediaTypes.filter((value) => value === 'audio' || value === 'video'))].sort();
    if (types.length === 0) return null;
    return {
      promptPermission: types.length === 2 ? 'microphone+camera' : types[0] === 'audio' ? 'microphone' : 'camera',
      grants: types.map((value) => `media:${value}`),
    };
  }
  if (!SUPPORTED_SIMPLE_PERMISSIONS.has(permission)) return null;
  return { promptPermission: permission, grants: [permission] };
}

/** Chromium checks media grants one device category at a time. */
export function browserPermissionCheckScopes(permission: string, mediaType?: string): string[] {
  if (permission === 'media') return mediaType === 'audio' || mediaType === 'video' ? [`media:${mediaType}`] : [];
  return SUPPORTED_SIMPLE_PERMISSIONS.has(permission) ? [permission] : [];
}

/**
 * ADR-055 P10 — the prompt-permission values a per-site decision may be
 * remembered under. These are the `promptPermission` values
 * `browserPermissionRequestScope` can produce; anything else is never persisted.
 */
export const PERSISTABLE_BROWSER_PERMISSIONS: ReadonlySet<string> = new Set([
  ...SUPPORTED_SIMPLE_PERMISSIONS,
  'microphone',
  'camera',
  'microphone+camera',
]);

export function isPersistableBrowserPermission(value: string): boolean {
  return PERSISTABLE_BROWSER_PERMISSIONS.has(value);
}

/**
 * The exact grants a remembered prompt decision implies — the reverse of
 * `browserPermissionRequestScope`, so restoring "allow camera" re-adds
 * `media:video` (the key Chromium actually checks), not the prompt label.
 */
export function browserPermissionGrantsFor(promptPermission: string): string[] {
  if (promptPermission === 'microphone') return ['media:audio'];
  if (promptPermission === 'camera') return ['media:video'];
  if (promptPermission === 'microphone+camera') return ['media:audio', 'media:video'];
  return SUPPORTED_SIMPLE_PERMISSIONS.has(promptPermission) ? [promptPermission] : [];
}
