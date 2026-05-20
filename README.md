# 🧠 BrainRouter

### Dynamic Context Gateway & Multi-Agent Memory Core

BrainRouter is a multi-tenant, hierarchical memory engine and context router designed to coordinate autonomous AI agents. By organizing and serving context dynamically, BrainRouter prevents context-window bloat, controls LLM latency, and allows multiple agents (e.g. CLI helpers, IDE plugins, and web dashboards) to maintain a synchronized, persistent memory and behavioral identity.

Rather than loading every checklist and instruction set into the prompt at once, BrainRouter utilizes **Spiking Skill Routing**—a dynamic activation score and decay mechanism that automatically pre-warms the agent's active context window with relevant rules and memories only when active tools or tasks warrant them.

---

## 🏗️ System Architecture

BrainRouter is structured as a TypeScript monorepo using npm workspaces:

```mermaid
graph TD
    subgraph "Monorepo Workspace Map"
        mcp_server["@brainrouter/mcp-server (mcp/)"]
        web_dashboard["dashboard (web/)"]
        sdk["@brainrouter/sdk (packages/sdk/)"]
        hooks["@brainrouter/hooks (packages/hooks/)"]
        types["@brainrouter/types (packages/types/)"]
        
        mcp_server -->|Imports| types
        sdk -->|Imports| types
        hooks -->|Imports| sdk
        hooks -->|Imports| types
        web_dashboard -->|Imports| hooks
        web_dashboard -->|Imports| sdk
        web_dashboard -->|Imports| types
    end
```

### Monorepo Workspaces:
*   **`mcp/` (`@brainrouter/mcp-server`):** Express HTTP / Streamable MCP Server hosting the core memory engine, L0/L1 pipelines, and SQLite store.
*   **`packages/types/` (`@brainrouter/types`):** Centralized TypeScript interfaces for REST APIs, memory layers, and configurations.
*   **`packages/sdk/` (`@brainrouter/sdk`):** Type-safe Client SDK (`BrainRouterClient`) for making REST API calls to the server.
*   **`packages/hooks/` (`@brainrouter/hooks`):** React Hooks to sync dashboard panels with active memory logs and activations.
*   **`web/` (`dashboard`):** Next.js dashboard client styled in Obsidian dark mode, visualising real-time activation potentials.

---

## ⚡ Runtime Execution Flow

Every agent turn operates through a Sensor-Analyzer-Reactor loop:

```mermaid
graph TD
    subgraph "Active Turn Cycle"
        action["Agent Action / Tool Trigger"] -->|Sensor| spike["Spike Skill Activation (+1.0)"]
        spike -->|Store| db[(SQLite WAL Database)]
        
        recall["Prompt Recall Request"] -->|Analyzer| decay["Calculate In-Memory SNN Decay"]
        db --> decay
        decay -->|Evaluate| check{"Potential >= 1.5?"}
        
        check -->|Yes| prewarm["Reactor: Pre-Warm Prompt Context (Inject skill hints & records)"]
        check -->|No| fallback["Reactor: Load Standard Prompt Context"]
        
        prewarm --> assemble["Assemble Final LLM Prompt"]
        fallback --> assemble
    end
```

---

## 🛠️ Getting Started

### 1. Prerequisites
- **Node.js:** v22+ (required for native `node:sqlite` support)
- **npm:** v10+

### 2. Installation
Install dependencies in the monorepo root:
```bash
npm install
```

### 3. Environment Variables
Create an `.env` file in the root directory:
```env
# Server configuration (default: 3747)
PORT=3747
USE_HTTP=true

# Security
BRAINROUTER_JWT_SECRET=your_secure_random_jwt_secret_here

# Skill Routing parameters
BRAINROUTER_SKILL_HALF_LIFE_MINUTES=10
BRAINROUTER_SKILL_MIN_TURN_DECAY=0.05
BRAINROUTER_SKILL_PREWARM_THRESHOLD=1.5
BRAINROUTER_SKILL_SPIKE_AMOUNT=1.0
BRAINROUTER_SKILL_MAX_POTENTIAL=4.0
```

### 4. Running the Project

#### Build the Monorepo
Compile shared packages and compile the Next.js app:
```bash
npm run build
```

#### Run the MCP Server (Backend)
Start the backend MCP server (runs Express and hosts the SQLite database):
```bash
npm run dev -w @brainrouter/mcp-server
```
Once started, the backend exposes:
- **MCP SSE Transport:** `http://localhost:3747/mcp`
- **REST API:** `http://localhost:3747/api`
- **Health Check:** `http://localhost:3747/health`

#### Run the Web Dashboard (Frontend)
Run the Next.js frontend in development mode:
```bash
npm run dev -w dashboard
```
Open [http://localhost:3000](http://localhost:3000) (the default port Next.js uses for the client dashboard web server) to view the visualizer dashboard.

---

## 🧪 Testing

To run the complete test suite:
```bash
npm test
```

---

## 📄 License
This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
