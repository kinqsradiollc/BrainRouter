/**
 * ADR-028 I3/I4 — which GitHub account is this workspace pushing as?
 *
 * `gh` holds one active account. A person with a work account and a personal
 * one has an active account that is right for whichever repository they last
 * thought about.
 *
 * The failure is not cosmetic. **Pushing a work branch from a personal account,
 * or company code to a personal fork, is a disclosure** — silent, attributed to
 * the person, and usually discovered by someone else.
 *
 * So each workspace records the account it expects, and every operation that
 * WRITES to the forge compares before acting. Reads never do (I4): an identity
 * check on every read would make the guard something people learn to click
 * through, which is exactly how it fails on the push that mattered.
 */

export interface GitHubAccount {
  login: string;
  /** The host, so github.com and an enterprise instance are distinguishable. */
  host: string;
  active: boolean;
}

export interface WorkspaceBinding {
  workspaceRoot: string;
  /** The account this workspace has pushed as before. */
  expectedLogin: string;
  host: string;
  boundAt: string;
}

/**
 * Operations that can disclose. Only these consult the binding.
 *
 * `push` and `create` are obvious. `merge` is here because merging a stack
 * lands commits under the merging account, and `comment` because a review
 * posted from the wrong identity is attributed to a person who did not write it.
 */
export type ForgeOperation =
  | 'push' | 'create_pr' | 'merge' | 'comment'
  | 'read_pr' | 'read_checks' | 'list_stack';

const WRITES: ReadonlySet<ForgeOperation> = new Set<ForgeOperation>([
  'push', 'create_pr', 'merge', 'comment',
]);

export function isWriteOperation(op: ForgeOperation): boolean {
  return WRITES.has(op);
}

export type IdentityVerdict =
  /** Proceed — bound and matching, or a read. */
  | { kind: 'ok' }
  /** Nothing bound yet. The FIRST push binds; it does not interrogate. */
  | { kind: 'bind'; login: string; host: string }
  /** Bound to someone else. Stops, and names both. */
  | {
      kind: 'mismatch';
      expected: string;
      active: string;
      message: string;
    }
  /** No account at all. */
  | { kind: 'signed_out'; message: string };

/**
 * May this operation proceed as the active account?
 *
 * A mismatch is a QUESTION, not an error — people legitimately change which
 * account owns a project, so both "switch account" and "update what this
 * workspace expects" are one click. Presenting it as a failure would train
 * people to dismiss it.
 */
export function checkIdentity(input: {
  operation: ForgeOperation;
  active: GitHubAccount | null;
  binding: WorkspaceBinding | null;
}): IdentityVerdict {
  // I4 — reads cannot disclose, so they never ask.
  if (!isWriteOperation(input.operation)) return { kind: 'ok' };

  if (!input.active) {
    return {
      kind: 'signed_out',
      message: 'No GitHub account is signed in. Run `gh auth login`, then try again.',
    };
  }

  if (!input.binding) {
    // Bound on first push rather than by a settings page nobody visits.
    return { kind: 'bind', login: input.active.login, host: input.active.host };
  }

  if (
    input.binding.expectedLogin === input.active.login &&
    input.binding.host === input.active.host
  ) {
    return { kind: 'ok' };
  }

  return {
    kind: 'mismatch',
    expected: input.binding.expectedLogin,
    active: input.active.login,
    // Names BOTH accounts. "Wrong account" makes you go and look; naming them
    // lets you decide from the message.
    //
    // It also names the COMMAND. I3 wanted two one-click answers and no
    // renderer ever built them, so what a person actually meets is this
    // sentence — and a sentence that says "switch account" without saying how
    // is a refusal wearing the word "or". `switchCommand` had no caller until
    // 2026-08-12 for exactly that reason: it was written for the UI that did
    // not arrive.
    message:
      `This workspace has pushed as ${input.binding.expectedLogin}; you are signed in as ` +
      `${input.active.login}. Switch account with \`${switchCommand({ login: input.binding.expectedLogin, host: input.binding.host })}\`, ` +
      'or update what this workspace expects?',
  };
}

/** The switch command, so it can be shown before it runs. */
export function switchCommand(account: Pick<GitHubAccount, 'login' | 'host'>): string {
  return `gh auth switch --hostname ${account.host} --user ${account.login}`;
}

/**
 * Bind a workspace to the account it just used.
 *
 * Deliberately NOT a second credential store. A separate store would drift from
 * the one `git` and `gh` actually use, and the drift would surface as a push
 * that used an account the UI said was inactive — which is worse than no guard,
 * because it would be trusted.
 */
export function bindWorkspace(
  workspaceRoot: string,
  account: GitHubAccount,
  nowIso: string,
): WorkspaceBinding {
  return {
    workspaceRoot,
    expectedLogin: account.login,
    host: account.host,
    boundAt: nowIso,
  };
}

/*
 * `describeAccounts` annotated a list of accounts for an account PICKER, and
 * was **retired 2026-08-12**: there is no picker, and none is proposed. Nothing
 * in the product enumerates GitHub accounts — the identity check reads the
 * ACTIVE one and compares it to the binding, which is one account, not a list.
 * The rest of what the picker would have said now appears where the question
 * is actually asked: `checkIdentity`'s mismatch names both logins and the
 * command that switches between them.
 */
