/**
 * Font helpers. The design tokens (`tokens.ts`) carry web-style CSS font STACKS
 * (Geist + fallbacks) which React Native cannot use as a `fontFamily` (RN needs
 * a single registered family). Until Geist is bundled as an asset, screens use
 * the system sans (omit fontFamily) and this platform monospace for mono bits.
 */
import { Platform } from 'react-native';

export const MONO: string = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) ?? 'monospace';
