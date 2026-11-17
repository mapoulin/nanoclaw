#!/usr/bin/env node

/**
 * SMTP Email CLI
 * Send email via SMTP protocol. Works with Gmail, Outlook, 163.com, and any standard SMTP server.
 * Supports attachments, HTML content, and multiple recipients.
 */

const nodemailer = require('nodemailer');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Fetch Message-ID, References, and body content by reusing imap.js fetch
async function fetchThreadHeaders(uid) {
  const imapScript = path.resolve(__dirname, 'imap.js');

  return new Promise((resolve, reject) => {
    execFile('node', [imapScript, 'fetch', String(uid)], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Failed to fetch thread headers: ${stderr || err.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve({
          messageId: result.messageId || null,
          references: result.references || null,
          from: result.from || null,
          date: result.date || null,
          subject: result.subject || null,
          text: result.text || null,
          html: result.html || null,
        });
      } catch (e) {
        reject(new Error(`Failed to parse imap fetch output: ${e.message}`));
      }
    });
  });
}

// Build an HTML reply with the original message quoted below
function buildQuotedHtml(newBodyText, original) {
  const dateStr = original.date
    ? new Date(original.date).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'full', timeStyle: 'short' })
    : '';
  const fromStr = original.from || '';

  // Escape and convert plain text new body to HTML
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const newBodyHtml = escape(newBodyText).replace(/\n/g, '<br>\n');

  // Extract body content from original HTML, or fall back to plain text
  let quotedContent;
  if (original.html) {
    // Strip outer html/head/body tags, keep inner content
    let inner = original.html
      .replace(/^[\s\S]*?<body[^>]*>/i, '')
      .replace(/<\/body>[\s\S]*$/i, '');
    // If stripping didn't work (no body tag), use html as-is but remove doctype/html/head blocks
    if (inner === original.html) {
      inner = original.html
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<html[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<\/?html[^>]*>/gi, '')
        .replace(/<\/?body[^>]*>/gi, '');
    }
    quotedContent = inner.trim();
  } else if (original.text) {
    quotedContent = escape(original.text).replace(/\n/g, '<br>\n');
  } else {
    quotedContent = '';
  }

  return `<div style="font-family: Arial, sans-serif; font-size: 14px; background: #ffffff; color: #000000;">
  <div>${newBodyHtml}</div>
  <br>
  <div class="gmail_quote gmail_quote_container">
    <div dir="ltr" class="gmail_attr">On ${dateStr}, ${fromStr} wrote:<br></div>
    <blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${quotedContent}</blockquote>
  </div>
</div>`;
}

function validateReadPath(inputPath) {
  let realPath;
  try {
    realPath = fs.realpathSync(inputPath);
  } catch {
    realPath = path.resolve(inputPath);
  }

  const allowedDirsStr = process.env.ALLOWED_READ_DIRS;
  if (!allowedDirsStr) {
    throw new Error('ALLOWED_READ_DIRS not set in .env. File read operations are disabled.');
  }

  const allowedDirs = allowedDirsStr.split(',').map(d =>
    path.resolve(d.trim().replace(/^~/, os.homedir()))
  );

  const allowed = allowedDirs.some(dir =>
    realPath === dir || realPath.startsWith(dir + path.sep)
  );

  if (!allowed) {
    throw new Error(`Access denied: '${inputPath}' is outside allowed read directories`);
  }

  return realPath;
}

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      options[key] = value || true;
      if (value && !value.startsWith('--')) i++;
    } else {
      positional.push(arg);
    }
  }

  return { command, options, positional };
}

// Create SMTP transporter
function createTransporter() {
  const config = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
    },
  };

  if (!config.host || !config.auth.user || !config.auth.pass) {
    throw new Error('Missing SMTP configuration. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env');
  }

  return nodemailer.createTransport(config);
}

