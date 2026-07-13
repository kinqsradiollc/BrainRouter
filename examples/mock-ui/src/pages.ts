/**
 * The "UI pages" half of the demo — each returns the HTML for one screen, with a
 * stable `data-testid` on every interactive element so the Browser panel's
 * Extract + command layer (tap / type / assertVisible) have something to act on.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** Top nav, present on every screen. */
export function navBar(active: string): string {
  const link = (id: string, href: string, label: string): string =>
    `<a data-testid="${id}" href="${href}" class="${active === id ? 'active' : ''}">${label}</a>`;
  return `<nav data-testid="main-nav">
    ${link('nav-home', '#/home', 'Home')}
    ${link('nav-login', '#/login', 'Login')}
    ${link('nav-todos', '#/todos', 'Todos')}
  </nav>`;
}

export function homePage(count: number): string {
  return `<section data-testid="home-page">
    <h1 data-testid="home-title">Mock UI — Home</h1>
    <p>A tiny app to exercise Extract + the command layer.</p>
    <div class="counter">
      <button data-testid="counter-increment">Increment</button>
      <span data-testid="counter-value">${count}</span>
      <button data-testid="counter-reset">Reset</button>
    </div>
  </section>`;
}

export function loginPage(): string {
  return `<section data-testid="login-page">
    <h1 data-testid="login-title">Login</h1>
    <input data-testid="email-field" type="email" placeholder="you@example.com" aria-label="Email" />
    <input data-testid="password-field" type="password" placeholder="Password" aria-label="Password" />
    <button data-testid="login-submit">Sign in</button>
    <div data-testid="login-message" role="status"></div>
  </section>`;
}

export function todosPage(todos: string[]): string {
  const items = todos
    .map(
      (t, i) =>
        `<li data-testid="todo-item"><span>${escapeHtml(t)}</span><button data-testid="todo-remove" data-index="${i}" aria-label="Remove">×</button></li>`,
    )
    .join('');
  return `<section data-testid="todos-page">
    <h1 data-testid="todos-title">Todos</h1>
    <div class="todo-row">
      <input data-testid="todo-input" placeholder="What needs doing?" aria-label="New todo" />
      <button data-testid="todo-add">Add</button>
    </div>
    <div data-testid="todo-count">${todos.length} item(s)</div>
    <ul data-testid="todo-list">${items}</ul>
  </section>`;
}
