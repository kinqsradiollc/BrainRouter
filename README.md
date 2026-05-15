# 🤖 Universal Agent Template

A high-performance, documentation-driven framework for building web applications with AI agents. This repository provides the "Brain" and "Map" for any AI-assisted coding environment.

---

## 🚀 Quick Start

1. **Install the Template**: Copy the following into your project root:
   - `/agents`, `/docs`, `/references`, `/skills`
   - `AGENT.md`, `README.md` (this file)

2. **Invoke the Agent**: Load [AGENT.md](./AGENT.md) and say: **"Bootstrap this project."**

3. **Branching Paths**: The agent will automatically detect your project state:
   - **New Project**: It guides you through vision definition, folder creation, and theme selection.
   - **Existing Project**: It scans your code, aligns the documentation templates to your reality, and helps you adopt a new design theme incrementally.

---

## 🏗️ Core Architecture

This framework is built on three composable layers:

1.  **Context Router (`AGENT.md`)**: The central nervous system. It prevents the AI from scanning the whole repo and directs it to the specific "Skill" needed for the task.
2.  **Skills (`/skills`)**: Specialized workflows (e.g., `Planning`, `Debugging`, `Testing`). They define the **How**.
3.  **Personas (`/agents`)**: Specialized roles (e.g., `Security Auditor`, `Code Reviewer`). They define the **Who**.
4.  **Source of Truth (`/docs`)**: Machine-readable documentation (e.g., `Design.md`, `API.md`). This is what the agent uses to write code that matches your standards.

---

## 🎨 Design Themes

The template includes 6 professional design themes in [docs/design/themes/](./docs/design/themes/):
- **Apple**: Premium, cinematic white space.
- **Vodafone**: Bold, monumental display.
- **Pinterest**: Masonry, image-first.
- **Concrete Lemon**: Brutalist, high-viz wayfinding.
- **Gallery White**: Minimalist portfolio.
- **Realty Open House**: Warm, serif elegance.

---

## 🛠️ Key Commands / Triggers

| Action | Phrase | Skill Used |
| :--- | :--- | :--- |
| **Start Project** | "Bootstrap this project" | `bootstrap-skill` |
| **Ideate** | "Help me refine this idea" | `idea-refine-skill` |
| **Plan Feature** | "Create a plan for [X]" | `planning-skill` |
| **Write Spec** | "Write a technical spec for [Y]" | `spec-driven-skill` |
| **Ship Code** | "/ship" | `shipping-skill` |
| **Review Code** | "/review" | `code-reviewer` |

---

## ⚖️ Rules for AI Agents

- **Skill-First**: If a task matches a skill, you MUST use it.
- **Strict Docs**: Do not deviate from the tokens defined in `Design.md` or the routes in `API.md`.
- **No Shortcuts**: Build for scale and maintainability from line one.

---

*Built with ❤️ for High-Density Engineering.*
