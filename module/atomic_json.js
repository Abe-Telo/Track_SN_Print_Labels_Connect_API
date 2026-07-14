const fs = require('fs');
const path = require('path');

/**
 * Atomically write JSON to disk: write temp file in same directory, then rename.
 * Prevents empty/corrupt files if the process crashes mid-write.
 */
function atomicWriteJsonSync(filePath, data) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    const base = path.basename(resolved);
    const tmp = path.join(dir, '.' + base + '.tmp.' + process.pid + '.' + Date.now());
    const payload = (typeof data === 'string') ? data : JSON.stringify(data, null, 2);

    fs.writeFileSync(tmp, payload, 'utf8');
    try {
        fs.renameSync(tmp, resolved);
    } catch (err) {
        // Fallback if rename fails across filesystems (shouldn't happen in same dir)
        try {
            fs.writeFileSync(resolved, payload, 'utf8');
        } finally {
            try { fs.unlinkSync(tmp); } catch (_) {}
        }
        if (err && err.code !== 'EXDEV') {
            // renamed failed for another reason after fallback — keep fallback result
        }
    }
}

module.exports = { atomicWriteJsonSync };
