// Authenticated Fail2ban status and management API.
// The Node service runs as root on production, so all command arguments and
// file writes are strictly validated. Never replace execFileSync with a shell.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const FAIL2BAN_CLIENT = '/usr/bin/fail2ban-client';
const FAIL2BAN_LOG = '/var/log/fail2ban.log';
const AUDIT_LOG = '/var/log/orderassist-fail2ban-audit.log';
const WHITELIST_FILE = '/etc/fail2ban/jail.d/orderassist-whitelist.local';
const PROTECTED_WHITELIST_FILE = '/etc/fail2ban/orderassist-protected-whitelist.txt';

function runClient(args) {
  return execFileSync(FAIL2BAN_CLIENT, args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024
  }).trim();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.loggedIn) {
    return res.status(401).json({ error: 'Login required' });
  }
  res.set('Cache-Control', 'no-store');
  next();
}

function requireDashboardRequest(req, res, next) {
  if (req.get('x-requested-with') !== 'OrderAssistFail2ban') {
    return res.status(403).json({ error: 'Invalid dashboard request' });
  }
  next();
}

function validAddress(value, allowCidr = true) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /\s/.test(trimmed)) return false;

  const parts = trimmed.split('/');
  if (parts.length === 1) return net.isIP(parts[0]) !== 0;
  if (!allowCidr || parts.length !== 2 || net.isIP(parts[0]) === 0) return false;

  const prefix = Number(parts[1]);
  const max = net.isIP(parts[0]) === 4 ? 32 : 128;
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= max;
}

function parseJails(status) {
  const match = status.match(/Jail list:\s*(.*)$/m);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map((jail) => jail.trim()).filter(Boolean);
}

function statusNumber(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}:\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : 0;
}

function parseJailStatus(jail, text) {
  const bannedMatch = text.match(/Banned IP list:\s*(.*)$/m);
  const banned = bannedMatch && bannedMatch[1].trim()
    ? bannedMatch[1].trim().split(/\s+/).filter((value) => validAddress(value, false))
    : [];

  return {
    jail,
    currentlyFailed: statusNumber(text, 'Currently failed'),
    totalFailed: statusNumber(text, 'Total failed'),
    currentlyBanned: statusNumber(text, 'Currently banned'),
    totalBanned: statusNumber(text, 'Total banned'),
    banned
  };
}

