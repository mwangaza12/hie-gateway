import admin from "firebase-admin";
import "dotenv/config";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

export const db = admin.firestore();
console.log("✅ Firebase Firestore connected");

export const col = {
  facilities:   db.collection("facilities"),
  accessTokens: db.collection("access_tokens"),
  auditLog:     db.collection("audit_log"),
};

const BC = "hie_chain";
export const cref = {
  meta:       ()   => db.collection(BC).doc("meta"),
  facility:   (id) => db.collection(BC).doc("facilities").collection("docs").doc(id),
  facs:       ()   => db.collection(BC).doc("facilities").collection("docs"),
  patient:    (id) => db.collection(BC).doc("patients").collection("docs").doc(id),
  pats:       ()   => db.collection(BC).doc("patients").collection("docs"),
  consent:    (id) => db.collection(BC).doc("consents").collection("docs").doc(id),
  cons:       ()   => db.collection(BC).doc("consents").collection("docs"),
  identity:   (id) => db.collection(BC).doc("identities").collection("docs").doc(id),
  ids:        ()   => db.collection(BC).doc("identities").collection("docs"),
  staff:      (id) => db.collection(BC).doc("staff").collection("docs").doc(id),
  allStaff:   ()   => db.collection(BC).doc("staff").collection("docs"),
  encounter:  (id) => db.collection(BC).doc("encounters").collection("docs").doc(id),
  encounters: ()   => db.collection(BC).doc("encounters").collection("docs"),
};

export { admin };