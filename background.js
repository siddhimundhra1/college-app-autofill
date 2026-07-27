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
      .then(({ values, moreRemaining }) => {
        log('Success. Field values:', JSON.stringify(values));
        sendResponse({ values, moreRemaining });
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

  if (message.type === 'RESET_RESUME_TRACKING') {
    chrome.storage.local.set({ usedItemIds: [] }, () => {
      log('Resume item tracking reset.');
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function handleMergeResumeFact(label, value) {
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!apiKey) throw new Error('No API key saved. Open the profile page and add one.');

  const resumeText = profile?.resume || '';
  const prompt = buildResumeMergePrompt(resumeText, label, value);
  const raw = await callGemmaWithRetry(prompt, apiKey, null, { systemInstructionText: RESUME_SYSTEM_INSTRUCTION });
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

// ---------------------------------------------------------------------------
// Resume item extraction — parses the freeform resume into discrete,
// separately-listable items (one extracurricular, one award, one job, etc.)
// so a repeatable section (like the UC "Activities & Awards" list) can be
// filled one entry at a time without repeating the same item.
// ---------------------------------------------------------------------------

const RESUME_ITEMS_SYSTEM_INSTRUCTION =
  'You are a JSON-only resume-parsing API, not a chat assistant. You never explain your ' +
  'approach, never restate instructions, and never output anything except one raw JSON ' +
  'object. Any non-JSON output from you is a failure.';

const RESUME_ITEM_CATEGORIES = ['Award', 'EdPrep', 'ExtraCurr', 'OtherCourse', 'Volunteer', 'WorkExp'];

// Cheap, deterministic string hash so we can tell whether the resume text
// changed since we last parsed it into items (avoids re-calling Gemma on
// every single fill when the resume hasn't been touched).
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}

async function extractResumeItems(resumeText, apiKey) {
  if (!resumeText.trim()) return [];
  const prompt = `Parse the resume below into a flat JSON array of discrete, separately-listable
items — the kind of thing that would each get its own entry on a college application (one
extracurricular, one award, one job, one volunteer role, etc.). Split multi-item bullet lists
apart; merge nothing.

Resume:
"""
${resumeText}
"""

For each item, output:
- "id": a short, stable, lowercase-hyphenated slug derived from the item's name (e.g.
  "robotics-club-captain")
- "category": one of ${JSON.stringify(RESUME_ITEM_CATEGORIES)} — pick whichever fits best
- "name": short name/title of the item
- "summary": 1-3 sentence summary of everything relevant about it (role, duration, hours,
  achievements) so it can be used to fill a detailed form later without re-reading the resume

Output ONLY a JSON object of the shape { "items": [ ... ] } and nothing else.`;

  const schema = {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            category: { type: 'STRING', enum: RESUME_ITEM_CATEGORIES },
            name: { type: 'STRING' },
            summary: { type: 'STRING' },
          },
          required: ['id', 'category', 'name', 'summary'],
          propertyOrdering: ['id', 'category', 'name', 'summary'],
        },
      },
    },
    required: ['items'],
  };

  const raw = await callGemmaWithRetry(prompt, apiKey, schema, { systemInstructionText: RESUME_ITEMS_SYSTEM_INSTRUCTION });
  const parsed = parseModelJson(raw);
  return parsed.items || [];
}

// Cached by a hash of the resume text so repeated fills during the same
// session don't re-parse the resume on every single call.
async function getResumeItems(profile, apiKey) {
  const resumeText = profile?.resume || '';
  const hash = simpleHash(resumeText);
  const { resumeItemsCache } = await chrome.storage.local.get(['resumeItemsCache']);
  if (resumeItemsCache && resumeItemsCache.hash === hash) {
    return resumeItemsCache.items;
  }
  const items = await extractResumeItems(resumeText, apiKey);
  await chrome.storage.local.set({ resumeItemsCache: { hash, items } });
  return items;
}

