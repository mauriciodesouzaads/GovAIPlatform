package govai.policy

default allow = false

allow if {
    not has_prompt_injection
    not has_forbidden_topics
}

has_prompt_injection if {
    lower_message := lower(input.message)
    bypass_phrases := ["ignore", "bypass", "admin mode", "forget"]
    contains(lower_message, bypass_phrases[_])
}

has_forbidden_topics if {
    lower_message := lower(input.message)
    forbidden := ["drop database", "rm -rf", "delete everything"]
    contains(lower_message, forbidden[_])
}
