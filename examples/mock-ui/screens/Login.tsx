// @ts-nocheck
/**
 * Extraction fixture — the Login screen as JSX (see ./Home.tsx for the why).
 * Mirrors ../src/pages.ts. Read by the Atlas "Screens" data-testid extractor.
 */
export function LoginScreen() {
  return (
    <main>
      <nav data-testid="main-nav">
        <a data-testid="nav-home" href="#/">Home</a>
        <a data-testid="nav-login" href="#/login">Login</a>
        <a data-testid="nav-todos" href="#/todos">Todos</a>
      </nav>
      <input data-testid="email-field" placeholder="Email" />
      <input data-testid="password-field" type="password" placeholder="Password" />
      <button data-testid="login-submit" onClick={() => {}}>Sign in</button>
      <p data-testid="login-message" />
    </main>
  );
}
