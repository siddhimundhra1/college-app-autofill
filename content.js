// This selector list is a STARTING POINT — you will need to inspect the real
// UC application DOM (right-click a field > Inspect) and adjust selectors to
// match actual name/id/aria-label attributes once you're testing live.
// Includes contenteditable boxes (e.g. essay answer boxes like
// <div contenteditable="true" id="answerBox">), which are treated as
// "essay" fields — see readVisibleSection below.
const FIELD_SELECTORS = 'input:not([type=hidden]), textarea, select, [contenteditable="true"]';

// Heuristic phrases for the button/link that adds a new blank entry to a
// repeatable list section (another activity, another award, etc). This is a
// STARTING POINT — inspect the real "Add Another Activity"-style control on
// the UC application and tighten this regex (or hardcode a selector) once
// you know its actual text/markup.
const ADD_ANOTHER_TEXT_RE = /add\s+(another|new)\b|\+\s*add\b/i;

// Heuristic pattern for a nearby word/character counter, e.g. "0 / 350
// words" or "350 characters remaining". Used to detect essay length limits.
const LIMIT_TEXT_RE = /(\d[\d,]*)\s*(word|character|char)s?\b/i;

const LOG_PREFIX = '[UC-Autofill:content]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
  chrome.runtime.sendMessage({ type: 'LOG', source: 'content', line: args.map(String).join(' ') }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VISIBLE_SECTION') {
    const section = readVisibleSection();
    log(
      'Found', section.fields.length, 'visible fields (repeatable:', section.repeatable, '):',
      JSON.stringify(section.fields)
    );
    sendResponse(section);
  }

  if (message.type === 'APPLY_VALUES') {
    log('Applying values:', JSON.stringify(message.values));
    applyValues(message.values);
    sendResponse({ ok: true });
  }

  if (message.type === 'CLICK_ADD_ANOTHER') {
    const btn = findAddAnotherButton();
    if (!btn) {
      log('No "Add Another" button found.');
      sendResponse({ clicked: false });
      return true;
    }
    btn.click();
    log('Clicked "Add Another" — waiting for DOM to settle...');
    waitForDomSettle().then(() => sendResponse({ clicked: true }));
    return true; // keep channel open for the async waitForDomSettle
  }

  return true;
});

function findAddAnotherButton() {
  const candidates = document.querySelectorAll('button, a, [role="button"]');
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const text = (el.textContent || '').trim();
    if (ADD_ANOTHER_TEXT_RE.test(text)) return el;
  }
  return null;
}

// Waits for the DOM to stop mutating (e.g. a new activity entry rendering
// in after "Add Another" is clicked) before resolving, so the caller can
// safely re-read fields. Resolves after `quietMs` of no mutations, or after
// `maxWaitMs` regardless, so it never hangs indefinitely on a page that
// doesn't mutate the way we expect.
function waitForDomSettle(quietMs = 400, maxWaitMs = 3000) {
  return new Promise((resolve) => {
    let quietTimer = null;
    const hardTimer = setTimeout(() => {
      observer.disconnect();
      clearTimeout(quietTimer);
      resolve();
    }, maxWaitMs);

    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(hardTimer);
        resolve();
      }, quietMs);
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    quietTimer = setTimeout(() => {
      observer.disconnect();
      clearTimeout(hardTimer);
      resolve();
    }, quietMs);
  });
}

// Looks for a word/character limit displayed near an essay box — e.g. a
// counter like "0 / 350 words" somewhere in a nearby ancestor — or falls
// back to a maxlength-style attribute on the element itself. This is a
// heuristic: the real UC markup may show the counter differently, so adjust
// LIMIT_TEXT_RE or this search depth once you're testing live.
function findLimitNear(el) {
  let container = el.parentElement;
  for (let depth = 0; depth < 4 && container; depth++) {
    const text = container.textContent || '';
    const match = text.match(LIMIT_TEXT_RE);
    if (match) {
      return {
        count: parseInt(match[1].replace(/,/g, ''), 10),
        unit: /word/i.test(match[2]) ? 'words' : 'characters',
      };
    }
    container = container.parentElement;
  }
  const maxLength = el.getAttribute('maxlength') || el.getAttribute('data-max-length') || el.getAttribute('data-maxlength');
  if (maxLength && !Number.isNaN(parseInt(maxLength, 10))) {
    return { count: parseInt(maxLength, 10), unit: 'characters' };
  }
  return null;
}