async function handleFillSection(sectionInfo) {
  const { profile, apiKey, usedItemIds } = await chrome.storage.local.get(['profile', 'apiKey', 'usedItemIds']);
  if (!apiKey) throw new Error('No API key saved. Open the profile page and add one.');
  if (!profile) throw new Error('No profile saved yet. Open the profile page to set it up.');

  log('Detected fields:', JSON.stringify(sectionInfo.fields));

  // sectionInfo.fields is an array like:
  // [{ id: "firstName", label: "First Name", type: "text" }, ...]
  // built by content.js from the live DOM of whatever section is on screen.
  // sectionInfo.repeatable (set by content.js) means this section is one
  // entry of a repeatable list (e.g. Activities & Awards) with an
  // "Add Another" control, so we should pull from unused resume items and
  // report back whether more remain.
  const loopCtx = sectionInfo.repeatable
    ? { resumeItems: await getResumeItems(profile, apiKey), usedItemIds: usedItemIds || [] }
    : null;

  const hasEssayField = sectionInfo.fields.some((f) => f.type === 'essay');

  const prompt = buildPrompt(profile, sectionInfo, loopCtx);
  log('Prompt sent to Gemma:', prompt.slice(0, 500) + (prompt.length > 500 ? '...(truncated)' : ''));

  const schema = buildResponseSchema(sectionInfo.fields, !!loopCtx);

  // Essay fields need more room to generate (a 500-650 word essay is
  // ~700-900 tokens) and benefit from a little temperature so the prose
  // doesn't read as stiff/robotic; everything else stays deterministic.
  const result = await callGemmaWithRetry(prompt, apiKey, schema, {
    maxOutputTokens: hasEssayField ? 4096 : 2048,
    temperature: hasEssayField ? 0.4 : 0,
  });
  log('Raw model response:', hasEssayField ? result.slice(0, 500) + '...(truncated)' : result);

  const parsed = parseModelJson(result);
  const { _usedItemId, _moreRemaining, ...values } = parsed;

  if (loopCtx && _usedItemId) {
    const updated = [...(usedItemIds || []), _usedItemId];
    await chrome.storage.local.set({ usedItemIds: updated });
    log(`Marked resume item "${_usedItemId}" as used.`);
  }

  return { values, moreRemaining: loopCtx ? !!_moreRemaining : false };
}

// Constrains the model's output to an object with EXACTLY these keys. Select
// fields get an `enum` of their real <option> values ONLY — no escape hatch —
// so the model can never hallucinate an option, but it also can never skip a
// dropdown. Every field is a required, non-null string: the model must always
// produce its best guess, and the applicant reviews/edits before submitting.
// Essay fields (type "essay") also just get a plain STRING slot — the essay
// text itself — same as any other field, just longer.
//
// When includeLoopMeta is true (repeatable sections), two extra keys are
// added: "_usedItemId" (which resume item this pass consumed) and
// "_moreRemaining" (whether unused matching resume items are still left).
function buildResponseSchema(fields, includeLoopMeta) {
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

  const required = fields.map((f) => f.id);
  const propertyOrdering = fields.map((f) => f.id);

  if (includeLoopMeta) {
    properties['_usedItemId'] = { type: 'STRING' };
    properties['_moreRemaining'] = { type: 'BOOLEAN' };
    required.push('_usedItemId', '_moreRemaining');
    propertyOrdering.push('_usedItemId', '_moreRemaining');
  }

  return {
    type: 'OBJECT',
    properties,
    required,
    propertyOrdering,
  };
}

