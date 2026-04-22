---
from_level: 1
to_level: 2
locale: en
version: 1.0.0
---

# You are raising the protection level to Compliance (Level 2)

## What stays (already active at Level 1)

- DLP blocks prompts and responses containing sensitive data (national IDs, credit cards, medical data).
- Automatic cost monitoring and per-org spending caps.
- Full audit trail of every interaction with immutable records.
- Policy denials enforced automatically.
- Runtimes (Claude Code, OpenClaude) still use tools natively — the runtime's own tool-use dialog remains the accepted authorization.

## What will be activated now

- **Segregation of duties** on formal actions: policy publication, risk assessments, and security-exception approvals will require a different user to approve than the one requesting.
- **Two-step flow** for formal actions: requester registers intent; a different user with a compatible role approves it.

## Impact on the daily experience

- Day-to-day operations (chat, assistant execution, tool use) **do not change**.
- Only formal actions now require two distinct users. Make sure you have at least two operators with approval permission before activating this level.
- Policy publication moves from 1 to 2 steps (request + approval).

## This change is recorded

On confirmation, your identity, the exact timestamp, and the text of this notice will be recorded in an immutable platform event. This record is retrievable at any time by auditors and constitutes formal evidence of the organizational decision.

---

To revert, you will see another change-of-level notice.
