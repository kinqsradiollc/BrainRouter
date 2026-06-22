/**
 * Pure path → Monaco language-id map. Kept separate from monacoEnv (which pulls
 * in the monaco runtime + `?worker` imports) so editorModel stays importable
 * under node/tsx for unit tests.
 */
export function monacoLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
    md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust',
    sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini',
    sql: 'sql', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', dockerfile: 'dockerfile',
  };
  return map[ext] ?? 'plaintext';
}
