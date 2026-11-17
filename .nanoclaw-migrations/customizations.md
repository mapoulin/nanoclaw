# Customizations to re-apply on v2

Apply after `migrate-v2.sh` + `/migrate-from-v1` Phase 0 (v2 answers in Slack).
Paths prefixed `v1:` refer to the fork at `dfb47d82`; everything else is the v2 checkout.

## Applied skills (v1)

- **Slack** — v1 `skill/slack` (bolt-based `src/channels/slack.ts`). v2: install with
  `/add-slack` (Chat SDK bridge); migrate-v2.sh does this when Slack is selected.
  Single registered group: `slack:C0ALFDK1HT5` → folder `slack_main`, was `is_main=1`
  → grant owner role to `slack:<Marc's user id>` in `/migrate-from-v1` Phase 1.
- **Native credential proxy** — v1 `skill/native-credential-proxy` (replaced OneCLI with
  `src/credential-proxy.ts`, OAuth token from `.env`). v2: decide between OneCLI
  (upstream default, recommended) and re-merging `upstream/skill/native-credential-proxy`
  if it supports v2. Not a code port.

## 1. Agent model: Claude Sonnet 5.5

**Intent:** All agents run on `claude-sonnet-5-5`.

**v1:** `AGENT_MODEL` in `v1:src/config.ts`, passed as `ANTHROPIC_MODEL` in
`v1:src/container-runner.ts` (commits ab481930, dfb47d82).

**How to apply:** No code. v2 reads `NANOCLAW_DEFAULT_MODEL` (see `src/container-config.ts`,
`model: row.model ?? DEFAULT_MODEL`). Add to `.env`:
```
NANOCLAW_DEFAULT_MODEL=claude-sonnet-5-5
```
Check the `slack_main` agent group has no per-group `model` overriding it. Verify after a
run that the session used `claude-sonnet-5-5`.

## 2. Slack Socket Mode auto-recovery

**Intent:** If the Slack Socket Mode client gives up reconnecting, the process must not
stay silently deaf (inbound dead, outbound REST still working). v1 exits so systemd
restarts it.

**v1:** `v1:src/channels/slack.ts` `setupFatalReconnectHandler()` (commit d1dbdda3):
```ts
const client = (this.app as unknown as { receiver: { client: EventEmitter } }).receiver.client;
client.on('unable_to_socket_mode_start', (err: unknown) => {
  logger.error({ err }, 'Slack Socket Mode client gave up reconnecting, exiting process for restart');
  process.exit(1);
});
```

**How to apply:** v2 Slack goes through the Chat SDK bridge (`src/channels/chat-sdk-bridge.ts`
+ `src/channels/slack.ts` copied from upstream's `channels` branch by `/add-slack`). It still
uses Socket Mode when `SLACK_APP_TOKEN` (xapp-…) is set (`mode: appToken ? 'socket' : 'webhook'`),
so the failure mode can recur. Check whether it already handles reconnect exhaustion (look for
`unable_to_socket_mode_start` / reconnect handling in the adapter and in
`src/channels/adapter.ts` / `src/liveness.ts`). Port only if the gap still exists, using the
same pattern: listen for the socket client's terminal event, log, `process.exit(1)` and rely
on the service's restart policy. Background: Aug 2026 outage, see memory
`project_nanoclaw_aws_slack_outage_2026-08`.

## 3. imap-smtp-email container skill

**Intent:** Agent reads/sends Marc's email over IMAP/SMTP (IMAP default host
`127.0.0.1:1143`). Used ad hoc and by the morning digest.

**Files:** copy the whole directory `v1:container/skills/imap-smtp-email/`
(`SKILL.md`, `setup.sh`, `package.json`, `package-lock.json`, `scripts/imap.js`,
`scripts/smtp.js`) into v2 `container/skills/imap-smtp-email/`. Fork-specific fixes already
inside those files (no separate action):
- `smtp.js`: `execFile` maxBuffer 10 MB, IMAP fetch maxBuffer 50 MB (acaf45d4, 9999e721)
- `smtp.js`: HTML wrapper + quoted reply with `gmail_quote` structure (2f95ecc9)
- `imap.js`: `parseDate` keeps the UTC marker and converts to America/Toronto (a4198bf3);
  raw `HEADER.FIELDS` fallback removed (dff638ef)

**Credentials:** the skill loads `../.env` relative to `scripts/`. On the box the real file is
the per-group copy: `data/sessions/slack_main/.claude/skills/imap-smtp-email/.env`
(IMAP_*/SMTP_*/ALLOWED_WRITE_DIRS). It is not in git. migrate-v2.sh copies session data; verify
the `.env` lands next to the skill in the v2 per-group skills dir, otherwise copy it there.
Better long-term: move these into OneCLI/v2 secret handling if v2 supports env injection for
container skills.

