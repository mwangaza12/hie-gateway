/**
 * AfyaLink Kenya — HIE Gateway + Blockchain  v4
 * Refactored: modular routes & services
 */

import express from "express";
import axios   from "axios";
import cors    from "cors";
import helmet  from "helmet";
import "dotenv/config";

// ── Services (initialise early so chain loads) ────────────────────
import "./services/firebase.js";
import { chain }   from "./services/chain.js";

// ── Routes ────────────────────────────────────────────────────────
import mohRoutes      from "./routes/moh.routes.js";
import patientRoutes  from "./routes/patient.routes.js";
import verifyRoutes   from "./routes/verify.routes.js";
import fhirRoutes     from "./routes/fhir.routes.js";
import referralRoutes from "./routes/referral.routes.js";

// ── Audit ─────────────────────────────────────────────────────────
import { logAudit } from "./services/audit.js";
import { col }      from "./services/firebase.js";
import { admin }    from "./services/firebase.js";

const app = express();

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } } }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*", credentials: true }));
app.use(express.json({ limit: "10mb" }));

// ── Mount routes ──────────────────────────────────────────────────
app.use("/api/moh",       mohRoutes);
app.use("/api/patients",  patientRoutes);
app.use("/api/verify",    verifyRoutes);
app.use("/api/fhir",      fhirRoutes);
app.use("/api/referrals", referralRoutes);

// ── Public facility list ──────────────────────────────────────────
app.get("/api/facilities", async (req, res) => {
  try {
    const snap       = await col.facilities.where("active", "==", true).get();
    const facilities = snap.docs.map(d => {
      const data = d.data();
      return { facilityId: data.facilityId, name: data.name, county: data.county, type: data.type, active: data.active, verified: data.verified };
    });
    res.json({ success: true, facilities, count: facilities.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Audit log ─────────────────────────────────────────────────────
import { requireFacility } from "./middleware/auth.js";

app.get("/api/audit", requireFacility, async (req, res) => {
  try {
    const { limit = 100, event, patientNupi } = req.query;
    let query = col.auditLog.orderBy("timestamp", "desc").limit(parseInt(limit));
    if (event)       query = query.where("event",       "==", event);
    if (patientNupi) query = query.where("patientNupi", "==", patientNupi);
    const snap = await query.get();
    res.json({ success: true, logs: snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toDate() })), count: snap.size });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Debug (remove in production) ──────────────────────────────────
app.get("/api/debug/chain", async (req, res) => {
  try {
    const firestoreSnap = await col.facilities.get();
    const firestoreFacs = {};
    firestoreSnap.docs.forEach(d => { firestoreFacs[d.id] = d.data(); });
    res.json({
      inMemory:    Object.keys(chain.facilities),
      inFirestore: Object.keys(firestoreFacs),
      chainReady:  chain._ready,
      chainBlocks: chain.chain.length,
      mismatch:    Object.keys(firestoreFacs).filter(id => !chain.facilities[id]),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health check ──────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await col.auditLog.limit(1).get(); // lightweight Firestore ping
    const stats = chain.getStats();
    res.json({
      status: "ok", uptime: process.uptime(),
      database: "Firebase Firestore", fhirVersion: "R4",
      blockchain: {
        blocks:      stats.totalBlocks,
        facilities:  stats.activeFacilities,
        patients:    stats.patients,
        encounters:  stats.encounters,
        integrity:   chain.verifyIntegrity().valid ? "✅ valid" : "❌ BROKEN",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ status: "error", error: err.message }); }
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🏥 AfyaLink HIE Gateway + Blockchain v4`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n   MoH routes:           /api/moh/*`);
  console.log(`   Patient routes:       /api/patients/*`);
  console.log(`   Verify routes:        /api/verify/*`);
  console.log(`   FHIR routes:          /api/fhir/*`);
  console.log(`   Referral routes:      /api/referrals/*\n`);

  // ── Keep-alive (Render free tier) ─────────────────────────────
  if (process.env.RENDER_EXTERNAL_URL) {
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
    setInterval(() => {
      axios.get(pingUrl, { timeout: 10000 })
        .then(r => console.log(`🏓 Keep-alive ping → ${r.status}`))
        .catch(e => console.warn(`⚠️  Keep-alive ping failed: ${e.message}`));
    }, 10 * 60 * 1000);
    console.log(`🏓 Keep-alive active → ${pingUrl}`);
  }
});