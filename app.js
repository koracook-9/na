const DAYS_TO_FLAG = 5;
const INSTALL_WINDOW_DAYS = 14;
const state = { analyses: [] };

const input = document.getElementById('csvInput');
const dropZone = document.querySelector('.upload-box');
const results = document.getElementById('results');
const summary = document.getElementById('summary');

input.addEventListener('change', () => handleFiles(input.files));

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  handleFiles(event.dataTransfer.files);
});

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const csvFiles = files.filter((file) => file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv');
  const rejected = files.filter((file) => !csvFiles.includes(file));
  const analyses = await Promise.all(csvFiles.map(analyzeFile));
  state.analyses = [...state.analyses, ...analyses];
  render();

  if (rejected.length) {
    showMessage(`Skipped non-CSV file${rejected.length > 1 ? 's' : ''}: ${rejected.map((file) => file.name).join(', ')}`);
  }
  input.value = '';
}

async function analyzeFile(file) {
  try {
    const rows = parseCSV(await file.text());
    if (rows.length < 2) throw new Error('The CSV is empty or contains headers only.');
    const headers = rows[0].map((value) => String(value || '').trim());
    const reportName = identifyReport(file.name);
    const alerts = rows.slice(1)
      .filter((row) => row.some((cell) => String(cell || '').trim()))
      .map((row) => evaluateRow(normalizeRow(headers, row), reportName))
      .filter((result) => result.flags.length);
    return { fileName: file.name, reportName, rowCount: rows.length - 1, alerts, error: '' };
  } catch (error) {
    return { fileName: file.name, reportName: identifyReport(file.name), rowCount: 0, alerts: [], error: error.message };
  }
}

function identifyReport(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('claude')) return 'Claude Integrations';
  if (name.includes('reserve') || name.includes('backlog')) return 'Reserve / Backlog';
  if (name.includes('kora') || name.includes('stall')) return 'Kora Stall Progressing';
  return 'Salesforce export (report type not inferred from filename)';
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeRow(headers, cells) {
  return Object.fromEntries(headers.map((header, index) => [normalizeHeader(header), String(cells[index] || '').trim()]));
}

function valueFor(row, names) {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value) return value;
  }
  return '';
}

