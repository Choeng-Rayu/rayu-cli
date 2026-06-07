#!/bin/bash

# Test Specialist Swarm — Dispatch all 7 agents on real task
# Tests: context sharing, tool usage, permission handling, memory persistence

set -e

SCENARIO=$(cat << 'EOF'
I want to build an Invoice Management MVP for Cambodia. Requirements:
- Dual-currency support (KHR/USD), Khmer+English UI
- REST API with auth, PDF export, Bakong payment integration
- Flutter mobile app, CI/CD, Docker containerization

Use all 7 specialists to design this:
1. PA-AGENT: Decide tech stack
2. DB-AGENT: Design invoice schema (dual currency)
3. BE-AGENT: REST API routes + auth middleware
4. SEC-AGENT: Auth design, RBAC, validation rules
5. FE-AGENT: Dashboard components and invoice form
6. MOB-AGENT: Flutter screen architecture
7. DO-AGENT: Docker + CI/CD pipeline

For each specialist:
- Use tools (Read, Write, Bash) to create working artifacts
- Check if permission prompts appear and bubble to user
- Save learnings to your MEMORY.md
- Reference prior specialists' decisions

Verify:
✓ Each specialist gets correct context (no gold-plating)
✓ Tool calls ask for permission (don't auto-deny)
✓ Memory injection works (search-before pattern)
✓ Specialists can read shared context from prior waves
✓ DRIFT_FLAG emitted for out-of-scope work
EOF
)

echo "═══════════════════════════════════════════════════════════════════"
echo "SPECIALIST SWARM TEST: All 7 agents on real task"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "SCENARIO:"
echo "$SCENARIO"
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "Starting interactive rayu-cli session..."
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Run in interactive mode so user can approve permissions, watch streams, etc.
node dist/rayu.js --print "$SCENARIO" \
  --permission-mode default \
  --debug "agent" \
  --model "claude-opus-4-6" \
  2>&1 | tee test-specialist-swarm.log

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "TEST COMPLETE"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Check test-specialist-swarm.log for:"
echo "  ✓ PA-AGENT tech stack decision output"
echo "  ✓ DB-AGENT schema design (dual currency)"
echo "  ✓ BE-AGENT API routes + auth middleware"
echo "  ✓ SEC-AGENT auth flow + RBAC matrix"
echo "  ✓ FE-AGENT component architecture"
echo "  ✓ MOB-AGENT Flutter screen plan"
echo "  ✓ DO-AGENT Dockerfile + CI/CD"
echo "  ✓ Permission prompts (if any tool calls occurred)"
echo "  ✓ DRIFT_FLAG emissions (if out-of-scope work detected)"
echo "  ✓ MEMORY.md entries (search-before pattern)"
echo ""
