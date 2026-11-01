---
description: "Local external LLM CLI adapter for DeepSeek Harness supporting Agy, Codex, Claude Code, and Copilot CLIs without API keys."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-external-cli

## Summary

`@deepseek-ai/dsh-llm-external-cli` routes DeepSeek Harness model requests to local external LLM CLIs such as Agy, Codex, Claude Code, and Copilot via standard input and standard output. It executes commands locally without requiring a DeepSeek API key or external HTTP credentials. Formatted prompts are passed to child process stdin, and captured stdout is normalized into the canonical DeepSeek Harness streaming and completion chunk protocol with reasoning separation and token usage accounting.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when you want DeepSeek Harness to dispatch prompts to a locally installed LLM command-line interface instead of calling a remote HTTP API.

### When to choose it

Choose this provider when working offline, utilizing subscription-authenticated local CLIs, or running local AI agents (Google Antigravity `agy`, OpenAI `codex`, Anthropic `claude`, GitHub `copilot`) without configuring a DeepSeek API key or HTTP endpoint.

### Select a model in chat

Configured CLI routes offer their actual models in the model selector below the chat input. Select a model and one of its declared reasoning efforts before sending a message. A running request retains its original selection. The CLI default entry keeps the CLI's own model and sends only the effort the CLI documents for it, so every route offers a level even when it advertises no models (Copilot on some installations). The default entry follows the route's models in the list.

Each `providers` profile accepts `cliType`, `models`, and optional custom argument arrays. A model has an `id`, optional `name`, and optional `reasoningEfforts` mapping from selectable effort identifiers to CLI values. Codex uses `--model` and `-c model_reasoning_effort=…`; Claude Code and Agy use `--model` and `--effort`; Copilot uses `--model` and `--reasoning-effort`. Remove conflicting model or effort options from the profile's base `args` before selecting an explicit model.

```yaml
providers:
  codex:
    command: codex
    cliType: codex
    args: [exec]
    models:
      - id: your-model-id
        name: Your model
        reasoningEfforts:
          low: low
          high: high
```

Agy discovers models with `agy models`, Codex answers `model/list` over `codex app-server`, Claude Code discloses its models in the initialization metadata of `--print` stream mode, and Copilot answers `models.list` over its stdio channel. Each channel runs without a generation request and is stopped once the catalog arrives. Discovered models carry the reasoning levels their CLI advertises; the chat selector offers them without saving the model first. A configured entry overrides the name and levels it declares and keeps the discovered ones it leaves unset.

Agy publishes one model identifier per reasoning level (`gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-argon-high`). Discovery folds those identifiers into one model (`Gemini 4 Argon`) whose levels the Effort selector offers, and the request sends the level-free identifier with `--effort`; a model Agy publishes at a single level keeps its identifier. The CLI default entry carries the levels `--effort` documents and applies them to the model Agy configures itself.

Copilot advertises no text models on some installations. Its route then offers only the CLI default entry and its configured models; the default entry still carries the levels `--reasoning-effort` documents. Discovery uses the profile timeout and `discoveryMaxBytes` output limit (default 1 MiB).

Custom CLIs declare `modelArgs` and `effortArgs` arrays. Each `{model}` or `{effort}` occurrence is replaced within its argument without splitting values. For example, `modelArgs: ['--model', '{model}']`. Executable paths may select an explicit `cliType` independently of their filename.

### CLI Examples

#### 1. Google Antigravity CLI (Agy)

Configure the `agy` CLI as your backend provider:

```yaml
- id: llm-external-cli
  name: '@deepseek-ai/dsh-llm-external-cli'
  config:
    command: agy
    args: ['--print', '-']
```

Run via the CLI dispatcher:

```bash
pnpm dsh headless --provider external-cli --model agy "Explain quicksort algorithm"
```

#### 2. OpenAI Codex CLI

Configure the `codex` CLI with execution arguments:

```yaml
- id: llm-external-cli
  name: '@deepseek-ai/dsh-llm-external-cli'
  config:
    command: codex
    args: ['exec']
```

Run via the CLI dispatcher:

```bash
pnpm dsh headless --provider external-cli --model codex "Refactor utils.ts to use modern syntax"
```

#### 3. Anthropic Claude Code CLI

Configure the `claude` CLI with non-interactive print mode:

```yaml
- id: llm-external-cli
  name: '@deepseek-ai/dsh-llm-external-cli'
  config:
    command: claude
    args: ['--print']
```

Run via the CLI dispatcher:

```bash
pnpm dsh headless --provider external-cli --model claude "Find and fix bugs in tests"
```

#### 4. GitHub Copilot CLI

Configure the GitHub `copilot` CLI:

```yaml
- id: llm-external-cli
  name: '@deepseek-ai/dsh-llm-external-cli'
  config:
    command: copilot
    args: ['suggest']
```

Run via the CLI dispatcher:

```bash
pnpm dsh headless --provider external-cli --model copilot "Generate a docker compose file for PostgreSQL"
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`ExternalCliAdapter` implements `LlmAdapter` from `@deepseek-ai/dsh-llm`. For each turn, it formats prompt messages into text, spawns the specified command, writes to child stdin, and reads stdout. A successful exit without response content produces `CLI_EMPTY_OUTPUT`, including the standard-error diagnostic when available. CLI subscription limits and noninteractive permission denials remain provider failures; Harness does not grant permissions or reset quotas. Standard output containing `<think>...</think>` tags is parsed to separate reasoning deltas from visible text deltas. All API key validation is completely bypassed for this provider.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm service](../llm/README.md) - the provider-neutral LLM service this adapter registers on.
- [llm-deepseek adapter](../llm-deepseek/README.md) - direct HTTP API adapter for DeepSeek.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) - multi-provider API adapter.

-----

## Dev Note

The adapter buffers CLI output until process exit. Token counts are estimates; external CLI authentication, quotas, and tool permissions are managed by the CLI.

Each CLI runs headless as it does in a terminal, with its own tools, in the Session's working directory (the `workingDirectory` service), so those tools act on the user's project; without a Session directory it runs in the app's directory. A turn may run that agent loop for a while, so the default `timeoutMs` is 30 minutes. The adapter adjusts the configured arguments: Agy's `--print -` becomes its stream-json mode, because Agy takes `-` as the literal prompt and never reads stdin; Codex `exec` gets `--skip-git-repo-check`; Copilot gets `--silent`, which keeps its banner and statistics out of the reply. When the app itself runs inside a Claude Code session (`CLAUDECODE` is set), the child process does not inherit that session's `CLAUDE_CODE_*` variables. The CLI then signs in with the user's own login instead of the parent session's short-lived token, which fails with "OAuth token revoked".

<a id="model-experience"></a>
## Model Experience

### External CLI execution

#### What the model sees

The external CLI process receives serialized system prompts and conversation turn messages over stdin. Single-turn completion prompts are sent as raw text; multi-turn conversations include role headers (`[System]`, `[User]`, `[Assistant]`, `[Tool Result]`).

#### Token effect

Token usage is estimated from prompt character counts and CLI output character lengths, normalized into `TokenUsage` accounting chunks.

#### KV Cache effect

Prompt prefix reuse and caching behavior depend entirely on the external local CLI's internal caching implementation.

## Known Limitations and Deferred Work

- Interactive multi-step tool calls require native CLI support in the targeted external tool.
