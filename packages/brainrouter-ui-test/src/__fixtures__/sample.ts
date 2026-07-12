/**
 * Test fixtures — TSX source as strings (kept as a compiled `.ts` module so the
 * test can import them from `dist/` without bundling raw `.tsx` files). Covers the
 * cases the extractor must handle: plain string testID, expression-wrapped testID,
 * self-closing tags, nesting, role override, href links, and a component wrapper.
 */

export const LOGIN_TSX = `
import React from 'react';
export function LoginScreen() {
  return (
    <form>
      <input data-testid="email-field" placeholder="Email" />
      <input data-testid="password-field" type="password" />
      <a data-testid="forgot-link" href="/forgot">Forgot?</a>
      <button data-testid={"login-submit"} onClick={() => submit()}>Log in</button>
      <div data-testid="login-error" role="alert">Bad creds</div>
    </form>
  );
}
`;

// A non-screen file (no pages/ dir) — its testIDs land in the shared screen.
export const WIDGET_TSX = `
import React from 'react';
export const Toolbar = () => (
  <header>
    <span data-testid="brand" role="button" onClick={go}>Brand</span>
    <select data-testid="env-picker"><option>dev</option></select>
    <CustomButton data-testid="cta">Go</CustomButton>
  </header>
);
`;
