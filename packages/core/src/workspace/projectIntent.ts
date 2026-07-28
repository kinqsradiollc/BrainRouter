/**
 * Shared, bounded project-intent classification for profile planning.
 *
 * Workspace initialization is a planning concern, not a domain execution
 * signal. Keeping this classifier shared prevents onboarding/setup language
 * from accidentally launching Research evidence collection or another
 * profile's execution strategy before its project contract exists.
 */

/** Return true when a prompt asks to initialize a project-shaped workspace. */
export function isWorkspaceInitializationRequest(prompt: string): boolean {
  const bounded = prompt.trim().slice(0, 16_000);
  const setUpIntent =
    /\bset(?:ting)?(?:\s+(?:this|that|the|a|an|my|our|your))?(?:\s+(?:workspace|project|repository|repo|folder|codebase))?\s+up\b/i;
  const setupIntent =
    setUpIntent.test(bounded)
    || /\b(?:setup|initiali[sz](?:e|ing|ation)|bootstrap(?:ping)?)\b/i.test(bounded);
  const projectContext =
    /\b(?:workspace|project|repository|repo|folder|codebase)\b/i;
  return setupIntent && projectContext.test(bounded);
}
