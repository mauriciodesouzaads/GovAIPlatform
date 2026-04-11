import { GrpcServer } from '../src/grpc/server.ts'
import { init } from '../src/entrypoints/init.ts'

// Polyfill MACRO which is normally injected by the bundler
Object.assign(globalThis, {
  MACRO: {
    VERSION: '0.1.7',
    DISPLAY_VERSION: '0.1.7',
    PACKAGE_URL: '@gitlawb/openclaude',
  }
})

async function main() {
  console.log('Starting OpenClaude gRPC Server...')
  await init()

  // Mirror CLI bootstrap: hydrate secure tokens and resolve provider profile
  // GovAI locked mode: skip secure-storage hydration and provider profile resolution.
  // The container is configured exclusively via environment variables (OPENAI_BASE_URL +
  // OPENAI_API_KEY pointing at the LiteLLM proxy). No saved profiles, no Gemini/GitHub
  // credentials, no provider validation (LiteLLM may not be reachable at boot).
  if (process.env.OPENCLAUDE_GOVAI_LOCKED_MODE === 'true') {
    console.log('[GovAI Locked Mode] Skipping provider profile, credentials hydration, and validation')
    console.log('[GovAI Locked Mode] OPENAI_BASE_URL =', process.env.OPENAI_BASE_URL)
    console.log('[GovAI Locked Mode] OPENAI_MODEL    =', process.env.OPENAI_MODEL || '(default)')
  } else {
    const { enableConfigs } = await import('../src/utils/config.js')
    enableConfigs()
    const { applySafeConfigEnvironmentVariables } = await import('../src/utils/managedEnv.js')
    applySafeConfigEnvironmentVariables()
    const { hydrateGeminiAccessTokenFromSecureStorage } = await import('../src/utils/geminiCredentials.js')
    hydrateGeminiAccessTokenFromSecureStorage()
    const { hydrateGithubModelsTokenFromSecureStorage } = await import('../src/utils/githubModelsCredentials.js')
    hydrateGithubModelsTokenFromSecureStorage()

    const { buildStartupEnvFromProfile, applyProfileEnvToProcessEnv } = await import('../src/utils/providerProfile.js')
    const { getProviderValidationError, validateProviderEnvOrExit } = await import('../src/utils/providerValidation.js')
    const startupEnv = await buildStartupEnvFromProfile({ processEnv: process.env })
    if (startupEnv !== process.env) {
      const startupProfileError = await getProviderValidationError(startupEnv)
      if (startupProfileError) {
        console.warn(`Warning: ignoring saved provider profile. ${startupProfileError}`)
      } else {
        applyProfileEnvToProcessEnv(process.env, startupEnv)
      }
    }
    await validateProviderEnvOrExit()
  }

  const port = process.env.GRPC_PORT ? parseInt(process.env.GRPC_PORT, 10) : 50051
  const host = process.env.GRPC_HOST || 'localhost'
  const server = new GrpcServer()

  server.start(port, host)
}

main().catch((err) => {
  console.error('Fatal error starting gRPC server:', err)
  process.exit(1)
})
