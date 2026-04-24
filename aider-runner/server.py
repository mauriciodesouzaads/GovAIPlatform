"""
Aider gRPC runner — FASE 13.5b/3.
---------------------------------------------------------------------------
Implements the same `openclaude.v1.AgentService.Chat` bidi-stream that
openclaude-runner and claude-code-runner speak, so the api adapter can
route work items to Aider without runtime-specific branches.

Flow (simplified):
    Client -> ChatRequest(message, working_directory, ...)
    Server <- TextChunk (one per aider stdout line)
            <- FinalResponse on clean exit
            <- ErrorResponse on non-zero exit or Python exception

Aider inherits OPENAI_API_KEY + OPENAI_API_BASE from env and routes all
LLM calls through LiteLLM. The runner does not hold provider keys of
its own. `AIDER_MODEL` is passed via `--model` so the choice is visible
in the spawn command for audit.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from concurrent import futures
from pathlib import Path

import grpc

# These modules are generated at image build time from proto/openclaude.proto
import openclaude_pb2 as pb        # noqa: E402
import openclaude_pb2_grpc as pb_grpc  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format='[aider-runner] %(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger(__name__)


class AgentServicer(pb_grpc.AgentServiceServicer):
    """Implements the bidirectional Chat stream.

    The api always sends exactly one ChatRequest as the first (and
    usually only) client message, then drains ServerMessage events
    until FinalResponse or ErrorResponse. We follow the same shape.
    """

    def Chat(self, request_iterator, context):  # noqa: N802  (gRPC naming)
        first_msg = next(request_iterator, None)
        if first_msg is None:
            yield pb.ServerMessage(error=pb.ErrorResponse(
                message='empty client stream',
                code='EMPTY_STREAM',
            ))
            return

        req = first_msg.request
        if not req or not req.message:
            yield pb.ServerMessage(error=pb.ErrorResponse(
                message='first message must be ChatRequest with non-empty message',
                code='INVALID_FIRST_MESSAGE',
            ))
            return

        workdir = Path(req.working_directory or '/workspace')
        try:
            workdir.mkdir(parents=True, exist_ok=True)
        except Exception as err:
            yield pb.ServerMessage(error=pb.ErrorResponse(
                message=f'cannot create workspace {workdir}: {err}',
                code='WORKSPACE_UNAVAILABLE',
            ))
            return

        model_override = req.model if req.HasField('model') else None
        model = model_override or os.environ.get('AIDER_MODEL', 'govai-llm-cerebras')

        cmd = [
            'aider',
            '--yes',
            '--no-auto-commits',
            '--no-show-model-warnings',
            '--model', model,
            '--message', req.message,
        ]

        log.info('spawning aider: cwd=%s model=%s session=%s', workdir, model, req.session_id)

        env = {
            **os.environ,
            'OPENAI_API_KEY': os.environ.get('OPENAI_API_KEY', ''),
            'OPENAI_API_BASE': os.environ.get('OPENAI_API_BASE', ''),
        }

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(workdir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError:
            yield pb.ServerMessage(error=pb.ErrorResponse(
                message='aider binary not found in container',
                code='AIDER_NOT_FOUND',
            ))
            return

        # Forward aider stdout line-by-line as TextChunk events so the
        # api worker sees progress in the same shape as the other
        # runtimes. A non-zero exit becomes ErrorResponse; clean exit
        # becomes FinalResponse.
        full_text_parts: list[str] = []
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                if line:
                    full_text_parts.append(line)
                    yield pb.ServerMessage(text_chunk=pb.TextChunk(text=line))
        except Exception as err:
            log.exception('aider stream read error')
            proc.kill()
            yield pb.ServerMessage(error=pb.ErrorResponse(
                message=f'stream read failed: {err}',
                code='AIDER_STREAM_ERROR',
            ))
            return

        exit_code = proc.wait()
        if exit_code == 0:
            yield pb.ServerMessage(done=pb.FinalResponse(
                full_text=''.join(full_text_parts),
                prompt_tokens=0,       # aider doesn't report token usage
                completion_tokens=0,
            ))
        else:
            yield pb.ServerMessage(error=pb.ErrorResponse(
                message=f'aider exited with code {exit_code}',
                code='AIDER_EXIT_NONZERO',
            ))


def serve() -> None:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    pb_grpc.add_AgentServiceServicer_to_server(AgentServicer(), server)

    socket_path = os.environ.get('GRPC_SOCKET_PATH')
    tcp_host = os.environ.get('GRPC_HOST', '0.0.0.0')
    tcp_port = os.environ.get('GRPC_PORT', '50051')

    started_any = False
    if socket_path:
        try:
            Path(socket_path).parent.mkdir(parents=True, exist_ok=True)
            # Remove stale socket from prior run — bind fails otherwise
            try:
                os.unlink(socket_path)
            except FileNotFoundError:
                pass
            server.add_insecure_port(f'unix://{socket_path}')
            # FASE 13.5b.2 — Python's grpcio creates unix sockets with mode
            # 0755 (owner rwx, others r-x). Unix socket connect() requires
            # write permission, so the api container (uid 1000 / govai)
            # gets EACCES when reaching this socket owned by the aider
            # user (uid 1002). openclaude-runner and claude-code-runner
            # already end up with 0666 via the grpc-js default, which is
            # why those two runtimes dispatch cleanly cross-uid. Match
            # that contract explicitly here.
            os.chmod(socket_path, 0o666)
            log.info('listening on unix://%s (chmod 0666)', socket_path)
            started_any = True
        except Exception as err:
            log.warning('unix socket bind failed on %s: %s — continuing with TCP only',
                        socket_path, err)

    server.add_insecure_port(f'{tcp_host}:{tcp_port}')
    log.info('listening on %s:%s', tcp_host, tcp_port)
    started_any = True

    assert started_any
    server.start()

    # gRPC blocks until terminated; use a thread to handle SIGTERM for
    # faster `docker compose stop` behaviour.
    shutdown = threading.Event()
    def _stop(*_args):
        shutdown.set()
        server.stop(grace=5)

    import signal
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    server.wait_for_termination()


if __name__ == '__main__':
    serve()