// Builds the extra instruction block used only when the section has one or
// more essay-type fields (contenteditable prompt boxes). Kept separate from
// the main prompt builder so the common case (plain fields) isn't cluttered.
function buildEssayBlock(profile, fields) {
  const essayFields = fields.filter((f) => f.type === 'essay');
  if (!essayFields.length) return '';

  const limitsNote = essayFields
    .map((f) => {
      if (!f.limit) {
        return `- "${f.label}": no explicit limit detected — aim for a typical UC-style response (roughly 350 words unless the prompt itself implies otherwise).`;
      }
      return `- "${f.label}": stay at or under ${f.limit.count} ${f.limit.unit} — target ~90-97% of that, never exceed it.`;
    })
    .join('\n');

  const draftsNote = essayFields
    .filter((f) => f.existingDraft)
    .map(
      (f) =>
        `- "${f.label}" already has a draft in progress:\n"""\n${f.existingDraft}\n"""\nPreserve its ideas, structure, and voice — polish and complete it rather than discarding it and starting fresh.`
    )
    .join('\n\n');

  return `

One or more fields below are long-form ESSAY responses (their "type" is "essay"), not short
factual fields — these are contenteditable prompt boxes where "label" is the actual essay prompt
question the applicant must answer.

For essay fields specifically:
- Write in the applicant's own authentic first-person voice, grounded in real specifics —
  concrete anecdotes, moments, and details drawn from the resume/structured info above. Never
  invent an accomplishment, award, statistic, or event that isn't already given somewhere.
- Use the "Previous writing samples" below purely to calibrate VOICE — tone, vocabulary level,
  typical sentence length/rhythm, how reflective vs. matter-of-fact the applicant tends to be.
  Do not copy phrases from the samples verbatim, and do not treat the samples as a source of new
  facts unless the same fact also appears in the resume or structured info.
- Answer the specific prompt in "label" directly — don't write a generic personal-statement that
  could answer any prompt.
- Output plain prose only: no markdown formatting, no headers, no bullet lists, no wrapping
  quotation marks around the whole response.

Length limits per essay field:
${limitsNote}
${draftsNote ? `\nExisting in-progress drafts to build on rather than replace:\n${draftsNote}` : ''}

Previous writing samples (style reference only — voice and tone, not facts):
"""
${profile.priorWriting || '(none provided — write in a natural, straightforward first-person student voice)'}
"""`;
}

function buildPrompt(profile, sectionInfo, loopCtx) {
  const loopBlock = loopCtx
    ? `

This section is part of a REPEATABLE list — the applicant may have MULTIPLE resume items that
belong here (multiple extracurriculars, awards, jobs, etc.), entered one at a time as separate
form entries.

Parsed resume items available to place (id, category, name, summary):
${JSON.stringify(loopCtx.resumeItems, null, 2)}

Items already entered in a previous pass on this application — do NOT reuse these, pick a
different one:
${JSON.stringify(loopCtx.usedItemIds)}

From the items NOT already used, pick the single best next one whose category matches what this
section is asking for (see the category/type field's options above, if present). Set
"_usedItemId" to that item's "id" and fill the rest of the fields on this page using that
specific item's details.

If every resume item matching this kind of entry has already been used, set "_moreRemaining" to
false and "_usedItemId" to an empty string, and just do a single best-effort generic pass over
the fields as usual. Otherwise, if at least one more matching unused item exists beyond this one,
set "_moreRemaining" to true.`
    : '';

  const essayBlock = buildEssayBlock(profile, sectionInfo.fields);

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
${loopBlock}
${essayBlock}

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
- For an essay field ("type": "essay"), follow the essay-specific instructions given above
  instead of these short-field rules.
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
// options: { attempt, systemInstructionText, maxOutputTokens, temperature }
async function callGemmaWithRetry(prompt, apiKey, schema, options = {}) {
  const {
    attempt = 0,
    systemInstructionText = JSON_SYSTEM_INSTRUCTION,
    maxOutputTokens = 2048,
    temperature = 0,
  } = options;

  const generationConfig = { temperature, maxOutputTokens };
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
    return callGemmaWithRetry(prompt, apiKey, schema, { ...options, attempt: attempt + 1 });
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
