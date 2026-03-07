/**
 * AfyaLink Kenya — HIE Gateway + Blockchain  v4
 */

import express from "express";
import axios   from "axios";
import cors    from "cors";
import helmet  from "helmet";
import "dotenv/config";

import "./services/firebase.js";
import { chain }   from "./services/chain.js";

import mohRoutes        from "./routes/moh.routes.js";
import patientRoutes    from "./routes/patient.routes.js";
import verifyRoutes     from "./routes/verify.routes.js";
import fhirRoutes       from "./routes/fhir.routes.js";
import referralRoutes   from "./routes/referral.routes.js";
import facilitiesRoutes from "./routes/facilities.routes.js";

import { logAudit }        from "./services/audit.js";
import { col, admin }      from "./services/firebase.js";
import { requireFacility } from "./middleware/auth.js";

const app = express();

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } } }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*", credentials: true }));
app.use(express.json({ limit: "10mb" }));

// ── Mount routes ──────────────────────────────────────────────────
// FIX: removed the duplicate inline app.get("/api/facilities") handler that
//      shadowed the facilitiesRoutes module and caused double-response errors.
//      facilitiesRoutes already handles GET /api/facilities and GET /api/facilities/:id.
app.use("/api/facilities", facilitiesRoutes); // public — no auth needed
app.use("/api/moh",        mohRoutes);
app.use("/api/patients",   patientRoutes);
app.use("/api/verify",     verifyRoutes);     // verify routes live at /api/verify/*
app.use("/api/fhir",       fhirRoutes);
app.use("/api/referrals",  referralRoutes);

// ── Audit log ─────────────────────────────────────────────────────
app.get("/api/audit", requireFacility, async (req, res) => {
  try {
    const { limit = 100, event, patientNupi } = req.query;
    let query = col.auditLog.orderBy("timestamp", "desc").limit(parseInt(limit));
    if (event)       query = query.where("event",       "==", event);
    if (patientNupi) query = query.where("patientNupi", "==", patientNupi);
    const snap = await query.get();
    res.json({
      success: true,
      logs:    snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toDate() })),
      count:   snap.size,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Debug ─────────────────────────────────────────────────────────
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
    await col.auditLog.limit(1).get();
    const stats = chain.getStats();
    res.json({
      status: "ok", uptime: process.uptime(),
      database: "Firebase Firestore", fhirVersion: "R4",
      blockchain: {
        blocks:     stats.totalBlocks,
        facilities: stats.activeFacilities,
        patients:   stats.patients,
        encounters: stats.encounters,
        integrity:  chain.verifyIntegrity().valid ? "✅ valid" : "❌ BROKEN",
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
  console.log(`\n   Facility routes:  /api/facilities/* (public)`);
  console.log(`   MoH routes:       /api/moh/*`);
  console.log(`   Patient routes:   /api/patients/*`);
  console.log(`   Verify routes:    /api/verify/*`);
  console.log(`   FHIR routes:      /api/fhir/*`);
  console.log(`   Referral routes:  /api/referrals/*\n`);

  if (process.env.RENDER_EXTERNAL_URL) {
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
    setInterval(() => {
      axios.get(pingUrl, { timeout: 10000 })
        .then(r => console.log(`🏓 Keep-alive → ${r.status}`))
        .catch(e => console.warn(`⚠️  Keep-alive failed: ${e.message}`));
    }, 10 * 60 * 1000);
    console.log(`🏓 Keep-alive active → ${pingUrl}`);
  }
});