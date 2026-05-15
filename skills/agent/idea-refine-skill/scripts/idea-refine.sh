#!/bin/bash
set -e

# This script helps initialize the ideas directory for the idea-refine skill.
# Updated to move from docs/ideas to root ideas/ per user request.

IDEAS_DIR="ideas"
LEGACY_DIR="docs/ideas"

# Create root ideas directory if it doesn't exist
if [ ! -d "$IDEAS_DIR" ]; then
  mkdir -p "$IDEAS_DIR"
  echo "Created root directory: $IDEAS_DIR" >&2
fi

# Migrate from legacy directory if it exists
if [ -d "$LEGACY_DIR" ]; then
  echo "Found legacy ideas directory: $LEGACY_DIR. Migrating..." >&2
  mv "$LEGACY_DIR"/* "$IDEAS_DIR"/ 2>/dev/null || true
  rmdir "$LEGACY_DIR" 2>/dev/null || echo "Note: Could not remove $LEGACY_DIR (it might not be empty or has other files)." >&2
fi

echo "{\"status\": \"ready\", \"directory\": \"$IDEAS_DIR\"}"
