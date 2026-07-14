/**
 * Safe archive helpers
 * Solved = remaining reached expected quantity (e.g. 3 of 3 scanned).
 * Then wait 3 months before auto-archive unless Done is clicked.
 * Return buckets (qty >= 9000) are excluded until a dedicated Returns DB exists.
 */

const RETURN_BUCKET_MIN_QTY = 9000;

function addMonths(date, months) {
    const copy = new Date(date);
    copy.setMonth(copy.getMonth() + months);
    return copy;
}

function isReturnBucket(item) {
    return Number(item.quantity) >= RETURN_BUCKET_MIN_QTY;
}

/** True when scanned/remaining count has caught up to expected quantity. */
function isSolved(item) {
    const qty = Number(item.quantity);
    const rem = Number(item.remaining);
    if (!Number.isFinite(qty) || !Number.isFinite(rem)) return false;
    if (qty < 1) return false;
    if (isReturnBucket(item)) return false;
    return rem === qty;
}

function markSafeArchivePending(item, now = new Date()) {
    if (!item.autoArchivePending || !item.archiveEligibleAt) {
        item.autoArchivePending = true;
        item.solvedAt = now.toISOString();
        item.archiveEligibleAt = addMonths(now, 3).toISOString();
        // clear old leftover field from previous remaining<=0 design
        delete item.remainingZeroAt;
        return true;
    }
    return false;
}

function clearSafeArchivePending(item) {
    let changed = false;
    if (item.autoArchivePending) {
        delete item.autoArchivePending;
        changed = true;
    }
    if (item.solvedAt) {
        delete item.solvedAt;
        changed = true;
    }
    if (item.remainingZeroAt) {
        delete item.remainingZeroAt;
        changed = true;
    }
    if (item.archiveEligibleAt) {
        delete item.archiveEligibleAt;
        changed = true;
    }
    return changed;
}

/** Apply solved -> pending, or incomplete -> clear pending. Returns true if data changed. */
function applySafeArchiveState(item, now = new Date()) {
    if (isSolved(item)) {
        return markSafeArchivePending(item, now);
    }
    return clearSafeArchivePending(item);
}

/**
 * Hourly/startup: ensure pending flags for solved rows,
 * then move due pending rows into archivedTrackingData.
 */
function runDueAutoArchive() {
    try {
        const now = new Date();
        const active = Array.isArray(global.trackingData) ? global.trackingData : [];
        if (!Array.isArray(global.archivedTrackingData)) {
            global.archivedTrackingData = [];
        }

        let changed = false;
        let movedCount = 0;

        for (let i = active.length - 1; i >= 0; i--) {
            const item = active[i];
            changed = applySafeArchiveState(item, now) || changed;

            if (item.autoArchivePending && item.archiveEligibleAt) {
                const eligibleAt = new Date(item.archiveEligibleAt);
                if (!Number.isNaN(eligibleAt.getTime()) && eligibleAt <= now) {
                    const [moved] = active.splice(i, 1);
                    moved.autoArchivedAt = now.toISOString();
                    moved.archiveReason = 'solved_qty_equals_remaining_after_3_month_safe_period';
                    delete moved.autoArchivePending;
                    global.archivedTrackingData.push(moved);
                    changed = true;
                    movedCount++;
                }
            }
        }

        if (changed) {
            global.saveTrackingData();
            global.saveArchivedTrackingData();
        }

        if (movedCount > 0) {
            console.log(`Auto-archived ${movedCount} solved tracking record(s) after 3-month safe period.`);
        }
    } catch (error) {
        console.error('runDueAutoArchive error:', error);
    }
}

module.exports = {
    RETURN_BUCKET_MIN_QTY,
    isReturnBucket,
    isSolved,
    markSafeArchivePending,
    clearSafeArchivePending,
    applySafeArchiveState,
    runDueAutoArchive,
    addMonths
};
