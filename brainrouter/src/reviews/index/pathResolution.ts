import { dirname, extname, join, normalize } from 'node:path/posix';

export const TYPESCRIPT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export function isTypeScriptSourcePath(path: string): boolean {
  return TYPESCRIPT_SOURCE_EXTENSIONS.includes(
    extname(path).toLowerCase() as (typeof TYPESCRIPT_SOURCE_EXTENSIONS)[number],
  );
}

export function isTestSourcePath(path: string): boolean {
  return /(^|\/)(__tests__\/|tests?\/)|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(path);
}

export function isConfigurationSourcePath(path: string): boolean {
  return /(^|\/)(?:config|configuration)\//i.test(path) || /(?:^|[.-])config(?:uration)?\.[cm]?[jt]sx?$/i.test(path);
}

export function resolveRelativeModule(
  fromPath: string,
  specifier: string,
  eligiblePaths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(fromPath), specifier));
  const emittedJavaScriptExtension = /\.[cm]?jsx?$/i.test(base) ? base.slice(0, -extname(base).length) : null;
  const candidates = [
    base,
    ...(emittedJavaScriptExtension
      ? TYPESCRIPT_SOURCE_EXTENSIONS.map((extension) => `${emittedJavaScriptExtension}${extension}`)
      : []),
    ...TYPESCRIPT_SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...TYPESCRIPT_SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => eligiblePaths.has(candidate)) ?? null;
}
