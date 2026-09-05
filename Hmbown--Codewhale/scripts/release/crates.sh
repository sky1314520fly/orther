#!/usr/bin/env bash

# Crates published for each codewhale release, in dependency order.
release_crates=(
  codewhale-build-support
  codewhale-mcp
  codewhale-paths
  codewhale-protocol
  codewhale-release
  codewhale-secrets
  codewhale-state
  codewhale-workflow
  codewhale-workflow-js
  codewhale-execpolicy
  codewhale-hooks
  codewhale-tools
  codewhale-config
  # Path+version dependency of cli/tui — must publish before those crates.
  codewhale-telemetry
  codewhale-lane
  codewhale-agent
  codewhale-core
  # Prototype command boundary depends on core; future TUI/commands adapters
  # consume it without changing current production dispatch in FEAT-014.
  codewhale-command-contract
  codewhale-tui
  codewhale-app-server
  codewhale-cli
)
