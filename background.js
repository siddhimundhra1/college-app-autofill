const GEMMA_MODEL = 'gemma-4-31b-it';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`;
const LOG_PREFIX = '[UC-Autofill:bg]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
  chrome.runtime.sendMessage({ type: 'LOG', source: 'background', line: args.map(String).join(' ') }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_SECTION') {
    handleFillSection(message.sectionInfo)
      .then((values) => sendResponse({ values }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
});

async function handleFillSection(sectionInfo) {
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!profile) throw new Error('No profile saved yet.');
  if (!sectionInfo?.fields?.length) throw new Error('No visible fields detected on this UC page.');

  log('Detected fields:', JSON.stringify(sectionInfo.fields));

  if (!apiKey) {
    log('No API key saved; using local fallback mapper.');
    return localMap(profile, sectionInfo.fields);
  }

  try {
    const prompt = buildPrompt(profile, sectionInfo);
    const schema = buildResponseSchema(sectionInfo.fields);
    const result = await callGemmaWithRetry(prompt, apiKey, schema);
    return parseModelJson(result);
  } catch (err) {
    log('Gemma failed; falling back locally:', err.message || err);
    return localMap(profile, sectionInfo.fields);
  }
}

function buildResponseSchema(fields) {
  const properties = {};
  fields.forEach((field) => {
    properties[field.id] = { type: 'STRING', nullable: true };
  });
  return {
    type: 'OBJECT',
    properties,
    propertyOrdering: fields.map((field) => field.id),
  };
}

function buildPrompt(profile, sectionInfo) {
  return `Map the applicant profile onto visible University of California application fields.

Rules:
- Return one JSON object only.
- Keys must exactly match the field ids provided.
- Use null for fields that do not have a clear profile match.
- Do not invent facts.
- For household, parent, guardian, income, residency, citizenship, demographic, race, ethnicity, or family background fields, only map a value if the profile explicitly contains it.
- Prefer concise UC-style values for activity and essay fields.

Applicant profile JSON:
${JSON.stringify(profile, null, 2)}

Visible UC page context:
${JSON.stringify(sectionInfo, null, 2)}
`;
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
              'You are a JSON-only UC application autofill API. Output exactly one raw JSON object and no prose.',
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
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return callGemmaWithRetry(prompt, apiKey, schema, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemma API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') || '';
}

function parseModelJson(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Model did not return valid JSON.');
  }
}

function localMap(profile, fields) {
  const values = {};
  fields.forEach((field, index) => {
    const label = normalize(`${field.label} ${field.id}`);
    const value = localValueForField(profile, field, label, index);
    values[field.id] = value || null;
  });
  return values;
}

function localValueForField(profile, field, label, index) {
  if (has(label, ['first name', 'given name'])) return firstName(profile.fullName);
  if (has(label, ['last name', 'surname', 'family name'])) return lastName(profile.fullName);
  if (has(label, ['full legal name', 'full name', 'applicant name', 'student name'])) return profile.fullName;
  if (has(label, ['email', 'e mail'])) return profile.email;
  if (has(label, ['phone', 'mobile', 'cell'])) return profile.phone;
  if (has(label, ['high school', 'school name'])) return profile.highSchool;
  if (has(label, ['gpa', 'grade point'])) return profile.gpa;
  if (has(label, ['major', 'field of study', 'academic interest'])) return profile.major;
  if (has(label, ['campus', 'university of california location'])) return bestOptionOrText(field, profile.campuses?.[0] || '');
  if (has(label, ['essay', 'personal insight', 'piq', 'leadership'])) return profile.piq1;
  if (has(label, ['activity', 'extracurricular', 'award', 'honor'])) return activityValue(profile, label, index);
  if (has(label, ['hours per week', 'hour week'])) return profile.activities?.[0]?.hoursPerWeek;
  if (has(label, ['years', 'grade levels', 'participation'])) return profile.activities?.[0]?.years;
  if (has(label, ['household', 'background', 'family context'])) return profile.backgroundContext;
  if (has(label, ['residency', 'resident'])) return profile.backgroundContext && /california/i.test(profile.backgroundContext) ? 'California resident' : '';
  return '';
}

function activityValue(profile, label, index) {
  if (!profile.activities?.length) return '';
  const activity = profile.activities[Math.min(index, profile.activities.length - 1)] || profile.activities[0];
  if (has(label, ['description', 'responsibilities'])) return activity.description;
  if (has(label, ['role', 'position'])) return activity.role;
  if (has(label, ['organization', 'employer'])) return activity.organization || activity.name;
  if (has(label, ['name', 'title'])) return activity.name;
  return [activity.name, activity.role, activity.description].filter(Boolean).join(' - ');
}

function bestOptionOrText(field, value) {
  if (!field.options?.length) return value;
  const normalized = normalize(value);
  const option = field.options.find((candidate) => (
    normalize(candidate.label).includes(normalized) ||
    normalize(candidate.value).includes(normalized) ||
    normalized.includes(normalize(candidate.label))
  ));
  return option?.value || option?.label || value;
}

function has(label, terms) {
  return terms.some((term) => label.includes(normalize(term)));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function firstName(fullName = '') {
  return fullName.trim().split(/\s+/)[0] || '';
}

function lastName(fullName = '') {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}