**Dependencies:** the skill needs its own `node_modules` (`dotenv`, `imap`, `imap-simple`,
`mailparser`, `nodemailer` per its package.json). Check how v2 installs container-skill deps
(`container/install-cli-tools.sh`, `container/cli-tools.json`) or run `npm ci` in the skill dir.

## 4. Morning digest script

**Intent:** Daily 08:00 (America/Toronto) Slack digest of last-24h inbox + unread newsletters
(newsletters are marked read after). Scheduled task `task-1775483632503-m4brx4`
(cron `0 8 * * *`, group `slack_main`) whose prompt runs
`node /workspace/project/scripts/digest-fetch.js`.

**Files:** `v1:scripts/digest-fetch.js`, `v1:scripts/package.json` (dep `turndown ^7.2.0`),
`v1:scripts/package-lock.json`. The script shells out to the email skill's `imap.js`
(path overridable with `IMAP_SCRIPT`).

**How to apply:** migrate-v2.sh ports the scheduled task. v2 (v2026.10.0) does **not** mount
the project root at `/workspace/project` (no reference in `src/` or `container/agent-runner`),
so: move `digest-fetch.js` into `container/skills/imap-smtp-email/scripts/`, add
`turndown ^7.2.0` to that skill's package.json, and update the task prompt's path to the
skill's in-container location. The script locates imap.js via
`process.env.IMAP_SCRIPT || '/home/node/.claude/skills/imap-smtp-email/scripts/imap.js'`;
change the default to a path relative to the script (`path.join(dirname, 'imap.js')`) so it
works wherever v2 puts skills.
Test by running the script inside a v2 container for the `slack_main` group.

## 5. Agent can edit and commit its own skills

**Intent:** The agent installs/changes container skills and commits them to the fork
(`git@github.com:mapoulin/nanoclaw.git`), using a deploy key.

**v1:** `v1:src/container-runner.ts` mounts `container/skills` writable,
`.git` writable, and `data/github_ssh` → `/home/node/.ssh` read-only (2bc4dde2, cd455b69,
7ed5122d). `groups/global/CLAUDE.md` has the push rules (no force, verify history; see
acadd3cd).

**How to apply:** v2 ships `container/skills/self-customize` and `/manage-mounts`. Ask Marc
whether he still wants the agent committing to the fork. If yes, prefer v2's
self-customize flow; add the `.ssh` mount via `/manage-mounts` rather than patching core.
If no, drop it and remove the deploy keys from the box.

## 6. Global memory instructions

**Intent:** Assistant is named **Claw** (trigger `@Claw`), proactive memory instructions,
trimmed global CLAUDE.md.

**Files:** `v1:groups/global/CLAUDE.md` (commits 9383fb27, a71f38b5, 24a7ad5b), `ASSISTANT_NAME`
in `.env`.

**How to apply:** user content. migrate-v2.sh carries `.env` and group folders; confirm the
global file's content ended up in v2's global/shared memory location (`docs/memory.md`,
`/migrate-memory`). Drop v1-only sections (OneCLI, IPC tool names, skill-push instructions if
#5 is dropped).

## 7. Per-group memory repo

**Intent:** `groups/slack_main` is its own git repo
(`git@github-memory:mapoulin/nanoclaw-memory.git`) so memory is versioned and backed up.

**How to apply:** after migration, check whether the v2 group folder is a copy (no `.git`)
or the same dir. Re-init it as a clone of `nanoclaw-memory` (or move `.git` over) so the
history continues. SSH alias `github-memory` lives in the box's `~/.ssh/config`.

## 8. Box deploy (`~/nanoclaw-sync.sh`)

**Intent:** Push to fork `main` = deploy. The v1 unit runs `nanoclaw-sync.sh` as
`ExecStartPre` (fatal) and v1 `container-runner.ts` runs it before every agent session
(non-fatal). It does `git fetch && git reset --hard origin/main`, `npm install && npm run build`
when HEAD moved, and `git pull --ff-only` on the memory repo when clean.

**How to apply:** do not port as-is (npm vs pnpm, v2 updates by release channel through
`/update-nanoclaw`). Options:
- Keep "fork main = deploy" with a v2 script: `git fetch && git reset --hard origin/main`,
  `pnpm install --frozen-lockfile && pnpm run build`, memory repo pull. Wire it as the v2
  unit's `ExecStartPre`.
- Or adopt v2's release-channel updates and keep fork changes on a branch rebased per
  release.
Decide with Marc during Stage B. Either way remove the pre-session sync call (v1-only).

## Dropped (v1-only, not ported)

- `.github/workflows/{update-tokens,bump-version}.yml` removal and fork-sync workflows —
  CI plumbing for the v1 fork.
- `setup/verify.ts` ONECLI_URL tweak, `@slack/bolt`/`@slack/types` root deps — replaced by
  v2 channel install.
- `src/credential-proxy.ts`, `PROXY_BIND_HOST` in `src/container-runtime.ts` — part of the
  native-credential-proxy choice above.
