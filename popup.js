const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');

function setStatus(msg) {
  statusEl.textContent = msg;
}

function appendLog(source, line, isError = false) {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  if (isError) div.className = 'err';
  div.textContent = `[${time}] (${source}) ${line}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

const summaryEl = $('summary');

// Track the most recent section/values in memory so manual-fill actions
// know what they're updating without re-fetching from storage each time.
let currentSectionInfo = null;
let currentValues = null;

// IDs of fields whose row is currently showing the edit input instead of
// static text. Cleared on save/cancel; not persisted (resets on reopen).
const editingFields = new Set();

function renderSummary(sectionInfo, values) {
  currentSectionInfo = sectionInfo;
  currentValues = values;

  const fieldById = {};
  sectionInfo.fields.forEach((f) => {
    fieldById[f.id] = f;
  });

  const rows = Object.keys(values)
    .map((id) => {
      const value = values[id];
      const field = fieldById[id] || { label: id, type: 'text' };
      const label = field.label || id;
      const isSkipped = value === null || value === undefined || String(value).trim() === '';
      const isEditing = editingFields.has(id);

      if (isSkipped || isEditing) {
        const existing = isSkipped ? '' : escapeHtml(String(value));
        return `
          <tr>
            <td class="label">${escapeHtml(label)}</td>
            <td class="value ${isSkipped ? 'skipped' : ''}">
              <div class="manual-fill-row">
                <input type="text" data-manual-input="${escapeHtml(id)}" placeholder="type the answer..." value="${existing}" />
                <button data-manual-save="${escapeHtml(id)}">Save</button>
                ${isEditing ? `<button data-manual-cancel="${escapeHtml(id)}" class="cancel-btn">Cancel</button>` : ''}
              </div>
            </td>
          </tr>`;
      }
      return `
        <tr>
          <td class="label">${escapeHtml(label)}</td>
          <td class="value">
            <div class="filled-row">
              <span class="value-text">${escapeHtml(String(value))}</span>
              <button data-manual-edit="${escapeHtml(id)}" class="edit-btn" title="Edit">&#9998;</button>
            </div>
          </td>
        </tr>`;
    })
    .join('');

  const filledCount = Object.values(values).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length;
  const totalCount = Object.keys(values).length;

  summaryEl.innerHTML = `
    <div style="margin-bottom:4px;"><strong>${filledCount}/${totalCount} fields filled</strong></div>
    <table>${rows}</table>
  `;
}

// Event delegation: the summary table gets rebuilt on every render, so we
// attach one listener to the container instead of per-button.
summaryEl.addEventListener('click', (e) => {
  const saveBtn = e.target.closest('[data-manual-save]');
  if (saveBtn) {
    const fieldId = saveBtn.getAttribute('data-manual-save');
    const input = summaryEl.querySelector(`[data-manual-input="${CSS.escape(fieldId)}"]`);
    const value = input?.value?.trim();
    if (!value) return;
    editingFields.delete(fieldId);
    handleManualFill(fieldId, value);
    return;
  }

  const editBtn = e.target.closest('[data-manual-edit]');
  if (editBtn) {
    const fieldId = editBtn.getAttribute('data-manual-edit');
    editingFields.add(fieldId);
    renderSummary(currentSectionInfo, currentValues);
    summaryEl.querySelector(`[data-manual-input="${CSS.escape(fieldId)}"]`)?.focus();
    return;
  }

  const cancelBtn = e.target.closest('[data-manual-cancel]');
  if (cancelBtn) {
    const fieldId = cancelBtn.getAttribute('data-manual-cancel');
    editingFields.delete(fieldId);
    renderSummary(currentSectionInfo, currentValues);
  }
});

// Let Enter submit the edit input without reaching for the Save button.
summaryEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('[data-manual-input]');
  if (!input) return;
  const fieldId = input.getAttribute('data-manual-input');
  const saveBtn = summaryEl.querySelector(`[data-manual-save="${CSS.escape(fieldId)}"]`);
  saveBtn?.click();
});

async function handleManualFill(fieldId, value) {
  if (!currentSectionInfo) return;
  const field = currentSectionInfo.fields.find((f) => f.id === fieldId) || { label: fieldId, type: 'text' };

  // 1. Apply immediately to the live page.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'APPLY_VALUES', values: { [fieldId]: value } });
  }

  // 2. Update the in-memory result and re-render right away so the row
  // shows as filled without waiting on the network round-trip below.
  currentValues = { ...currentValues, [fieldId]: value };
  renderSummary(currentSectionInfo, currentValues);
  chrome.storage.local.set({ lastSectionInfo: currentSectionInfo, lastValues: currentValues });

  // 3. Fold this new fact into the resume document via Gemma, so any future
  // fill — on this page or any other page of the application — can draw on
  // it too. The resume itself stays the single source of truth.
  appendLog('popup', `Merging "${field.label}" into the resume...`);
  chrome.runtime.sendMessage(
    { type: 'MERGE_RESUME_FACT', label: field.label || fieldId, value },
    (response) => {
      if (chrome.runtime.lastError) {
        appendLog('popup', `Resume merge failed: ${chrome.runtime.lastError.message}`, true);
        return;
      }
      if (response?.error) {
        appendLog('popup', `Resume merge failed: ${response.error}`, true);
        return;
      }
      appendLog('popup', 'Resume updated with the new info.');
    }
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

chrome.storage.local.get(['lastSectionInfo', 'lastValues'], ({ lastSectionInfo, lastValues }) => {
  if (lastSectionInfo && lastValues) renderSummary(lastSectionInfo, lastValues);
});

chrome.storage.local.get(['logLines'], ({ logLines }) => {
  (logLines || []).forEach((l) => appendLog(l.source, l.line, l.isError));
});

// Live log lines from background.js / content.js while the popup is open.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'LOG') {
    const isError = /error/i.test(message.line);
    appendLog(message.source, message.line, isError);
    // Persist so logs survive popup close/reopen.
    chrome.storage.local.get(['logLines'], ({ logLines }) => {
      const updated = [...(logLines || []), { ...message, isError }].slice(-200);
      chrome.storage.local.set({ logLines: updated });
    });
  }
});

$('clearLogBtn').addEventListener('click', () => {
  logEl.innerHTML = '';
  summaryEl.innerHTML = '';
  chrome.storage.local.set({ logLines: [], lastSectionInfo: null, lastValues: null });
});

// The identity fields + resume now live on the full-page profile editor
// (profile.html) rather than in this compact panel.
$('editProfileBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Promise wrappers around the callback-based chrome.* messaging APIs, used
// by both the single-shot fill and the "fill all" loop below.
// ---------------------------------------------------------------------------

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => resolve(response));
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

$('fillBtn').addEventListener('click', async () => {
  setStatus('Filling...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('apply.universityofcalifornia.edu')) {
    setStatus('Open the UC application tab first.');
    return;
  }

  // Ask the content script what section is currently visible,
  // then ask the background worker to map profile -> field values via Gemma.
  chrome.tabs.sendMessage(tab.id, { type: 'GET_VISIBLE_SECTION' }, (sectionInfo) => {
    if (chrome.runtime.lastError || !sectionInfo) {
      setStatus('Could not read the page. Refresh and try again.');
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'FILL_SECTION', sectionInfo },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }
        if (response?.error) {
          setStatus('Error: ' + response.error);
          return;
        }
        chrome.tabs.sendMessage(tab.id, {
          type: 'APPLY_VALUES',
          values: response.values,
        });
        setStatus('Filled ' + Object.keys(response.values).length + ' fields — see breakdown below.');
        renderSummary(sectionInfo, response.values);
        chrome.storage.local.set({ lastSectionInfo: sectionInfo, lastValues: response.values });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// "Fill All From Resume" — keeps filling the current repeatable section
// (e.g. Activities & Awards), clicking "Add Another" and re-filling, until
// the model reports no more unused resume items match this section, or the
// page has no "Add Another" control, or a safety iteration cap is hit.
//
// This never touches a submit/continue button — it only ever fills fields
// and clicks "Add Another" — so every auto-added entry still sits there for
// the applicant to review before moving on.
// ---------------------------------------------------------------------------

const MAX_LOOP_ITERATIONS = 20;

async function fillOnce(tab, sectionInfo) {
  const response = await sendRuntimeMessage({ type: 'FILL_SECTION', sectionInfo });
  if (chrome.runtime.lastError || !response || response.error) {
    return { error: response?.error || chrome.runtime.lastError?.message || 'Unknown error' };
  }
  await sendTabMessage(tab.id, { type: 'APPLY_VALUES', values: response.values });
  renderSummary(sectionInfo, response.values);
  chrome.storage.local.set({ lastSectionInfo: sectionInfo, lastValues: response.values });
  return { values: response.values, moreRemaining: response.moreRemaining };
}

async function fillAllFromResume() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('apply.universityofcalifornia.edu')) {
    setStatus('Open the UC application tab first.');
    return;
  }

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    const sectionInfo = await sendTabMessage(tab.id, { type: 'GET_VISIBLE_SECTION' });
    if (chrome.runtime.lastError || !sectionInfo) {
      setStatus('Could not read the page. Refresh and try again.');
      return;
    }

    setStatus(`Filling entry ${i + 1}...`);
    const result = await fillOnce(tab, sectionInfo);
    if (result.error) {
      setStatus('Error: ' + result.error);
      return;
    }

    if (!sectionInfo.repeatable) {
      setStatus('Filled ' + Object.keys(result.values).length + " fields — this section isn't a repeatable list.");
      return;
    }

    if (!result.moreRemaining) {
      setStatus('Done — no more unused resume items match this section.');
      return;
    }

    setStatus('Adding another entry...');
    const clickResult = await sendTabMessage(tab.id, { type: 'CLICK_ADD_ANOTHER' });
    if (!clickResult || !clickResult.clicked) {
      setStatus('Filled what it could — no "Add Another" button found to continue.');
      return;
    }
    await sleep(200); // small extra buffer past content.js's own DOM-settle wait
  }

  setStatus(`Stopped after ${MAX_LOOP_ITERATIONS} entries (safety limit) — check the page.`);
}

$('fillAllBtn').addEventListener('click', fillAllFromResume);

$('resetTrackingBtn').addEventListener('click', async () => {
  await sendRuntimeMessage({ type: 'RESET_RESUME_TRACKING' });
  setStatus('Resume tracking reset — next "Fill All" will start from the top of the resume.');
});
