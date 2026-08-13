# Changelog

All notable changes to this project are documented in this file.

## [0.3.0] - 2026-08-13

### Added

- Added a bounded late-output patrol so useful reports written after the main reply can still reach the owner.
- Added the optional `outputRelayTrustedChatIds` allowlist for owner-triggered group attachments; existing configurations remain valid.

### Fixed

- Recovered reply workers stuck in `resuming` after `ECHO_TIMEOUT` and retried the interrupted turn.
- Prevented missing or relocated Claude session transcripts from creating silent ghost sessions.
- Accepted valid model names ending in `[1m]` while continuing to reject terminal-formatting residue.
- Rejected false-positive Claude startup checks without hiding genuine contract failures.
- Kept failed late-output deliveries eligible for a later retry and serialized patrol polling to avoid duplicate sends.

### Security

- Restricted automatic file and image relay to regular, non-hidden files inside the turn working directory.
- Blocked symlink escapes, credential-like files, inbound uploads, unsupported types, oversized files, unauthorized group attachments, and bot-triggered Discuss attachments.
- Updated narrowly scoped transitive dependency overrides to the first patched versions for the published advisories present in the previous lockfile.

### Changed

- Documented the reply engine as the primary owner-used Claude CLI path, with pool and print retained as rollback options.
- Revalidated the synthetic local CLI contract against Claude Code 2.1.229 while keeping future-version compatibility explicitly unguaranteed.
