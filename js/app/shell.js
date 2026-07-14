/**
 * OrderAssist Tracking — app shell (Phase 1)
 * Preserves global toggleSection / loadContent API used by existing JS modules.
 */
(function () {
  const PAGE_TITLES = {
    AddTrackingForm: 'Add Tracking',
    searchSection: 'Search',
    devicesTable: 'All Devices',
    archive: 'All Tracking',
    howto: 'How It Works',
    updates: 'Software Updates',
    scripts: 'Scripts & Tools',
    fail2ban: 'Security / Fail2ban',
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

    const path = '/js/' + scriptName + '?v=20260714j';
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
      ? fetch(htmlPath + (htmlPath.includes('?') ? '&' : '?') + 'v=20260714d')
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

    toggleSection('AddTrackingForm');
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
            htmlPath: '/html/archive.html',
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
            htmlPath: '/html/updates.html',
            containerId: 'contentContainer',
            navKey: 'updates'
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
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initSidebar();

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
