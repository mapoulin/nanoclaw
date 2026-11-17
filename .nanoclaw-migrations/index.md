# NanoClaw Migration Guide — v1 fork → v2 (v2026.10.0)

Generated: 2026-11-17
Base (merge-base with upstream): 1d5c38d1 (2026-04-05)
HEAD at generation: dfb47d82 (fork `main`)
Upstream target: tag `v2026.10.0` (7203e00d, 2026-10-09). Upstream tip at generation: 2cb6926b (v2026.11.0-rc.1)

This is a **v1 → v2** migration. v2 is a rewrite (central DB + per-session DBs, Chat SDK
channels installed as skills, OneCLI gateway for credentials, pnpm, new service unit).
The worktree-and-reapply flow of `/migrate-nanoclaw` does not apply. Use upstream's path:

1. Fresh v2 checkout in a **sibling directory** of the v1 install.
2. `bash migrate-v2.sh` — interactive, must be typed by the user in a real terminal.
   Migrates `.env`, groups (CLAUDE.md → CLAUDE.local.md), sessions, scheduled tasks,
   channel code + auth, container skills; builds the image.
3. `/migrate-from-v1` skill — owner role, access policy, memory, port custom code
   using the sections in [customizations.md](customizations.md).

v1 stays untouched; rollback = stop the v2 service, start the v1 one.

## Migration Plan

### Stage A — Local rehearsal (Mac)
1. Copy the box's v1 data (`store/`, `data/`, `groups/`, `.env`) into a local v1 dir
   (e.g. `~/nanoclaw-v1-rehearsal`, a checkout of fork `main`). **Stop the box's service
   first, or use a different Slack app**: two processes on the same Slack app token
   (Socket Mode) split inbound events between them.
2. `git clone` upstream at `v2026.10.0` into a sibling dir (e.g. `~/nanoclaw-v2`).
3. User runs `bash migrate-v2.sh` there (points at the v1 rehearsal dir via
   `NANOCLAW_V1_PATH`).
4. `/migrate-from-v1`, then apply [customizations.md](customizations.md) in order.
5. Test: Slack message round-trip, email skill (`imap.js check`), digest-fetch dry run,
   model in use = `claude-sonnet-5-5`.

### Stage B — Box
1. Disable the v1 auto-deploy first (see customizations.md → "Box deploy"): remove
   `ExecStartPre=/home/ubuntu/nanoclaw-sync.sh` from the v1 unit and the pre-session
   call (in v1 `src/container-runner.ts`) is harmless once main stops moving.
2. Clone v2 to `~/nanoclaw-v2`, user runs `ssh -t … 'cd ~/nanoclaw-v2 && bash migrate-v2.sh'`.
3. Re-apply customizations (commit them to a fork branch during Stage A so Stage B is a
   checkout, not a redo).
4. Switch services, smoke test in Slack, keep v1 dir for rollback.

### Risk areas
- **Disk on the box:** 5.1 GB free; v1 image is 2.4 GB. v2 pulls/builds agent images
  plus pnpm store. Prune old images / grow the EBS volume before Stage B.
- **Credentials model changes:** v1 fork uses the native credential proxy
  (OAuth token in `.env`). v2 default is the OneCLI gateway. migrate-v2.sh runs OneCLI
  setup; upstream still has `skill/native-credential-proxy` if OneCLI is unwanted.
- **Project mount:** the morning digest runs `node /workspace/project/scripts/digest-fetch.js`.
  v2's mount layout differs; verify where (if anywhere) the project root is mounted,
  otherwise move the script into the email container skill (see customizations.md).
- **Message history is not migrated** by v2 (only agents, channels, wiring, tasks,
  group folders, sessions). Conversation archives in `groups/slack_main/conversations/`
  are files and come along with the group folder.
- **Box auto-deploy:** `nanoclaw-sync.sh` does `git reset --hard origin/main` +
  `npm install && npm run build` on every service start and before every agent session.
  If v2 code lands on fork `main` while v1 is still running, the v1 service breaks.
  Keep v2 work on branch `migrate/v2` until Stage B is done.

## Sections
- [customizations.md](customizations.md) — each customization with intent and how to re-apply in v2
