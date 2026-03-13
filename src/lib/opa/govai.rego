##############################################################################
# GovAI Platform — OPA Policy
# OWASP LLM Top 10 (2025): LLM01-PromptInjection, LLM06-SensitiveInfoDisclosure
# + Org-configurable forbidden topics
#
# Entrypoint: govai/policy/allow (boolean)
# Also returns: reason (string), category (string) for audit enrichment
#
# Compile:
#   opa build -t wasm -e govai/policy/allow \
#             -e govai/policy/reason \
#             -e govai/policy/category \
#             govai.rego -o bundle.tar.gz
##############################################################################
package govai.policy

import rego.v1

# ── Defaults ──────────────────────────────────────────────────────────────────
default allow         := false
default reason        := "Conteúdo permitido pela política"
default category      := "ALLOW"

# ── LLM01: Prompt Injection ───────────────────────────────────────────────────
# Referência: OWASP LLM01:2025 — Prompt Injection
# Cobre: bypass clássico, role-play/persona hijacking, delimiter injection

llm01_bypass_phrases := [
    # Classic override
    "ignore previous", "ignore all previous",
    "disregard previous", "disregard all instructions", "disregard the above",
    "forget instructions", "forget your instructions", "forget everything",
    "forget all previous", "override instructions", "override your instructions",
    "bypass restrictions", "bypass security", "bypass filter",
    "skip restrictions", "skip instructions",
    # Privilege escalation modes
    "admin mode", "developer mode", "god mode", "root mode",
    "jailbreak", "do anything now", "dan mode", "dude mode",
    "no restrictions", "without restrictions", "remove restrictions",
    "ignore safety", "disable safety", "turn off restrictions",
    # Instruction hijacking
    "new instructions:", "updated instructions:", "revised instructions:",
    "your actual instructions", "your true instructions", "your real instructions",
    "ignore the system prompt", "ignore system instructions",
]

llm01_roleplay_phrases := [
    # Persona hijacking
    "pretend you are", "pretend you're", "pretend to be",
    "act as if you are", "act as a", "act as an",
    "roleplay as", "role-play as", "role play as",
    "you are now", "from now on you are", "from now on you will",
    "simulate being", "simulate a", "simulate an",
    "imagine you are", "imagine you have no", "imagine you have been",
    "behave as", "behave like", "respond as",
    "your new persona", "take on the persona", "assume the persona",
    "you have been reprogrammed", "you have been updated",
    "you are no longer", "you are not an ai",
]

llm01_delimiter_phrases := [
    # Structural injection (markdown/code-block escaping)
    "### system",  "## system", "# system",
    "[system]", "[system prompt]",
    "new conversation starts here", "conversation reset",
    "ignore all context", "reset context", "clear context",
    "end of system prompt", "begin new prompt",
    "user input begins", "end of instructions",
]

violation_prompt_injection if {
    lower_msg := lower(input.message)
    phrase    := llm01_bypass_phrases[_]
    contains(lower_msg, phrase)
}

violation_prompt_injection if {
    lower_msg := lower(input.message)
    phrase    := llm01_roleplay_phrases[_]
    contains(lower_msg, phrase)
}

violation_prompt_injection if {
    lower_msg := lower(input.message)
    phrase    := llm01_delimiter_phrases[_]
    contains(lower_msg, phrase)
}

# ── LLM06: Sensitive Information Disclosure ───────────────────────────────────
# Referência: OWASP LLM06:2025 — Sensitive Information Disclosure
# Cobre: extração de system prompt, pesca de credenciais, comandos de filesystem

llm06_system_prompt_phrases := [
    "reveal your instructions",  "reveal your system prompt",
    "show me your instructions", "show me your prompt",
    "show your system prompt",   "show your instructions",
    "what are your instructions","what are your rules",
    "what are your constraints",
    "print your prompt",         "print your instructions",
    "output your instructions",  "output your prompt",
    "display your instructions", "display your prompt",
    "tell me your instructions", "tell me your prompt",
    "what is your initial prompt","what is your system prompt",
    "repeat your instructions",  "repeat your prompt",
    "dump your instructions",
]

llm06_credential_phrases := [
    "show api key",    "reveal api key",   "print api key",
    "show api keys",   "give me api key",  "get api key",
    "give me credentials", "show credentials", "reveal credentials",
    "show me secrets", "reveal secrets",   "print secrets",
    "show password",   "reveal password",  "print password",
    "show private key","reveal private key",
    "show environment variables", "print environment variables",
    "show env vars",   "print env vars",   "echo $env",
    "show .env",       "cat .env",         "read .env",
    "show config",     "reveal config",    "print config",
]

llm06_shell_phrases := [
    # Filesystem traversal
    "cat /etc/", "cat /proc/", "cat /var/",
    "/etc/passwd", "/etc/shadow", "/etc/hosts",
    "/proc/self/", "../../etc/",
    # Destructive commands
    "rm -rf", "rmdir /s", "del /f",
    "drop database", "drop table", "drop schema",
    "delete from", "truncate table", "truncate database",
    # Code injection
    "exec(", "eval(", "__import__(",
    "os.system(", "subprocess.call(", "subprocess.run(",
    "shell_exec(", "system(", "passthru(",
    # Shell meta-characters in exploit context
    "; cat ", "&& cat ", "| cat ", "; ls /", "&& ls /",
]

violation_sensitive_disclosure if {
    lower_msg := lower(input.message)
    phrase    := llm06_system_prompt_phrases[_]
    contains(lower_msg, phrase)
}

violation_sensitive_disclosure if {
    lower_msg := lower(input.message)
    phrase    := llm06_credential_phrases[_]
    contains(lower_msg, phrase)
}

violation_sensitive_disclosure if {
    lower_msg := lower(input.message)
    phrase    := llm06_shell_phrases[_]
    contains(lower_msg, phrase)
}

# ── Forbidden Topics (org-configurable) ──────────────────────────────────────

violation_forbidden_topic if {
    lower_msg := lower(input.message)
    topic     := input.rules.forbidden_topics[_]
    contains(lower_msg, lower(topic))
}

# ── Decision ──────────────────────────────────────────────────────────────────

allow if {
    not violation_prompt_injection
    not violation_sensitive_disclosure
    not violation_forbidden_topic
}

# reason e category usam else-chains para garantir exatamente um valor

reason := "LLM01: Prompt Injection — tentativa de manipulação de instruções do sistema" if {
    violation_prompt_injection
    not violation_sensitive_disclosure
} else := "LLM06: Extração de informações sensíveis (system prompt, credenciais ou filesystem)" if {
    violation_sensitive_disclosure
    not violation_prompt_injection
} else := "LLM01+LLM06: Prompt Injection e extração de informações sensíveis (ataque combinado)" if {
    violation_prompt_injection
    violation_sensitive_disclosure
} else := "POLICY: Assunto proibido pela configuração da organização" if {
    violation_forbidden_topic
}

category := "LLM01:PromptInjection" if {
    violation_prompt_injection
    not violation_sensitive_disclosure
} else := "LLM06:SensitiveInfoDisclosure" if {
    violation_sensitive_disclosure
    not violation_prompt_injection
} else := "LLM01+LLM06:Combined" if {
    violation_prompt_injection
    violation_sensitive_disclosure
} else := "POLICY:ForbiddenTopic" if {
    violation_forbidden_topic
}
