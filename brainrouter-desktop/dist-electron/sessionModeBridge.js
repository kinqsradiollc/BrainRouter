const EXECUTION_MODES = new Set(['planning', 'fast']);
const REVIEW_POLICIES = new Set(['request', 'proceed']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);
export function desktopSessionModePatchFromArgs(args) {
    const patch = {};
    if ('executionMode' in args) {
        const value = args.executionMode;
        if (value != null && value !== '' && !EXECUTION_MODES.has(value)) {
            return { patch: {}, error: `Unknown execution mode "${String(value)}".` };
        }
        patch.executionMode = value;
    }
    if ('reviewPolicy' in args) {
        const value = args.reviewPolicy;
        if (value != null && value !== '' && !REVIEW_POLICIES.has(value)) {
            return { patch: {}, error: `Unknown review policy "${String(value)}".` };
        }
        patch.reviewPolicy = value;
    }
    if ('effort' in args) {
        const value = args.effort;
        if (value != null && value !== '' && !EFFORT_LEVELS.has(value)) {
            return { patch: {}, error: `Unknown effort "${String(value)}".` };
        }
        patch.effort = value;
    }
    return { patch };
}
export function mergeSessionModePrefs(workspacePrefs, activeMode) {
    return {
        ...workspacePrefs,
        executionMode: activeMode.executionMode,
        reviewPolicy: activeMode.reviewPolicy,
        effort: activeMode.effort,
    };
}
