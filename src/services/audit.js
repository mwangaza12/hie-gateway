import { col, admin } from "./firebase.js";

export async function logAudit(event) {
  try {
    await col.auditLog.add({ ...event, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    console.log("📝 AUDIT:", event.event);
  } catch (err) {
    console.error("Audit log failed:", err.message);
  }
}