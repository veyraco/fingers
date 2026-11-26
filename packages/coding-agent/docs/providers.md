# Providers

Most hosted providers support one or both of these authentication methods:

- Sign in through a browser or device flow backed by OAuth.
- Provide an API key.

Use `/login [provider]` to see the methods supported by a provider. Amazon Bedrock and Google Vertex AI can also use ambient cloud credentials.

## Authenticate interactively

Run `/login <provider>`, for example `/login anthropic`; part of a name lists the providers that match it. (`/login` alone signs in to your Veyra account; see [Veyra account commands](cli.md#veyra-account-commands).) Fingers guides you through its OAuth or API-key flow and saves the resulting credential in your [OS keychain](#where-credentials-are-stored).

On a remote or headless machine, an OAuth callback may not reach the local process. When prompted, paste the final redirect URL or authorization code back into Fingers.

Run `/logout <provider>` to remove a provider's stored credential (`/logout` alone signs out of your Veyra account when you are signed in, and otherwise lists the providers). This does not unset environment variables, remove authentication from `models.json`, or revoke the credential at the provider.

## Model connections from Veyra

When you are signed in to Veyra (`fingers login`, or `/login` alone), Fingers offers your organization's model connections from Veyra Connect as providers of their own, named after the connection, for example `Claude (Veyra)` with the id `veyra-<connection id>`. `fingers login` and `/login` list them (`✓ 3 model connections from Connect: …`), `/model` shows their models, and option 1 of the first-run screen picks the first one's default model.

The provider key never reaches your computer. Each model call goes to Veyra Hands' model proxy (`https://api.veyra.so/hands/v1/model-proxy/<connection>/<anthropic|openai|google>`) with your Veyra sign-in's short-lived token for Hands; Hands adds the key of the connection, which may be an API key or a subscription login, and records the call's cost for you. Fingers stores no credential for these providers: nothing goes to the keychain's provider entries, `auth.json` or `models.json`.

Fingers offers a connection when:

- its apps in Connect include both `fingers` and `hands`;
- its provider is one Hands relays: Anthropic, OpenAI, Google Gemini, OpenRouter, xAI or Moonshot Kimi (Bedrock, Vertex AI and OpenAI-compatible endpoints are not offered yet);
- its key was not rejected, and its groups, when set, include yours.

Seeing the connections needs Connect `models:read` for your group. Using one needs Connect `models:use` and Fingers `cli:use`, and stays within the organization's cost caps for the Fingers CLI; a refusal names the connection and what is missing, for example `Veyra model connection “Claude”: refused (…). Ask an admin of your organization in Connect: …`.

Fingers loads the list in the background after the first frame. A start whose saved model, `--model`, `--provider`, `--models` or resumed session names a `veyra-` provider waits for it (up to 8 seconds) before it picks the model. `/logout` removes the connections, and offline (`--offline`) Fingers does not ask for them.

## Where credentials are stored

Fingers keeps saved API keys and OAuth tokens in the operating system's keychain:

| System | Store | Tool Fingers uses |
|---|---|---|
| macOS | login keychain, item "Veyra Fingers" | `security` (built in) |
| Linux | Secret Service (GNOME Keyring, KWallet) | `secret-tool` from libsecret |
| Windows | Credential Manager, "Veyra Fingers/..." | PowerShell (built in) |

Keys reach these tools on standard input, never on a command line. The agent directory then holds only `auth.keychain.json`, a marker without secrets that names the keychain entry.

The first time Fingers starts with a keychain, it moves an existing `auth.json` into the keychain and deletes the file. If the keychain cannot be reached (for example a headless Linux machine without a Secret Service, or a container), Fingers keeps using `auth.json`. Set `FINGERS_CREDENTIAL_STORE=file` to keep `auth.json` on purpose. `auth.json` can contain API keys and OAuth tokens: keep it private and do not commit it.

In [managed RPC mode](rpc-managed.md) Fingers reads neither the keychain nor `auth.json`; the host sends the run's credential.

## Use an API key from the environment

Environment variables are useful in CI and anywhere Fingers should not store the key. Set the variable before starting Fingers:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
fingers
```

This table covers providers with a single primary API-key variable. Providers that need additional configuration or support ambient credentials are covered under [Provider Specific Config](#provider-specific-config).

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| OpenCode Zen and Go | `OPENCODE_API_KEY` |
| TypeSafe ([classifier models](models.md#use-classifier-models)) | `TYPESAFE_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI (Global and China) | `MOONSHOT_API_KEY` |
| Qwen (Alibaba Cloud Model Studio) | `DASHSCOPE_API_KEY` |
| Qwen Token Plan Team | `QWEN_TOKEN_PLAN_TEAM_API_KEY` |
| Qwen Token Plan Team (China) | `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY` |
| Qwen Token Plan Individual | `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY` |
| Qwen Token Plan Individual (China) | `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` |
| Xiaomi MiMo | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

Anthropic also recognizes `ANTHROPIC_OAUTH_TOKEN` as an API credential and `ANTHROPIC_AUTH_TOKEN` as bearer authentication.

With no key or token set, Anthropic uses workload identity federation when `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` are set: the Anthropic SDK exchanges the identity token for a short-lived access token and refreshes it itself (re-reading the identity token file, so keep that file fresh for long sessions). `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are passed through when set.

## Load an API key from a command

To use a secret manager without writing the resolved key to disk, set a provider's `key` in `auth.json` to a command prefixed with `!`:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

Fingers runs the command when the key is first needed and caches its standard output for the process lifetime. Empty output, a timeout, or a nonzero exit leaves the key unresolved until Fingers restarts.

## Provider Specific Config

The providers below have additional setup, need additional settings, or can use credentials supplied by their platform.

A stored API-key credential can include an `env` object. Its values take priority over the process environment for that provider:

```json
{
  "cloudflare-workers-ai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "CLOUDFLARE_ACCOUNT_ID": "account-id"
    }
  }
}
```

### OpenRouter

Authenticate with `/login openrouter` or `OPENROUTER_API_KEY`.

With a key, Fingers lists only the OpenRouter chat models that key may use, with the key's context size, max output, and prices. These come from OpenRouter's `/models/user` endpoint and reflect guardrails and provider restrictions set in OpenRouter. Image and classifier models are not filtered.

Fingers refreshes the list in the background at startup in interactive mode, when `/model` opens, after `/login`, and on `fingers update --models`. The last list is saved and used offline and in `fingers -p` and RPC mode. After switching keys outside `/login`, the previous key's list stays until the next refresh.

Regional endpoints filter models to their region. To use one, set the base URL in [`models.json`](models.md#configure-a-compatible-endpoint):

```json
{
  "providers": {
    "openrouter": { "baseUrl": "https://us.openrouter.ai/api/v1" }
  }
}
```

If the base URL rejects the key at `/models/user` or does not have that endpoint, for example a proxy configured as the OpenRouter base URL, Fingers lists every OpenRouter model.

### Azure OpenAI

The provider ID is `azure` (formerly `azure-openai-responses`). Use it as the key in `auth.json`, `models.json`, and `settings.json`, and in model references such as `--model azure/gpt-5.4`.

The `azure` provider serves OpenAI models through the Responses API and Microsoft Foundry models through Chat Completions, such as `azure/deepseek-v4-pro`.

Set an API key plus either a base URL or resource name:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# Or:
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

Resource root URLs under `ai.azure.com`, `cognitiveservices.azure.com`, and `openai.azure.com` are normalized to the OpenAI API path.

Fingers sends the model ID as the deployment name. If a deployment has a different name, map it with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`:

