# Custom Hooks

This document provides an overview of all the custom React hooks available in the `@the project/hooks` package. These hooks encapsulate the core business logic, API interactions, and state management used across both the Web and Mobile clients.

---

## 🏗️ Architecture

The hook layer sits between the UI components and the `@the project/sdk` services. Hooks are designed to be:
- **Composable**: Build complex logic from simpler hooks.
- **Reusable**: Share logic between different platforms (Web/Mobile).
- **Testable**: Easily mockable for unit testing.

---

## 🛠️ Core Hooks

### Auth
- `useAuth`: Handles login, logout, and current user state.
- `useSession`: Manages JWT refresh and session persistence.

### Data Fetching
- `useResource`: Generic hook for fetching and caching resources.
- `useMutation`: Wrapper for creating/updating/deleting data.

---

## 📦 SDK Integration

For modules like **Storage** and **Analytics**, the logic is handled via the `@the project/sdk` services. Hooks provide a reactive interface to these services.
