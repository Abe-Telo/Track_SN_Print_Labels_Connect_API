// Fail2ban dashboard UI. All data and actions require the existing login session.
(function () {
  let refreshTimer = null;
  let busy = false;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatSeconds(value) {
    const seconds = Number(value || 0);
    if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
    if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} minute(s)`;
    return `${seconds} second(s)`;
  }

  function message(text, type = 'ok') {
    const element = document.getElementById('f2bMessage');
    if (!element) return;
    element.textContent = text;
    element.style.display = 'block';
    element.style.padding = '0.65rem 0.8rem';
    element.style.borderRadius = '8px';
    element.style.border = type === 'error' ? '1px solid #fecaca' : '1px solid #bbf7d0';
    element.style.background = type === 'error' ? '#fef2f2' : '#f0fdf4';
    element.style.color = type === 'error' ? '#991b1b' : '#166534';
  }

  function card(label, value, color = '#0f172a') {
    return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:0.8rem;background:#f8fafc;">
      <div style="font-size:0.78rem;color:#64748b;font-weight:600;text-transform:uppercase;">${escapeHtml(label)}</div>
      <div style="font-size:1.5rem;font-weight:700;color:${color};margin-top:0.2rem;">${escapeHtml(value)}</div>
    </div>`;
  }

  function renderTable(headers, rows, emptyText) {
    if (!rows.length) {
      return `<div style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;border-radius:8px;padding:0.75rem;">${escapeHtml(emptyText)}</div>`;
    }
    return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderStatus(data) {
    const jails = data.jails || [];
    const totalCurrentlyBanned = jails.reduce((sum, jail) => sum + jail.currentlyBanned, 0);
    const totalBanned = jails.reduce((sum, jail) => sum + jail.totalBanned, 0);
    const totalFailed = jails.reduce((sum, jail) => sum + jail.totalFailed, 0);
    const settings = data.settings || {};

    document.getElementById('f2bSummary').innerHTML = [
      card('Service', data.active ? 'Active' : 'Inactive', data.active ? '#15803d' : '#b91c1c'),
      card('Blocked now', totalCurrentlyBanned, totalCurrentlyBanned ? '#b91c1c' : '#15803d'),
      card('Total bans', totalBanned),
      card('Failed attempts', totalFailed),
      card('Ban after', `${settings.maxretry || '-'} attempts`),
      card('Initial ban', settings.bantime ? formatSeconds(settings.bantime) : '-')
    ].join('');

    const bannedRows = [];
    jails.forEach((jail) => {
      (jail.banned || []).forEach((ip) => {
        bannedRows.push(`<tr>
          <td>${escapeHtml(ip)}</td>
          <td>${escapeHtml(jail.jail)}</td>
          <td><button type="button" class="btn btn-secondary f2b-unban" data-jail="${escapeHtml(jail.jail)}" data-ip="${escapeHtml(ip)}">Unban</button></td>
        </tr>`);
      });
    });
    document.getElementById('f2bBanned').innerHTML = renderTable(
      ['IP address', 'Jail', 'Action'],
      bannedRows,
      'No IP addresses are currently blocked.'
    );

    const protectedEntries = new Set(data.protectedWhitelist || []);
    const whitelistRows = (data.whitelist || []).map((ip) => {
      const protectedEntry = protectedEntries.has(ip)
        || (ip === '127.0.0.0/8' && protectedEntries.has('127.0.0.1/8'));
      return `<tr>
        <td>${escapeHtml(ip)}</td>
        <td>${protectedEntry ? 'Protected' : 'Managed'}</td>
        <td>${protectedEntry
          ? '<span style="color:#64748b;">Safety entry</span>'
          : `<button type="button" class="btn btn-secondary f2b-remove-whitelist" data-ip="${escapeHtml(ip)}">Remove</button>`
        }</td>
      </tr>`;
    });
    document.getElementById('f2bWhitelist').innerHTML = renderTable(
      ['IP / network', 'Type', 'Action'],
      whitelistRows,
      'No whitelist entries are configured.'
    );

    const eventRows = (data.events || []).map((event) => `<tr>
      <td style="white-space:nowrap;">${escapeHtml(event.timestamp)}</td>
      <td><span style="font-weight:600;color:${event.action === 'Ban' ? '#b91c1c' : '#15803d'};">${escapeHtml(event.action)}</span></td>
      <td>${escapeHtml(event.ip)}</td>
      <td>${escapeHtml(event.jail)}</td>
    </tr>`);
    document.getElementById('f2bEvents').innerHTML = renderTable(
      ['Time (UTC)', 'Event', 'IP address', 'Jail'],
      eventRows,
      'No ban or unban events recorded yet.'
    );

    document.getElementById('f2bLoading').style.display = 'none';
    document.getElementById('f2bDashboard').style.display = 'block';
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'OrderAssistFail2ban',
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  async function refresh() {
    if (busy || !document.getElementById('f2bDashboard')) return;
    busy = true;
    try {
      const data = await request('/api/fail2ban/status');
      renderStatus(data);
    } catch (error) {
      document.getElementById('f2bLoading').style.display = 'none';
      message(`Could not load Fail2ban: ${error.message}`, 'error');
    } finally {
      busy = false;
    }
  }

  async function runAction(url, method, payload, successPrefix) {
    if (busy) return;
    busy = true;
    try {
      const result = await request(url, {
        method,
        body: JSON.stringify(payload)
      });
      message(result.message || successPrefix);
    } catch (error) {
      message(error.message, 'error');
    } finally {
      busy = false;
      await refresh();
    }
  }

  function bindEvents() {
    const dashboard = document.getElementById('f2bDashboard');
    if (!dashboard || dashboard.dataset.eventsBound === 'true') return;
    dashboard.dataset.eventsBound = 'true';

    document.getElementById('f2bRefresh')?.addEventListener('click', refresh);

    document.getElementById('f2bWhitelistForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('f2bWhitelistIp');
      const ip = input.value.trim();
      if (!ip) return;
      await runAction('/api/fail2ban/whitelist', 'POST', { ip }, 'Whitelist updated');
      input.value = '';
    });

    dashboard.addEventListener('click', (event) => {
      const unbanButton = event.target.closest('.f2b-unban');
      if (unbanButton) {
        const ip = unbanButton.dataset.ip;
        if (window.confirm(`Unban ${ip}? It can be banned again if attacks continue.`)) {
          runAction('/api/fail2ban/unban', 'POST', {
            jail: unbanButton.dataset.jail,
            ip
          }, 'IP unbanned');
        }
        return;
      }

      const removeButton = event.target.closest('.f2b-remove-whitelist');
      if (removeButton) {
        const ip = removeButton.dataset.ip;
        if (window.confirm(`Remove ${ip} from the whitelist?`)) {
          runAction('/api/fail2ban/whitelist', 'DELETE', { ip }, 'Whitelist updated');
        }
      }
    });
  }

  window.renderFail2banPage = function renderFail2banPage() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    bindEvents();
    refresh();
    refreshTimer = window.setInterval(() => {
      if (document.getElementById('f2bDashboard')) refresh();
    }, 30000);
  };

  window.renderFail2banPage();
})();
