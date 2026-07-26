const GEMMA_MODEL = 'gemma-4-31b-it';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`;

// Make clicking the toolbar icon open the side panel (docked, stays open on
// outside clicks) instead of the old transient popup.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error('[UC-Autofill:bg] Failed to set side panel behavior:', err);
});

const LOG_PREFIX = '[UC-Autofill:bg]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
  // Also broadcast to the popup (if open) so logs show up in one place.
  chrome.runtime.sendMessage({ type: 'LOG', source: 'background', line: args.map(String).join(' ') }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_SECTION') {
    log('Received FILL_SECTION with', message.sectionInfo.fields.length, 'fields');
    handleFillSection(message.sectionInfo)
      .then((values) => {
        log('Success. Field values:', JSON.stringify(values));
        sendResponse({ values });
      })
      .catch((err) => {
        log('ERROR:', err.message || err);
        sendResponse({ error: String(err) });
      });
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'MERGE_RESUME_FACT') {
    log(`Received MERGE_RESUME_FACT for "${message.label}"`);
    handleMergeResumeFact(message.label, message.value)
      .then((resume) => {
        log('Resume updated.');
        sendResponse({ resume });
      })
      .catch((err) => {
        log('ERROR merging resume fact:', err.message || err);
        sendResponse({ error: String(err) });
      });
    return true;
  }
});

async function handleMergeResumeFact(label, value) {
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!apiKey) throw new Error('No API key saved. Open the profile page and add one.');

  const resumeText = profile?.resume || '';
  const prompt = buildResumeMergePrompt(resumeText, label, value);
  const raw = await callGemmaWithRetry(prompt, apiKey, null, 0, RESUME_SYSTEM_INSTRUCTION);
  const updatedResume = raw.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();

  const updatedProfile = { ...(profile || {}), resume: updatedResume };
  await chrome.storage.local.set({ profile: updatedProfile });
  return updatedResume;
}

function buildResumeMergePrompt(resumeText, label, value) {
  return `You maintain an applicant's running "resume" document, which is used as context to
autofill college application forms (any page — activities, awards, essays, etc).

Current resume:
"""
${resumeText || '(empty — nothing recorded yet)'}
"""

The applicant just answered a form field that wasn't already covered by the resume:
Field label: "${label}"
Applicant's answer: "${value}"

Rewrite the ENTIRE resume with this new fact folded into the most appropriate existing section
(e.g. Extracurriculars, Awards & Honors, Work Experience, Volunteering, Essays). Create a new
section only if nothing fits. Keep every piece of existing content — never drop or invent
anything. Keep the tone and format consistent with the rest of the document (plain resume-style
text, not JSON). Output ONLY the updated resume text and nothing else — no preamble, no
commentary, no markdown fences.`;
}

async function handleFillSection(sectionInfo) {
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!apiKey) throw new Error('No API key saved. Open the profile page and add one.');
  if (!profile) throw new Error('No profile saved yet. Open the profile page to set it up.');

  log('Detected fields:', JSON.stringify(sectionInfo.fields));

  // sectionInfo.fields is an array like:
  // [{ id: "firstName", label: "First Name", type: "text" }, ...]
  // built by content.js from the live DOM of whatever section is on screen.
  const prompt = buildPrompt(profile, sectionInfo);
  log('Prompt sent to Gemma:', prompt.slice(0, 500) + (prompt.length > 500 ? '...(truncated)' : ''));

  const schema = buildResponseSchema(sectionInfo.fields);
  const result = await callGemmaWithRetry(prompt, apiKey, schema);
  log('Raw model response:', result);

  const parsed = parseModelJson(result);
  return parsed;
}

// Constrains the model's output to an object with EXACTLY these keys. Select
// fields get an `enum` of their real <option> values ONLY — no escape hatch —
// so the model can never hallucinate an option, but it also can never skip a
// dropdown. Every field is a required, non-null string: the model must always
// produce its best guess, and the applicant reviews/edits before submitting.
function buildResponseSchema(fields) {
  const properties = {};
  fields.forEach((f) => {
    if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
      properties[f.id] = {
        type: 'STRING',
        enum: f.options.map((o) => o.value),
      };
    } else {
      properties[f.id] = { type: 'STRING' };
    }
  });
  return {
    type: 'OBJECT',
    properties,
    required: fields.map((f) => f.id),
    propertyOrdering: fields.map((f) => f.id),
  };
}

function buildPrompt(profile, sectionInfo) {
  return `Map the applicant's information onto the form fields below. These fields can come from
