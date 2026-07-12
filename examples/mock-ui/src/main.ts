/**
 * Mock UI entry — a tiny hash-router that mounts the pages and wires their
 * buttons/inputs to the functions. Plain TypeScript + DOM, no framework, so the
 * rendered markup (and its data-testid attributes) is exactly what you author.
 */
import './style.css';
import { navBar, homePage, loginPage, todosPage } from './pages';
import { Counter, login, addTodo, removeTodo } from './functions';

const app = document.getElementById('app')!;
const counter = new Counter();
let todos: string[] = ['Try Extract', 'Tap the login button'];

function route(): string {
  return location.hash.replace(/^#\//, '') || 'home';
}

function q<T extends HTMLElement = HTMLElement>(testid: string): T | null {
  return document.querySelector<T>(`[data-testid="${testid}"]`);
}

function render(): void {
  const r = route();
  const page = r === 'login' ? loginPage() : r === 'todos' ? todosPage(todos) : homePage(counter.value);
  app.innerHTML = navBar(`nav-${r === 'home' ? 'home' : r}`) + `<main>${page}</main>`;
  wire(r);
}

function wire(r: string): void {
  if (r === 'home' || r === '') {
    q('counter-increment')?.addEventListener('click', () => {
      counter.increment();
      render();
    });
    q('counter-reset')?.addEventListener('click', () => {
      counter.reset();
      render();
    });
  } else if (r === 'login') {
    q('login-submit')?.addEventListener('click', () => {
      const email = q<HTMLInputElement>('email-field')?.value ?? '';
      const password = q<HTMLInputElement>('password-field')?.value ?? '';
      const res = login(email, password);
      const msg = q('login-message');
      if (msg) {
        msg.textContent = res.message;
        msg.className = res.ok ? 'ok' : 'err';
      }
    });
  } else if (r === 'todos') {
    q('todo-add')?.addEventListener('click', () => {
      const input = q<HTMLInputElement>('todo-input');
      if (input) {
        todos = addTodo(todos, input.value);
        render();
      }
    });
    document.querySelectorAll<HTMLElement>('[data-testid="todo-remove"]').forEach((btn) =>
      btn.addEventListener('click', () => {
        todos = removeTodo(todos, Number(btn.dataset.index));
        render();
      }),
    );
  }
}

window.addEventListener('hashchange', render);
render();