```bash
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-5.4=my-gpt-deployment,deepseek-v4-pro=my-deepseek
```

`AZURE_OPENAI_API_VERSION` overrides the API version for OpenAI models (default `v1`).

To use a Foundry model that Fingers does not include, add it under `azure` in [`models.json`](models.md#configure-a-compatible-endpoint) with `api: "openai-completions"`. Custom models require a `baseUrl`; `AZURE_OPENAI_BASE_URL` and `AZURE_OPENAI_RESOURCE_NAME` take priority over it when set:

```json
{
  "providers": {
    "azure": {
      "baseUrl": "https://your-resource.services.ai.azure.com",
      "models": [
        { "id": "your-deployment", "api": "openai-completions" }
      ]
    }
  }
}
```

### Amazon Bedrock

Bedrock can use a bearer token or an ambient AWS credential source:

```bash
# Named profile
export AWS_PROFILE=your-profile

# IAM keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# Required for temporary credentials
export AWS_SESSION_TOKEN=...

# Bedrock bearer token
export AWS_BEARER_TOKEN_BEDROCK=...

# Region, when not supplied by the profile or AWS SDK configuration
export AWS_REGION=us-west-2
# AWS_DEFAULT_REGION is also supported
```

Fingers also supports ECS task credentials and IRSA through the standard `AWS_CONTAINER_CREDENTIALS_*` and `AWS_WEB_IDENTITY_TOKEN_FILE` variables.

### Cloudflare AI Gateway

The gateway requires a token, account ID, and gateway ID:

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

The account and gateway IDs can come from the process environment or the credential's `env` object in `auth.json`.

`CLOUDFLARE_API_KEY` authenticates Fingers to the gateway. Upstream access can use Cloudflare unified billing, credentials stored in the gateway, or an `Authorization` header configured for the provider in `models.json`.

### Cloudflare Workers AI

Workers AI requires a token and account ID:

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

The account ID can also be stored in the credential's `env` object.

### Google Vertex AI

Use a Google Cloud API key:

```bash
export GOOGLE_CLOUD_API_KEY=...
```

To use Application Default Credentials, configure a project and location:

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# GCLOUD_PROJECT is also supported
export GOOGLE_CLOUD_LOCATION=us-central1
```

Then authenticate:

```bash
gcloud auth application-default login
```

To use a service-account key file instead, set `GOOGLE_APPLICATION_CREDENTIALS` along with the project and location.

### Claude on Google Vertex AI

The provider `google-vertex-anthropic` sends the Anthropic Messages API to Vertex AI with Application Default Credentials. It needs a project; the location defaults to `global`:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
# optional: a regional endpoint
export GOOGLE_CLOUD_LOCATION=us-east5
fingers --model google-vertex-anthropic/claude-sonnet-4-6
```

`ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` (the names Anthropic's tools use) work too. Model IDs are Anthropic's; Fingers turns dated IDs such as `claude-sonnet-4-5-20250929` into Vertex's `claude-sonnet-4-5@20250929`. Costs use Anthropic's list prices; regional endpoints may bill more.
