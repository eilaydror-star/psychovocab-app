import { FIREBASE_CONFIG } from './config.js';

// These are mutable module state, exported as live bindings so other
// modules (auth.js, app.js) always see the current value without needing
// setters for reads - only this module ever assigns them directly.
export let firebaseReady = false;
export let currentUser = null;
export let auth = null;
export let db = null;

export function setCurrentUser(user) {
  currentUser = user;
  if (window.app) {
    window.app.currentUser = user;
  }
}

export function initializeFirebase() {
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
          window.app.syncProgressWithFirebase();
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
