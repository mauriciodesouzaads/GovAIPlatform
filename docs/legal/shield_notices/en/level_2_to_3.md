---
from_level: 2
to_level: 3
locale: en
version: 1.0.0
---

# You are raising the protection level to Maximum Shield (Level 3)

## What stays (already active at Level 2)

- DLP blocks prompts and responses with sensitive data.
- Automatic cost monitoring and spending caps.
- Full audit trail of every interaction with immutable records.
- Policy denials enforced automatically.
- **Segregation of duties** on policy publication, risk assessments, and exceptions.

## What will be activated now

- **Runtime tool-use classification**: every tool invoked by agents (Claude Code, OpenClaude) is classified in-flight as safe-read or write/exec/network.
- **Human-in-the-loop pause**: tools classified as destructive (disk writes, command execution, network access) pause execution and wait for an explicit approval from an operator.
- `auto_all` / `auto_safe` approval modes remain available per work item, letting users pre-authorize an entire run if they prefer.

## Impact

- Agent executions that currently flow continuously may wait minutes or hours for human approval on each destructive tool.
- Operators with approval permission need to be available during business hours.
- Programmatic integrations that trigger agents should be prepared to handle the "awaiting approval" state.

## This change is recorded

On confirmation, your identity, the exact timestamp, and the text of this notice will be recorded in an immutable platform event.

---

To go back to Level 1 or 2, you will see another change-of-level notice.
