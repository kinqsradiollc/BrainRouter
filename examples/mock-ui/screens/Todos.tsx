// @ts-nocheck
/**
 * Extraction fixture — the Todos screen as JSX (see ./Home.tsx for the why).
 * Mirrors ../src/pages.ts. Read by the Atlas "Screens" data-testid extractor.
 */
export function TodosScreen() {
  return (
    <main>
      <nav data-testid="main-nav">
        <a data-testid="nav-home" href="#/">Home</a>
        <a data-testid="nav-login" href="#/login">Login</a>
        <a data-testid="nav-todos" href="#/todos">Todos</a>
      </nav>
      <input data-testid="todo-input" placeholder="New todo" />
      <button data-testid="todo-add" onClick={() => {}}>Add</button>
      <ul data-testid="todo-list" />
      <span data-testid="todo-count">0</span>
    </main>
  );
}
