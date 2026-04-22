---
from_level: 3
to_level: 2
locale: en
version: 1.0.0
---

# You are lowering the protection level to Compliance (Level 2)

## This is a partial controls reduction. Read carefully.

By leaving Level 3 (Maximum Shield) you are **turning off runtime tool-use classification and the human-in-the-loop pause**.

Segregation of duties on formal actions **remains active** — this move does not break SoD.

## What remains active at Level 2

- DLP blocking prompts and responses with sensitive data.
- Automatic cost monitoring and spending caps.
- Full audit trail of every interaction with immutable records.
- Policy denials enforced automatically.
- **Segregation of duties** on policy publication, risk assessments, and exception approvals.

## What is switched off

- **Runtime tool-use classification**: agents (Claude Code, OpenClaude) go back to using tools natively.
- **Human-in-the-loop pause** on destructive tools (disk writes, command execution, network access): there will no longer be a GovAI-side wait — the runtime's own approval is treated as sufficient.

## Expected impact

- Agent executions return to continuous, fast flow.
- SoD is still enforced on formal actions, preserving part of the SOC 2 control set (CC7.2, CC8.1).
- External integrations that expect the "awaiting approval" state for destructive tools will stop receiving it — review the callers.

## This change is recorded

On confirmation, your identity, the exact timestamp, and the text of this notice will be recorded in an immutable platform event.

---

To go back to Level 3 or further down, you will see another change notice.
