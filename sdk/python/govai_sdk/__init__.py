"""
govai-sdk — Official Python client for the GovAI Platform API.

This module is a scaffold. The concrete models + api modules are
generated from `docs/api/openapi.yaml` by openapi-python-client:

    pip install openapi-python-client
    cd sdk/python
    openapi-python-client generate \\
        --path ../../docs/api/openapi.yaml \\
        --config config.yaml \\
        --overwrite

After generation, `govai_sdk.Client`, `govai_sdk.AuthenticatedClient`,
and `govai_sdk.api.*` become available. Keep the regenerated files
checked in so downstream consumers don't need to install the generator.
"""

__version__ = "1.0.0"

__all__ = ["__version__"]
