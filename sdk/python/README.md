# govai-sdk (Python)

Official Python client for the **GovAI Platform API**. Generated from
the versioned OpenAPI spec shipped with the platform
(`docs/api/openapi.yaml`) so every endpoint, request model, and
response body is fully typed.

## Install

Once published to PyPI:

```bash
pip install govai-sdk
```

## Regenerate from the spec

The concrete `api/` and `models/` modules are produced by
[`openapi-python-client`](https://github.com/openapi-generators/openapi-python-client)
from `docs/api/openapi.yaml`. The generator is a dev-time dependency,
not a runtime one; commit the generated files.

```bash
pip install openapi-python-client
cd sdk/python
openapi-python-client generate \
    --path ../../docs/api/openapi.yaml \
    --config config.yaml \
    --overwrite
```

Regeneration is idempotent. Run it whenever `docs/api/openapi.yaml`
changes (the platform CI runs `npm run openapi:check` to guarantee
the spec matches the live routes).

## Quick start

```python
from govai_sdk import AuthenticatedClient
from govai_sdk.api.assistants import list_assistants

client = AuthenticatedClient(
    base_url="https://api.yourcompany.com",
    token="sk-govai-…",  # or a JWT
    headers={"x-org-id": "00000000-0000-0000-0000-000000000001"},
    timeout=30,
)

resp = list_assistants.sync(client=client)
for a in resp:
    print(a.id, a.name)
```

Async is also available:

```python
import asyncio
from govai_sdk.api.assistants import list_assistants

async def main() -> None:
    async with AuthenticatedClient(
        base_url="https://api.yourcompany.com",
        token="sk-govai-…",
    ) as client:
        resp = await list_assistants.asyncio(client=client)
        ...

asyncio.run(main())
```

## Rate limits

The generated client returns the raw response on errors; to honor the
platform's `X-RateLimit-*` and `Retry-After` headers, subclass
`AuthenticatedClient` with a retry policy on your httpx transport:

```python
import httpx
from govai_sdk import AuthenticatedClient

transport = httpx.HTTPTransport(retries=3)
client = AuthenticatedClient(
    base_url="https://api.yourcompany.com",
    token="sk-govai-…",
    httpx_args={"transport": transport},
)
```

See `docs/api/RATE_LIMITS.md` in the platform repo for the full
backoff contract.

## License

Apache-2.0. See `LICENSE` at the repo root.
