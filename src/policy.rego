# src/lib/opa/policy.rego
package govai.policy

import data.govai.policy.action
import data.govai.policy.allow
import data.govai.policy.reason

import rego.v1

# 1. Topic blacklisting
violation_forbidden_topic if {
	some i
	topic := input.rules.forbidden_topics[i]
	contains(lower(input.message), lower(topic))
}

# 2. Jailbreak / Prompt Injection Prevention
bypass_phrases := ["ignore previous", "admin mode", "bypass"]

violation_jailbreak if {
	some i
	phrase := bypass_phrases[i]
	contains(lower(input.message), phrase)
}

# 3. HIGH-RISK ACTION DETECTION → Human-in-the-Loop
hitl_keywords := input.rules.hitl_keywords

violation_hitl if {
	input.rules.hitl_enabled != false
	some i
	keyword := hitl_keywords[i]
	contains(lower(input.message), lower(keyword))
}

# Decide action based on violations
# Provide reasons
