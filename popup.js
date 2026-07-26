const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const CAMPUSES = [
  'UC Berkeley',
  'UCLA',
  'UC San Diego',
  'UC Irvine',
  'UC Davis',
  'UC Santa Barbara',
  'UC Santa Cruz',
  'UC Riverside',
  'UC Merced',
];

const SCHOOL_RECOMMENDATIONS = [
  ['UC Berkeley', 'Reach', ['computer science', 'data science', 'engineering', 'public health', 'business', 'economics', 'biology'], 'Top research option for STEM, policy, public health, and social sciences.'],
  ['UCLA', 'Reach', ['biology', 'pre med', 'public health', 'psychology', 'data science', 'engineering', 'film'], 'Strong fit for health, life sciences, media, research, and interdisciplinary majors.'],
  ['UC San Diego', 'Target/Reach', ['biology', 'bioengineering', 'computer science', 'data science', 'public health', 'cognitive science'], 'Excellent for STEM, health, research, and data-heavy interests.'],
  ['UC Irvine', 'Target', ['computer science', 'public health', 'biology', 'business', 'psychology', 'engineering'], 'Balanced UC option for health, tech, business, and applied research.'],
  ['UC Davis', 'Target', ['biology', 'pre med', 'public health', 'environmental science', 'animal science', 'engineering'], 'Strong for life sciences, health, sustainability, and community research.'],
  ['UC Santa Barbara', 'Target', ['physics', 'engineering', 'data science', 'economics', 'environmental science', 'biology'], 'Strong research campus for physical sciences, engineering, and environment.'],
  ['UC Santa Cruz', 'Likely/Target', ['computer science', 'game design', 'biology', 'environmental science', 'psychology', 'film'], 'Good for CS, creative technology, environmental work, and interdisciplinary students.'],
  ['UC Riverside', 'Likely/Target', ['biology', 'pre med', 'business', 'engineering', 'psychology', 'public policy'], 'Access-focused UC with good health, business, policy, and engineering options.'],
  ['UC Merced', 'Likely', ['engineering', 'computer science', 'biology', 'public health', 'environmental science', 'psychology'], 'Growing UC campus with strong undergraduate access and STEM opportunities.'],
  ['Cal Poly San Luis Obispo', 'Reach/Target', ['engineering', 'computer science', 'architecture', 'business', 'biology'], 'Hands-on project-based option outside the UC system.'],
  ['San Diego State University', 'Target/Likely', ['public health', 'business', 'psychology', 'biology', 'communications', 'data science'], 'Strong CSU option for applied majors, health, business, and internships.'],
  ['Santa Clara University', 'Target/Reach', ['computer science', 'engineering', 'business', 'data science', 'biology'], 'Private option with strong Silicon Valley connections.'],
].map(([name, type, strengths, note]) => ({ name, type, strengths, note }));

const SAMPLE_RESUME = `Maya Patel
maya.patel@email.com
(555) 123-4567
Mission Bay High School
GPA: 3.92
Intended Major: Public Health and Data Science

Community Health Outreach Lead | Volunteer Coordinator | 6 | 2
Organized 14 weekend clinics, coordinated 32 volunteers, and translated intake forms for families.

Pharmacy Assistant | Assistant | 8 | 1
Managed inventory logs and helped Spanish-speaking customers understand basic prescription pickup steps.

AP Biology Research Project | Student Researcher | 5 | 1
Built a neighborhood asthma data dashboard and presented findings to city youth council.

Leadership PIQ Draft:
Leading community health outreach taught me that leadership is not only assigning tasks. It is noticing who has not been heard and building systems where people can contribute.`;

let state = {
  profile: emptyProfile(),
  apiKey: '',
  lastSection: null,
  lastValues: null,
  lastMappingMeta: null,
};

function emptyProfile() {
  return {
    fullName: '',
    email: '',
    phone: '',
    highSchool: '',
    gpa: '',
    major: '',
    backgroundContext: '',
    transcriptRaw: '',
    academicHistory: '',
    courses: [],
    activitiesRaw: '',
    activities: [],
    campuses: [],
    piq1: '',
    schoolRecommendations: [],
  };
}

