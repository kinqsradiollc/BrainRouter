/**
 * ADR-035 — the module hooks that let the renderer's React components be
 * imported by `node --test`.
 *
 * ## What it owns
 *
 * One thing: the `.css` imports. A renderer component says `import
 * "./meetings.css"` because Vite turns that into a stylesheet, and Node has no
 * idea what to do with it — `ERR_UNKNOWN_FILE_EXTENSION` before the test file's
 * first line runs. So a stylesheet resolves to an empty module here.
 *
 * ## Why this exists at all
 *
 * Because without it the desktop renderer had NO component tests — zero
 * `*.test.tsx` anywhere under `src/`, and a `test` script whose glob was
 * `src/**‍/*.test.ts`, which cannot match one. What stood in for them was
 * `meetingCaptureContract.test.ts` reading `MeetingsView.tsx` as TEXT and
 * matching regexes over it. That pins a call being PRESENT and can never pin its
 * result being USED: `liveRef.current = session`, `transcriptRef.current =
 * folded.text` and `transcript: transcriptRef.current` were each deletable with
 * the whole suite still green, and each deletion loses a real meeting.
 *
 * ## Invariants
 *
 * 1. **Only `.css` is intercepted.** Everything else is handed straight to the
 *    next hook in the chain — tsx's, which is what compiles the `.tsx`. A hook
 *    that answered more than it owns would be a second module resolver.
 * 2. **The stub exports nothing.** A component that did `import styles from
 *    "./x.css"` and read a class off it would get `undefined` rather than a
 *    plausible-looking object, so the difference shows up in the test rather
 *    than being papered over. Nothing in this app imports a stylesheet's value.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const STYLESHEET = /\.css$/;

export async function resolve(specifier, context, nextResolve) {
  if (!STYLESHEET.test(specifier)) return nextResolve(specifier, context);
  const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
  return {
    url: pathToFileURL(path.resolve(parent, specifier)).href,
    format: 'module',
    shortCircuit: true,
  };
}

export async function load(url, context, nextLoad) {
  if (!STYLESHEET.test(new URL(url).pathname)) return nextLoad(url, context);
  return { format: 'module', source: 'export {};', shortCircuit: true };
}
