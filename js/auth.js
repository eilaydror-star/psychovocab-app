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