// Send email
async function sendEmail(options) {
  const transporter = createTransporter();

  // Verify connection
  try {
    await transporter.verify();
    console.error('SMTP server is ready to send');
  } catch (err) {
    throw new Error(`SMTP connection failed: ${err.message}`);
  }

  const mailOptions = {
    from: options.from || process.env.SMTP_FROM || process.env.SMTP_USER,
    to: options.to,
    cc: options.cc || undefined,
    bcc: options.bcc || undefined,
    subject: options.subject || '(no subject)',
    text: options.text || undefined,
    html: options.html || undefined,
    attachments: options.attachments || [],
    inReplyTo: options.inReplyTo || undefined,
    references: options.references || undefined,
  };

  // If neither text nor html provided, use default text
  if (!mailOptions.text && !mailOptions.html) {
    mailOptions.text = options.body || '';
  }

  const info = await transporter.sendMail(mailOptions);

  return {
    success: true,
    messageId: info.messageId,
    response: info.response,
    to: mailOptions.to,
  };
}

// Read file content for attachments
function readAttachment(filePath) {
  validateReadPath(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Attachment file not found: ${filePath}`);
  }
  return {
    filename: path.basename(filePath),
    path: path.resolve(filePath),
  };
}

// Send email with file content
async function sendEmailWithContent(options) {
  // Handle attachments
  if (options.attach) {
    const attachFiles = options.attach.split(',').map(f => f.trim());
    options.attachments = attachFiles.map(f => readAttachment(f));
  }

  return await sendEmail(options);
}

// Test SMTP connection
async function testConnection() {
  const transporter = createTransporter();

  try {
    await transporter.verify();
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.SMTP_USER, // Send to self
      subject: 'SMTP Connection Test',
      text: 'This is a test email from the IMAP/SMTP email skill.',
      html: '<p>This is a <strong>test email</strong> from the IMAP/SMTP email skill.</p>',
    });

    return {
      success: true,
      message: 'SMTP connection successful',
      messageId: info.messageId,
    };
  } catch (err) {
    throw new Error(`SMTP test failed: ${err.message}`);
  }
}

// Main CLI handler
async function main() {
  const { command, options, positional } = parseArgs();

  try {
    let result;

    switch (command) {
      case 'send':
        if (!options.to) {
          throw new Error('Missing required option: --to <email>');
        }
        if (!options.subject && !options['subject-file']) {
          throw new Error('Missing required option: --subject <text> or --subject-file <file>');
        }

        // Read subject from file if specified
        if (options['subject-file']) {
          validateReadPath(options['subject-file']);
          options.subject = fs.readFileSync(options['subject-file'], 'utf8').trim();
        }

        // Read body from file if specified
        if (options['body-file']) {
          validateReadPath(options['body-file']);
          const content = fs.readFileSync(options['body-file'], 'utf8');
          if (options['body-file'].endsWith('.html') || options.html) {
            options.html = content;
          } else {
            options.text = content;
          }
        } else if (options['html-file']) {
          validateReadPath(options['html-file']);
          options.html = fs.readFileSync(options['html-file'], 'utf8');
        } else if (options.body) {
          options.text = options.body;
        }

        if (options['reply-to-uid']) {
          const original = await fetchThreadHeaders(options['reply-to-uid']);
          options.inReplyTo = original.messageId;
          options.references = [original.references, original.messageId].filter(Boolean).join(' ');

          // Build quoted HTML reply (use current body text, fall back to empty)
          const bodyText = options.text || options.body || '';
          options.html = buildQuotedHtml(bodyText, original);
          options.text = undefined;
          options.body = undefined;
        } else if (!options.html && !options['html-file']) {
          // Wrap plain text in a basic HTML envelope with white background
          const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const bodyText = options.text || options.body || '';
          const bodyHtml = escape(bodyText).replace(/\n/g, '<br>\n');
          options.html = `<div style="font-family: Arial, sans-serif; font-size: 14px; background: #ffffff; color: #000000;">${bodyHtml}</div>`;
          options.text = undefined;
          options.body = undefined;
        }

        result = await sendEmailWithContent(options);
        break;

      case 'test':
        result = await testConnection();
        break;

      default:
        console.error('Unknown command:', command);
        console.error('Available commands: send, test');
        console.error('\nUsage:');
        console.error('  send   --to <email> --subject <text> [--body <text>] [--html] [--cc <email>] [--bcc <email>] [--attach <file>]');
        console.error('  send   --to <email> --subject <text> --body-file <file> [--html-file <file>] [--attach <file>]');
        console.error('  test   Test SMTP connection');
        process.exit(1);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
