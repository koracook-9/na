const REPORT_ALIASES = {
  kora: ['kora stall progressing', 'stall progressing', 'kora'],
  reserve: ['reserve', 'backlog', 'reserve all cases with backlog'],
  claude: ['claude', 'claude integrations']
};

const DAYS_TO_FLAG = 5;
const APPROX_INSTALL_WINDOW_DAYS = 14;

const state = {
  files: []
};

window.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('csvInput');
  const summaryWrap = document.getElementById('summary');
  const resultsWrap = document.getElementById('results');

  fileInput.addEventListener('change', async (event) => {
    const files = [...event.target.files || []];
    if (!files.length) return;

    const analyses = [];
    for (const file of files) {
      const analysis = await parseFile(file);
      analyses.push(analysis);
    }

    state.files = analyses;
    renderSummary(analyses);
    renderResults(analyses);
  });

  function renderSummary(analyses) {
    const totalFiles = analyses.length;
    const totalAlerts = analyses.reduce((sum, item) => sum + item.alerts.length, 0);
    const urgent = analyses.reduce((sum, item) => {
      return sum + item.alerts.filter((alert) => alert.severity === 'urgent').length;
    }, 0);

    summaryWrap.innerHTML = `
      <div class="summary-card">
        <p class="label">Files analyzed</p>
        <p class="value">${totalFiles}</p>
      </div>
      <div class="summary-card">
        <p class="label">Flagged cases</p>
        <p class="value">${totalAlerts}</p>
      </div>
      <div class="summary-card">
        <p class="label">Urgent items</p>
        <p class="value">${urgent}</p>
      </div>
    `;
  }

  function renderResults(analyses) {
    if (!analyses.length) {
      resultsWrap.innerHTML = '<p class="placeholder">No files uploaded yet.</p>';
      return;
    }

    const groups = analyses.map((item) => {
      const title = item.reportName || item.fileName;
      return `
        <div class="file-group">
          <div class="file-header">${escapeHtml(title)} (${item.alerts.length} flagged)</div>
          <ul class="alert-list">
            ${item.alerts.length ? item.alerts.map((alert) => `
              <li class="alert-item ${alert.severity}">
                <div class="case-header">
                  <span class="case-id">${escapeHtml(alert.caseId || 'Case')}</span>
                  <span class="tag ${alert.severity}">${alert.severity}</span>
                </div>
                <p class="muted">Owner: ${escapeHtml(alert.owner || 'Unknown')}</p>
                <ul class="flags">
                  ${alert.flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join('')}
                </ul>
              </li>
            `).join('') : '<li class="alert-item success"><p class="muted">No flags for this report.</p></li>'}
          </ul>
        </div>
      `;
    }).join('');

    resultsWrap.innerHTML = groups;
  }
});

async function parseFile(file) {
  const text = await file.text();
  const rows = parseCSV(text);

  if (!rows.length) {
    return {
      fileName: file.name,
      reportName: identifyReport(file.name),
      alerts: []
    };
  }

  const headerRow = rows[0].map((header) => String(header || '').trim());
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => (cell || '').trim() !== ''));

  const alerts = [];
  for (const row of dataRows) {
    const normalizedRow = normalizeRow(headerRow, row);
    const evaluation = evaluateRow(normalizedRow, identifyReport(file.name));

    if (evaluation.flags.length) {
      alerts.push({
        caseId: evaluation.caseId,
        owner: evaluation.owner,
        severity: evaluation.severity,
        flags: evaluation.flags
      });
    }
  }

  return {
    fileName: file.name,
    reportName: identifyReport(file.name),
    alerts
  };
}

function identifyReport(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('claude')) return 'Claude Integrations';
  if (lower.includes('reserve') || lower.includes('backlog')) return 'Reserve / Backlog';
  return 'Kora Stall Progressing';
}

