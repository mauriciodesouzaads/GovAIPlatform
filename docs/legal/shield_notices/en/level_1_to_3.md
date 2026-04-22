---
from_level: 1
to_level: 3
locale: en
version: 1.0.0
---

# You are raising the protection level to Maximum Shield (Level 3)

## What stays (already active at Level 1)

- DLP blocks prompts and responses containing sensitive data.
- Automatic cost monitoring and per-org spending caps.
- Full audit trail of every interaction with immutable records.
- Policy denials enforced automatically.

## What will be activated now

- **Segregation of duties** on formal actions: policy publication, risk assessments, and security-exception approvals require a different approver than the requester.
- **Runtime tool-use classification**: every tool invoked by agents (Claude Code, OpenClaude) is classified in-flight as safe-read or write/exec/network.
- **Human-in-the-loop pause**: tools classified as destructive (disk writes, command execution, network access) pause execution and wait for an explicit approval from an operator in your organization.

## Impact on user experience

- Executions that are instantaneous today may wait minutes or hours for human approval.
- You need an operator with approval permission available during business hours.
- Policy publication moves from 1 to 2 steps (request + approval).
- Programmatic integrations may need to handle the "awaiting approval" state.

## This change is recorded

On confirmation, your identity, the exact timestamp, and the text of this notice will be recorded in an immutable platform event. This record is retrievable at any time by auditors and constitutes formal evidence of the organizational decision.

---

To revert, you will see another change-of-level notice.
