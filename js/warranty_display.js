/**
 * Shared warranty expiry display — countdown to EXP day, or "Expired".
 * Loaded globally on the Tracking Console (window.OAWarranty).
 */
(function (global) {
  function parseExpiryDate(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s || /^expired$/i.test(s) || /^n\/?a$/i.test(s) || s === '—' || s === '-') return null;
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) {
      const d = new Date(`${iso[1]}T12:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const parsed = Date.parse(s);
    if (Number.isNaN(parsed)) return null;
    const d = new Date(parsed);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function startOfLocalDay(date) {
    const d = date ? new Date(date) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function formatIsoDate(date) {
    if (!date) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** Whole days from today to expiry. Negative = already expired. null = unknown. */
  function daysUntilExpiry(expiresOn, today) {
    const exp = parseExpiryDate(expiresOn);
    if (!exp) return null;
    const expDay = startOfLocalDay(exp);
    const todayDay = startOfLocalDay(today || new Date());
    return Math.round((expDay.getTime() - todayDay.getTime()) / 86400000);
  }

  /**
   * @param {{ status?: string, expiresOn?: string, expires?: string }} opts
   */
  function warrantyCountdown(opts) {
    const options = opts || {};
    const status = String(options.status || '').trim();
    const expiresOn = options.expiresOn || options.expires || null;
    const days = daysUntilExpiry(expiresOn);
    const dateStr = formatIsoDate(parseExpiryDate(expiresOn));
    const expiredByStatus = /EXPIRED/i.test(status);
    const expiredByDate = days != null && days < 0;
    const expired = expiredByStatus || expiredByDate;

    if (expired) {
      return {
        expired: true,
        days: days != null ? days : null,
        date: dateStr,
        shortLabel: 'Expired',
        longLabel: dateStr ? `Expired · was ${dateStr}` : 'Expired',
        lineLabel: dateStr ? `Expired · was ${dateStr}` : 'Expired',
        chipTone: 'danger',
        chipLabel: 'Expired',
        // Compact list badge — critical for MS eligibility
        daysBadge: 'EXP',
        daysBadgeTone: 'danger'
      };
    }

    if (days == null) {
      const inWarranty = /IN_WARRANTY/i.test(status);
      return {
        expired: false,
        days: null,
        date: dateStr,
        shortLabel: dateStr ? `Exp ${dateStr}` : (inWarranty ? 'In warranty' : (status || '')),
        longLabel: dateStr
          ? `Exp ${dateStr}`
          : (inWarranty ? 'In warranty' : (status ? status.replace(/_/g, ' ') : '')),
        lineLabel: dateStr
          ? `Exp ${dateStr}`
          : (inWarranty ? 'In warranty' : (status ? status.replace(/_/g, ' ') : '')),
        chipTone: inWarranty ? 'ok' : 'muted',
        chipLabel: inWarranty ? 'In warranty' : (status ? status.replace(/_/g, ' ') : 'Not checked'),
        daysBadge: '?',
        daysBadgeTone: 'muted'
      };
    }

    if (days === 0) {
      return {
        expired: false,
        days: 0,
        date: dateStr,
        shortLabel: 'Expires today',
        longLabel: `Exp ${dateStr} · today`,
        lineLabel: `Exp ${dateStr} · today`,
        chipTone: 'warn',
        chipLabel: 'Expires today',
        daysBadge: '0D',
        daysBadgeTone: 'danger'
      };
    }

    const dayWord = days === 1 ? 'day' : 'days';
    const urgent = days <= 30;
    const critical = days <= 14;
    return {
      expired: false,
      days,
      date: dateStr,
      shortLabel: `${days} ${dayWord} left`,
      longLabel: `Exp ${dateStr} · ${days} ${dayWord} left`,
      lineLabel: `Exp ${dateStr} · ${days} ${dayWord} left`,
      chipTone: urgent ? 'warn' : (/IN_WARRANTY/i.test(status) ? 'ok' : 'muted'),
      chipLabel: `${days}D left`,
      daysBadge: `${days}D`,
      daysBadgeTone: critical ? 'danger' : (urgent ? 'warn' : 'ok')
    };
  }

  /** True when device matches All Devices "warranty days" filter values. */
  function matchesDaysFilter(expiresOn, status, filterValue) {
    if (!filterValue) return true;
    const info = warrantyCountdown({ status, expiresOn });
    if (filterValue === 'none') return info.days == null && !info.expired;
    if (filterValue === 'expired') return info.expired;
    if (filterValue === 'today') return !info.expired && info.days === 0;
    const max = Number(filterValue);
    if (!Number.isFinite(max)) return true;
    return !info.expired && info.days != null && info.days >= 0 && info.days <= max;
  }

  function isBlankSpec(value) {
    if (value == null) return true;
    const text = String(value).trim();
    if (!text) return true;
    if (text === '—' || text === '–' || text === '-') return true;
    return ['unknown', 'n/a', 'na', 'none', 'null', '?'].includes(text.toLowerCase());
  }

  function toGbNumber(value) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(TB|GB|G|T)?$/i);
    if (!match) {
      const n = Number(text);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    let amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = (match[2] || '').toUpperCase();
    if (unit === 'TB' || unit === 'T') amount *= 1024;
    return Math.round(amount);
  }

  /**
   * Pull CPU / RAM / HD from Microsoft marketing names like
   * "Surface Laptop Studio - i5/16/256" or "… Elite/32/1TB".
   */
  function parseHardwareFromDeviceName(deviceName) {
    const raw = String(deviceName || '').trim();
    const out = { ram: null, hd: null, cpu: null };
    if (!raw) return out;

    const slash = raw.match(
      /\b((?:Ultra\s*)?\d*|i\d+|R\d+|SQ\d+|[A-Za-z][A-Za-z0-9]*)\s*\/\s*(\d+)\s*\/\s*(\d+(?:\.\d+)?\s*(?:TB|GB)?)\b/i
    );
    if (slash) {
      const token = String(slash[1] || '').trim();
      const ram = Number(slash[2]);
      let hd = toGbNumber(slash[3]);
      if (hd != null && hd > 0 && hd <= 8 && !/TB|GB/i.test(slash[3])) hd *= 1024;
      if (ram > 0 && ram <= 128) out.ram = ram;
      if (hd != null && hd >= 64) out.hd = hd;
      if (/^(?:i\d+|R\d+|SQ\d+|Ultra\s*\d+|Elite|Plus|X\s*Plus|X\s*Elite)$/i.test(token)) {
        out.cpu = token.replace(/\s+/g, ' ');
      }
      return out;
    }

    const classic = raw.match(/(\d+)\s*GB\b.*?\b(\d+)\s*GB\b/i);
    if (classic) {
      const storage = Number(classic[1]);
      const ram = Number(classic[2]);
      if (storage >= 64) out.hd = storage;
      if (ram > 0 && ram <= 128) out.ram = ram;
    }
    const tb = raw.match(/\b(\d+(?:\.\d+)?)\s*TB\b/i);
    if (tb && out.hd == null) out.hd = Math.round(Number(tb[1]) * 1024);
    const cpuClassic = raw.match(/\b(i\d+|R\d+|SQ\d+|Ultra\s*\d+|Elite|Plus|X\s*Plus|X\s*Elite)\b/i);
    if (cpuClassic) out.cpu = cpuClassic[1].replace(/\s+/g, ' ').trim();
    return out;
  }

  /** Prefer local specs; fill blanks from Microsoft model name. */
  function resolveDisplaySpecs(localData, warranty) {
    const device = localData || {};
    const w = warranty || device._warrantyMerged || device.msWarranty || {};
    const name = device.warrantyDeviceName || w.deviceName || '';
    const parsed = parseHardwareFromDeviceName(name);
    return {
      cpu: !isBlankSpec(device.cpu) ? device.cpu : (parsed.cpu || ''),
      ram: !isBlankSpec(device.ram) ? device.ram : (parsed.ram != null ? parsed.ram : ''),
      hd: !isBlankSpec(device.hd) ? device.hd : (parsed.hd != null ? parsed.hd : ''),
      fromMicrosoft: {
        cpu: isBlankSpec(device.cpu) && !!parsed.cpu,
        ram: isBlankSpec(device.ram) && parsed.ram != null,
        hd: isBlankSpec(device.hd) && parsed.hd != null
      }
    };
  }

  global.OAWarranty = {
    parseExpiryDate,
    daysUntilExpiry,
    warrantyCountdown,
    matchesDaysFilter,
    parseHardwareFromDeviceName,
    resolveDisplaySpecs,
    isBlankSpec
  };
})(typeof window !== 'undefined' ? window : globalThis);
