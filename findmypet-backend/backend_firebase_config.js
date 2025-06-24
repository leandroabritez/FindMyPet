// src/config/firebase.js
const admin = require('firebase-admin');

let firebaseApp = null;

const initializeFirebase = () => {
  try {
    if (!firebaseApp) {
      // Configuración usando variables de entorno
      const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`
      };

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
      });

      console.log('✅ Firebase inicializado correctamente');
    }
    
    return firebaseApp;
  } catch (error) {
    console.error('❌ Error inicializando Firebase:', error);
    throw error;
  }
};

const getAuth = () => {
  if (!firebaseApp) {
    throw new Error('Firebase no inicializado');
  }
  return admin.auth();
};

const getFirestore = () => {
  if (!firebaseApp) {
    throw new Error('Firebase no inicializado');
  }
  return admin.firestore();
};

const getStorage = () => {
  if (!firebaseApp) {
    throw new Error('Firebase no inicializado');
  }
  return admin.storage();
};

module.exports = {
  initializeFirebase,
  getAuth,
  getFirestore,
  getStorage,
  admin
};