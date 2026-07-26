# College App Autofill with Gemma 4

A Manifest V3 Chrome extension that helps students turn a resume and transcript into a local applicant profile, then preview and autofill visible sections of the University of California application.

This project is built for hackathon/demo use. Use only fictional sample data while testing.

## Features

- Resume-first profile import from pasted text, `.txt`, `.md`, `.csv`, or text-based PDF files
- Transcript import for high school, GPA, coursework, and academic history notes
- Activity and award extraction from resume-style entries
- UC campus and school recommendations based on major/interests
- Gemma 4 field mapping through Google AI Studio
- Built-in demo mapper when no API key is saved
- Preview before fill, with sensitive household/background fields blocked unless approved
- UC Activities & Awards support for category, organization, description, grade levels, hours/week, and weeks/year
- UC Academic History support for finding/searching a high school

## Project Files

- `manifest.json` - Chrome extension manifest
- `popup.html` - extension popup UI
- `popup.js` - resume/transcript parsing, profile state, preview/fill controls
- `content.js` - reads visible UC fields and applies values to inputs/selects/radios/checkboxes
- `background.js` - Gemma 4 integration and local fallback mapping
- `sample-resume.txt` - fictional resume sample
- `sample-transcript.txt` - fictional transcript sample

## Install Locally

1. Clone the repo locally.
2. No package install is required for the current extension build.

## Test on Chrome Interface

1. Open Chrome and go to `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this folder:

```text
C:\Kalpita\college-app-autofill
```

After code changes, return to `chrome://extensions` and click Reload on the extension card.

## Basic Demo Flow

1. Open the extension popup.
2. In Import, upload `sample-resume.txt` or click Use sample resume.
3. Click Import resume.
4. Upload `sample-transcript.txt` or paste transcript text.
5. Click Import transcript.
6. Review the extracted profile.
7. In UC, select campuses or click Recommend schools from major / interests.
8. Save UC details.
9. Open the UC application site and navigate to a section.
10. In Fill, click Scan visible UC fields.
11. Click Preview mapped values.
12. Click Fill current section.

The popup reports how many fields were filled and skipped. If a field is skipped, it shows the first skipped field id and reason.

## Gemma 4 Setup

The extension uses this model in `background.js`:

```js
const GEMMA_MODEL = 'gemma-4-31b-it';
```

To use Gemma 4:

1. Create a Google AI Studio API key.
2. Open the extension popup.
3. Go to the UC tab.
4. Paste the API key into Google AI Studio API key.
5. Click Save UC details.

If no API key is saved, the extension uses the built-in demo mapper. This is useful for offline demo testing, but Gemma 4 should produce better mappings on real UC fields.

## Supported UC Sections

Current mapping coverage includes:

- Applicant name and contact fields
- High school name/search fields
- GPA and academic interest fields
- UC campus fields
- PIQ/personal insight text fields
- Activities & Awards category dropdowns
- Volunteer/community service follow-up questions
- Grade level participation checkboxes
- Hours per week and weeks per year

Some UC pages use generated ids or custom controls. Use Preview mapped values and the filled/skipped status to identify fields that need another mapping rule.

## Privacy Notes

- Profile data and the API key are stored locally in Chrome extension storage.
- Do not test with real student personal information during demos.
- The sample files contain fictional data only.
- Sensitive household/background fields are filtered unless the approval checkbox is selected before filling.

## Troubleshooting

If the popup looks outdated:

1. Confirm Chrome loaded `C:\Kalpita\college-app-autofill`.
2. Click Reload in `chrome://extensions`.
3. Close and reopen the popup.

If nothing fills:

1. Refresh the UC application page.
2. Click Scan visible UC fields.
3. Click Preview mapped values.
4. Check whether the preview contains reasonable values.
5. Click Fill current section.
6. Read the final status, especially `First skipped: ...`.

Common skip reasons:

- `empty value` - no profile value or mapping was found for that field
- `no matching element` - the page changed after scanning; scan again
- `could not set value` - a dropdown/radio option did not match; add an alias in `content.js` and `background.js`

## Development Notes

Run quick syntax checks with:

```bash
node --check popup.js
node --check content.js
node --check background.js
```

Reload the extension after every JavaScript change so the Manifest V3 service worker and popup use the latest files.
