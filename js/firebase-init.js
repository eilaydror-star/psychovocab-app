// These are shared globals (this file is a plain script, not a module, so
// index.html can be opened directly via file:// - see js/auth.js and
// js/app.js, which are loaded after this file and read/reassign these
// same top-level bindings).
let firebaseReady = false;
let currentUser = null;
let auth = null;
let db = null;

function setCurrentUser(user) {
  currentUser = user;
  if (window.app) {
    window.app.currentUser = user;
  }
}

function initializeFirebase() {
  if (FIREBASE_CONFIG.apiKey.includes('YOUR_')) {
    console.log('Firebase config not set. Falling back to localStorage.');
    return false;
  }

  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.database();
    firebaseReady = true;

    // Safety net: onAuthStateChanged's first callback can be blocked
    // indefinitely (third-party storage/IndexedDB restrictions, privacy
    // extensions, corporate proxies) - without this, getScreenType() would
    // gate the app on !authChecked forever and leave the user stuck on the
    // boot spinner with no way to reach the login or start screen.
    setTimeout(() => {
      if (window.app && !window.app.authChecked) {
        window.app.authChecked = true;
        window.app.render();
      }
    }, 4000);

    // Listen for auth changes
    auth.onAuthStateChanged((user) => {
      currentUser = user;
      if (window.app) {
        window.app.currentUser = user;
        // First callback resolves whether a previous session is being
        // restored - flips the boot screen over to the real login/start
        // screen instead of leaving a stale "loading" state or, worse,
        // flashing the login form before the restored session is known.
        const wasChecked = window.app.authChecked;
        window.app.authChecked = true;

        if (user) {
          console.log('User logged in:', user.email);
          // Pull the user's saved cloud progress down (not push local state
          // up) - this fires on every login, including auto-restored
          // sessions, so it must be the "load" direction or a fresh/empty
          // device would silently overwrite real cloud progress with a
          // blank slate.
          //
          // `wasChecked` distinguishes the very first callback (page
          // boot - either restoring a persisted session, or confirming
          // there's none) from a later one firing because the user just
          // signed in during this same page visit. Only in that second
          // case can there be real, unsynced guest progress sitting in
          // memory that a blind merge would silently let clobber the
          // account's actual cloud data - see hasGuestProgress()/
          // handleGuestToAccountTransition() in js/app.js.
          if (wasChecked && window.app.hasGuestProgress()) {
            window.app.handleGuestToAccountTransition();
          } else {
            window.app.loadProgressFromFirebase();
          }
        } else {
          console.log('No user logged in');
          if (!wasChecked) window.app.render();
        }
      }
    });

    return true;
  } catch (e) {
    console.warn('Firebase init failed:', e.message);
    return false;
  }
}

// Start the auth check as soon as this script runs (the Firebase SDKs are
// already loaded via the blocking <script> tags above it in index.html),
// rather than waiting for the 'load' event - which fires only after every
// image/font on the page has finished, needlessly delaying how soon a
// returning user's session is restored.
initializeFirebase();
