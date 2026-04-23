# =============================================================================
# Aider Runner — FASE 13.5b/3
# -----------------------------------------------------------------------------
# Wraps the Aider CLI (https://aider.chat) behind the same gRPC contract
# as openclaude-runner + claude-code-runner, so the same adapter in the
# api (src/lib/openclaude-client.ts) can route work items to any of the
# three runtimes transparently.
#
# Key points:
#   - OpenAI-compatible endpoint: aider inherits OPENAI_API_KEY +
#     OPENAI_API_BASE from env and routes through LiteLLM. No provider
#     bypass; full governance/audit/DLP/rate-limit applies.
#   - Dedicated uid (1002) + dedicated socket volume to stay inside the
#     EACCES isolation established in 13.5b/0.
#   - grpcio-tools generates pb2 + pb2_grpc stubs at build time from the
#     proto copied from src/proto — single source of truth.
# =============================================================================

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Pin versions for reproducible builds. aider-chat is the only hard dep
# the runner wraps; grpcio provides the server + client plumbing.
RUN pip install --no-cache-dir \
        'aider-chat==0.70.0' \
        'grpcio==1.68.1' \
        'grpcio-tools==1.68.1' \
        'protobuf>=5.26,<6'

WORKDIR /app
COPY proto/openclaude.proto /app/proto/openclaude.proto
COPY server.py /app/server.py

# Generate pb2 + pb2_grpc stubs at build time so the runtime doesn't need
# protoc. Output lands directly in /app next to server.py.
RUN python -m grpc_tools.protoc \
        -I/app/proto \
        --python_out=/app \
        --grpc_python_out=/app \
        /app/proto/openclaude.proto

# Dedicated uid/gid 1002 — keeps Aider isolated from openclaude-runner (root)
# and claude-code-runner (node=1000).
RUN groupadd -r aider -g 1002 && \
    useradd  -r -g aider -u 1002 -m -d /home/aider aider && \
    mkdir -p /var/run/govai /workspace && \
    chown -R aider:aider /app /var/run/govai /workspace /home/aider

USER aider
WORKDIR /workspace

ENV GRPC_HOST=0.0.0.0 \
    GRPC_PORT=50051 \
    GRPC_SOCKET_PATH=/var/run/govai/aider.sock \
    HOME=/home/aider

EXPOSE 50051

CMD ["python", "/app/server.py"]
