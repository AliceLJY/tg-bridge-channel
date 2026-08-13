# v0.3.0 — resilient Claude reply sessions and safer output relay

## Why upgrade

This release makes the owner-used Claude reply path recover from more daemon and transcript failures, captures useful output that arrives after the main turn, and tightens automatic attachment relay.

## Highlights

- Recovers reply workers that previously remained stuck in `resuming` after an echo timeout, then retries the interrupted turn.
- Detects ghost or relocated sessions before they silently swallow the next message.
- Adds a bounded, serial late-output patrol for reports produced after the main reply has finished.
- Confines automatic file and image relay to safe files inside the turn working directory and requires an explicit allowlist for group attachments.
- Fixes valid `[1m]` model-name handling and false-positive Claude startup checks.
- Treats reply as the primary Claude CLI engine while retaining pool and print as rollback paths.
- Refreshes narrowly scoped transitive dependency overrides to patched versions without upgrading the major SDK surfaces.

## Compatibility

The `a2a-tg/v1` wire protocol is unchanged, and legacy `a2a/v1` input remains accepted. Existing configuration remains valid: `outputRelayTrustedChatIds` is optional and defaults to an empty list. No data migration is required.

Claude Code is not bundled with this package. CLI engines use `CLAUDE_CLI_PATH` or `~/.local/bin/claude`. The synthetic local contract was revalidated against Claude Code 2.1.229 on 2026-08-13, when 2.1.229 was npm's `latest`; future Claude Code releases are not automatically guaranteed compatible because the reply engine also depends on observed daemon and transcript internals.

## Upgrade

1. Pull the v0.3.0 source.
2. Run `bun install --frozen-lockfile`.
3. Run `bun test`, `bun run check:claude-contract`, and `bun run package:check`.
4. Verify the locally installed Claude Code version with `claude --version` and review the compatibility boundary in the README.
5. During an approved maintenance window, restart bridge instances one at a time and verify every expected instance separately.

## Rollback

Return to the GitHub v0.2.2 Release commit, run `bun install --frozen-lockfile`, and restore the previous runtime revision during a maintenance window. No configuration or data migration reversal is required. If only the daemon reply contract regresses, switch to the pool engine as the lower-coupling CLI fallback.
