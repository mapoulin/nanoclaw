#!/usr/bin/env node
/**
 * digest-fetch.js
 * Fetches the last 24h of emails for the morning digest.
 * Runs both INBOX and Newsletters in parallel, converts HTML bodies to
 * Markdown via turndown, truncates long bodies, and drops noisy fields.
 *
 * Usage (inside container):
 *   node /workspace/project/scripts/digest-fetch.js [options]
 *
 * Options:
 *   --inbox-limit <n>         Max inbox emails (default: 20)
 *   --newsletter-limit <n>    Max newsletter emails (default: 15)
 *   --newsletter-folder <f>   IMAP folder (default: Folders/Newsletters)
 *   --body-limit <n>          Max chars per email body (default: 800)
 *   --recent <time>           Time window, e.g. 24h, 48h (default: 24h)
 *
 * Behaviour:
 *   - INBOX:       all emails (read + unread) within the time window
 *   - Newsletters: unread only; marked as read after the digest is built
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import TurndownService from 'turndown';

const execFileAsync = promisify(execFile);

// Inside the container, imap.js lives in the skills folder.
// Override with IMAP_SCRIPT env var for local testing.
const IMAP =
  process.env.IMAP_SCRIPT ||
  '/home/node/.claude/skills/imap-smtp-email/scripts/imap.js';

const DEFAULTS = {
  inboxLimit: 20,
  newsletterLimit: 15,
  newsletterFolder: 'Folders/Newsletters',
  bodyLimit: 800,
  recent: '24h',
};

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
td.addRule('strip-links', { filter: 'a', replacement: (content) => content });
td.addRule('strip-images', { filter: 'img', replacement: () => '' });

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inbox-limit')       opts.inboxLimit       = parseInt(args[++i]);
    if (args[i] === '--newsletter-limit')  opts.newsletterLimit  = parseInt(args[++i]);
    if (args[i] === '--newsletter-folder') opts.newsletterFolder = args[++i];
    if (args[i] === '--body-limit')        opts.bodyLimit        = parseInt(args[++i]);
    if (args[i] === '--recent')            opts.recent           = args[++i];
  }
  return opts;
}

async function runImap(args) {
  const { stdout } = await execFileAsync('node', [IMAP, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function stripUrls(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')        // bare URLs
    .replace(/\[https?:\/\/[^\]]*\]/g, '') // [url] markdown leftovers
    .replace(/[\u200b\u200c\u200d\u034f\ufeff]/g, '') // zero-width / invisible email spacers
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^[\[\]\|\s]+$/.test(l)) // drop lines that are only brackets/pipes/whitespace
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toMarkdown(email) {
  const raw = email.text ? email.text.trim() : (email.html ? td.turndown(email.html) : '');
  return stripUrls(raw);
}

function cleanEmail(email, bodyLimit) {
  const raw = toMarkdown(email);
  const body =
    raw.length > bodyLimit
      ? raw.slice(0, bodyLimit) + `\n… [+${raw.length - bodyLimit} chars truncated]`
      : raw;

  const out = {
    uid: email.uid,
    from: email.from,
    subject: email.subject,
    date: email.date,
    flags: email.flags,
    body,
  };

  if (email.calendarEvent) out.calendarEvent = email.calendarEvent;

  return out;
}

async function main() {
  const opts = parseArgs();

  const [inbox, newsletters] = await Promise.all([
    runImap(['search', '--recent', opts.recent, '--mailbox', 'INBOX', '--limit', String(opts.inboxLimit)]),
    runImap(['search', '--recent', opts.recent, '--mailbox', opts.newsletterFolder, '--limit', String(opts.newsletterLimit), '--unseen']),
  ]);

  // Mark fetched newsletters as read
  if (newsletters.length > 0) {
    const uids = newsletters.map((e) => String(e.uid));
    await runImap(['mark-read', ...uids, '--mailbox', opts.newsletterFolder]);
  }

  const result = {
    fetched_at: new Date().toISOString(),
    inbox: inbox.map((e) => cleanEmail(e, opts.bodyLimit)),
    newsletters: newsletters.map((e) => cleanEmail(e, opts.bodyLimit)),
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
