# claude-code-runner/Dockerfile
# ---------------------------------------------------------------------------
# FASE 7 — Claude Code Official sidecar
#
# This container exposes the REAL Anthropic Claude Code CLI behind a gRPC
# shim that speaks the same openclaude.proto the existing adapter already
# uses. When the adapter talks to `claude-code-runner:50051` it gets the
# same event shape (TextChunk, ToolCallStart, ToolCallResult, FinalResponse,
# ErrorResponse) — but the underlying work is executed by the real Claude
# Code runtime instead of the open OpenClaude runner.
#
# Profile: ONLY built / started when the operator opts in explicitly
# (`docker compose --profile official up -d claude-code-runner`). It
# requires a real ANTHROPIC_API_KEY with credits; without one the CLI
# exits with a 401 and the adapter surfaces that error verbatim.
#
# Unified adapter: the bridge.js file translates the Claude Code CLI's
# streaming JSON output into the proto events the adapter already
# consumes — no adapter-side changes are required to support it.
# ---------------------------------------------------------------------------

FROM node:20-slim

WORKDIR /app

# ── Dependencies ───────────────────────────────────────────────────────────
# - curl: CLI installer + runtime diagnostics
# - ca-certificates: HTTPS for Anthropic API calls from inside the CLI
# - git: Claude Code expects a git binary available for its native tools
#        (Git tool, workspace detection) — installing it up front avoids
#        the CLI hard-erroring when a skill tries to invoke git from the
#        sandbox.
# - jq + bash: shell-based skills often pipe through jq.
#
# FASE 14.0/6a₂.C — fat container tooling. Lets the agent generate
# PDF / DOCX / XLSX out-of-the-box without falling back to multi-step
# shell improv (the original PDF reality-check burned 24 tools per
# task; with reportlab in-place a single python3 call lands the same
# output in 3-5 tool turns).
#
#   * python3 / pip / venv          — runtime + reportlab/openpyxl/etc
#   * pandoc                        — md → pdf / docx / html one-liners
#   * wkhtmltopdf                   — html → pdf for richer styling
#   * poppler-utils + ghostscript   — pdf splitting / manipulation
#   * imagemagick                   — image conversion / thumbnails
#   * libreoffice-{core,writer,calc} — headless fallback for legacy
#                                      .doc / .xls and high-fidelity
#                                      .xlsx generation; the -nogui
#                                      package isn't available in
#                                      bookworm so we install just
#                                      writer + calc to skip
#                                      impress / draw / base footprint
#   * build-essential               — some pip wheels fall back to
#                                      compile (lxml on glibc-musl mix)
#   * locales                       — enable pt_BR.UTF-8 so report
#                                      generation formats Brazilian
#                                      dates / numbers correctly
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git jq bash \
        python3 python3-pip python3-venv \
        pandoc \
        wkhtmltopdf \
        poppler-utils ghostscript imagemagick \
        libreoffice-core libreoffice-writer libreoffice-calc \
        build-essential \
        locales \
    && sed -i '/pt_BR.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=pt_BR.UTF-8 \
    LANGUAGE=pt_BR:pt \
    LC_ALL=pt_BR.UTF-8

# ── Python libraries — document & data toolkit ────────────────────────────
# Installed system-wide via --break-system-packages because Debian
# bookworm enforces PEP 668 (externally-managed environments). We don't
# ship a venv layer because the agent invokes python3 from arbitrary
# cwds inside the workspace and a venv would require activation in
# every tool call. The CLI runs as `node` (uid 1000) but pip3 here
# executes as root during build; the resulting site-packages is
# world-readable so the runtime user can import without issues.
#
# Selection rationale:
#   * reportlab / pypdf2 / pdfplumber  — PDF read / write / inspect
#   * python-docx / openpyxl / xlsxwriter — Office read / write
#   * markdown / beautifulsoup4 / lxml — html + md tooling
#   * pandas / numpy                   — tabular wrangling for ~80%
#                                         of report-generation skills
#   * matplotlib / seaborn             — chart embedding (paired with
#                                         reportlab for branded PDFs)
RUN pip3 install --no-cache-dir --break-system-packages \
        reportlab pypdf2 pdfplumber \
        python-docx openpyxl xlsxwriter \
        markdown beautifulsoup4 lxml \
        pandas numpy \
        matplotlib seaborn

# ── Claude Code CLI ────────────────────────────────────────────────────────
# The CLI is distributed as a global npm package (@anthropic-ai/claude-code).
# We install it globally so it's available on PATH as `claude` regardless
# of the WORKDIR at runtime. The CLI is a pure-Node tool so no build toolchain
# or native deps are needed beyond the base node:20 image.
RUN npm install -g @anthropic-ai/claude-code \
    && claude --version || echo "[install] claude binary not yet on PATH — will retry at runtime"

# ── Bridge dependencies ────────────────────────────────────────────────────
# Small project for the gRPC shim only. We intentionally keep this isolated
# from the Claude Code CLI install so upgrading one doesn't disturb the other.
RUN npm init -y \
    && npm install --silent --no-fund --no-audit \
        @grpc/grpc-js@1.12.2 \
        @grpc/proto-loader@0.7.13 \
        ioredis@5.4.1 \
        chokidar@4.0.1

# ── Copy shim source ───────────────────────────────────────────────────────
COPY proto/ /app/proto/
COPY bridge.js /app/bridge.js

# ── Workspace + skills volume mount-points ────────────────────────────────
# /tmp/govai-workspaces — shared between api + runner via the
#                         govai_workspaces named volume so both sides
#                         see the same per-(org, work_item) work tree.
# /mnt/skills           — FASE 14.0/6a₂.C: read-only mount of the
#                         skills_storage volume populated by the api.
#                         Anthropic-style skill packages (SKILL.md +
#                         scripts + assets) are referenced from the
#                         agent's system prompt at /mnt/skills/<org>/
#                         <skill_id>/. RO at compose time.
# /var/run/govai        — gRPC unix-socket dir.
RUN mkdir -p /tmp/govai-workspaces /tmp/govai-workspace /var/run/govai /mnt/skills \
    && chmod 777 /tmp/govai-workspaces /tmp/govai-workspace /var/run/govai \
    && chmod 0755 /mnt/skills

# ── FASE 12: Non-root user ────────────────────────────────────────────────
# Claude CLI 2.x refuses --dangerously-skip-permissions when running as
# root ("cannot be used with root/sudo privileges for security reasons").
# The node:20-slim base image already ships a `node` user (uid 1000).
# Give it ownership of the workspace + app dirs and run as that user.
RUN chown -R node:node /app /tmp/govai-workspaces /tmp/govai-workspace /var/run/govai
# /mnt/skills stays root-owned (read-only at runtime via compose mount);
# uid 1000 reads through filesystem permissions (chmod 0755).
USER node

# ── Defaults overridable from docker-compose ───────────────────────────────
ENV GRPC_HOST=0.0.0.0 \
    GRPC_PORT=50051 \
    GRPC_SOCKET_PATH=/var/run/govai/claude-code.sock \
    CLAUDE_CLI_PATH=claude \
    CLAUDE_CODE_MAX_BUDGET_USD=0.50 \
    HOME=/tmp

# ── Healthcheck ────────────────────────────────────────────────────────────
# Probes the gRPC TCP port directly — same pattern as openclaude-runner so
# compose dependency graphs behave identically for both sidecars.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=30s \
    CMD node -e "const n=require('net');const c=n.connect(50051,'127.0.0.1',()=>{c.end();process.exit(0)});c.on('error',()=>process.exit(1))" || exit 1

EXPOSE 50051

CMD ["node", "bridge.js"]
