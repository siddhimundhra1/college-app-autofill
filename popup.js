const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Load any previously saved profile into the form
chrome.storage.local.get(['profile', 'apiKey'], ({ profile, apiKey }) => {
  if (profile) {
    $('fullName').value = profile.fullName || '';
    $('highSchool').value = profile.highSchool || '';
    $('gpa').value = profile.gpa || '';
    $('activities').value = profile.activitiesRaw || '';
    $('piq1').value = profile.piq1 || '';
  }
  if (apiKey) $('apiKey').value = apiKey;
});

$('saveBtn').addEventListener('click', () => {
  const activitiesRaw = $('activities').value;
  const activities = activitiesRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, role, hoursPerWeek, years] = line.split('|').map((s) => s.trim());
      return { name, role, hoursPerWeek, years };
    });

  const profile = {
    fullName: $('fullName').value.trim(),
    highSchool: $('highSchool').value.trim(),
    gpa: $('gpa').value.trim(),
    activitiesRaw,
    activities,
    piq1: $('piq1').value.trim(),
  };

  chrome.storage.local.set({ profile, apiKey: $('apiKey').value.trim() }, () => {
    setStatus('Profile saved.');
  });
});

$('fillBtn').addEventListener('click', async () => {
  setStatus('Filling...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('apply.universityofcalifornia.edu')) {
    setStatus('Open the UC application tab first.');
    return;
  }

  // Ask the content script what section is currently visible,
  // then ask the background worker to map profile -> field values via Gemma.
  chrome.tabs.sendMessage(tab.id, { type: 'GET_VISIBLE_SECTION' }, (sectionInfo) => {
    if (chrome.runtime.lastError || !sectionInfo) {
      setStatus('Could not read the page. Refresh and try again.');
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'FILL_SECTION', sectionInfo },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }
        if (response?.error) {
          setStatus('Error: ' + response.error);
          return;
        }
        chrome.tabs.sendMessage(tab.id, {
          type: 'APPLY_VALUES',
          values: response.values,
        });
        setStatus('Filled ' + Object.keys(response.values).length + ' fields.');
      }
    );
  });
});
