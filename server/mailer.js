'use strict';

// Minimal SMTP sender (implicit TLS, AUTH PLAIN) with no dependencies.
// Works with Gmail: SMTP_HOST=smtp.gmail.com SMTP_PORT=465
// SMTP_USER=<the gmail address> SMTP_PASS=<a Google "App password">.
// Server only; the phone app opens the staff member's own mail app instead.

const tls = require('node:tls');
const os = require('node:os');

function mailerFromEnv(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  return createMailer({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || env.SMTP_USER,
  });
}

// Strip CR/LF so nothing a youth types can add mail headers.
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);

function encodeHeader(s) {
  const v = oneLine(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function createMailer({ host, port = 465, user, pass, from, timeoutMs = 15000 }) {
  async function send({ to, subject, text, replyTo }) {
    const recipients = [].concat(to).map(oneLine).filter(Boolean);
    if (!recipients.length) throw new Error('No recipient');
    const socket = tls.connect({ host, port, servername: host });
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP timed out')));

    let buffer = '';
    const waiters = [];
    socket.on('data', (chunk) => {
      buffer += chunk;
      // A reply is complete when a line has "NNN " (space, not dash) after the code.
      let m;
      while ((m = buffer.match(/^(\d{3})([ -])[^\n]*\n/m))) {
        const end = buffer.indexOf('\n', m.index) + 1;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end);
        if (m[2] === ' ' && waiters.length) waiters.shift().resolve({ code: Number(m[1]), line });
      }
    });
    socket.on('error', (err) => waiters.splice(0).forEach((w) => w.reject(err)));
    const reply = () => new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    const cmd = async (line, ok) => {
      const p = reply();
      if (line != null) socket.write(`${line}\r\n`);
      const r = await p;
      if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.line.trim()}`);
      return r;
    };

    try {
      await cmd(null, [220]);
      await cmd(`EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'}`, [250]);
      await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
      await cmd(`MAIL FROM:<${oneLine(from).replace(/^.*<|>.*$/g, '')}>`, [250]);
      for (const r of recipients) await cmd(`RCPT TO:<${r}>`, [250, 251]);
      await cmd('DATA', [354]);
      const headers = [
        `From: Bridge Out of Poverty <${oneLine(from).replace(/^.*<|>.*$/g, '')}>`,
        `To: ${recipients.join(', ')}`,
        `Subject: ${encodeHeader(subject)}`,
        replyTo ? `Reply-To: ${oneLine(replyTo)}` : null,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@bridge.local>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
      ].filter(Boolean);
      const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
      await cmd(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, [250]);
      await cmd('QUIT', [221]).catch(() => {});
      return { ok: true };
    } finally {
      socket.end();
    }
  }
  return { send, describe: () => `${user} via ${host}:${port}` };
}

module.exports = { createMailer, mailerFromEnv };
