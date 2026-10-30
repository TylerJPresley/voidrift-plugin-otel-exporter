# @voidrift/plugin-otel-exporter

VoidRift OpenTelemetry exporter — maps the core's neutral ObsRecord onto OTel GenAI spans and ships them to any OTLP backend.

Package `@voidrift/plugin-otel-exporter` · kind: `plugin` · repo: `voidrift-plugin-otel-exporter`. This folder is its own git project; commit here.

## What this is
A plugin loaded at runtime via `config.plugins`; it exports `register(core, options)` and uses only the CoreAPI surface (`core.register.*`, `core.registry`), never SDK internals. It is trusted code in the SDK's process; a failure is contained and logged as a warning. Secrets are referenced by environment variable NAME only; exporters flush before the process exits. `@voidrift/core` is a peer dependency.

## Specification
Governing blueprints: `blueprint.md`, `otel-exporter-blueprint.md`. They are maintained outside this repository by the project owner and are the
authoritative specifications; code follows them, never the reverse. Section numbers (`§N.N`) cited in code
comments and tests stay stable. A spec change needs the owner's approval.

## Dependencies
- `@voidrift/core` `^0.1.0` (peer dependency)
- No source or test imports another package by relative path or reaches into its `dist`; use declared dependencies only.
- Before adding a dependency check its license: shipped dependencies (`dependencies`, `peerDependencies`, anything bundled) must be Apache-2.0 or more permissive (MIT, BSD, ISC); reject copyleft, including weak copyleft (MPL, EPL, CDDL). Dev-only tooling is not restricted.
- Depend on LangChain abstractions (`BaseChatModel`), not provider implementations. There is no automatic model failover (owner decision 2026-10-18).

## Build and verify
Run from this folder. Scripts:
- `npm run build`
- `npm run typecheck`
- `npm run test`
- TypeScript strict, ESM. Single test file: `npx vitest run <file>`.
- Lint and the package-graph checks are not configured in this repository yet.

## Testing
- Everything is tested. A bug fix carries a regression test; a new feature carries tests before it is complete.
- Statement coverage: ≥80% per package, ≥90% for entities and use-cases, ≥70% for adapters.
- Tests mirror the source directory structure; use in-memory implementations of repository interfaces, `InMemoryTransport` from `@modelcontextprotocol/sdk` for MCP tests, and `hermeticTmp(label)` for test directories (never a fixed `/tmp/voidrift-*` path).
- Fit for the target: VoidRift runs against local models (Ollama, vLLM), OpenAI-compatible proxies and cloud APIs; a feature that works on only one provider is not correct.

## Conventions
- Configuration files are JSON; prose is Markdown. Filename slugs are lowercase alphanumerics and hyphens.
- A limit is added only when exceeding it would break functionality or testing shows a tunable problem; otherwise derive it from an existing budget or keep an internal constant. Every limit is an entry in the one `limits` registry (`core-blueprint.md` §13.11).

Follow `CONTRIBUTING.md` for this project's standards.
