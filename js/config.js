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

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCjLofg-9qSCgI7m6XFK2dHJz-AMpXl2tI",
  authDomain: "time-logger-a7e59.firebaseapp.com",
  projectId: "time-logger-a7e59",
  storageBucket: "time-logger-a7e59.firebasestorage.app",
  messagingSenderId: "504746570461",
  appId: "1:504746570461:web:b0c3cbc9d19b9dfa78a134",
  measurementId: "G-MFSQFZN27G"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
