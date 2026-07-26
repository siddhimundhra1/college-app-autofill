const FIELD_SELECTORS = 'input:not([type=hidden]), textarea, select';
const LOG_PREFIX = '[UC-Autofill:content]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
  chrome.runtime.sendMessage({ type: 'LOG', source: 'content', line: args.map(String).join(' ') }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true });
  }

  if (message.type === 'GET_VISIBLE_SECTION') {
    const section = readVisibleSection();
    log('Found', section.fields.length, 'visible fields:', JSON.stringify(section.fields));
    sendResponse(section);
  }

  if (message.type === 'APPLY_VALUES') {
    const result = applyValues(message.values || {});
    log('Apply result:', JSON.stringify(result));
    sendResponse(result);
  }

  return true;
});

function readVisibleSection() {
  const fields = [];
  document.querySelectorAll(FIELD_SELECTORS).forEach((el) => {
    if (!isVisible(el) || isProbablyNonApplicantField(el)) return;

    const id = el.id || el.name || el.dataset.ucAutofillId || autoId(el);
    el.dataset.ucAutofillId = id;

    fields.push({
      id,
      label: getLabelFor(el),
      type: getFieldType(el),
      options: getOptions(el),
      required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
    });
  });
  return {
    title: document.title,
    heading: getPageHeading(),
    url: location.href,
    fields,
  };
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function isProbablyNonApplicantField(el) {
  const type = (el.type || '').toLowerCase();
  const label = getLabelFor(el).toLowerCase();
  return type === 'submit' || type === 'button' || type === 'reset' || /search|captcha|password/.test(label);
}

function getFieldType(el) {
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'TEXTAREA') return 'textarea';
  return (el.type || 'text').toLowerCase();
}

function getOptions(el) {
  if (el.tagName !== 'SELECT') return [];
  return Array.from(el.options).map((option) => ({
    value: option.value,
    label: option.textContent.trim(),
  }));
}

function getPageHeading() {
  return document.querySelector('h1, h2, [role="heading"]')?.textContent?.trim() || '';
}

function getLabelFor(el) {
  const pieces = [];

  if (el.id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl) pieces.push(labelEl.textContent.trim());
  }

  const wrappedLabel = el.closest('label');
  if (wrappedLabel) pieces.push(wrappedLabel.textContent.trim());

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) pieces.push(ariaLabel);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    labelledBy.split(/\s+/).forEach((id) => {
      const labelSource = document.getElementById(id);
      if (labelSource) pieces.push(labelSource.textContent.trim());
    });
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) pieces.push(placeholder);

  const nearby = findNearbyText(el);
  if (nearby) pieces.push(nearby);

  pieces.push(el.name || el.id || '');

  return uniqueClean(pieces).join(' | ').slice(0, 240);
}

function findNearbyText(el) {
  const container = el.closest('div, section, fieldset, li, tr');
  if (!container) return '';
  return Array.from(container.querySelectorAll('label, legend, p, span'))
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
}

function uniqueClean(values) {
  return Array.from(new Set(values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)));
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
  const filled = [];
  const skipped = [];

  Object.entries(values).forEach(([id, value]) => {
    if (value === null || value === undefined || value === '') {
      skipped.push({ id, reason: 'empty value' });
      return;
    }

    const el = findElementById(id);
    if (!el) {
      skipped.push({ id, reason: 'no matching element' });
      return;
    }

    const ok = setFieldValue(el, String(value));
    if (ok) filled.push(id);
    else skipped.push({ id, reason: 'could not set value' });
  });

  return { filled, skipped };
}

function setFieldValue(el, value) {
  const type = getFieldType(el);
  if (type === 'select') return setSelectValue(el, value);
  if (type === 'checkbox') return setCheckboxValue(el, value);
  if (type === 'radio') return setRadioValue(el, value);
  return setNativeTextValue(el, value);
}

function setSelectValue(el, value) {
  const normalized = normalize(value);
  const option = Array.from(el.options).find((candidate) => (
    normalize(candidate.value) === normalized ||
    normalize(candidate.textContent) === normalized ||
    normalize(candidate.textContent).includes(normalized) ||
    normalized.includes(normalize(candidate.textContent)) ||
    optionAliasMatches(normalized, normalize(candidate.textContent)) ||
    optionAliasMatches(normalized, normalize(candidate.value))
  ));
  if (!option) return false;
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function setCheckboxValue(el, value) {
  const shouldCheck = /^(true|yes|y|checked|selected|1)$/i.test(value.trim());
  el.checked = shouldCheck;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function setRadioValue(el, value) {
  const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
  const normalized = normalize(value);
  const match = Array.from(group).find((radio) => {
    const label = getLabelFor(radio);
    return normalize(radio.value) === normalized ||
      normalize(label).includes(normalized) ||
      normalized.includes(normalize(label)) ||
      optionAliasMatches(normalized, normalize(label)) ||
      optionAliasMatches(normalized, normalize(radio.value));
  });
  if (!match) return false;
  match.checked = true;
  match.dispatchEvent(new Event('input', { bubbles: true }));
  match.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function setNativeTextValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function optionAliasMatches(value, option) {
  const aliases = {
    'community service': ['volunteer', 'community service', 'service'],
    'extracurricular activity': ['extracurricular', 'club', 'leadership'],
    'educational preparation program': ['education', 'academic', 'research', 'course', 'preparation'],
    'work experience': ['work', 'job', 'employment', 'paid'],
    'award or honor': ['award', 'honor', 'recognition'],
    'in california': ['california', 'ca'],
    'outside california in the u s': ['outside california', 'out of state', 'u s'],
    'outside the u s': ['outside the u s', 'international'],
  };
  return Object.entries(aliases).some(([canonical, terms]) => (
    (value.includes(canonical) || terms.some((term) => value.includes(term))) &&
    (option.includes(canonical) || terms.some((term) => option.includes(term)))
  ));
}
