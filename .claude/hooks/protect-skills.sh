#!/usr/bin/env bash
# PreToolUse guard: blocks deletion or overwrite of files under .claude/skills/.
# Triggered for Bash, Write, Edit, and known GitHub MCP write/delete tools.

set -u

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""')
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')
[ -n "$cwd" ] || cwd=$(pwd)

deny() {
  reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    },
    systemMessage: ("[.claude/skills protected] " + $r)
  }'
  exit 0
}

# True if a path string refers to something under .claude/skills/
under_skills() {
  p="$1"
  [ -n "$p" ] || return 1
  case "$p" in
    *".claude/skills/"*|*".claude/skills") return 0 ;;
    *) return 1 ;;
  esac
}

case "$tool_name" in
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
    if printf '%s' "$cmd" | grep -qE '\.claude/skills'; then
      if printf '%s' "$cmd" | grep -qE '(\brm\b|\brmdir\b|\bunlink\b|\bmv\b|\bshred\b|--delete\b|-delete\b|git[[:space:]]+rm\b|>[[:space:]]*[^|&]*\.claude/skills)'; then
        deny "Bash command touches .claude/skills/ destructively: $cmd"
      fi
    fi
    ;;
  Write)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
    if under_skills "$fp"; then
      abs="$fp"
      case "$abs" in /*) ;; *) abs="$cwd/$abs" ;; esac
      if [ -e "$abs" ]; then
        deny "Write would overwrite existing file in .claude/skills/: $fp"
      fi
    fi
    ;;
  Edit)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
    new_string=$(printf '%s' "$input" | jq -r '.tool_input.new_string // ""')
    if under_skills "$fp"; then
      if [ -z "$new_string" ]; then
        deny "Edit would empty content in .claude/skills/: $fp"
      fi
    fi
    ;;
  mcp__github__delete_file)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.path // ""')
    if under_skills "$fp"; then
      deny "mcp__github__delete_file targets .claude/skills/: $fp"
    fi
    ;;
  mcp__github__push_files)
    bad=$(printf '%s' "$input" | jq -r '[.tool_input.files[]?.path | select(test("\\.claude/skills/"))] | join(", ")')
    if [ -n "$bad" ]; then
      deny "mcp__github__push_files writes to .claude/skills/: $bad"
    fi
    ;;
  mcp__github__create_or_update_file)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.path // ""')
    if under_skills "$fp"; then
      deny "mcp__github__create_or_update_file writes to .claude/skills/: $fp"
    fi
    ;;
esac

exit 0