any page of a college application — personal info, activities, awards, essays, and so on — so use
whichever part of the applicant's information actually answers each one.

Applicant's structured info (JSON) — fixed-shape facts like name, contact info, school, GPA, etc:
${JSON.stringify(profile.identity || {}, null, 2)}

Applicant's resume (freeform) — extracurriculars, awards/honors, work and volunteer experience,
leadership, essay material, and anything else that doesn't fit a fixed field:
"""
${profile.resume || '(empty — nothing recorded yet)'}
"""

Form fields on screen right now (JSON):
${JSON.stringify(sectionInfo.fields, null, 2)}

ALWAYS PROVIDE A VALUE FOR EVERY FIELD. Never output null or an empty string. The applicant will
review every field and can correct or clear anything before submitting, so your best reasonable
guess is always more useful than leaving a field blank.

For each field, use its "label" to figure out which piece of the applicant's information it
wants — check both the structured info and the resume text first. If you find a direct match,
use it. If you don't, don't stop there — reason it out:
- Combine or rephrase facts that ARE present rather than requiring an exact wording match.
- For a dropdown/category/type/level/frequency field, pick whichever listed option is the closest
  reasonable fit given everything you know about the applicant, even if the connection is
  indirect or your confidence is low. This is a judgment call among a closed set of options, not
  invented information.
- For a quantitative field with no explicit number available (hours per week, weeks per year,
  etc.), give a reasonable typical estimate for that kind of activity.
- For a grade-level / date-range field, infer from years of involvement, graduation year, or
  similar context when you have it.
- If truly nothing in the applicant's info bears on a field at all, still give your single most
  plausible generic guess for that kind of applicant/field rather than leaving it blank.

Some fields include an "options" list (these are dropdowns). For those fields you MUST output one
of the given option "value" strings exactly as written — never the display "text", never a value
that isn't in the list.

For checkbox fields ("type": "checkbox"), output the string "true" or "false" — always one or the
other, your best guess of whether it should be checked, never blank.

The one thing to avoid: don't state a specific, checkable fact (an exact GPA, test score, date,
or figure) that contradicts something you were actually given elsewhere. Reasonable estimates and
category judgments are exactly what's wanted — that caution is about contradiction, not about
whether to answer.`;
}

const JSON_SYSTEM_INSTRUCTION =
  'You are a JSON-only form-filling API, not a chat assistant. You never explain your ' +
  'approach, never restate instructions, and never output anything except one raw JSON ' +
  'object. Any non-JSON output from you is a failure.';

const RESUME_SYSTEM_INSTRUCTION =
  'You are a careful resume-editing assistant, not a chat assistant. You never explain your ' +
  'approach, never restate instructions, and never output anything except the updated resume ' +
  'text itself. Any preamble, commentary, or markdown fencing from you is a failure.';

// schema: pass a responseSchema object for constrained JSON output (form-fill
// calls), or null/undefined for plain-text output (resume-merge calls).
async function callGemmaWithRetry(prompt, apiKey, schema, attempt = 0, systemInstructionText = JSON_SYSTEM_INSTRUCTION) {
  const generationConfig = { temperature: 0, maxOutputTokens: 2048 };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (res.status === 429 && attempt < 3) {
    const backoffMs = 500 * 2 ** attempt;
    log(`429 rate limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/3)`);
    await new Promise((r) => setTimeout(r, backoffMs));
    return callGemmaWithRetry(prompt, apiKey, schema, attempt + 1, systemInstructionText);
  }

  if (!res.ok) {
    const text = await res.text();
    log(`HTTP ${res.status} from Gemma:`, text.slice(0, 300));
    throw new Error(`Gemma API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    log(`WARNING: finishReason was "${finishReason}" (not STOP) — response may be truncated or blocked`);
  }

  const text = candidate?.content?.parts?.map((p) => p.text).join('') || '';
  return text;
}

function parseModelJson(rawText) {
  // Strip accidental ```json fences just in case the model adds them.
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fallback: the model may have added stray prose before/after the JSON.
    // Try to pull out the first {...} block and parse just that.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        // fall through to the error below
      }
    }
    throw new Error('Model did not return valid JSON: ' + cleaned.slice(0, 200));
  }
}
