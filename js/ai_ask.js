/**
 * AI Ask — modern chat UI for OrderAssist Tracking console.
 * Sessions persist on the server (~6 months) and the active chat is
 * restored via localStorage when leaving/returning to the tab.
 */
(function () {
  const SESSION_KEY = 'oa_ai_ask_session_id';
  let sessionId = null;
  let busy = false;
  let bound = false;
  let sessionFilter = 'active'; // active | archived
  let archivedCount = 0;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatWhen(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString();
    } catch (_) {
      return String(iso);
    }
  }

  function rememberSessionId(id) {
    sessionId = id || null;
    try {
      if (id) localStorage.setItem(SESSION_KEY, id);
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* ignore */ }
  }

  function readStoredSessionId() {
    try {
      return localStorage.getItem(SESSION_KEY) || null;
    } catch (_) {
      return null;
    }
  }

  /** Light markdown: **bold**, links, headings, bullets — XSS-safe via escape first. */
  function renderMarkdown(text) {
    const raw = String(text || '');
    const escaped = escapeHtml(raw);
    return escaped
      .replace(/\[([^\]]+)\]\((console:[^)\s]+)\)/g, (_, label, href) => (
        `<a href="#" class="aiask-console-link" data-console-nav="${escapeHtml(href)}">${label}</a>`
      ))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) => (
        `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      ))
      .replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (_, label, href) => (
        `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      ))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^### (.+)$/gm, '<div class="aiask-md-h">$1</div>')
      .replace(/^## (.+)$/gm, '<div class="aiask-md-h">$1</div>')
      .replace(/^# (.+)$/gm, '<div class="aiask-md-h">$1</div>')
      .replace(/^- (.+)$/gm, '• $1');
  }

  function scrollMessages() {
    const el = document.getElementById('aiAskMessages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function renderThinking(m) {
    const steps = Array.isArray(m.thinking) ? m.thinking : [];
    if (!steps.length && !m.writeMode && !(m.toolsUsed && m.toolsUsed.length)) return '';
    const mode = m.writeMode === 'write' ? 'write' : 'read';
    const modeLabel = mode === 'write' ? 'Wrote' : 'Read-only';
    const rows = steps.length
      ? steps.map((s) => `
          <div class="aiask-think-step" data-kind="${escapeHtml(s.kind || 'info')}">
            <div class="aiask-think-label">${escapeHtml(s.label || 'Step')}</div>
            ${s.detail ? `<div class="aiask-think-detail">${escapeHtml(s.detail)}</div>` : ''}
          </div>
        `).join('')
      : `<div class="aiask-think-step"><div class="aiask-think-label">Tools</div>
          <div class="aiask-think-detail">${escapeHtml((m.toolsUsed || []).join(', ') || 'none')}</div></div>`;
    return `
      <details class="aiask-think">
        <summary>
          How AI thought
          <span class="aiask-think-mode ${mode}">${modeLabel}</span>
        </summary>
        <div class="aiask-think-body">${rows}</div>
      </details>
    `;
  }

  function renderMessages(messages) {
    const box = document.getElementById('aiAskMessages');
    if (!box) return;
    if (!messages || !messages.length) {
      box.innerHTML = `<div class="aiask-empty">
        <h2>Ask the system</h2>
        <p>Devices, repair stages, MS cases, orders, warranty — chats are saved ~6 months. Say “remember that …” to store durable training memory. Paste an MS update and say “update the case” when you want writes.</p>
      </div>`;
      return;
    }
    box.innerHTML = messages.map((m) => {
      const isUser = m.role === 'user';
      const think = isUser ? '' : renderThinking(m);
      return `
        <div class="aiask-turn ${isUser ? 'user' : 'assistant'}">
          ${think}
          <div class="aiask-bubble ${isUser ? 'user' : 'assistant'}">${isUser ? escapeHtml(m.content) : renderMarkdown(m.content)}</div>
          <div class="aiask-bubble-meta ${isUser ? 'user-meta' : ''}">${escapeHtml(formatWhen(m.at))}${m.by ? ` · ${escapeHtml(m.by)}` : ''}${m.provider ? ` · ${escapeHtml(m.provider)}` : ''}</div>
        </div>
      `;
    }).join('');
    scrollMessages();
  }

  function setTyping(on) {
    const box = document.getElementById('aiAskMessages');
    if (!box) return;
    const existing = box.querySelector('.aiask-typing');
    if (existing) existing.remove();
    if (on) {
      const el = document.createElement('div');
      el.className = 'aiask-typing';
      el.textContent = 'Thinking…';
      box.appendChild(el);
      scrollMessages();
    }
  }

  async function loadSessions() {
    const list = document.getElementById('aiAskSessionList');
    if (!list) return [];
    try {
      const qs = sessionFilter === 'archived' ? '?onlyArchived=1' : '';
      const res = await fetch(`/api/console/ai-ask/sessions${qs}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      const sessions = data.sessions || [];
      archivedCount = Number(data.archivedCount) || 0;
      const countEl = document.getElementById('aiAskArchivedCount');
      if (countEl) countEl.textContent = archivedCount ? `(${archivedCount})` : '';

      document.querySelectorAll('.aiask-side-tab').forEach((tab) => {
        tab.classList.toggle('is-active', tab.getAttribute('data-session-filter') === sessionFilter);
      });

      if (!sessions.length) {
        list.innerHTML = `<div class="aiask-session-meta" style="padding:0.4rem;">${
          sessionFilter === 'archived' ? 'No archived chats' : 'No chats yet'
        }</div>`;
        return [];
      }
      list.innerHTML = sessions.map((s) => `
        <div class="aiask-session-row" data-session-row="${escapeHtml(s.id)}">
          <button type="button" class="aiask-session-btn ${s.id === sessionId ? 'is-active' : ''}" data-session="${escapeHtml(s.id)}">
            ${escapeHtml(s.title || 'Chat')}
            <span class="aiask-session-meta">${escapeHtml(formatWhen(s.updatedAt))} · ${escapeHtml(s.messageCount || 0)} msgs</span>
          </button>
          <div class="aiask-session-actions">
            ${sessionFilter === 'archived'
              ? `<button type="button" class="aiask-session-action" data-unarchive="${escapeHtml(s.id)}" title="Restore chat">↩</button>`
              : `<button type="button" class="aiask-session-action" data-archive="${escapeHtml(s.id)}" title="Archive chat">📦</button>`}
            <button type="button" class="aiask-session-action danger" data-delete="${escapeHtml(s.id)}" title="Delete forever">🗑</button>
          </div>
        </div>
      `).join('');
      list.querySelectorAll('[data-session]').forEach((btn) => {
        btn.addEventListener('click', () => openSession(btn.getAttribute('data-session')));
      });
      list.querySelectorAll('[data-archive]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          archiveSession(btn.getAttribute('data-archive'));
        });
      });
      list.querySelectorAll('[data-unarchive]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          unarchiveSession(btn.getAttribute('data-unarchive'));
        });
      });
      list.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteSession(btn.getAttribute('data-delete'));
        });
      });
      return sessions;
    } catch (e) {
      list.innerHTML = `<div class="aiask-session-meta">${escapeHtml(e.message || 'Failed to load')}</div>`;
      return [];
    }
  }

  async function archiveSession(id) {
    if (!id) return;
    try {
      const res = await fetch(`/api/console/ai-ask/sessions/${encodeURIComponent(id)}/archive`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Archive failed');
      if (sessionId === id) {
        rememberSessionId(null);
        renderMessages([]);
        const title = document.getElementById('aiAskTitle');
        if (title) title.textContent = 'AI Ask';
      }
      await loadSessions();
    } catch (e) {
      window.alert(e.message || 'Archive failed');
    }
  }

  async function unarchiveSession(id) {
    if (!id) return;
    try {
      const res = await fetch(`/api/console/ai-ask/sessions/${encodeURIComponent(id)}/unarchive`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Restore failed');
      sessionFilter = 'active';
      await loadSessions();
      await openSession(id);
    } catch (e) {
      window.alert(e.message || 'Restore failed');
    }
  }

  async function deleteSession(id) {
    if (!id) return;
    if (!window.confirm('Delete this chat forever? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/console/ai-ask/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Delete failed');
      if (sessionId === id) {
        rememberSessionId(null);
        renderMessages([]);
        const title = document.getElementById('aiAskTitle');
        if (title) title.textContent = 'AI Ask';
      }
      await loadSessions();
    } catch (e) {
      window.alert(e.message || 'Delete failed');
    }
  }

  async function openSession(id) {
    if (!id) return false;
    rememberSessionId(id);
    const title = document.getElementById('aiAskTitle');
    try {
      const res = await fetch(`/api/console/ai-ask/sessions/${encodeURIComponent(id)}`, {
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Load failed');
      if (title) title.textContent = data.session.title || 'AI Ask';
      renderMessages(data.session.messages || []);
      await loadSessions();
      return true;
    } catch (e) {
      rememberSessionId(null);
      renderMessages([{ role: 'assistant', content: e.message || 'Could not open chat', at: new Date().toISOString() }]);
      return false;
    }
  }

  async function newChat() {
    try {
      const res = await fetch('/api/console/ai-ask/sessions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not create chat');
      rememberSessionId(data.session.id);
      const title = document.getElementById('aiAskTitle');
      if (title) title.textContent = 'New chat';
      renderMessages([]);
      await loadSessions();
      document.getElementById('aiAskInput')?.focus();
    } catch (e) {
      renderMessages([{ role: 'assistant', content: e.message || 'Failed', at: new Date().toISOString() }]);
    }
  }

  async function sendMessage(text) {
    const message = String(text || '').trim();
    if (!message || busy) return;
    busy = true;
    const sendBtn = document.getElementById('aiAskSend');
    if (sendBtn) sendBtn.disabled = true;

    const box = document.getElementById('aiAskMessages');
    if (box && box.querySelector('.aiask-empty')) box.innerHTML = '';
    if (box) {
      box.insertAdjacentHTML('beforeend', `
        <div class="aiask-bubble user">${escapeHtml(message)}</div>
        <div class="aiask-bubble-meta user-meta">now</div>
      `);
      scrollMessages();
    }
    setTyping(true);

    try {
      const res = await fetch('/api/console/ai-ask/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      rememberSessionId(data.sessionId || sessionId);
      const title = document.getElementById('aiAskTitle');
      if (title && data.title) title.textContent = data.title;
      renderMessages(data.messages || []);
      if (data.memorySaved) {
        const line = document.getElementById('aiAskStatusLine');
        if (line) {
          line.textContent = `Saved to learned memory${data.memoryItem && data.memoryItem.crucial ? ' (crucial)' : ''}`;
        }
      } else if (data.writeMode || data.writeReason) {
        const line = document.getElementById('aiAskStatusLine');
        if (line) {
          line.textContent = data.writeMode === 'write'
            ? `Wrote to console · ${(data.writeReason || '').slice(0, 90)}`
            : `Read-only · ${(data.writeReason || 'looked up data only').slice(0, 90)}`;
        }
      }
      await loadSessions();
    } catch (e) {
      setTyping(false);
      if (box) {
        box.insertAdjacentHTML('beforeend', `
          <div class="aiask-bubble assistant">${escapeHtml(e.message || 'Failed')}</div>
        `);
        scrollMessages();
      }
    } finally {
      busy = false;
      if (sendBtn) sendBtn.disabled = false;
      setTyping(false);
    }
  }

  async function refreshStatus() {
    const line = document.getElementById('aiAskStatusLine');
    try {
      const res = await fetch('/api/console/ai-ask/status', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!line) return;
      if (!data.aiAvailable) {
        line.textContent = 'AI unavailable — Cursor Agent login needed';
        return;
      }
      const via = data.provider === 'cursor' ? 'Cursor Agent' : (data.provider || 'AI');
      const mem = data.memoryCount != null ? ` · ${data.memoryCount} memories` : '';
      const days = data.retentionDays != null ? ` · keep ~${data.retentionDays}d` : '';
      line.textContent = `Ready via ${via}${mem}${days}`;
    } catch (_) {
      if (line) line.textContent = 'Status unavailable';
    }
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    document.getElementById('aiAskNew')?.addEventListener('click', () => {
      sessionFilter = 'active';
      newChat();
    });
    document.getElementById('aiAskTabActive')?.addEventListener('click', async () => {
      sessionFilter = 'active';
      await loadSessions();
    });
    document.getElementById('aiAskTabArchived')?.addEventListener('click', async () => {
      sessionFilter = 'archived';
      await loadSessions();
    });
    document.getElementById('aiAskForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.getElementById('aiAskInput');
      const text = input ? input.value : '';
      if (input) input.value = '';
      sendMessage(text);
    });
    document.getElementById('aiAskInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        document.getElementById('aiAskForm')?.requestSubmit();
      }
    });
    document.getElementById('aiAskSuggestions')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-prompt]');
      if (!chip) return;
      const prompt = chip.getAttribute('data-prompt') || '';
      const input = document.getElementById('aiAskInput');
      if (/Lookup a serial/i.test(prompt)) {
        if (input) {
          input.value = '';
          input.focus();
          input.placeholder = 'Paste a serial number…';
        }
        return;
      }
      sendMessage(prompt);
    });
    document.getElementById('aiAskMessages')?.addEventListener('click', (event) => {
      const link = event.target.closest('[data-console-nav]');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('data-console-nav') || '';
      const target = href.replace(/^console:/i, '');
      if (typeof window.navigateConsole === 'function') window.navigateConsole(target);
    });
  }

  function setAiAskShellActive(on) {
    document.body.classList.toggle('aiask-active', !!on);
  }

  window.renderAiAskPage = async function renderAiAskPage() {
    bindOnce();
    setAiAskShellActive(true);
    await refreshStatus();
    sessionFilter = 'active';
    const sessions = await loadSessions();

    // Restore last chat after leaving the tab (localStorage + server sessions)
    const preferred = sessionId || readStoredSessionId();
    if (preferred) {
      const ok = await openSession(preferred);
      if (ok) {
        document.getElementById('aiAskInput')?.focus();
        return;
      }
    }
    if (sessions.length) {
      await openSession(sessions[0].id);
    } else {
      renderMessages([]);
    }
    document.getElementById('aiAskInput')?.focus();
  };

  // Clear lock when navigating away (shell reloads other pages into contentContainer)
  const obsTarget = document.getElementById('contentContainer');
  if (obsTarget && !window.__aiAskNavObserver) {
    window.__aiAskNavObserver = new MutationObserver(() => {
      if (!document.getElementById('aiAskPage')) setAiAskShellActive(false);
    });
    window.__aiAskNavObserver.observe(obsTarget, { childList: true });
  }
})();
