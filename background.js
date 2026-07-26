const GEMMA_MODEL = 'gemma-4-31b-it';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`;
const LOG_PREFIX = '[UC-Autofill:bg]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
  chrome.runtime.sendMessage({ type: 'LOG', source: 'background', line: args.map(String).join(' ') }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_SECTION') {
    log('Received FILL_SECTION with', message.sectionInfo?.fields?.length || 0, 'fields');
    handleFillSection(message.sectionInfo)
      .then((result) => {
        log('Mapping source:', result.source, result.model || 'none');
        sendResponse(result);
      })
      .catch((err) => {
        log('ERROR:', err.message || err);
        sendResponse({ error: err.message || String(err) });
      });
    return true;
  }
});

async function handleFillSection(sectionInfo) {
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!profile) throw new Error('No profile saved yet.');
  if (!sectionInfo?.fields?.length) throw new Error('No visible fields detected on this UC page.');

  log('Detected fields:', JSON.stringify(sectionInfo.fields));

  if (!apiKey) {
    log('No API key saved; using built-in demo mapper.');
    return {
      values: localMap(profile, sectionInfo.fields),
      source: 'demo',
      model: null,
    };
  }

  try {
    const prompt = buildPrompt(profile, sectionInfo);
    const schema = buildResponseSchema(sectionInfo.fields);
    log('Sending UC field mapping request to', GEMMA_MODEL);
    const result = await callGemmaWithRetry(prompt, apiKey, schema);
    log('Raw Gemma response:', result.slice(0, 500) + (result.length > 500 ? '...(truncated)' : ''));
    const modelValues = parseModelJson(result);
    const fallbackValues = localMap(profile, sectionInfo.fields);
    return {
      values: mergeMappedValues(modelValues, fallbackValues, sectionInfo.fields),
      source: 'gemma',
      model: GEMMA_MODEL,
    };
  } catch (err) {
    log('Gemma failed; falling back locally:', err.message || err);
    return {
      values: localMap(profile, sectionInfo.fields),
      source: 'local-fallback',
      model: GEMMA_MODEL,
      warning: err.message || String(err),
    };
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
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    log(`Gemma finish reason was "${finishReason}"; response may be incomplete.`);
  }

  return candidate?.content?.parts?.map((part) => part.text).join('') || '';
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

function mergeMappedValues(primary, fallback, fields = []) {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  return Object.fromEntries(
    Object.keys(fallback).map((id) => {
      const field = fieldsById.get(id);
      const value = primary?.[id];
      if (value === null || value === undefined || value === '') return [id, fallback[id]];
      if (field?.options?.length && !optionMatches(field, value) && optionMatches(field, fallback[id])) {
        return [id, fallback[id]];
      }
      return [id, value];
    })
  );
}

function localValueForField(profile, field, label, index) {
  const academicHistoryValue = academicHistoryFieldValue(profile, field, label);
  if (academicHistoryValue !== '') return academicHistoryValue;

  const ucActivityValue = ucActivityFieldValue(profile, field, label, index);
  if (ucActivityValue !== '') return ucActivityValue;

  if (has(label, ['first name', 'given name', 'legal first', 'applicant first'])) return firstName(profile.fullName);
  if (has(label, ['last name', 'surname', 'family name', 'legal last', 'applicant last'])) return lastName(profile.fullName);
  if (has(label, ['middle name'])) return middleName(profile.fullName);
  if (has(label, ['full legal name', 'full name', 'applicant name', 'student name', 'legal name'])) return profile.fullName;
  if (has(label, ['email', 'e mail', 'email address'])) return profile.email;
  if (has(label, ['phone', 'mobile', 'cell', 'telephone'])) return profile.phone;
  if (has(label, ['high school', 'school name', 'current school', 'secondary school'])) return profile.highSchool;
  if (has(label, ['gpa', 'grade point'])) return profile.gpa;
  if (has(label, ['major', 'field of study', 'academic interest', 'intended field'])) return profile.major;
  if (has(label, ['campus', 'university of california location', 'uc campus'])) return bestOptionOrText(field, profile.campuses?.[0] || '');
  if (has(label, ['essay', 'personal insight', 'piq', 'leadership'])) return profile.piq1;
  if (has(label, ['type of activity', 'activity type', 'category of activity'])) return activityTypeValue(profile, field, index);
  if (has(label, ['activity', 'extracurricular', 'award', 'honor', 'experience', 'work experience'])) return activityValue(profile, label, index);
  if (has(label, ['hours per week', 'hour week'])) return profile.activities?.[0]?.hoursPerWeek;
  if (has(label, ['years', 'grade levels', 'participation'])) return profile.activities?.[0]?.years;
  if (has(label, ['household', 'background', 'family context'])) return profile.backgroundContext;
  if (has(label, ['residency', 'resident'])) return profile.backgroundContext && /california/i.test(profile.backgroundContext) ? 'California resident' : '';
  return '';
}

function academicHistoryFieldValue(profile, field, label) {
  if (!isAcademicHistoryContext(label)) return '';

  if (has(label, ['where did you attend high school', 'attend high school', 'high school located'])) {
    return bestOptionOrText(field, inferHighSchoolLocation(profile));
  }

  if (has(label, ['in california'])) {
    return inferHighSchoolLocation(profile) === 'In California' ? 'true' : '';
  }

  if (has(label, ['outside california', 'outside california in the u s', 'outside the u s'])) {
    return 'false';
  }

  if (has(label, ['home school', 'homeschool'])) {
    return /home\s*school|homeschool/i.test(profile.academicHistory || profile.highSchool || '') ? 'true' : '';
  }

  if (has(label, ['independent study'])) {
    return /independent study/i.test(profile.academicHistory || profile.highSchool || '') ? 'true' : '';
  }

  if (has(label, ['search criteria', 'search for high school', 'school name city or school code', 'enter your school'])) {
    return highSchoolSearchCriteria(profile);
  }

  return '';
}

function isAcademicHistoryContext(label) {
  return has(label, [
    'academic history',
    'find high school',
    'where did you attend high school',
    'search for high school',
    'search criteria',
    'specialized curriculum',
    'home school',
    'independent study',
  ]);
}

function inferHighSchoolLocation(profile) {
  const text = `${profile.highSchool || ''} ${profile.academicHistory || ''} ${profile.backgroundContext || ''}`;
  if (/outside california|out of state|outside ca/i.test(text)) return 'Outside California (in the U.S.)';
  if (/outside the u\.?s\.?|international|foreign/i.test(text)) return 'Outside the U.S.';
  return 'In California';
}

function highSchoolSearchCriteria(profile) {
  return profile.highSchool || extractHighSchoolFromAcademicHistory(profile.academicHistory) || '';
}

function extractHighSchoolFromAcademicHistory(value = '') {
  const match = String(value).match(/High school:\s*(.+)/i);
  return match?.[1]?.trim() || '';
}

function ucActivityFieldValue(profile, field, label, index) {
  const activity = profile.activities?.[Math.min(index, profile.activities.length - 1)] || profile.activities?.[0];
  if (!activity) return '';

  if (has(label, ['type of activity', 'activity type', 'category of activity', 'category'])) {
    return activityTypeValue(profile, field, index);
  }

  if (has(label, ['name of the organization', 'organization program school or group', 'organization you volunteered for'])) {
    return activityOrganizationName(activity);
  }

  if (has(label, ['please describe the organization', 'describe the organization', 'reason the organization exists', 'how does it help'])) {
    return truncateText(activityOrganizationDescription(activity), 250);
  }

  if (has(label, ['what did you do', 'what you accomplished', 'leadership role', 'mentor to others'])) {
    return truncateText(activityImpactDescription(activity), 350);
  }

  if (has(label, ['hours spent per week', 'hours per week', 'hour week'])) {
    return activity.hoursPerWeek || '';
  }

  if (has(label, ['weeks spent per year', 'weeks per year'])) {
    return activity.weeksPerYear || inferWeeksPerYear(activity);
  }

  if (has(label, ['when did you volunteer', 'when did you participate', 'grade levels', 'participation'])) {
    return activityGradeLevelText(activity);
  }

  if (has(label, ['9th grade', '10th grade', '11th grade', '12th grade', 'after 12th grade'])) {
    return shouldCheckActivityGrade(label, activity) ? 'true' : '';
  }

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

function activityOrganizationName(activity) {
  return activity.organization || String(activity.name || 'Community Health Outreach').replace(/\s+(lead|leader|captain|assistant|coordinator|member|volunteer)$/i, '').trim();
}

function activityOrganizationDescription(activity) {
  const name = activityOrganizationName(activity);
  const text = normalize([activity.name, activity.role, activity.description].filter(Boolean).join(' '));
  if (/health|clinic|pharmacy|outreach|volunteer|community/.test(text)) {
    return `${name} supports community health education, outreach, and access to basic wellness resources for local families.`;
  }
  if (/research|data|science|academic|biology/.test(text)) {
    return `${name} gives students a way to explore academic research, data, and community problem solving.`;
  }
  return `${name} gives students a structured way to contribute, learn, and support a community or school group.`;
}

function activityImpactDescription(activity) {
  const pieces = [
    activity.description,
    activity.role ? `Served as ${activity.role}.` : '',
  ].filter(Boolean);
  return pieces.join(' ').trim() || `${activity.name || 'Activity'} helped me practice responsibility, communication, and leadership.`;
}

function activityGradeLevelText(activity) {
  const years = Number.parseInt(activity.years, 10);
  if (years >= 4) return '9th grade, 10th grade, 11th grade, 12th grade';
  if (years === 3) return '10th grade, 11th grade, 12th grade';
  if (years === 2) return '11th grade, 12th grade';
  if (years === 1) return '12th grade';
  return '11th grade, 12th grade';
}

function shouldCheckActivityGrade(label, activity) {
  const grades = normalize(activityGradeLevelText(activity));
  return grades.includes(normalize(label).replace(/\bgrade\b/g, '').trim()) || grades.includes(normalize(label));
}

function inferWeeksPerYear(activity) {
  const text = normalize([activity.name, activity.role, activity.description].filter(Boolean).join(' '));
  if (/summer/.test(text)) return '8';
  if (/weekend|weekly|club|volunteer|community|outreach/.test(text)) return '36';
  if (/project|research/.test(text)) return '16';
  return '20';
}

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '.';
}

function activityTypeValue(profile, field, index) {
  const activity = profile.activities?.[Math.min(index, profile.activities.length - 1)] || profile.activities?.[0];
  const text = normalize([activity?.name, activity?.role, activity?.description].filter(Boolean).join(' '));
  const type = inferActivityType(text);
  return bestOptionOrText(field, type);
}

function inferActivityType(text) {
  if (/work|job|assistant|intern|employee|pharmacy|paid/.test(text)) return 'Work experience';
  if (/award|honor|recognition|competition|olympiad/.test(text)) return 'Award or honor';
  if (/volunteer|community|service|outreach|clinic/.test(text)) return 'Community service';
  if (/course|class|academic|research|project|science|biology|data/.test(text)) return 'Educational preparation program';
  return 'Extracurricular activity';
}

function bestOptionOrText(field, value) {
  if (!field.options?.length) return value;
  const normalized = normalize(value);
  const option = field.options.find((candidate) => (
    normalize(candidate.label).includes(normalized) ||
    normalize(candidate.value).includes(normalized) ||
    normalized.includes(normalize(candidate.label)) ||
    optionAliasMatches(normalized, normalize(candidate.label)) ||
    optionAliasMatches(normalized, normalize(candidate.value))
  ));
  return option?.value || option?.label || value;
}

function optionMatches(field, value) {
  if (value === null || value === undefined || value === '') return false;
  const normalized = normalize(value);
  return field.options.some((candidate) => (
    normalize(candidate.label).includes(normalized) ||
    normalize(candidate.value).includes(normalized) ||
    normalized.includes(normalize(candidate.label)) ||
    optionAliasMatches(normalized, normalize(candidate.label)) ||
    optionAliasMatches(normalized, normalize(candidate.value))
  ));
}

function optionAliasMatches(value, option) {
  const aliases = {
    'community service': ['volunteer', 'community service', 'service'],
    'extracurricular activity': ['extracurricular', 'club', 'leadership'],
    'educational preparation program': ['education', 'academic', 'research', 'course'],
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

function middleName(fullName = '') {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 2 ? parts.slice(1, -1).join(' ') : '';
}