function setStatus(message, tone = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${tone}`;
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.hidden = panel.id !== `${tabName}Panel`;
  });
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function renderCampuses() {
  $('campusGrid').innerHTML = CAMPUSES.map((campus) => {
    const selected = state.profile.campuses.includes(campus);
    return `<button type="button" class="campus ${selected ? 'selected' : ''}" data-campus="${campus}">${selected ? 'Selected: ' : ''}${campus}</button>`;
  }).join('');

  document.querySelectorAll('.campus').forEach((button) => {
    button.addEventListener('click', () => {
      const campus = button.dataset.campus;
      state.profile.campuses = state.profile.campuses.includes(campus)
        ? state.profile.campuses.filter((item) => item !== campus)
        : [...state.profile.campuses, campus];
      renderCampuses();
      renderReadiness();
      saveProfile(false);
    });
  });
}

function syncInputsFromState() {
  const profile = state.profile;
  $('resumeText').value = profile.activitiesRaw || '';
  $('fullName').value = profile.fullName || '';
  $('email').value = profile.email || '';
  $('phone').value = profile.phone || '';
  $('highSchool').value = profile.highSchool || '';
  $('gpa').value = profile.gpa || '';
  $('major').value = profile.major || '';
  $('transcriptText').value = profile.transcriptRaw || '';
  $('academicHistory').value = profile.academicHistory || '';
  $('backgroundContext').value = profile.backgroundContext || '';
  $('piq1').value = profile.piq1 || '';
  $('apiKey').value = state.apiKey || '';
  renderActivities();
  renderCourses();
  renderProfileSummary();
  renderRecommendations();
  renderModelStatus();
  renderReadiness();
}

function collectProfileFromInputs() {
  state.profile = {
    ...state.profile,
    activitiesRaw: $('resumeText').value.trim(),
    fullName: $('fullName').value.trim(),
    email: $('email').value.trim(),
    phone: $('phone').value.trim(),
    highSchool: $('highSchool').value.trim(),
    gpa: $('gpa').value.trim(),
    major: $('major').value.trim(),
    transcriptRaw: $('transcriptText').value.trim(),
    academicHistory: $('academicHistory').value.trim(),
    backgroundContext: $('backgroundContext').value.trim(),
    piq1: $('piq1').value.trim(),
  };
  state.apiKey = $('apiKey').value.trim();
  renderProfileSummary();
  renderReadiness();
}

function renderReadiness() {
  const checks = [
    Boolean(state.profile.activitiesRaw),
    Boolean(state.profile.fullName),
    Boolean(state.profile.email || state.profile.phone),
    Boolean(state.profile.highSchool),
    Boolean(state.profile.gpa),
    Boolean(state.profile.major),
    Boolean(state.profile.academicHistory || state.profile.courses.length),
    state.profile.activities.length > 0,
    state.profile.campuses.length > 0,
    Boolean(state.profile.piq1),
  ];
  const percent = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  $('readinessText').textContent = `${percent}%`;
  $('readinessFill').style.width = `${percent}%`;
}

function renderProfileSummary() {
  const items = [
    ['Name', state.profile.fullName],
    ['Contact', state.profile.email || state.profile.phone],
    ['School', state.profile.highSchool],
    ['GPA', state.profile.gpa],
    ['Major / interests', state.profile.major],
    ['Courses', state.profile.courses.length ? `${state.profile.courses.length} found` : 'Missing'],
    ['Campuses', state.profile.campuses.join(', ')],
  ];

  $('profileSummary').innerHTML = items.map(([label, value]) => `
    <div class="mini-card">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value || 'Missing')}</span>
    </div>
  `).join('');
}

function renderCourses() {
  const list = $('courseList');
  if (!list) return;

  if (!state.profile.courses.length) {
    list.innerHTML = '<div class="item"><strong>No transcript courses yet</strong><span>Import a transcript to populate academic history.</span></div>';
    return;
  }

  list.innerHTML = state.profile.courses.slice(0, 10).map((course) => `
    <div class="item">
      <strong>${escapeHtml(course.name)}</strong>
      <span>${escapeHtml([course.grade, course.term].filter(Boolean).join(' | ') || 'Grade not found')}</span>
    </div>
  `).join('');
}

function renderRecommendations() {
  const list = $('recommendationList');
  if (!list) return;

  if (!state.profile.schoolRecommendations?.length) {
    list.innerHTML = '<div class="item"><strong>No recommendations yet</strong><span>Import resume/transcript, confirm major / interests, then click Recommend schools.</span></div>';
    return;
  }

  list.innerHTML = state.profile.schoolRecommendations.map((school) => `
    <div class="item">
      <strong>${escapeHtml(school.name)} <span class="pill">${escapeHtml(school.type)}</span></strong>
      <span>${escapeHtml(school.matchReason)}</span>
      <p>${escapeHtml(school.note)}</p>
    </div>
  `).join('');
}

function recommendSchoolsFromMajor() {
  collectProfileFromInputs();
  const interestText = normalizeInterestText([
    state.profile.major,
    state.profile.academicHistory,
    state.profile.activitiesRaw,
    state.profile.piq1,
  ].filter(Boolean).join(' '));

  if (!interestText) {
    setStatus('Add or import major / interests first.', 'warn');
    switchTab('review');
    return;
  }

  const scored = SCHOOL_RECOMMENDATIONS.map((school) => {
    const matches = school.strengths.filter((strength) => interestText.includes(normalizeInterestText(strength)) || broadInterestMatch(interestText, strength));
    return {
      ...school,
      score: matches.length,
      matchReason: matches.length ? `Matches: ${matches.slice(0, 3).join(', ')}` : 'General California application option',
    };
  })
    .filter((school) => school.score > 0 || /undecided|general|explor/.test(interestText))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  state.profile.schoolRecommendations = scored.length ? scored : SCHOOL_RECOMMENDATIONS.slice(0, 6).map((school) => ({
    ...school,
    matchReason: 'Broad option based on general interests',
  }));

  const recommendedUcCampuses = state.profile.schoolRecommendations
    .map((school) => school.name)
    .filter((name) => name.startsWith('UC '));
  state.profile.campuses = Array.from(new Set([...state.profile.campuses, ...recommendedUcCampuses]));

  renderCampuses();
  renderRecommendations();
  renderProfileSummary();
  renderReadiness();
  saveProfile(false);
  setStatus(`Recommended ${state.profile.schoolRecommendations.length} schools from major / interests.`, 'good');
}

function renderActivities() {
  const list = $('activityList');
  if (!state.profile.activities.length) {
    list.innerHTML = '<div class="item"><strong>No activities extracted yet</strong><span>Import resume text to populate activities.</span></div>';
    return;
  }

  list.innerHTML = state.profile.activities.slice(0, 8).map((activity) => `
    <div class="item">
      <strong>${escapeHtml(activity.name || activity.role || 'Activity')}</strong>
      <span>${escapeHtml([activity.role, activity.organization].filter(Boolean).join(' at '))}</span>
      <p>${escapeHtml(activity.description || `${activity.hoursPerWeek || '?'} hr/wk, ${activity.years || '?'} years`)}</p>
    </div>
  `).join('');
}

function saveProfile(showMessage = true) {
  collectProfileFromInputs();
  chrome.storage.local.set({ profile: state.profile, apiKey: state.apiKey }, () => {
    $('savedPill').textContent = 'Saved';
    if (showMessage) setStatus('Profile saved locally.', 'good');
  });
}

function importResumeText() {
  const text = $('resumeText').value.trim();
  if (!text) {
    setStatus('Paste or upload resume text first.', 'warn');
    return;
  }

  const parsed = parseResume(text);
  state.profile = {
    ...state.profile,
    ...removeEmpty(parsed),
    activitiesRaw: text,
    activities: parsed.activities.length ? parsed.activities : state.profile.activities,
  };

  syncInputsFromState();
  saveProfile(false);
  switchTab('review');
  setStatus(`Imported resume. Found ${state.profile.activities.length} activities.`, 'good');
}

function importTranscriptText() {
  const text = $('transcriptText').value.trim();
  if (!text) {
    setStatus('Paste or upload transcript text first.', 'warn');
    return;
  }

  const parsed = parseTranscript(text);
  state.profile = {
    ...state.profile,
    ...removeEmpty(parsed),
    transcriptRaw: text,
    courses: parsed.courses.length ? parsed.courses : state.profile.courses,
  };

  syncInputsFromState();
  saveProfile(false);
  switchTab('review');
  setStatus(`Imported transcript. Found ${state.profile.courses.length} possible courses.`, 'good');
}

function parseTranscript(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const gpa = text.match(/\b(?:Cumulative\s+)?GPA[:\s]*([0-4]\.\d{1,3})(?:\s*\/\s*4\.0)?\b/i)?.[1] || '';
  const highSchool = lines.find((line) => /high school|academy|preparatory|secondary|school name/i.test(line)) || '';
  const courses = parseCourses(lines);
  const academicHistory = buildAcademicHistory(gpa, highSchool, courses);

  return {
    gpa,
    highSchool: cleanSchoolName(highSchool),
    academicHistory,
    courses,
  };
}

function parseCourses(lines) {
  return lines
    .map((line) => {
      const cleaned = line.replace(/\s+/g, ' ').trim();
      const gradeMatch = cleaned.match(/\b(A\+?|A-|B\+?|B-|C\+?|C-|D\+?|D-|F|P|Pass|CR)\b/i);
      const courseLike = /(AP |IB |Honors|English|Math|Algebra|Geometry|Calculus|Biology|Chemistry|Physics|History|Government|Economics|Spanish|French|Computer Science|Data Science|Art|Music|Health|Science)/i.test(cleaned);
      if (!courseLike || !gradeMatch) return null;
      return {
        name: cleaned.replace(/\b(A\+?|A-|B\+?|B-|C\+?|C-|D\+?|D-|F|P|Pass|CR)\b.*$/i, '').replace(/[:|-]\s*$/, '').trim(),
        grade: gradeMatch[0].toUpperCase(),
        term: inferTerm(cleaned),
      };
    })
    .filter((course) => course && course.name.length > 2)
    .slice(0, 40);
}

function inferTerm(line) {
  const match = line.match(/\b(9th|10th|11th|12th|Freshman|Sophomore|Junior|Senior|Fall|Spring|Summer|Winter|20\d{2})\b/i);
  return match ? match[0] : '';
}

function cleanSchoolName(line = '') {
  return line.replace(/^(school name|school|institution)[:\s-]*/i, '').trim();
}

function buildAcademicHistory(gpa, highSchool, courses) {
  const parts = [];
  if (highSchool) parts.push(`High school: ${cleanSchoolName(highSchool)}`);
  if (gpa) parts.push(`Cumulative GPA: ${gpa}`);
  if (courses.length) {
    parts.push(`Transcript courses found: ${courses.slice(0, 12).map((course) => `${course.name} (${course.grade})`).join(', ')}`);
  }
  return parts.join('\n');
}

function parseResume(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phone = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0] || '';
  const gpa = text.match(/\b(?:GPA[:\s]*)?([0-4]\.\d{1,2})(?:\s*\/\s*4\.0)?\b/i)?.[1] || '';
  const highSchool = lines.find((line) => /high school|academy|preparatory|secondary/i.test(line)) || '';
  const majorLine = lines.find((line) => /major|interest|intended|field|concentration|career goal|academic focus/i.test(line)) || '';
  const name = inferName(lines, email, phone);
  const activities = parseActivities(lines);
  const piqCandidate = inferPiq(text, lines);

  return {
    fullName: name,
    email,
    phone,
    gpa,
    highSchool,
    major: cleanLabelValue(majorLine),
    piq1: state.profile.piq1 || piqCandidate,
    activities,
  };
}

function inferName(lines, email, phone) {
  const skipped = new Set([email, phone].filter(Boolean));
  const candidate = lines.find((line) => {
    if (skipped.has(line)) return false;
    if (/@|\d|gpa|major|school|resume|curriculum|linkedin/i.test(line)) return false;
    const words = line.split(/\s+/);
    return words.length >= 2 && words.length <= 4;
  });
  return candidate || '';
}

function inferPiq(text, lines) {
  const marker = text.match(/(?:PIQ|Personal Insight|Leadership PIQ|Essay Draft)[:\s]+([\s\S]+)/i);
  if (marker?.[1]) return marker[1].trim().slice(0, 1800);
  return lines.filter((line) => line.split(/\s+/).length > 18).slice(-3).join(' ');
}

function parseActivities(lines) {
  const pipeActivities = lines
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [name, role, hoursPerWeek, years, description] = line.split('|').map((part) => part.trim());
      return {
        name,
        role,
        hoursPerWeek,
        years,
        weeksPerYear: inferWeeksPerYearFromActivity(name, role, description),
        organization: inferOrganizationName(name),
        description,
      };
    });
  if (pipeActivities.length) return pipeActivities;

  return lines
    .filter((line) => /club|captain|volunteer|research|intern|assistant|leader|founder|award|olympiad|robotics|tutor|project|work|job/i.test(line))
    .slice(0, 10)
    .map((line, index) => ({
      name: line.split(/[-:]/)[0].trim() || `Activity ${index + 1}`,
      role: inferRole(line),
      hoursPerWeek: '',
      years: '',
      weeksPerYear: inferWeeksPerYearFromActivity(line, '', ''),
      organization: inferOrganizationName(line),
      description: line,
    }));
}

function inferOrganizationName(name = '') {
  return String(name)
    .replace(/\s+(lead|leader|captain|assistant|coordinator|member|volunteer|researcher|intern|founder)$/i, '')
    .trim();
}

function inferWeeksPerYearFromActivity(name = '', role = '', description = '') {
  const text = `${name} ${role} ${description}`.toLowerCase();
  if (/summer/.test(text)) return '8';
  if (/project|research/.test(text)) return '16';
  if (/weekend|weekly|club|volunteer|community|outreach/.test(text)) return '36';
  return '20';
}

function inferRole(line) {
  const match = line.match(/\b(captain|president|founder|lead|leader|assistant|intern|researcher|volunteer|member|tutor|coordinator)\b/i);
  return match ? match[0] : '';
}

function cleanLabelValue(line = '') {
  return line
    .replace(/^(major|intended major|major of interest|majors of interest|interests?|academic interests?|field|concentration|career goal|academic focus)[:\s-]*/i, '')
    .trim();
}

function normalizeInterestText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function broadInterestMatch(interests, strength) {
  const normalizedStrength = normalizeInterestText(strength);
  const groups = [
    ['pre med', 'medicine', 'health', 'public health', 'biology', 'bioengineering'],
    ['computer science', 'cs', 'coding', 'software', 'ai', 'artificial intelligence', 'data science'],
    ['business', 'economics', 'finance', 'entrepreneurship', 'marketing'],
    ['engineering', 'mechanical', 'electrical', 'civil', 'robotics'],
    ['environmental science', 'sustainability', 'climate', 'ecology'],
    ['psychology', 'cognitive science', 'neuroscience'],
    ['film', 'media', 'communications', 'design', 'game design'],
  ];

  return groups.some((group) => (
    group.includes(normalizedStrength) && group.some((term) => interests.includes(term))
  ));
}

function removeEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  }));
}

async function getActiveUcTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || !tab.url.includes('apply.universityofcalifornia.edu')) {
    throw new Error('Open the UC application tab first.');
  }
  return tab;
}

async function scanVisibleFields() {
  const tab = await getActiveUcTab();
  const sectionInfo = await sendTabMessageWithInjection(tab.id, { type: 'GET_VISIBLE_SECTION' });
  if (!sectionInfo || !Array.isArray(sectionInfo.fields)) {
    throw new Error('Could not read UC fields. Refresh the UC page and try again.');
  }
  state.lastSection = sectionInfo;
  setStatus(`Scanned ${sectionInfo.fields.length} visible UC fields.`, 'good');
  return sectionInfo;
}

async function previewMappedValues() {
  saveProfile(false);
  const sectionInfo = state.lastSection || await scanVisibleFields();
  const mapping = await getMappedValues(sectionInfo);
  state.lastValues = mapping.values;
  state.lastMappingMeta = mapping;
  renderPreview(mapping.values, sectionInfo.fields);
  renderModelStatus(mapping);
  switchTab('fill');
  setStatus(`Previewed ${Object.keys(mapping.values).length} mapped fields with ${formatMappingSource(mapping)}.`, 'good');
}

async function fillCurrentSection() {
  saveProfile(false);
  const sectionInfo = state.lastSection || await scanVisibleFields();
  const mapping = state.lastValues
    ? { values: state.lastValues, ...(state.lastMappingMeta || {}) }
    : await getMappedValues(sectionInfo);
  const values = mapping.values || {};
  const safeValues = filterSensitiveValues(values, sectionInfo);
  const tab = await getActiveUcTab();
  const result = await sendTabMessageWithInjection(tab.id, { type: 'APPLY_VALUES', values: safeValues });
  renderPreview(safeValues, sectionInfo.fields);
  renderModelStatus(mapping);
  const filledCount = result?.filled?.length || 0;
  const skippedCount = result?.skipped?.length || 0;
  const skippedDetail = formatSkippedDetail(result?.skipped);
  const tone = filledCount ? 'good' : 'warn';
  setStatus(`Filled ${filledCount} fields, skipped ${skippedCount}, using ${formatMappingSource(mapping)}.${skippedDetail}`, tone);
}

async function getMappedValues(sectionInfo) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'FILL_SECTION', sectionInfo }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve({
        values: response.values || {},
        source: response.source || 'unknown',
        model: response.model || null,
        warning: response.warning || '',
      });
    });
  });
}

function renderModelStatus(mapping = state.lastMappingMeta) {
  const el = $('modelStatus');
  if (!el) return;

  if (!mapping) {
    el.innerHTML = '<strong>Mapper</strong>Add a Google AI Studio API key to use Gemma 4, or preview with the built-in demo mapper.';
    return;
  }

  const label = formatMappingSource(mapping);
  const warning = mapping.warning ? `<br>${escapeHtml(mapping.warning)}` : '';
  el.innerHTML = `<strong>Mapper</strong>${escapeHtml(label)}${warning}`;
}

function formatMappingSource(mapping = {}) {
  if (mapping.source === 'gemma') return `Gemma 4 (${mapping.model || 'gemma-4-31b-it'})`;
  if (mapping.source === 'local-fallback') return `built-in demo mapper after Gemma 4 error`;
  if (mapping.source === 'demo' || mapping.source === 'local') return 'built-in demo mapper';
  return mapping.model ? `Gemma 4 (${mapping.model})` : 'built-in demo mapper';
}

function formatSkippedDetail(skipped = []) {
  if (!skipped.length) return '';
  const first = skipped[0];
  return ` First skipped: ${first.id || 'unknown'} (${first.reason || 'unknown reason'}).`;
}

function filterSensitiveValues(values, sectionInfo) {
  if ($('approveSensitive').checked) return values;
  const sensitiveIds = new Set(
    sectionInfo.fields
      .filter((field) => /household|parent|guardian|income|citizen|residen|ethnic|race|background|family/i.test(field.label || field.id))
      .map((field) => field.id)
  );
  return Object.fromEntries(Object.entries(values).filter(([id]) => !sensitiveIds.has(id)));
}

function renderPreview(values, fields = state.lastSection?.fields || []) {
  const entries = Object.entries(values);
  if (!entries.length) {
    $('previewList').innerHTML = '<div class="item"><strong>No matched fields</strong><span>Scan a UC page and preview again.</span></div>';
    return;
  }
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  $('previewList').innerHTML = entries.map(([id, value]) => `
    <div class="item">
      <strong>${escapeHtml(id)}</strong>
      <span>${escapeHtml(fieldsById.get(id)?.label || 'No label found')}</span>
      <p>${escapeHtml(value === null || value === undefined ? 'Skipped' : String(value))}</p>
    </div>
  `).join('');
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function sendTabMessageWithInjection(tabId, message) {
  try {
    return await sendTabMessage(tabId, message);
  } catch (err) {
    if (!isMissingContentScriptError(err)) throw err;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  return sendTabMessage(tabId, message);
}

function isMissingContentScriptError(err) {
  return /receiving end does not exist|could not establish connection/i.test(err.message || String(err));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function bindInputs() {
  ['resumeText', 'transcriptText', 'fullName', 'email', 'phone', 'highSchool', 'gpa', 'major', 'academicHistory', 'backgroundContext', 'piq1', 'apiKey'].forEach((id) => {
    $(id).addEventListener('input', () => {
      collectProfileFromInputs();
      $('savedPill').textContent = 'Draft';
    });
  });
}

function bindActions() {
  $('resumeFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadFileIntoTextarea(file, 'resumeText', 'resume');
  });

  $('transcriptFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadFileIntoTextarea(file, 'transcriptText', 'transcript');
  });

  $('parseResumeBtn').addEventListener('click', importResumeText);
  $('parseTranscriptBtn').addEventListener('click', importTranscriptText);
  $('recommendBtn').addEventListener('click', recommendSchoolsFromMajor);
  $('loadSampleBtn').addEventListener('click', () => {
    $('resumeText').value = SAMPLE_RESUME;
    setStatus('Sample resume loaded. Click Import resume.', 'good');
  });
  $('saveBtn').addEventListener('click', () => saveProfile(true));
  $('saveUcBtn').addEventListener('click', () => saveProfile(true));
  $('scanBtn').addEventListener('click', () => {
    scanVisibleFields().catch((err) => setStatus(err.message, 'bad'));
  });
  $('previewBtn').addEventListener('click', () => {
    setStatus('Mapping values...');
    previewMappedValues().catch((err) => setStatus(err.message, 'bad'));
  });
  $('fillBtn').addEventListener('click', () => {
    setStatus('Filling current UC page...');
    fillCurrentSection().catch((err) => setStatus(err.message, 'bad'));
  });
}

async function loadFileIntoTextarea(file, textareaId, label) {
  setStatus(`Reading ${file.name}...`);
  try {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const buffer = await file.arrayBuffer();
      $(textareaId).value = await extractPdfText(buffer);
    } else {
      $(textareaId).value = await file.text();
    }

    if (!$(textareaId).value.trim()) {
      setStatus(`Loaded ${file.name}, but no text was found. If this is a scanned PDF, paste the ${label} text instead.`, 'warn');
      return;
    }

    setStatus(`Loaded ${file.name}. Click Import ${label}.`, 'good');
  } catch (err) {
    setStatus(`Could not read ${file.name}. Paste the ${label} text instead.`, 'bad');
  }
}

chrome.storage.local.get(['profile', 'apiKey'], ({ profile, apiKey }) => {
  state.profile = { ...emptyProfile(), ...(profile || {}) };
  state.apiKey = apiKey || '';
  bindTabs();
  bindInputs();
  bindActions();
  renderCampuses();
  syncInputsFromState();
  setStatus('Ready. Import a resume to start.', 'good');
});

async function extractPdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const latin = new TextDecoder('latin1').decode(bytes);
  const pieces = [];

  pieces.push(...extractPdfStrings(latin));

  if ('DecompressionStream' in self) {
    const streams = latin.match(/stream\r?\n[\s\S]*?\r?\nendstream/g) || [];
    for (const streamBlock of streams.slice(0, 80)) {
      const raw = streamBlock
        .replace(/^stream\r?\n/, '')
        .replace(/\r?\nendstream$/, '');
      try {
        const decompressed = await inflateBytes(latin1ToBytes(raw));
        pieces.push(...extractPdfStrings(new TextDecoder('latin1').decode(decompressed)));
      } catch {
        // Some PDF streams are images or use filters this lightweight reader does not support.
      }
    }
  }

  return cleanupPdfText(pieces.join('\n'));
}

function extractPdfStrings(text) {
  const output = [];

  for (const match of text.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)) {
    const value = decodePdfLiteral(match[0].slice(1, -1));
    if (looksLikeText(value)) output.push(value);
  }

  for (const match of text.matchAll(/<([0-9A-Fa-f]{8,})>/g)) {
    const value = decodePdfHex(match[1]);
    if (looksLikeText(value)) output.push(value);
  }

  return output;
}

function decodePdfLiteral(value) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function decodePdfHex(hex) {
  const bytes = [];
  for (let index = 0; index < hex.length - 1; index += 2) {
    bytes.push(parseInt(hex.slice(index, index + 2), 16));
  }

  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const chars = [];
    for (let index = 2; index < bytes.length - 1; index += 2) {
      chars.push(String.fromCharCode((bytes[index] << 8) + bytes[index + 1]));
    }
    return chars.join('');
  }

  return new TextDecoder('latin1').decode(new Uint8Array(bytes));
}

function latin1ToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 255;
  }
  return bytes;
}

async function inflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const chunks = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

function looksLikeText(value) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) return false;
  if (!/[A-Za-z]/.test(cleaned)) return false;
  return !/^[A-Z]{1,2}$/.test(cleaned);
}

function cleanupPdfText(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