function parseDate(value) {
  if (!value) return null;
  const text = value.trim();
  // Avoid implementation-dependent parsing of Salesforce dates like M/D/YYYY.
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/);
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let date;
  if (us) date = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  else if (iso) date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  else date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayDifference(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

function evaluateRow(row, reportName) {
  const owner = valueFor(row, ['Case Owner', 'Owner', 'Assigned To', 'Owner Name', 'Assigned Owner']);
  const caseId = valueFor(row, ['Case Number', 'Case ID', 'Case Id', 'Case Name', 'Subject']) || 'Case';
  const latestText = valueFor(row, ['Latest Update', 'Latest Update Date', 'Last Update', 'Most Recent Update', 'Last Modified Date']);
  const installText = valueFor(row, ['Install Date', 'Installation Date', 'Installed Date', 'Date Installed']);
  const scheduledText = valueFor(row, ['CC Scheduled Date', 'Scheduled Date', 'Date Scheduled', 'Outreach Date']);
  const allText = Object.values(row).join(' ');
  const lowerText = allText.toLowerCase();
  const flags = [];
  let severity = 'warning';

  // Backlog cases are excluded, except installed/unassigned cases which were specified as urgent.
  const installedUnassigned = /installed/i.test(allText) && /unassigned|default case owner|integration activations/i.test(owner + ' ' + allText);
  if (/backlog/i.test(allText) && !installedUnassigned) return { caseId, owner, flags: [] };
  if (reportName === 'Reserve / Backlog' && /reserve activations?/i.test(allText)) return { caseId, owner, flags: [] };

  if (/default case owner|integration activations|unassigned|not assigned/i.test(owner) || !owner) {
    if (installedUnassigned) flags.push('Installed and unassigned — urgent assignment needed.');
    else if (owner) flags.push('Owner is a default or activation queue — assign to a team member.');
    else flags.push('Owner is missing — verify assignment.');
    severity = installedUnassigned ? 'urgent' : 'warning';
  }

  const latestDate = parseDate(latestText);
  const scheduledDate = parseDate(scheduledText);
  const futureOutreachMention = /outreach\s+in\s+[a-z]+|outreach\s+(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{4}/i.test(allText);
  const futureScheduled = scheduledDate && scheduledDate > today();
  const ccScheduledPast = /cc\s+scheduled/i.test(lowerText) && scheduledDate && scheduledDate < today();

  if (reportName !== 'Claude Integrations') {
    if (!latestText) flags.push('Latest update is missing.');
    else if (latestDate && dayDifference(today(), latestDate) >= DAYS_TO_FLAG && !(futureOutreachMention || futureScheduled) && !(reportName === 'Reserve / Backlog' && /cc\s+scheduled/i.test(lowerText) && !ccScheduledPast)) {
      flags.push('Latest update is 5 or more days old.');
    }
  }

  if (reportName === 'Reserve / Backlog') {
    const installDate = parseDate(installText);
    if (installDate) {
      const daysUntil = dayDifference(installDate, today());
      if (daysUntil === 0) flags.push(`Install date is today (${installText}).`);
      else if (daysUntil > 0 && daysUntil <= INSTALL_WINDOW_DAYS) flags.push(`Install is within 2 weeks (${installText}).`);
      else if (daysUntil < 0) flags.push(`Install date has passed (${installText}).`);
    }
    if (ccScheduledPast) flags.push(`CC scheduled date is in the past (${scheduledText}).`);
  }

  if (reportName === 'Claude Integrations') {
    const immediateVendor = /deliverect|reddie|spoton\s+kiosk|popmenu|maple/i.test(allText);
    const installDate = parseDate(installText);
    const createdText = valueFor(row, ['Created Date', 'Case Created Date', 'Created']);
    const createdDate = parseDate(createdText);
    if (immediateVendor && !owner) {
      flags.push('Priority integration case — assign as soon as it is created.');
      severity = 'urgent';
    } else if (installDate && dayDifference(installDate, today()) >= 0 && dayDifference(installDate, today()) <= 7 && !owner) {
      flags.push('Install is within one week — assign this case.');
    } else if (createdDate && installDate && dayDifference(installDate, createdDate) <= 7 && !owner) {
      flags.push('Case is within the one-week assignment window.');
    }
  }

  if (installedUnassigned) severity = 'urgent';
  return { caseId, owner, flags: [...new Set(flags)], severity };
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((item) => item.trim())) rows.push(row);
  }
  return rows;
}

function render() {
  const count = state.analyses.reduce((sum, item) => sum + item.alerts.length, 0);
  const urgent = state.analyses.reduce((sum, item) => sum + item.alerts.filter((alert) => alert.severity === 'urgent').length, 0);
  summary.innerHTML = `
    <div class="summary-card"><p class="label">Files analyzed</p><p class="value">${state.analyses.length}</p></div>
    <div class="summary-card"><p class="label">Flagged cases</p><p class="value">${count}</p></div>
    <div class="summary-card"><p class="label">Urgent items</p><p class="value">${urgent}</p></div>`;
  results.innerHTML = state.analyses.map((item) => `
    <section class="file-group">
      <div class="file-header">${escapeHtml(item.reportName)} — ${escapeHtml(item.fileName)} (${item.rowCount} rows)</div>
      ${item.error ? `<p class="file-error">Could not read this CSV: ${escapeHtml(item.error)}</p>` : item.alerts.length ? `<ul class="alert-list">${item.alerts.map((alert) => `
        <li class="alert-item ${alert.severity || 'warning'}">
          <div class="case-header"><span class="case-id">${escapeHtml(alert.caseId)}</span><span class="tag ${alert.severity || 'warning'}">${alert.severity || 'warning'}</span></div>
          <p class="muted">Owner: ${escapeHtml(alert.owner || 'Unknown')}</p>
          <ul class="flags">${alert.flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join('')}</ul>
        </li>`).join('')}</ul>` : '<p class="file-success">CSV loaded successfully. No cases were flagged by the current rules.</p>'}
    </section>`).join('');
}

function showMessage(message) {
  const note = document.createElement('p');
  note.className = 'file-error';
  note.textContent = message;
  results.prepend(note);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}
