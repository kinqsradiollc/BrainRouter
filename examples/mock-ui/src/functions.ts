/**
 * Simple, pure functions the mock pages call — the "logic" half of the demo.
 * Kept dependency-free so the app stays tiny and easy to reason about while you
 * exercise Extract + the command layer against the rendered UI.
 */

/** Very loose email check — enough to demo a validation branch. */
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export interface LoginResult {
  ok: boolean;
  message: string;
}

/** Fake login: validates the email + a minimum password length. */
export function login(email: string, password: string): LoginResult {
  if (!validateEmail(email)) return { ok: false, message: 'Enter a valid email address.' };
  if (password.length < 6) return { ok: false, message: 'Password must be at least 6 characters.' };
  return { ok: true, message: `Welcome back, ${email.trim()}!` };
}

/** Append a trimmed todo (ignores blanks). Pure — returns a new array. */
export function addTodo(list: string[], text: string): string[] {
  const t = text.trim();
  return t ? [...list, t] : list;
}

/** Remove the todo at `index`. Pure. */
export function removeTodo(list: string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

/** A trivial counter with the kind of methods a real component would have. */
export class Counter {
  private current = 0;
  get value(): number {
    return this.current;
  }
  increment(): number {
    return ++this.current;
  }
  reset(): number {
    this.current = 0;
    return this.current;
  }
}
