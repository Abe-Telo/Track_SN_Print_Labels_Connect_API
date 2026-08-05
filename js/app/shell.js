/**
 * OrderAssist Tracking — app shell (Phase 1)
 * Preserves global toggleSection / loadContent API used by existing JS modules.
 */
(function () {
  const PAGE_TITLES = {
    AddTrackingForm: 'Add Tracking',
    searchSection: 'Search',
    devicesTable: 'All Devices',
    repair: 'Repair needed',
    archive: 'All Tracking',
    howto: 'How It Works',
    updates: 'Software Updates',
    printers: 'Printers',
    keys: 'Product Keys',
    mobileapp: 'Mobile App',
    scripts: 'Scripts & Tools',
    fail2ban: 'Security / Fail2ban',
    dashboard: 'Dashboard',
    shipstation: 'ShipStation Search',
    orders: 'Orders',
    history: 'History & Changes',
    aiask: 'AI Ask',
    contentContainer: 'Browse'
  };

  const loadedScripts = new Map(); // scriptName -> Promise

  function setActiveNav(key) {
    document.querySelectorAll('.nav-btn[data-nav]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === key);
    });
  }

  function setPageTitle(key) {
    const title = PAGE_TITLES[key] || 'OrderAssist Tracking';
    const el = document.getElementById('pageTitle');
    if (el) el.textContent = title;
  }

  function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarBackdrop')?.classList.remove('visible');
  }

  function showSectionEl(section) {
    if (!section) return;
    section.classList.remove('hidden');
    section.style.display = 'block';
  }

  function hideSectionEl(section) {
    if (!section) return;
    section.classList.add('hidden');
    section.style.display = 'none';
  }

  window.hideAllSections = function hideAllSections() {
    document.querySelectorAll('#AddTrackingForm, #searchSection, #devicesTable, .app-content > .hidden, .app-content > .card.hidden').forEach((section) => {
      hideSectionEl(section);
    });
    // Also hide any .hidden sections that may have been shown
    document.querySelectorAll('.app-content .card').forEach((section) => {
      if (section.id === 'AddTrackingForm' || section.id === 'searchSection' || section.id === 'devicesTable') {
        hideSectionEl(section);
      }
    });
    const container = document.getElementById('contentContainer');
    if (container) {
      container.style.display = 'none';
    }
  };

  window.clearDynamicContent = function clearDynamicContent() {
    const dynamicContainer = document.getElementById('contentContainer');
    if (dynamicContainer) {
      dynamicContainer.innerHTML = '';
      dynamicContainer.style.display = 'none';
    }
  };

  window.loadScript = function loadScript(scriptName) {
    if (!scriptName) return Promise.resolve();
    if (loadedScripts.has(scriptName)) return loadedScripts.get(scriptName);

    const path = '/js/' + scriptName + '?v=20260803badge2';
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = path;
      script.onload = () => {
        console.log('Loaded script:', scriptName);
        resolve();
      };
      script.onerror = () => {
        console.error('Failed to load script:', scriptName);
        loadedScripts.delete(scriptName);
        reject(new Error('Failed to load ' + scriptName));
      };
      document.head.appendChild(script);
    });
    loadedScripts.set(scriptName, promise);
    return promise;
  };

  function afterArchiveLoaded() {
    if (typeof window.fetchArchiveTrackingData === 'function') {
      window.fetchArchiveTrackingData();
    }
  }

  window.toggleSection = function toggleSection(sectionId) {
    hideAllSections();
    clearDynamicContent();

    const section = document.getElementById(sectionId);
    if (section) {
      showSectionEl(section);
      localStorage.setItem('lastOpenedSection', sectionId);
      localStorage.removeItem('lastContent');
      setActiveNav(sectionId);
      setPageTitle(sectionId);
    }
    closeSidebar();
  };

  window.loadContent = function loadContent({
    scriptName = null,
    htmlPath = null,
    containerId = 'contentContainer',
    navKey = null,
    afterLoad = null
  } = {}) {
    hideAllSections();

    const container = document.getElementById(containerId);
    if (container) {
      container.style.display = 'block';
    }

    const contentParams = JSON.stringify({ scriptName, htmlPath, containerId, navKey });
    localStorage.setItem('lastContent', contentParams);
    localStorage.setItem('lastOpenedSection', 'contentContainer');

    const activeKey = navKey || 'contentContainer';
    setActiveNav(activeKey);
    setPageTitle(activeKey);
    closeSidebar();

    const htmlReady = (htmlPath && container)
      ? fetch(htmlPath + (htmlPath.includes('?') ? '&' : '?') + 'v=20260729atd1')
          .then((response) => response.text())
          .then((html) => {
            container.innerHTML = html;
            container.style.display = 'block';
          })
      : Promise.resolve();

    htmlReady
      .then(() => (scriptName ? loadScript(scriptName) : Promise.resolve()))
      .then(() => {
        if (typeof afterLoad === 'function') afterLoad();
        // Default: archive page populates after HTML + script are ready
        if (htmlPath && htmlPath.indexOf('archive.html') !== -1) {
          afterArchiveLoaded();
        }
        if (htmlPath && htmlPath.indexOf('fail2ban.html') !== -1
            && typeof window.renderFail2banPage === 'function') {
          window.renderFail2banPage();
        }
        if (htmlPath && htmlPath.indexOf('dashboard.html') !== -1
            && typeof window.renderDashboardPage === 'function') {
          window.renderDashboardPage();
        }
        if (htmlPath && htmlPath.indexOf('shipstation_search.html') !== -1
            && typeof window.renderShipStationSearchPage === 'function') {
          window.renderShipStationSearchPage();
        }
        if (htmlPath && htmlPath.indexOf('orders.html') !== -1
            && typeof window.renderOrdersPage === 'function') {
          window.renderOrdersPage();
        }
        if (htmlPath && htmlPath.indexOf('repair_needed.html') !== -1
            && typeof window.renderRepairNeededPage === 'function') {
          window.renderRepairNeededPage();
        }
        if (htmlPath && htmlPath.indexOf('updates.html') !== -1
            && typeof window.renderSoftwareUpdatesPage === 'function') {
          window.renderSoftwareUpdatesPage();
        }
        if (htmlPath && htmlPath.indexOf('printers.html') !== -1
            && typeof window.renderPrintersPage === 'function') {
          window.renderPrintersPage();
        }
        if (htmlPath && htmlPath.indexOf('product_keys.html') !== -1
            && typeof window.renderProductKeysPage === 'function') {
          window.renderProductKeysPage();
        }
        if (htmlPath && htmlPath.indexOf('history.html') !== -1
            && typeof window.renderHistoryPage === 'function') {
          window.renderHistoryPage();
        }
        if (htmlPath && htmlPath.indexOf('ai_ask.html') !== -1
            && typeof window.renderAiAskPage === 'function') {
          window.renderAiAskPage();
        }
        if (htmlPath && htmlPath.indexOf('mobile_app.html') !== -1
            && typeof window.renderMobileAppPage === 'function') {
          window.renderMobileAppPage();
        }
        refreshNavBadges();
        refreshNotifications();
      })
      .catch((error) => console.error('Failed to load content:', error));
  };

  window.toggleAndLoadScript = function toggleAndLoadScript(sectionId, scriptName) {
    hideAllSections();
    clearDynamicContent();
    const section = document.getElementById(sectionId);
    if (section) showSectionEl(section);
    if (scriptName) loadScript(scriptName);
    setActiveNav(sectionId);
    setPageTitle(sectionId);
    closeSidebar();
  };

  function restoreLastView() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const nav = (params.get('nav') || '').toLowerCase();
      if (nav === 'keys' || nav === 'product-keys' || nav === 'productkeys') {
        loadContent({
          scriptName: 'product_keys_page.js',
          htmlPath: '/html/product_keys.html?v=20260803keys3',
          containerId: 'contentContainer',
          navKey: 'keys'
        });
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, '', '/');
        }
        return;
      }
    } catch (e) { /* ignore */ }

    const lastContent = localStorage.getItem('lastContent');
    if (lastContent && lastContent.trim().startsWith('{')) {
      try {
        loadContent(JSON.parse(lastContent));
        return;
      } catch (e) {
        console.warn('Could not restore lastContent', e);
      }
    }

    const lastSection = localStorage.getItem('lastOpenedSection');
    if (lastSection && document.getElementById(lastSection)) {
      toggleSection(lastSection);
      return;
    }

    loadContent({
      scriptName: 'dashboard_ui.js',
      htmlPath: '/html/dashboard.html?v=20260802fix1',
      containerId: 'contentContainer',
      navKey: 'dashboard'
    });
  }

  function initSidebar() {
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('open');
      document.getElementById('sidebarBackdrop')?.classList.toggle('visible');
    });

    document.getElementById('sidebarBackdrop')?.addEventListener('click', closeSidebar);

    document.querySelectorAll('.nav-btn[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'toggle') {
          toggleSection(btn.dataset.nav);
        } else if (action === 'archive') {
          loadContent({
            scriptName: 'new_entries.js',
            htmlPath: '/html/archive.html?v=20260729atd1',
            containerId: 'contentContainer',
            navKey: 'archive'
          });
        } else if (action === 'howto') {
          loadContent({
            htmlPath: '/html/how_it_works.html',
            containerId: 'contentContainer',
            navKey: 'howto'
          });
        } else if (action === 'updates') {
          loadContent({
            scriptName: 'updates.js',
            htmlPath: '/html/updates.html?v=20260803fb1',
            containerId: 'contentContainer',
            navKey: 'updates'
          });
        } else if (action === 'printers') {
          loadContent({
            scriptName: 'printers_page.js',
            htmlPath: '/html/printers.html?v=20260803prt9',
            containerId: 'contentContainer',
            navKey: 'printers'
          });
        } else if (action === 'keys') {
          loadContent({
            scriptName: 'product_keys_page.js',
            htmlPath: '/html/product_keys.html?v=20260803keys3',
            containerId: 'contentContainer',
            navKey: 'keys'
          });
        } else if (action === 'mobileapp') {
          loadContent({
            scriptName: 'mobile_app.js',
            htmlPath: '/html/mobile_app.html?v=20260729mobile1',
            containerId: 'contentContainer',
            navKey: 'mobileapp'
          });
        } else if (action === 'scripts') {
          loadContent({
            scriptName: 'scripts_page.js',
            htmlPath: '/html/scripts.html',
            containerId: 'contentContainer',
            navKey: 'scripts'
          });
        } else if (action === 'fail2ban') {
          loadContent({
            scriptName: 'fail2ban.js',
            htmlPath: '/html/fail2ban.html',
            containerId: 'contentContainer',
            navKey: 'fail2ban'
          });
        } else if (action === 'dashboard') {
          loadContent({
            scriptName: 'dashboard_ui.js',
            htmlPath: '/html/dashboard.html?v=20260802fix1',
            containerId: 'contentContainer',
            navKey: 'dashboard'
          });
        } else if (action === 'shipstation') {
          loadContent({
            scriptName: 'shipstation_search.js',
            htmlPath: '/html/shipstation_search.html?v=20260729ss1',
            containerId: 'contentContainer',
            navKey: 'shipstation'
          });
        } else if (action === 'orders') {
          loadContent({
            scriptName: 'orders.js',
            htmlPath: '/html/orders.html?v=20260731ws2',
            containerId: 'contentContainer',
            navKey: 'orders'
          });
        } else if (action === 'repair') {
          loadContent({
            scriptName: 'repair_needed.js',
            htmlPath: '/html/repair_needed.html?v=20260803badge2',
            containerId: 'contentContainer',
            navKey: 'repair'
          });
        } else if (action === 'aiask') {
          loadContent({
            scriptName: 'ai_ask.js',
            htmlPath: '/html/ai_ask.html?v=20260805think1',
            containerId: 'contentContainer',
            navKey: 'aiask'
          });
        } else if (action === 'history') {
          loadContent({
            scriptName: 'history.js',
            htmlPath: '/html/history.html?v=20260803hist1',
            containerId: 'contentContainer',
            navKey: 'history'
          });
        }
      });
    });
  }

  /** Navigate from notifications / changelog / AI Ask links.
   *  Accepts: "repair", "repair?ticket=ID&serial=SN&open=email", "history?id=cl-…", etc.
   */
  window.navigateConsole = function navigateConsole(href, meta) {
    const raw = String(href || '').trim();
    const qIdx = raw.indexOf('?');
    const key = (qIdx >= 0 ? raw.slice(0, qIdx) : raw).toLowerCase();
    const query = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
    const params = query ? new URLSearchParams(query) : new URLSearchParams();

    if (key === 'repair') {
      try {
        const focus = {
          ticketId: params.get('ticket') || params.get('ticketId') || (meta && meta.ticketId) || '',
          serialNumber: params.get('serial') || params.get('serialNumber') || (meta && meta.serialNumber) || '',
          open: params.get('open') || (meta && meta.open) || '',
          draftId: params.get('draft') || params.get('draftId') || (meta && meta.draftId) || '',
          uid: params.get('uid') || (meta && meta.uid) || ''
        };
        if (focus.ticketId || focus.serialNumber || focus.open || focus.uid || focus.draftId) {
          sessionStorage.setItem('oa_repair_focus', JSON.stringify(focus));
        }
      } catch (_) { /* ignore */ }
    }
    if (key === 'history') {
      try {
        const id = params.get('id') || params.get('changelogId') || (meta && meta.changelogId) || '';
        if (id) sessionStorage.setItem('oa_history_focus', JSON.stringify({ id }));
      } catch (_) { /* ignore */ }
    }

    if (meta && (meta.title || meta.body)) {
      try {
        sessionStorage.setItem('oa_notif_context', JSON.stringify({
          title: meta.title || '',
          body: meta.body || '',
          kind: meta.kind || '',
          at: meta.at || '',
          href: raw
        }));
      } catch (_) { /* ignore */ }
    }

    const bust = '20260803badge2';
    const map = {
      repair: () => loadContent({
        scriptName: 'repair_needed.js',
        htmlPath: `/html/repair_needed.html?v=${bust}`,
        containerId: 'contentContainer',
        navKey: 'repair'
      }),
      aiask: () => loadContent({
        scriptName: 'ai_ask.js',
        htmlPath: `/html/ai_ask.html?v=20260805think1`,
        containerId: 'contentContainer',
        navKey: 'aiask'
      }),
      history: () => loadContent({
        scriptName: 'history.js',
        htmlPath: `/html/history.html?v=${bust}`,
        containerId: 'contentContainer',
        navKey: 'history'
      }),
      updates: () => loadContent({
        scriptName: 'updates.js',
        htmlPath: '/html/updates.html?v=20260803fb1',
        containerId: 'contentContainer',
        navKey: 'updates'
      }),
      dashboard: () => loadContent({
        scriptName: 'dashboard_ui.js',
        htmlPath: '/html/dashboard.html?v=20260802fix1',
        containerId: 'contentContainer',
        navKey: 'dashboard'
      }),
      orders: () => loadContent({
        scriptName: 'orders.js',
        htmlPath: '/html/orders.html?v=20260731ws2',
        containerId: 'contentContainer',
        navKey: 'orders'
      }),
      printers: () => loadContent({
        scriptName: 'printers_page.js',
        htmlPath: '/html/printers.html?v=20260803prt9',
        containerId: 'contentContainer',
        navKey: 'printers'
      }),
      keys: () => loadContent({
        scriptName: 'product_keys_page.js',
        htmlPath: '/html/product_keys.html?v=20260803keys3',
        containerId: 'contentContainer',
        navKey: 'keys'
      })
    };
    if (map[key]) map[key]();
    else if (key) loadContent({
      scriptName: 'history.js',
      htmlPath: `/html/history.html?v=${bust}`,
      containerId: 'contentContainer',
      navKey: 'history'
    });

    setTimeout(showNotifContextBannerFromStorage, 200);
  };

  function resolveNotifHref(n) {
    if (!n) return 'history';
    const href = String(n.href || '').trim();
    if (href.includes('?')) return href;
    if (n.ticketId || n.serialNumber) {
      const params = new URLSearchParams();
      if (n.ticketId) params.set('ticket', n.ticketId);
      if (n.serialNumber) params.set('serial', n.serialNumber);
      const open = n.open || (n.kind === 'new_email' ? 'email' : n.kind === 'human_needed' ? 'sheet' : 'sheet');
      if (open) params.set('open', open);
      if (n.draftId) params.set('draft', n.draftId);
      if (n.uid) params.set('uid', n.uid);
      return `repair?${params.toString()}`;
    }
    if (n.changelogId) return `history?id=${encodeURIComponent(n.changelogId)}`;
    if (n.uid) return `repair?open=unmatched&uid=${encodeURIComponent(n.uid)}`;
    return href || 'history';
  }

  function showNotifContextBannerFromStorage() {
    let ctx = null;
    try {
      const raw = sessionStorage.getItem('oa_notif_context');
      if (raw) ctx = JSON.parse(raw);
      sessionStorage.removeItem('oa_notif_context');
    } catch (_) {
      try { sessionStorage.removeItem('oa_notif_context'); } catch (__) { /* ignore */ }
    }
    if (ctx) showNotifContextBanner(ctx);
  }

  function showNotifContextBanner(ctx) {
    ensureNotifStyles();
    let bar = document.getElementById('notifContextBanner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'notifContextBanner';
      bar.className = 'notif-context-banner';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <div class="notif-context-inner">
        <div class="notif-context-text">
          <div class="notif-context-title">${escapeNotif(ctx.title || 'Notification')}</div>
          <div class="notif-context-body">${escapeNotif(ctx.body || '')}</div>
          <div class="notif-context-meta">${escapeNotif(ctx.kind || '')}${ctx.at ? ` · ${escapeNotif(formatNotifWhen(ctx.at))}` : ''}</div>
        </div>
        <button type="button" class="btn btn-secondary" id="notifContextDismiss">Dismiss</button>
      </div>`;
    bar.classList.add('is-on');
    bar.querySelector('#notifContextDismiss')?.addEventListener('click', () => {
      bar.classList.remove('is-on');
    });
    clearTimeout(showNotifContextBanner._t);
    showNotifContextBanner._t = setTimeout(() => bar.classList.remove('is-on'), 20000);
  }

  // —— Per-computer notifications (localStorage device id) ——
  function getConsoleDeviceId() {
    const key = 'oa_console_device_id';
    let id = localStorage.getItem(key);
    if (id && id.length >= 12) return id;
    id = 'dev-' + (window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
    localStorage.setItem(key, id);
    return id;
  }

  function ensureNotifStyles() {
    if (document.getElementById('consoleNotifStyles')) return;
    const style = document.createElement('style');
    style.id = 'consoleNotifStyles';
    style.textContent = [
      '.topbar{display:flex;align-items:center;gap:0.75rem;}',
      '.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:0.5rem;position:relative;}',
      '.notif-bell{position:relative;font-size:1.15rem;line-height:1;}',
      '.notif-badge{position:absolute;top:-4px;right:-6px;min-width:1.05rem;height:1.05rem;',
      'padding:0 0.28rem;border-radius:999px;background:#dc2626;color:#fff;font-size:0.65rem;',
      'font-weight:700;display:none;align-items:center;justify-content:center;}',
      '.notif-badge.is-on{display:inline-flex;}',
      '.notif-panel{display:none;position:absolute;right:0;top:calc(100% + 0.45rem);width:min(360px,92vw);',
      'max-height:70vh;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;',
      'box-shadow:0 12px 40px rgba(15,23,42,0.15);z-index:200;padding:0.35rem;}',
      '.notif-panel.is-open{display:block;}',
      '.notif-panel-head{display:flex;justify-content:space-between;align-items:center;',
      'padding:0.55rem 0.7rem;border-bottom:1px solid #f1f5f9;font-size:0.85rem;font-weight:700;}',
      '.notif-item{display:block;width:100%;text-align:left;border:none;background:transparent;',
      'padding:0.65rem 0.7rem;border-radius:8px;cursor:pointer;font:inherit;}',
      '.notif-item:hover{background:#f8fafc;}',
      '.notif-item.is-unread{background:#fff7ed;}',
      '.notif-item-title{font-weight:700;font-size:0.88rem;color:#0f172a;}',
      '.notif-item-body{font-size:0.8rem;color:#64748b;margin-top:0.2rem;}',
      '.notif-item-meta{font-size:0.72rem;color:#94a3b8;margin-top:0.25rem;}',
      '.notif-empty{padding:1rem;color:#64748b;font-size:0.85rem;}',
      '.notif-toast{position:fixed;top:4.5rem;right:1rem;z-index:300;max-width:min(360px,92vw);',
      'background:#111827;color:#fff;padding:0.75rem 0.9rem;border-radius:10px;',
      'box-shadow:0 10px 30px rgba(0,0,0,0.25);font-size:0.88rem;display:none;cursor:pointer;}',
      '.notif-toast.is-on{display:block;animation:notifIn 0.25s ease;}',
      '@keyframes notifIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
      '.notif-context-banner{display:none;position:fixed;left:50%;transform:translateX(-50%);',
      'top:4.25rem;z-index:280;width:min(640px,94vw);}',
      '.notif-context-banner.is-on{display:block;animation:notifIn 0.2s ease;}',
      '.notif-context-inner{display:flex;gap:0.75rem;align-items:flex-start;background:#fff7ed;',
      'border:1px solid #fdba74;border-radius:12px;padding:0.75rem 0.9rem;',
      'box-shadow:0 12px 36px rgba(15,23,42,0.18);}',
      '.notif-context-text{flex:1;min-width:0;}',
      '.notif-context-title{font-weight:700;color:#9a3412;font-size:0.92rem;}',
      '.notif-context-body{font-size:0.82rem;color:#7c2d12;margin-top:0.25rem;white-space:pre-wrap;}',
      '.notif-context-meta{font-size:0.72rem;color:#c2410c;margin-top:0.3rem;}'
    ].join('');
    document.head.appendChild(style);
  }

  let notifCache = [];

  function renderNotifBadge(count) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.add('is-on');
    } else {
      badge.classList.remove('is-on');
      badge.textContent = '';
    }
  }

  function renderNotifPanel(items) {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    const unread = (items || []).filter((n) => !n.read);
    const list = (items || []).slice(0, 40);
    panel.innerHTML = `
      <div class="notif-panel-head">
        <span>Notifications</span>
        <button type="button" class="btn btn-secondary" id="notifMarkAll" style="font-size:0.75rem;padding:0.25rem 0.5rem;">Mark all read</button>
      </div>
      ${list.length ? list.map((n) => `
        <button type="button" class="notif-item ${n.read ? '' : 'is-unread'}" data-notif-id="${escapeNotif(n.id)}" data-href="${escapeNotif(resolveNotifHref(n))}">
          <div class="notif-item-title">${escapeNotif(n.title || 'Update')}</div>
          <div class="notif-item-body">${escapeNotif(n.body || '')}</div>
          <div class="notif-item-meta">${escapeNotif(n.kind || '')}${n.serialNumber ? ` · ${escapeNotif(n.serialNumber)}` : ''}${n.major ? ' · major' : ''} · ${escapeNotif(formatNotifWhen(n.at))}</div>
        </button>
      `).join('') : '<div class="notif-empty">No notifications yet.</div>'}`;

    panel.querySelectorAll('[data-notif-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-notif-id');
        const n = (notifCache || []).find((x) => x && String(x.id) === String(id)) || null;
        const href = (n && resolveNotifHref(n)) || btn.getAttribute('data-href') || 'history';
        await ackNotifications([id]);
        panel.classList.remove('is-open');
        window.navigateConsole(href, n || {
          title: btn.querySelector('.notif-item-title')?.textContent,
          body: btn.querySelector('.notif-item-body')?.textContent
        });
      });
    });
    panel.querySelector('#notifMarkAll')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await ackNotifications(null, true);
      refreshNotifications();
    });

    // One-time toast for newest unread major (per computer session)
    const major = unread.find((n) => n.major);
    if (major) {
      const toastKey = 'oa_notif_toast_' + major.id;
      if (!sessionStorage.getItem(toastKey)) {
        sessionStorage.setItem(toastKey, '1');
        showNotifToast(major);
      }
    }
  }

  function escapeNotif(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatNotifWhen(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString();
    } catch (_) {
      return '';
    }
  }

  function showNotifToast(notifOrText) {
    let toast = document.getElementById('notifToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'notifToast';
      toast.className = 'notif-toast';
      document.body.appendChild(toast);
    }
    const n = (notifOrText && typeof notifOrText === 'object') ? notifOrText : null;
    const text = n ? (n.title || 'Update available') : String(notifOrText || 'Update available');
    toast.textContent = text + (n ? ' — click to open' : '');
    toast.classList.add('is-on');
    toast.onclick = async () => {
      toast.classList.remove('is-on');
      if (!n) return;
      await ackNotifications([n.id]);
      window.navigateConsole(resolveNotifHref(n), n);
    };
    clearTimeout(showNotifToast._t);
    showNotifToast._t = setTimeout(() => toast.classList.remove('is-on'), 8000);
  }

  async function ackNotifications(ids, all) {
    const deviceId = getConsoleDeviceId();
    try {
      await fetch('/api/console/notifications/ack', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { deviceId, all: true } : { deviceId, ids: ids || [] })
      });
    } catch (_) { /* ignore */ }
    await refreshNotifications();
  }

  async function refreshNotifications() {
    ensureNotifStyles();
    const deviceId = getConsoleDeviceId();
    try {
      const res = await fetch('/api/console/notifications?deviceId=' + encodeURIComponent(deviceId), {
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return;
      notifCache = data.items || [];
      renderNotifBadge(data.unreadCount || 0);
      const panel = document.getElementById('notifPanel');
      if (panel && panel.classList.contains('is-open')) renderNotifPanel(notifCache);
      else if (data.unreadCount > 0) {
        // Still evaluate toast for major unread
        const major = notifCache.find((n) => !n.read && n.major);
        if (major) {
          const toastKey = 'oa_notif_toast_' + major.id;
          if (!sessionStorage.getItem(toastKey)) {
            sessionStorage.setItem(toastKey, '1');
            showNotifToast(major);
          }
        }
      }
    } catch (_) { /* ignore */ }
  }

  function initNotifications() {
    ensureNotifStyles();
    const bell = document.getElementById('notifBell');
    const panel = document.getElementById('notifPanel');
    if (!bell || !panel) return;

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !panel.classList.contains('is-open');
      panel.classList.toggle('is-open', open);
      if (open) renderNotifPanel(notifCache);
    });
    document.addEventListener('click', () => panel.classList.remove('is-open'));
    panel.addEventListener('click', (e) => e.stopPropagation());

    refreshNotifications();
    setInterval(refreshNotifications, 60000);
  }

  // Green nav badges (open repairs, order queue, print jobs, feedback, …)
  const NAV_BADGE_KEYS = ['repair', 'orders', 'updates', 'printers', 'fail2ban'];

  function ensureBadgeStyles() {
    if (document.getElementById('navBadgeStyles')) return;
    const style = document.createElement('style');
    style.id = 'navBadgeStyles';
    style.textContent = [
      '.nav-badge{display:inline-flex;align-items:center;justify-content:center;',
      'min-width:1.2rem;height:1.2rem;padding:0 0.3rem;margin-left:auto;',
      'border-radius:999px;background:#16a34a;color:#fff;font-size:0.72rem;',
      'font-weight:700;line-height:1;vertical-align:middle;}'
    ].join('');
    document.head.appendChild(style);
  }

  function renderNavBadges(badges, titles) {
    ensureBadgeStyles();
    const map = badges || {};
    const tip = titles || {};
    NAV_BADGE_KEYS.forEach((navKey) => {
      const btn = document.querySelector('.nav-btn[data-nav="' + navKey + '"]');
      if (!btn) return;
      let badge = btn.querySelector('.nav-badge');
      const count = Number(map[navKey]) || 0;
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'nav-badge';
          btn.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.title = tip[navKey] || (count + ' pending');
        btn.title = tip[navKey] || btn.title || '';
      } else if (badge) {
        badge.remove();
        if (tip[navKey]) btn.removeAttribute('title');
      }
    });
  }

  function refreshNavBadges() {
    fetch('/api/nav-badges', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data && data.ok) renderNavBadges(data.badges, data.titles);
      })
      .catch(() => { /* console offline / not logged in */ });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initSidebar();
    initNotifications();
    refreshNavBadges();
    setInterval(refreshNavBadges, 60000);

    const devicesHeader = document.getElementById('DevicesTable')?.getElementsByTagName('thead')[0];
    if (devicesHeader) {
      const stickyOffset = devicesHeader.offsetTop;
      window.addEventListener('scroll', function () {
        if (window.pageYOffset > stickyOffset) {
          devicesHeader.classList.add('sticky');
        } else {
          devicesHeader.classList.remove('sticky');
        }
      });
    }

    restoreLastView();
  });
})();
