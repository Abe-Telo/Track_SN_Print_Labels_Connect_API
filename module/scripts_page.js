// module/scripts_page.js
// Lists downloadable scripts/tools for the Scripts & Tools page.

const fs = require('fs');
const path = require('path');

const SOURCES = [
    {
        key: 'workstation',
        label: 'Workstation Kit (from tracking.1.0.11)',
        description: 'Individual scripts from the USB zip — COPY_TO_DESKTOP, RunOnce, updates, and the GS scanner. Use with the full zip or download pieces here.',
        dir: 'workstation',
        urlBase: '/workstation'
    },
    {
        key: 'ps',
        label: 'Legacy Server Scripts (ps/)',
        description: 'Older gs2_server versions kept on the server for reference. Production PCs use gs2_server_v5.1_Print.ps1 from the Workstation Kit.',
        dir: 'ps',
        urlBase: '/ps'
    },
    {
        key: 'downloads',
        label: 'Full USB Package & Tools',
        description: 'USB packages: full bootstrap zip for old USBs, core scripts zip for frequent changes, large-tools zip for heavy binaries, plus v.txt.',
        dir: 'Downloads',
        urlBase: '/Downloads'
    }
];

const FILE_HINTS = {
    'tracking.big.1.0.11.zip': 'Large tools package: Heaven, color tests, Surface tools, etc.',
    'tracking.core.1.0.12.zip': 'Small package: scripts/config that change often',
    'tracking.1.0.12.zip': 'Full bootstrap package for older USBs that still read only v= from v.txt',
    'COPY_TO_DESKTOP.cmd': 'Phase 1 entry point — run from USB to copy AUDIT_SCRIPS to Desktop and kick off updates',
    'COPY_TO_DESKTOP.ps1': 'Installs both Fios and AF7A1C, prefers Fios, then continues the Desktop setup flow',
    'gs_Windows_Environment.bat': 'Phase 3 — run from Desktop after updates; launches the GS scanner',
    'gs2_server_v5.1_Print.ps1': 'Working GS scanner on live Desktops (OrderAssist + Google Forms). Dual Wi-Fi: Fios preferred, AF7A1C fallback',
    'online_script_Update.ps1': 'New dual-package updater: downloads core and/or big zip only when that version changes',
    'RunOnce.ps1': 'First-run setup: PS modules, UpdateCycle scheduled task, runs InstallUpdates',
    'RunOnce.cmd': 'Admin launcher for RunOnce.ps1',
    'InstallUpdates.ps1': 'Windows Update via PSWindowsUpdate (-AcceptAll -AutoReboot)',
    'Get-ComputerSpecs.psm1': 'Helper module for system specs',
    'wifi-profile.xml': 'Wi-Fi profile used by InstallUpdates network setup',
    'AddWifi.bat': 'Quick Wi-Fi profile add helper',
    'Remote-Enabled.ps1': 'Sets RemoteSigned execution policy (run from COPY_TO_DESKTOP.cmd)',
    'Startup.ps1': 'Creates RunOnce shortcut in Startup folder',
    'WORKFLOW.txt': 'Plain-text overview of the 3-phase USB workflow',
    'tracking.1.0.11.zip': 'Full USB image — extract to D:\\ (507 MB)',
    'v.txt': 'Version manifest. Old USBs read v=; new updater also reads CoreVersion and BigVersion',
    'gs2_server_v2.3_working_Added_Device_info.ps1': 'Legacy scanner (Dec 2024) — superseded by v5.1 in zip'
};

function listDir(baseDir, source) {
    const dirPath = path.join(baseDir, source.dir);
    if (!fs.existsSync(dirPath)) return [];

    return fs.readdirSync(dirPath)
        .filter((name) => !name.startsWith('.') && name !== '.ipynb_checkpoints')
        .map((name) => {
            const stat = fs.statSync(path.join(dirPath, name));
            if (!stat.isFile()) return null;
            return {
                name,
                url: source.urlBase + '/' + encodeURIComponent(name),
                size: stat.size,
                modified: stat.mtime.toISOString(),
                hint: FILE_HINTS[name] || ''
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            // WORKFLOW.txt and COPY_TO_DESKTOP first in workstation group
            const priority = (n) => {
                if (n === 'WORKFLOW.txt') return 0;
                if (n.startsWith('COPY_TO_DESKTOP')) return 1;
                if (n.startsWith('gs')) return 2;
                return 3;
            };
            const pa = priority(a.name), pb = priority(b.name);
            if (pa !== pb) return pa - pb;
            return a.name.localeCompare(b.name);
        });
}

function scriptsPage(app) {
    app.get('/list-scripts', (req, res) => {
        try {
            const groups = SOURCES.map((source) => ({
                key: source.key,
                label: source.label,
                description: source.description || '',
                files: listDir(__dirname + '/..', source)
            }));
            res.json({ groups });
        } catch (err) {
            console.error('/list-scripts error:', err);
            res.status(500).json({ error: 'Failed to list scripts' });
        }
    });
}

module.exports = { scriptsPage };
