// This selector list is a STARTING POINT — you will need to inspect the real
// UC application DOM (right-click a field > Inspect) and adjust selectors to
// match actual name/id/aria-label attributes once you're testing live.
const FIELD_SELECTORS = 'input:not([type=hidden]), textarea, select';

const LOG_PREFIX = '[UC-Autofill:content]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
  chrome.runtime.sendMessage({ type: 'LOG', source: 'content', line: args.map(String).join(' ') }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VISIBLE_SECTION') {
    const section = readVisibleSection();
    log('Found', section.fields.length, 'visible fields:', JSON.stringify(section.fields));
    sendResponse(section);
  }
  if (message.type === 'APPLY_VALUES') {
    log('Applying values:', JSON.stringify(message.values));
    applyValues(message.values);
  }
  return true;
});

function readVisibleSection() {
  const fields = [];
  document.querySelectorAll(FIELD_SELECTORS).forEach((el) => {
    if (!isVisible(el)) return;

    const id = el.id || el.name || autoId(el);
    if (!el.id) el.dataset.ucAutofillId = id; // tag it so we can find it again later

    fields.push({
      id,
      label: getLabelFor(el),
      type: el.tagName === 'SELECT' ? 'select' : el.type || 'text',
    });
  });
  return { fields };
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function getLabelFor(el) {
  if (el.id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl) return labelEl.textContent.trim();
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder;
  return el.name || '';
}

let autoIdCounter = 0;
function autoId(el) {
  autoIdCounter += 1;
  return `ucaf_${autoIdCounter}`;
}

function findElementById(id) {
  return (
    document.getElementById(id) ||
    document.querySelector(`[name="${CSS.escape(id)}"]`) ||
    document.querySelector(`[data-uc-autofill-id="${CSS.escape(id)}"]`)
  );
}

function applyValues(values) {
  Object.entries(values).forEach(([id, value]) => {
    if (value === null || value === undefined) {
      log(`Skipped "${id}": model returned null`);
      return;
    }
    const el = findElementById(id);
    if (!el) {
      log(`Skipped "${id}": no matching element found on page`);
      return;
    }
    setNativeValue(el, String(value));
    log(`Filled "${id}" with "${value}"`);
  });
}

// Many form frameworks (React included) track input state internally and
// ignore a plain `el.value = x` assignment. This uses the native setter so
// the framework's change listener actually fires.
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  if (el.tagName === 'SELECT') {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
