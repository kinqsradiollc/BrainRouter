// @ts-nocheck
/**
 * Extraction fixture — the Home screen expressed as JSX so the Atlas "Screens"
 * mode can build a real screen map from source via the data-testid extractor
 * (source-AST). Mirrors the runtime markup in ../src/pages.ts: the vanilla mock
 * renders HTML template strings (which the Browser panel's live-DOM extractor
 * reads), while this typed JSX mirror is what the source-AST extractor reads.
 * Not imported at runtime — a source-of-truth fixture for the extractor. Lives
 * outside the mock's tsconfig `include` (src/) and carries @ts-nocheck so the
 * vanilla (non-React) app's tooling never tries to type-check it.
 */
export function HomeScreen() {
  return (
    <main>
      <nav data-testid="main-nav">
        <a data-testid="nav-home" href="#/">Home</a>
        <a data-testid="nav-login" href="#/login">Login</a>
        <a data-testid="nav-todos" href="#/todos">Todos</a>
      </nav>
      <h1 data-testid="home-title">Mock UI</h1>
      <button data-testid="counter-increment" onClick={() => {}}>+1</button>
      <span data-testid="counter-value">0</span>
      <button data-testid="counter-reset" onClick={() => {}}>Reset</button>
    </main>
  );
}
