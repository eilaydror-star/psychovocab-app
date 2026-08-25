# PsychoVocab

Personal English vocabulary trainer for the Israeli Psychometric exam, with spaced repetition and Firebase login.

Live site: https://eilaydror-star.github.io/psychovocab-app/

## How it works

- 4,000 English↔Hebrew word pairs, split into easy / moderate / hard difficulty tiers
- A traffic-light system (red → orange → green) tracks mastery per word, using spaced repetition (a word must be answered correctly twice in a row, a few hours apart, to be marked mastered)
- No manual difficulty picker - the app always works through the easy tier first, and automatically unlocks moderate once every easy word is green, then hard once moderate is green (`getCurrentTier()` in `js/app.js`)
- Each 7-word study set is drawn only from the user's current tier, from a capped pool of already-started words plus a limited number of never-attempted ones, so a session never surfaces words the user hasn't actually reached yet
- If you exit mid-set, the exact words, their order, and your progress within that set are saved (to `localStorage` and synced to Firebase) and automatically resumed the next time the app opens, instead of starting a new random session
- During a session, a side list shows every word in the current set, color-coded red/orange/green as you go - a sidebar next to the word card on wide screens, collapsing to a drawer below it on narrow/mobile screens
- A "שינון עד תום" button lets you mark a word you already know well as mastered (green) immediately, instead of waiting to answer it correctly twice across a rest period
- Progress is saved to `localStorage` automatically, and also synced to Firebase Realtime Database when logged in - so progress follows you across devices
- Firebase Authentication (email/password) handles login; each user's data is isolated by Firebase Realtime Database security rules

## Project structure

```
index.html              entry point
css/
  variables.css         color/spacing tokens
  base.css               resets, global animations
  layout.css             page structure (header, containers, screens)
  components.css         buttons, cards, modals, timer, etc.
js/
  config.js               Firebase project config
  words-data.js           the 4,000-word dataset
  storage.js               localStorage read/write helpers
  firebase-init.js         Firebase Auth/Database setup, auth state handling
  auth.js                   register/login/logout
  app.js                    VocabularyApp class - all UI rendering and app logic
assets/
  logo.png
```

Plain `<script>` tags (not ES modules) are used deliberately, so the app also works when `index.html` is opened directly by double-clicking it - browsers block ES module imports over `file://`.

## Running locally

No build step. Either:
- Double-click `index.html`, or
- Serve the folder with any static file server (e.g. `npx serve .`) and open it in a browser

## Firebase

Project: `psychometric-app-englishwords`. The config in `js/config.js` is not a secret (Firebase web configs are always public in shipped JS) - the actual security boundary is the Realtime Database rules, which restrict each user to reading/writing only their own `users/{uid}/progress` path.

## Tests

`tests/test.html` boots the real app (no Firebase SDK loaded, so it falls back to localStorage) and runs a small suite against the tier/spaced-repetition/leech logic in `js/app.js`. Open it directly, or via a static server, and check the console/page for `N/N passed`. Same no-build philosophy as the app itself - no Node or package manager required.