function normalizeHeader(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeRow(headerRow, row) {
  const result = {};
  for (let i = 0; i < headerRow.length; i += 1) {
    const key = normalizeHeader(headerRow[i]);
    result[key] = (row[i] ?? '').trim();
  }
  return result;
}

function getValue(row, candidates) {
  for (const candidate of candidates) {
    const key = normalizeHeader(candidate);
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

function allTextValues(row) {
  return Object.values(row).join(' ');
}

function parseDate(value) {
  const raw = (value || '').trim();
  if (!raw) return null;

  const cleaned = raw.replace(/\s*\(.*?\)\s*/g, '');
  const timestamp = new Date(cleaned);
  if (!Number.isNaN(timestamp.getTime())) return timestamp;

  const fallback = new Date(cleaned.replace(/[/-]/g, '/'));
  if (!Number.isNaN(fallback.getTime())) return fallback;

  return null;
}

function daysBetween(dateA, dateB) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((dateA - dateB) / msPerDay);
}

function isPastOrSoonInstall(date) {
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = daysBetween(date, today);
  return diff <= APPROX_INSTALL_WINDOW_DAYS && diff >= -1;
}

function includesBacklogText(text) {
  return /(backlog)/i.test(text);
}

function includesReserveActivationText(text) {
  return /(reserve.*activation|activation.*reserve)/i.test(text) || /reserve activations?/i.test(text);
}

function includesUnassignedOwner(ownerText) {
  const normalized = ownerText.toLowerCase();
  return (
    !ownerText ||
    normalized.includes('default case owner') ||
    normalized.includes('unassigned') ||
    normalized.includes('integration activations') ||
    normalized.includes('not assigned') ||
    normalized.includes('n/a') ||
    normalized.includes('none')
  );
}

function evaluateRow(row, reportName) {
  const owner = getValue(row, [
    'Case Owner', 'Owner', 'Assigned To', 'Owner Name', 'Team', 'Case owner name', 'Assigned owner'
  ]);

  const caseId = getValue(row, [
    'Case Number', 'Case', 'Case ID', 'Case Id', 'Case Number #', 'Case Name'
  ]);

  const latestUpdateText = getValue(row, [
    'Latest Update', 'Last Update', 'Most Recent Update', 'Last Modified Date', 'Updated', 'Latest Update Date'
  ]);

  const installText = getValue(row, [
    'Install Date', 'Installation Date', 'Installed Date', 'Date Installed', 'Scheduled install date'
  ]);

  const scheduledText = getValue(row, [
    'CC Scheduled', 'Scheduled Date', 'Date Scheduled', 'Next Outreach', 'Outreach Date', 'Schedule Date'
  ]);

  const notesText = allTextValues(row);
  const latestUpdateDate = parseDate(latestUpdateText);
  const installDate = parseDate(installText);
  const scheduledDate = parseDate(scheduledText);

  const flags = [];
  let severity = 'warning';

  if (includesBacklogText(notesText)) {
    return {
      caseId: caseId || 'Unknown case',
      owner: owner || 'Unknown',
      severity: 'ok',
      flags: ['Backlog case — not flagged by rule.']
    };
  }

  if (reportName === 'Reserve / Backlog' && includesReserveActivationText(notesText)) {
    return {
      caseId: caseId || 'Unknown case',
      owner: owner || 'Unknown',
      severity: 'ok',
      flags: ['Reserve activation — ignored by rule.']
    };
  }

  if (includesUnassignedOwner(owner)) {
    flags.push('Unassigned or default case owner — needs assignment ASAP.');
    severity = 'urgent';
  }

  if (!latestUpdateText) {
    flags.push('Latest update missing — needs review.');
    severity = 'urgent';
  } else if (latestUpdateDate) {
    const ageDays = daysBetween(new Date(), latestUpdateDate);
    const isFutureOutreach = /outreach in|scheduled.*future|cc scheduled/i.test(notesText) && (scheduledDate ? scheduledDate > new Date() : false);

    if (!isFutureOutreach && ageDays >= DAYS_TO_FLAG) {
      flags.push(`Latest update is ${Math.max(ageDays, DAYS_TO_FLAG)}+ days old and should be reviewed.`);
      severity = severity === 'urgent' ? 'urgent' : 'warning';
    }
  }

  if (installDate && isPastOrSoonInstall(installDate)) {
    const installAge = daysBetween(new Date(), installDate);
    const direction = installAge <= 0 ? 'past or due soon' : 'coming up';
    flags.push(`Install date is ${direction}: ${installText}.`);
    if (severity !== 'urgent') severity = 'warning';
  }

  if (scheduledDate && scheduledDate < new Date()) {
    flags.push(`Scheduled date is in the past: ${scheduledText}.`);
    if (severity !== 'urgent') severity = 'warning';
  }

  if (reportName === 'Claude Integrations') {
    const vendorPriority = /(deliverect|reddie|spoton kiosk|popmenu|maple)/i.test(notesText);
    if (vendorPriority) {
      flags.push('High-priority vendor: assign immediately as soon as case is created.');
      severity = 'urgent';
    }

    if (installDate) {
      const diff = daysBetween(installDate, new Date());
      if (diff <= 7 && diff >= 0) {
        flags.push('Install date is within 1 week — assignment needed.');
        severity = 'urgent';
      }
    }
  }

  return {
    caseId: caseId || 'Unknown case',
    owner: owner || 'Unknown',
    severity,
    flags: [...new Set(flags)]
  };
}

function parseCSV(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      if (row.some((cell) => (cell || '').trim() !== '')) {
        rows.push(row);
      }
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  if (current.length > 0 || row.length) {
    row.push(current);
    if (row.some((cell) => (cell || '').trim() !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
