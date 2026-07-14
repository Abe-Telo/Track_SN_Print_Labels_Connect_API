// js/scripts_page.js — renders the Scripts & Tools download page

(function () {
    function formatFileSize(bytes) {
        if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return bytes + ' B';
    }

    function fileTypeLabel(name) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.ps1')) return ['PowerShell', '#2563eb'];
        if (lower.endsWith('.psm1')) return ['Module', '#7c3aed'];
        if (lower.endsWith('.bat') || lower.endsWith('.cmd')) return ['CMD / Batch', '#b45309'];
        if (lower.endsWith('.zip')) return ['ZIP', '#059669'];
        if (lower.endsWith('.exe')) return ['EXE', '#64748b'];
        if (lower.endsWith('.txt')) return ['Text', '#64748b'];
        if (lower.endsWith('.xml')) return ['XML', '#64748b'];
        return ['File', '#64748b'];
    }

    function badge(name) {
        const info = fileTypeLabel(name);
        return '<span style="display:inline-block;padding:0.1rem 0.5rem;border-radius:999px;'
            + 'font-size:0.75rem;font-weight:600;color:#fff;background:' + info[1] + ';">'
            + info[0] + '</span>';
    }

    function renderScriptsPage() {
        const container = document.getElementById('scriptsPageContent');
        if (!container) return;

        fetch('/list-scripts')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) {
                let html = '';
                (data.groups || []).forEach(function (group) {
                    html += '<h2 style="font-size:1.05rem;margin:1.25rem 0 0.25rem;">' + group.label + '</h2>';
                    if (group.description) {
                        html += '<p style="color:#64748b;font-size:0.85rem;margin:0 0 0.5rem;">' + group.description + '</p>';
                    }
                    if (!group.files.length) {
                        html += '<p style="color:#64748b;">No files.</p>';
                        return;
                    }
                    html += '<div class="table-wrap"><table><thead><tr>'
                        + '<th>File</th><th>Type</th><th>Size</th><th>Updated</th><th style="width:1%;"></th>'
                        + '</tr></thead><tbody>';
                    group.files.forEach(function (file) {
                        const hintRow = file.hint
                            ? '<tr><td colspan="5" style="padding-top:0;padding-bottom:0.5rem;border-top:none;color:#64748b;font-size:0.8rem;">' + file.hint + '</td></tr>'
                            : '';
                        html += '<tr>'
                            + '<td style="word-break:break-all;">' + file.name + '</td>'
                            + '<td>' + badge(file.name) + '</td>'
                            + '<td style="white-space:nowrap;">' + formatFileSize(file.size) + '</td>'
                            + '<td style="white-space:nowrap;">' + file.modified.slice(0, 10) + '</td>'
                            + '<td><a class="btn" style="white-space:nowrap;" href="' + file.url + '" download>Download</a></td>'
                            + '</tr>' + hintRow;
                    });
                    html += '</tbody></table></div>';
                });
                container.innerHTML = html || '<p style="color:#64748b;">No files found.</p>';
            })
            .catch(function (error) {
                container.innerHTML = '<p style="color:#b91c1c;">Failed to load file list: ' + error.message + '</p>';
            });
    }

    window.renderScriptsPage = renderScriptsPage;
    renderScriptsPage();
})();
