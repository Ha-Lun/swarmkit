#!/usr/bin/env bash
# Claude Code Swarm Setup Script
# Delegating to unified installer
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$REPO_DIR/install.sh" --claude "$@"