function readVisibleSection() {
  const fields = [];
  document.querySelectorAll(FIELD_SELECTORS).forEach((el) => {
    if (!isVisible(el)) return;

    const id = el.id || el.name || autoId(el);
    if (!el.id) el.dataset.ucAutofillId = id; // tag it so we can find it again later

    const isEditable = el.matches('[contenteditable="true"]');

    const field = {
      id,
      label: getLabelFor(el),
      type: isEditable ? 'essay' : el.tagName === 'SELECT' ? 'select' : el.type || 'text',
    };

    if (el.tagName === 'SELECT') {
      field.options = Array.from(el.options)
        .filter((opt) => opt.value !== '') // skip empty/placeholder options
        .map((opt) => ({ value: opt.value, text: opt.textContent.trim() }));
    }

    if (isEditable) {
      const limit = findLimitNear(el);
      if (limit) field.limit = limit;

      const existingText = el.textContent.trim();
      if (existingText) field.existingDraft = existingText;
    }

    fields.push(field);
  });

  // A section is "repeatable" if it has a visible "Add Another"-style
  // control — that signals this is one entry of a list the applicant may
  // have several of (activities, awards, etc.), so background.js should
  // pull from the resume's item list and track what's already been used.
  const addBtn = findAddAnotherButton();
  return { fields, repeatable: !!addBtn };
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function getLabelFor(el) {
  // aria-labelledby (e.g. an essay box referencing the id of the element
  // holding the actual prompt question text) takes priority — it's the
  // most reliable signal for what a contenteditable box is actually asking.
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((refId) => document.getElementById(refId)?.textContent.trim() || '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
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
    if (value === null || value === undefined || String(value).trim() === '') {
      log(`Skipped "${id}": model returned no value`);
      return;
    }
    const el = findElementById(id);
    if (!el) {
      log(`Skipped "${id}": no matching element found on page`);
      return;
    }
    if (el.matches('[contenteditable="true"]') || el.isContentEditable) {
      setContentEditableValue(el, String(value));
    } else {
      setNativeValue(el, String(value));
    }
    log(`Filled "${id}" with "${value.length > 80 ? value.slice(0, 80) + '...(truncated)' : value}"`);
  });
}

// Many form frameworks (React included) track input state internally and
// ignore a plain `el.value = x` assignment. This uses the native setter so
// the framework's change listener actually fires.
function setNativeValue(el, value) {
  if (el.type === 'checkbox' || el.type === 'radio') {
    const shouldCheck = ['true', 'yes', '1', 'checked'].includes(String(value).toLowerCase());
    const nativeCheckedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
    if (nativeCheckedSetter) {
      nativeCheckedSetter.call(el, shouldCheck);
    } else {
      el.checked = shouldCheck;
    }
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (el.tagName === 'SELECT') {
    el.value = value;
    if (el.value !== value) {
      log(`WARNING: select "${el.id || el.name}" did not accept value "${value}" — no matching <option>. Selection left unchanged.`);
      return;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// contenteditable boxes (essay answers) aren't native form controls, so
// `.value =` does nothing and even setting `.textContent` directly is
// often ignored by whatever rich-text framework is managing the box. This
// focuses the element, selects its existing contents, and uses
// document.execCommand('insertText', ...) — which most editors (Draft.js,
// Slate, ProseMirror, and plain contenteditable alike) treat as a real user
// edit and pick up correctly, firing their own internal input handling.
// Falls back to a manual textContent rebuild (with paragraph breaks
// preserved) if execCommand isn't available/supported in this context.
function setContentEditableValue(el, value) {
  el.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);

  let inserted = false;
  try {
    inserted = document.execCommand && document.execCommand('insertText', false, value);
  } catch (e) {
    inserted = false;
  }

  if (!inserted) {
    el.textContent = '';
    const paragraphs = value.split(/\n{2,}/);
    paragraphs.forEach((para, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(para));
    });
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}
