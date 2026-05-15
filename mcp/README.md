# BrainRouter MCP Server

A high-performance Model Context Protocol (MCP) server that exposes BrainRouter's "Brain" and "Map" as callable tools.

## Features

- **Skill Layer**: Fetch specific skill sections (workflow, usage, etc.) to minimize context noise.
- **Docs Layer**: Read and update project-specific source-of-truth documentation (API.md, Design.md).
- **Dual Registry**: Automatically merges global BrainRouter skills with project-specific local skills.
- **Write Operations**: Agents can scaffold new skills and update documentation sections safely.

## Installation

### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brainrouter": {
      "command": "node",
      "args": [
        "/path/to/BrainRouter/mcp/dist/index.js",
        "--root",
        "/path/to/your/current/project"
      ]
    }
  }
}
```

### Cursor

1. Go to Settings > Features > MCP.
2. Click "+ Add New MCP Server".
3. Name: `BrainRouter`
4. Type: `stdio`
5. Command: `node /path/to/BrainRouter/mcp/dist/index.js --root /path/to/your/current/project`

## Tools

| Tool | Description |
|---|---|
| `list_skills` | List all available skills (global + local). |
| `get_skill` | Fetch a specific section of a skill (e.g., workflow). |
| `search_skills` | Fuzzy search across all skills. |
| `get_persona` | Fetch a persona definition (e.g., code-reviewer). |
| `get_reference` | Fetch a reference checklist (e.g., security-checklist). |
| `list_docs` | List all project-specific documentation. |
| `get_doc` | Read a project document or section. |
| `update_doc` | Update a section in a project document. |
| `create_skill` | Scaffold a new skill in the local project. |
| `update_skill` | Update an existing skill section. |

## Development

```bash
cd mcp
npm install
npm run build
npm run dev # with tsx watch
```

---
*Built for High-Density Engineering.*
