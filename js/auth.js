function registerUser(email, password) {
  return new Promise((resolve, reject) => {
    if (!firebaseReady) {
      reject('Firebase not ready');
      return;
    }

    auth.createUserWithEmailAndPassword(email, password)
      .then((userCredential) => {
        setCurrentUser(userCredential.user);
        resolve(userCredential.user);
      })
      .catch((error) => reject(error.message));
  });
}

function loginUser(email, password) {
  return new Promise((resolve, reject) => {
    if (!firebaseReady) {
      reject('Firebase not ready');
      return;
    }

    auth.signInWithEmailAndPassword(email, password)
      .then((userCredential) => {
        setCurrentUser(userCredential.user);
        resolve(userCredential.user);
      })
      .catch((error) => reject(error.message));
  });
}

function signInWithGoogle() {
  return new Promise((resolve, reject) => {
    if (!firebaseReady) {
      reject('Firebase not ready');
      return;
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider)
      .then((userCredential) => {
        setCurrentUser(userCredential.user);
        resolve(userCredential.user);
      })
      .catch((error) => reject(error.message));
  });
}

function resetPassword(email) {
  return new Promise((resolve, reject) => {
    if (!firebaseReady) {
      reject('Firebase not ready');
      return;
    }

    auth.sendPasswordResetEmail(email)
      .then(() => resolve())
      .catch((error) => reject(error.message));
  });
}

function logoutUser() {
  return new Promise((resolve, reject) => {
    if (!firebaseReady) {
      reject('Firebase not ready');
      return;
    }

    auth.signOut()
      .then(() => {
        setCurrentUser(null);
        resolve();
      })
      .catch((error) => reject(error.message));
  });
}
