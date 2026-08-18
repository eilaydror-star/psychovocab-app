# PsychoVocab

Personal English vocabulary trainer for the Israeli Psychometric exam, with spaced repetition and Firebase login.

Live site: https://eilaydror-star.github.io/psychovocab-app/

## How it works

- 3,500 English↔Hebrew word pairs, split into easy / moderate / hard difficulty
- A traffic-light system (red → orange → green) tracks mastery per word, using spaced repetition (a word must be answered correctly twice in a row to be marked mastered)
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
  words-data.js           the 3,500-word dataset
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
