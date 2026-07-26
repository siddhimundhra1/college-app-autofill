Here's the full local setup, step by step:

**1. Get the files onto your machine**
Download the `uc-autofill-extension` folder from the outputs panel above and unzip it somewhere on disk (e.g. `~/Desktop/uc-autofill-extension`).

**2. Load it into Chrome**
1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** on (top-right switch)
3. Click **Load unpacked**
4. Select the `uc-autofill-extension` folder (the one containing `manifest.json`)
5. You should see "UC App Autofill" appear as a card with an icon

**3. Get a Gemma API key**
Go to [aistudio.google.com](https://aistudio.google.com) → "Get API key" → create one. Copy it.

**4. Set up your profile**
Click the extension icon in the toolbar → paste your API key → fill in the mock profile fields (name, GPA, activities, etc.) → **Save Profile**.

**5. Test the fill**
1. Navigate to `apply.universityofcalifornia.edu` and get to any form section
2. Click the extension icon → **Fill Current Section**
3. Watch the console for errors — open DevTools (`Cmd+Option+I` / `Ctrl+Shift+I`) on both the page (for `content.js` errors) and via `chrome://extensions` → "service worker" link under your extension (for `background.js` errors)

**Things likely to break on first run — this is normal for a hackathon build:**
- **Model name 404** — if `background.js` throws a 404 from the Gemma endpoint, the `GEMMA_MODEL` string is wrong. Go to AI Studio, start a chat with Gemma 4, and check the "Get code" button — it'll show you the exact model string to paste in.
- **CORS/network errors on the fetch call** — shouldn't happen since `generativelanguage.googleapis.com` is in `host_permissions`, but if you add other API domains later, add them there too.
- **Fields not filling** — check the service worker console: if the model returns field IDs that don't match what `content.js` tagged, `findElementById` silently no-ops. Add a `console.log(values)` in `applyValues` in `content.js` to see what's actually coming back vs. what's on the page.
- **After editing any file**, go back to `chrome://extensions` and click the refresh icon on the extension card — Chrome doesn't hot-reload unpacked extensions.

