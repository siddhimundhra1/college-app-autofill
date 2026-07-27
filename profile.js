// Config-driven list of "structured" identity fields — the stuff that's
// genuinely fixed-shape and reused verbatim across every page of the
// application. To add a new common field, just add an entry here; the form
// and the save/load logic pick it up automatically, no other code changes.
const IDENTITY_FIELDS = [
  // Personal
  { key: 'legalFirstName', label: 'Legal first name', group: 'Personal' },
  { key: 'legalMiddleName', label: 'Legal middle name', group: 'Personal' },
  { key: 'legalLastName', label: 'Legal last name', group: 'Personal' },
  { key: 'preferredName', label: 'Preferred name / nickname', group: 'Personal' },
  { key: 'dob', label: 'Date of birth', type: 'date', group: 'Personal' },
  { key: 'gender', label: 'Gender', group: 'Personal' },
  { key: 'citizenship', label: 'Citizenship / residency status', group: 'Personal' },

  // Contact
  { key: 'email', label: 'Email', type: 'email', group: 'Contact' },
  { key: 'phone', label: 'Phone', type: 'tel', group: 'Contact' },
  { key: 'streetAddress', label: 'Street address', group: 'Contact' },
  { key: 'city', label: 'City', group: 'Contact' },
  { key: 'state', label: 'State / province', group: 'Contact' },
  { key: 'zip', label: 'ZIP / postal code', group: 'Contact' },
  { key: 'country', label: 'Country', group: 'Contact' },

  // Academic
  { key: 'highSchool', label: 'High school name', group: 'Academic' },
  { key: 'highSchoolCityState', label: 'High school city/state', group: 'Academic' },
  { key: 'gradYear', label: 'Graduation year', group: 'Academic' },
  { key: 'gpaUnweighted', label: 'GPA (unweighted)', group: 'Academic' },
  { key: 'gpaWeighted', label: 'GPA (weighted)', group: 'Academic' },
  { key: 'classRank', label: 'Class rank', group: 'Academic' },
  { key: 'satScore', label: 'SAT score', group: 'Academic' },
  { key: 'actScore', label: 'ACT score', group: 'Academic' },
  { key: 'intendedMajor', label: 'Intended major(s)', group: 'Academic' },

  // School contact
  { key: 'counselorName', label: "Counselor's name", group: 'School Contact' },
  { key: 'counselorEmail', label: "Counselor's email", group: 'School Contact' },

  // Family
  { key: 'parentGuardianName', label: 'Parent/guardian name', group: 'Family' },
  { key: 'parentGuardianEducation', label: "Parent/guardian's highest level of education", group: 'Family' },
];

function buildForm() {
  const groups = {};
  IDENTITY_FIELDS.forEach((f) => {
    (groups[f.group] = groups[f.group] || []).push(f);
  });

  const container = document.getElementById('identityFields');
  container.innerHTML = Object.entries(groups)
    .map(
      ([groupName, fields]) => `
        <fieldset>
          <legend>${groupName}</legend>
          <div class="field-grid">
            ${fields
              .map(
                (f) => `
                  <div>
                    <label for="id_${f.key}">${f.label}</label>
                    <input id="id_${f.key}" type="${f.type || 'text'}" data-identity-key="${f.key}" />
                  </div>`
              )
              .join('')}
          </div>
        </fieldset>`
    )
    .join('');
}

function loadProfile() {
  chrome.storage.local.get(['profile', 'apiKey'], ({ profile, apiKey }) => {
    const identity = profile?.identity || {};
    IDENTITY_FIELDS.forEach((f) => {
      const el = document.getElementById(`id_${f.key}`);
      if (el) el.value = identity[f.key] || '';
    });
    document.getElementById('resume').value = profile?.resume || '';
    document.getElementById('priorWriting').value = profile?.priorWriting || '';
    if (apiKey) document.getElementById('apiKey').value = apiKey;
  });
}

function saveProfile() {
  const identity = {};
  IDENTITY_FIELDS.forEach((f) => {
    const el = document.getElementById(`id_${f.key}`);
    identity[f.key] = el.value.trim();
  });
  const resume = document.getElementById('resume').value;
  const priorWriting = document.getElementById('priorWriting').value;
  const apiKey = document.getElementById('apiKey').value.trim();

  chrome.storage.local.get(['profile'], ({ profile }) => {
    const updatedProfile = { ...(profile || {}), identity, resume, priorWriting };
    chrome.storage.local.set({ profile: updatedProfile, apiKey }, () => {
      const status = document.getElementById('status');
      status.textContent = 'Saved.';
      setTimeout(() => {
        status.textContent = '';
      }, 2000);
    });
  });
}

buildForm();
loadProfile();
document.getElementById('saveBtn').addEventListener('click', saveProfile);

// If the side panel updates the resume in the background (via the AI merge
// on a manual fill) while this tab happens to be open, reflect it live
// instead of silently going stale.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.profile) return;
  const resumeEl = document.getElementById('resume');
  const newResume = changes.profile.newValue?.resume;
  if (newResume !== undefined && document.activeElement !== resumeEl) {
    resumeEl.value = newResume;
  }
});
