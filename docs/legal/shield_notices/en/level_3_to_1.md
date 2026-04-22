---
from_level: 3
to_level: 1
locale: en
version: 1.0.0
---

# You are lowering the protection level to Free Flow (Level 1)

## This is a significant controls REDUCTION. Read very carefully.

By leaving Level 3 (Maximum Shield) you are **turning off two control sets at once**: runtime tool-use classification AND segregation of duties on formal actions.

## What remains active at Level 1

- DLP blocking prompts and responses with sensitive data.
- Automatic cost monitoring and spending caps.
- Full audit trail of every interaction with immutable records.
- Policy denials enforced automatically.

## What is switched off

- **Runtime tool-use classification**: agents (Claude Code, OpenClaude) go back to using tools natively — there is no GovAI-side pause for destructive tools anymore.
- **Segregation of duties**: policy publication, risk assessments, and exception approvals will now allow the same person to request and approve their own action.
- **SOC 2 non-compliance** for the SoD-dependent controls (CC6.1, CC7.2, CC8.1).

## Expected impact

- Agent executions return to continuous, fast flow.
- Risk / compliance teams must be notified — if your organization is audited (SOC 2, ISO 27001, etc.), formally record the decision and rationale.
- Any external integration consuming the GovAI API that expected "awaiting approval" responses will stop receiving them — review the callers.

## This change is recorded

On confirmation, your identity, the exact timestamp, and the text of this notice will be recorded in an immutable platform event. The record makes the organizational decision to significantly reduce controls explicit.

---

To go back to Level 2 or 3, you will see another change-of-level notice.