function getWhitelist(jail = 'sshd') {
  const output = runClient(['get', jail, 'ignoreip']);
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^[|`\-\s]+/, '').trim())
    .filter((line) => validAddress(line));
}

function readEvents(limit = 100) {
  if (!fs.existsSync(FAIL2BAN_LOG)) return [];
  const stat = fs.statSync(FAIL2BAN_LOG);
  const readSize = Math.min(stat.size, 2 * 1024 * 1024);
  const fd = fs.openSync(FAIL2BAN_LOG, 'r');
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);

  const events = [];
  const lines = buffer.toString('utf8').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
    const line = lines[i];
    const match = line.match(
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}),\d+\s+fail2ban\.actions\s+\[\d+\]:\s+(NOTICE|WARNING)\s+\[([^\]]+)\]\s+(Ban|Unban)\s+(\S+)/
    );
    if (!match || !validAddress(match[5], false)) continue;
    events.push({
      timestamp: match[1],
      jail: match[3],
      action: match[4],
      ip: match[5]
    });
  }
  return events;
}

function readManagedWhitelist() {
  if (!fs.existsSync(WHITELIST_FILE)) return [...getProtectedWhitelist()];
  const text = fs.readFileSync(WHITELIST_FILE, 'utf8');
  const match = text.match(/^\s*ignoreip\s*=\s*(.*)$/m);
  if (!match) return [...getProtectedWhitelist()];
  return match[1]
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => validAddress(value));
}

function getProtectedWhitelist() {
  const defaults = ['127.0.0.1/8', '::1'];
  if (!fs.existsSync(PROTECTED_WHITELIST_FILE)) return new Set(defaults);
  const entries = fs.readFileSync(PROTECTED_WHITELIST_FILE, 'utf8')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => validAddress(value));
  return new Set([...defaults, ...entries]);
}

function writeManagedWhitelist(entries) {
  const unique = [...new Set(entries)];
  const content = [
    '[DEFAULT]',
    '# Managed by OrderAssist Fail2ban dashboard.',
    '# Localhost and the trusted admin IP cannot be removed in the web UI.',
    `ignoreip = ${unique.join(' ')}`,
    ''
  ].join('\n');
  const temp = `${WHITELIST_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content, { mode: 0o644 });
  fs.renameSync(temp, WHITELIST_FILE);
  runClient(['reload']);
}

function audit(req, action, detail) {
  const remote = req.ip || req.socket?.remoteAddress || 'unknown';
  const line = `${new Date().toISOString()} actor=${remote} action=${action} detail=${detail}\n`;
  fs.appendFileSync(AUDIT_LOG, line, { mode: 0o600 });
}

function errorResponse(res, error) {
  console.error('Fail2ban dashboard error:', error);
  const message = error && error.message ? error.message : String(error);
  res.status(500).json({ error: 'Fail2ban operation failed', detail: message.slice(0, 300) });
}

function setupFail2banDashboard(app) {
  app.get('/api/fail2ban/status', requireAuth, (req, res) => {
    try {
      const topStatus = runClient(['status']);
      const jails = parseJails(topStatus);
      const jailStatuses = jails.map((jail) => parseJailStatus(jail, runClient(['status', jail])));
      const settings = jails.includes('sshd')
        ? {
            bantime: Number(runClient(['get', 'sshd', 'bantime'])),
            findtime: Number(runClient(['get', 'sshd', 'findtime'])),
            maxretry: Number(runClient(['get', 'sshd', 'maxretry']))
          }
        : null;

      res.json({
        active: true,
        generatedAt: new Date().toISOString(),
        jails: jailStatuses,
        whitelist: jails.includes('sshd') ? getWhitelist('sshd') : [],
        protectedWhitelist: [...getProtectedWhitelist()],
        settings,
        events: readEvents(100)
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  app.post(
    '/api/fail2ban/unban',
    requireAuth,
    requireDashboardRequest,
    (req, res) => {
      try {
        const jail = String(req.body?.jail || '');
        const ip = String(req.body?.ip || '').trim();
        const jails = parseJails(runClient(['status']));
        if (!jails.includes(jail) || !validAddress(ip, false)) {
          return res.status(400).json({ error: 'Invalid jail or IP address' });
        }
        runClient(['set', jail, 'unbanip', ip]);
        audit(req, 'unban', `${jail}:${ip}`);
        res.json({ ok: true, message: `${ip} was unbanned from ${jail}` });
      } catch (error) {
        errorResponse(res, error);
      }
    }
  );

  app.post(
    '/api/fail2ban/whitelist',
    requireAuth,
    requireDashboardRequest,
    (req, res) => {
      try {
        const ip = String(req.body?.ip || '').trim();
        if (!validAddress(ip)) {
          return res.status(400).json({ error: 'Enter a valid IP address or CIDR range' });
        }
        const entries = readManagedWhitelist();
        if (!entries.includes(ip)) entries.push(ip);
        writeManagedWhitelist(entries);
        if (validAddress(ip, false)) {
          try {
            runClient(['set', 'sshd', 'unbanip', ip]);
          } catch (_) {
            // It is fine if the IP was not currently banned.
          }
        }
        audit(req, 'whitelist-add', ip);
        res.json({ ok: true, message: `${ip} was added to the whitelist` });
      } catch (error) {
        errorResponse(res, error);
      }
    }
  );

  app.delete(
    '/api/fail2ban/whitelist',
    requireAuth,
    requireDashboardRequest,
    (req, res) => {
      try {
        const ip = String(req.body?.ip || '').trim();
        if (!validAddress(ip)) {
          return res.status(400).json({ error: 'Invalid whitelist entry' });
        }
        const protectedWhitelist = getProtectedWhitelist();
        if (protectedWhitelist.has(ip)) {
          return res.status(400).json({ error: 'This safety whitelist entry cannot be removed here' });
        }
        const entries = readManagedWhitelist().filter((entry) => entry !== ip);
        for (const protectedEntry of protectedWhitelist) {
          if (!entries.includes(protectedEntry)) entries.push(protectedEntry);
        }
        writeManagedWhitelist(entries);
        audit(req, 'whitelist-remove', ip);
        res.json({ ok: true, message: `${ip} was removed from the whitelist` });
      } catch (error) {
        errorResponse(res, error);
      }
    }
  );
}

module.exports = { setupFail2banDashboard };
