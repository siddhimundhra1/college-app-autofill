const GEMMA_MODEL = 'gemma-4-31b-it';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`;

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
});

async function handleFillSection(sectionInfo) {
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!apiKey) throw new Error('No API key saved. Open the popup and add one.');
  if (!profile) throw new Error('No profile saved yet.');

  log('Detected fields:', JSON.stringify(sectionInfo.fields));

  // sectionInfo.fields is an array like:
  // [{ id: "firstName", label: "First Name", type: "text" }, ...]
  // built by content.js from the live DOM of whatever section is on screen.
  const prompt = buildPrompt(profile, sectionInfo);
  log('Prompt sent to Gemma:', prompt.slice(0, 500) + (prompt.length > 500 ? '...(truncated)' : ''));

  const schema = buildResponseSchema(sectionInfo.fields);
  const result = await callGemmaWithRetry(prompt, apiKey, schema);
  log('Raw model response:', result);

  return parseModelJson(result);
}

// Constrains the model's output to an object with EXACTLY these keys, each a
// nullable string. This is enforced at decoding time, not just by prompting —
// much stronger than asking nicely.
function buildResponseSchema(fields) {
  const properties = {};
  fields.forEach((f) => {
    properties[f.id] = { type: 'STRING', nullable: true };
  });
  return {
    type: 'OBJECT',
    properties,
    propertyOrdering: fields.map((f) => f.id),
  };
}

function buildPrompt(profile, sectionInfo) {
  return `Map the applicant's profile data onto the form fields below.

Applicant profile (JSON):
${JSON.stringify(profile, null, 2)}

Form fields on screen right now (JSON):
${JSON.stringify(sectionInfo.fields, null, 2)}

For each field, use its "label" to figure out which piece of profile data it wants,
then provide that value. If no profile data matches a field, use null for that field —
do not invent values.`;
}

async function callGemmaWithRetry(prompt, apiKey, schema, attempt = 0) {
  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text:
              'You are a JSON-only form-filling API, not a chat assistant. You never explain your ' +
              'approach, never restate instructions, and never output anything except one raw JSON ' +
              'object. Any non-JSON output from you is a failure.',
          },
        ],
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 2048,
      },
    }),
  });

  if (res.status === 429 && attempt < 3) {
    const backoffMs = 500 * 2 ** attempt;
    log(`429 rate limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/3)`);
    await new Promise((r) => setTimeout(r, backoffMs));
    return callGemmaWithRetry(prompt, apiKey, schema, attempt + 1);
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