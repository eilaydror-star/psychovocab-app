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

    // Listen for auth changes
    auth.onAuthStateChanged((user) => {
      currentUser = user;
      if (window.app) {
        window.app.currentUser = user;

        if (user) {
          console.log('User logged in:', user.email);
          // Pull the user's saved cloud progress down (not push local state
          // up) - this fires on every login, including auto-restored
          // sessions, so it must be the "load" direction or a fresh/empty
          // device would silently overwrite real cloud progress with a
          // blank slate.
          window.app.loadProgressFromFirebase();
        } else {
          console.log('No user logged in');
        }
      }
    });

    return true;
  } catch (e) {
    console.warn('Firebase init failed:', e.message);
    return false;
  }
}

// Initialize Firebase when page loads
window.addEventListener('load', () => {
  initializeFirebase();
});
