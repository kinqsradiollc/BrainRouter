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
