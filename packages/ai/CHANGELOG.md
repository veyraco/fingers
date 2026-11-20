# Changelog

## [Unreleased]

### Added

- First Veyra Fingers release.
- Prompt caching: Anthropic Messages (Anthropic API, Claude on Vertex, OpenRouter) and Chat Completions with Anthropic-style markers keep a fourth breakpoint on the message the previous request ended with, and Bedrock a cache point there, so a turn with many parallel tool calls still reads the previous turn's cache entry; prompts are sent as text blocks while caching is on, so a message's wire form does not change when a breakpoint moves. Gemini with long retention (`cacheRetention: "long"` / `FINGERS_CACHE_RETENTION=long`) caches the system instruction and tools in an explicit context cache (`cachedContents`, 1 h) reused by every request, with a fallback to the uncached request and `gemini_context_cache_refused` / `gemini_context_cache_fallback` diagnostics.
- Providers `google-vertex-anthropic` (Claude on Google Vertex AI through Anthropic Messages on Vertex rawPredict, Application Default Credentials) and `qwen` (Alibaba Cloud Model Studio pay-as-you-go, `DASHSCOPE_API_KEY`).
