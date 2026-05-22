#!/bin/bash
# ─────────────────────────────────────────────
# BrainRouter MCP — Restart Script
# ─────────────────────────────────────────────

PORT=3747
# Get the directory where this script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "🚀 Restarting BrainRouter MCP Server..."

# 1. Kill existing process on port 3747
PID=$(lsof -t -i:$PORT)
if [ -n "$PID" ]; then
  echo "Stopping existing server (PID: $PID)..."
  kill $PID
  sleep 1
else
  echo "No existing server found on port $PORT."
fi

# 2. Rebuild (optional but recommended)
echo "Building project..."
npm run build

# 3. Start the server in the background
echo "Starting server on port $PORT..."
# We use the start:http script from package.json
# It automatically handles the root resolution
nohup npm run start:http > mcp_server.log 2>&1 &

echo "✅ Server started in background."
echo "   Log file: $DIR/mcp_server.log"
echo "   Health check: http://localhost:$PORT/health"
