// Firebase configuration.
//
// Leave this as `null` and the app runs in LOCAL MODE: data is saved in this
// browser only (handy for trying it out).
//
// To sync across devices, create a Firebase project (see README.md) and paste
// the config object from Firebase console → Project settings → Your apps → Web
// app. These values are not secrets: access is protected by the Firestore
// security rules in firestore.rules, which only let you read your own data.
//
// Example:
// export const firebaseConfig = {
//   apiKey: "AIza...",
//   authDomain: "my-timelog.firebaseapp.com",
//   projectId: "my-timelog",
//   storageBucket: "my-timelog.firebasestorage.app",
//   messagingSenderId: "1234567890",
//   appId: "1:1234567890:web:abcdef123456",
// };

export const firebaseConfig = null;
