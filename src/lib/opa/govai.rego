package govai.policy

default allow = false

allow if {
    input.pii_filter == true
    not has_forbidden_topics
}

has_forbidden_topics if {
    some i
    input.message_topics[i] == data.forbidden_topics[_]
}
