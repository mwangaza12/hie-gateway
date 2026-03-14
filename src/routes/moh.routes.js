// gateway/src/routes/moh.routes.js

import { Router }        from "express";
import { chain }         from "../services/chain.js";
import { col, admin }    from "../services/firebase.js";
import { logAudit }      from "../services/audit.js";
import { AfyaChain }     from "../services/chain.js";
import { signMohToken, requireMoH } from "../middleware/auth.js";

const router = Router();

// ── POST /api/moh/login ───────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (email !== (process.env.MOH_ADMIN_EMAIL || "admin@health.go.ke") ||
      password !== process.env.MOH_ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid MoH credentials" });
  await logAudit({ event: "moh_login", email, success: true, ipAddress: req.ip });
  res.json({ success: true, token: signMohToken(email), role: "MOH_ADMIN" });
});

// ── POST /api/moh/facilities/register ────────────────────────────────────────
//
// Registers a new facility on the blockchain and saves it to Firestore.
//
// Required fields:
//   facilityId, name, mohLicense, apiUrl, adminEmail
//
// Optional but strongly recommended at registration time:
//   firebaseConfig: {
//     apiKey, appId, projectId,
//     messagingSenderId, storageBucket, authDomain   ← from Firebase Console
//   }
//
// If firebaseConfig is omitted at registration, it can be added later via:
//   PATCH /api/moh/facilities/:id/firebase-config
//
router.post("/facilities/register", requireMoH, async (req, res) => {
  try {
    const {
      facilityId, name, mohLicense, type, county,
      apiUrl, fhirEndpoints, adminEmail, address,
      firebaseConfig,   // ← NEW: Firebase credentials for this facility
    } = req.body;

    if (!facilityId || !name || !mohLicense || !apiUrl || !adminEmail)
      return res.status(400).json({
        error: "facilityId, name, mohLicense, apiUrl, adminEmail required",
      });

    // Validate firebaseConfig if provided
    if (firebaseConfig) {
      const { apiKey, appId, projectId } = firebaseConfig;
      if (!apiKey || !appId || !projectId)
        return res.status(400).json({
          error: "firebaseConfig must include apiKey, appId, and projectId",
        });
    }

    const existing = await col.facilities.doc(facilityId).get();
    if (existing.exists)
      return res.status(409).json({ error: "Facility already registered" });

    // Register on blockchain
    const chainResult = await chain.registerFacility({
      facilityId, name, mohLicense,
      type:      type   || "Hospital",
      county:    county || "Unknown",
      fhirUrl:   apiUrl,
      adminEmail, approvedBy: req.moh.email,
    });
    if (!chainResult.success) return res.status(409).json(chainResult);

    // Save to Firestore — include firebaseConfig if provided
    await col.facilities.doc(facilityId).set({
      facilityId, name, mohLicense,
      type:    type   || "Hospital",
      county:  county || "Unknown",
      apiUrl,
      apiKeyHash:  AfyaChain.sha256(chainResult.apiKey),
      fhirVersion: "R4",
      fhirEndpoints: {
        patient:     "/fhir/Patient/:id",
        encounter:   "/fhir/Encounter?patient=:id",
        observation: "/fhir/Observation?patient=:id",
        condition:   "/fhir/Condition?patient=:id",
        bundle:      "/fhir/Patient/:id/$everything",
        ...fhirEndpoints,
      },
      adminEmail,
      address:  address || null,
      active:   true,
      verified: false,

      // Firebase credentials — stored only if provided at registration
      // Can be added/updated later via PATCH /firebase-config
      firebaseConfig: firebaseConfig
        ? {
            apiKey:            firebaseConfig.apiKey,
            appId:             firebaseConfig.appId,
            projectId:         firebaseConfig.projectId,
            messagingSenderId: firebaseConfig.messagingSenderId || "",
            storageBucket:     firebaseConfig.storageBucket     || "",
            authDomain:        firebaseConfig.authDomain        || "",
          }
        : null,

      blockIndex:   chainResult.block.index,
      blockHash:    chainResult.block.hash,
      registeredBy: req.moh.email,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    await logAudit({
      event:      "facility_registered",
      facilityId, success: true,
      ipAddress:  req.ip,
      metadata:   {
        name,
        blockIndex:      chainResult.block.index,
        hasFirebaseConfig: !!firebaseConfig,
      },
    });

    console.log(`✅ Facility registered: ${name} | Block #${chainResult.block.index}${
      firebaseConfig ? " | Firebase config included" : " | Firebase config NOT set"
    }`);

    res.json({
      success:    true,
      facilityId,
      apiKey:     chainResult.apiKey,
      blockIndex: chainResult.block.index,
      blockHash:  chainResult.block.hash,
      firebaseConfigSet: !!firebaseConfig,
      message:    `${name} registered. Save the API key — it will not be shown again.`,
      warning:    !firebaseConfig
        ? "Firebase config not set. Add it via PATCH /api/moh/facilities/" +
          facilityId + "/firebase-config before onboarding this facility."
        : undefined,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /api/moh/facilities/:id/firebase-config ────────────────────────────
//
// Add or update the Firebase credentials for an existing facility.
// Use this when:
//   - Firebase config was omitted during registration
//   - A facility migrates to a new Firebase project
//   - Firebase credentials need to be rotated
//
// Body:
//   {
//     "apiKey":            "AIza...",
//     "appId":             "1:123:android:abc",
//     "projectId":         "clinic-connect-nairobi",
//     "messagingSenderId": "123456789",          (optional)
//     "storageBucket":     "project.appspot.com", (optional)
//     "authDomain":        "project.firebaseapp.com" (optional)
//   }
//
router.patch("/facilities/:id/firebase-config", requireMoH, async (req, res) => {
  try {
    const { id: facilityId } = req.params;
    const { apiKey, appId, projectId, messagingSenderId, storageBucket, authDomain } = req.body;

    if (!apiKey || !appId || !projectId)
      return res.status(400).json({
        error: "apiKey, appId, and projectId are required",
      });

    // Verify facility exists
    const doc = await col.facilities.doc(facilityId).get();
    if (!doc.exists)
      return res.status(404).json({ error: "Facility not found" });

    // Update Firestore with new Firebase credentials
    await col.facilities.doc(facilityId).update({
      firebaseConfig: {
        apiKey,
        appId,
        projectId,
        messagingSenderId: messagingSenderId || "",
        storageBucket:     storageBucket     || "",
        authDomain:        authDomain        || "",
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await logAudit({
      event:      "facility_firebase_config_updated",
      facilityId, success: true,
      ipAddress:  req.ip,
      metadata:   { projectId, updatedBy: req.moh.email },
    });

    console.log(`✅ Firebase config updated: ${doc.data().name} → ${projectId}`);

    res.json({
      success:    true,
      facilityId,
      projectId,
      message:    `Firebase config updated for ${doc.data().name}. ` +
                  `Devices at this facility can now use dynamic setup.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/moh/facilities/:id/firebase-config ───────────────────────────────
//
// View the current Firebase config for a facility (MoH admin only).
// The facility's app-facing endpoint (/api/facilities/:id/firebase-config)
// requires the facility API key — this one requires MoH token instead.
//
router.get("/facilities/:id/firebase-config", requireMoH, async (req, res) => {
  try {
    const doc = await col.facilities.doc(req.params.id).get();
    if (!doc.exists)
      return res.status(404).json({ error: "Facility not found" });

    const data = doc.data();
    res.json({
      success:      true,
      facilityId:   data.facilityId,
      facilityName: data.name,
      firebaseConfig: data.firebaseConfig || null,
      configured:   !!data.firebaseConfig?.apiKey,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── POST /api/moh/facilities/:id/rotate-key ───────────────────────────────────
//
// Generates a new API key for a facility when the old one is lost or compromised.
// The old key is immediately invalidated — any device still using it will get
// 401 errors and will need to be reconfigured with the new key.
//
// This mints a FACILITY_KEY_ROTATED block on the blockchain for audit.
// The new key is shown ONCE in the response — save it immediately.
//
router.post("/facilities/:id/rotate-key", requireMoH, async (req, res) => {
  try {
    const { id: facilityId } = req.params;
    const { reason }         = req.body;

    if (!reason)
      return res.status(400).json({ error: "reason is required (for audit log)" });

    const doc = await col.facilities.doc(facilityId).get();
    if (!doc.exists)
      return res.status(404).json({ error: "Facility not found" });

    const result = await chain.rotateApiKey(facilityId, req.moh.email);
    if (!result.success)
      return res.status(400).json({ success: false, error: result.error });

    // Update the apiKeyHash in Firestore with the new key's hash
    await col.facilities.doc(facilityId).update({
      apiKeyHash: result.block.data.newKeyHash,
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    await logAudit({
      event:      "facility_key_rotated",
      facilityId, success: true,
      ipAddress:  req.ip,
      metadata:   {
        reason,
        rotatedBy:  req.moh.email,
        blockIndex: result.block.index,
      },
    });

    console.log(`🔑 API key rotated: ${doc.data().name} | Block #${result.block.index}`);

    res.json({
      success:    true,
      facilityId,
      apiKey:     result.apiKey,   // ← NEW KEY — shown once, save immediately
      blockIndex: result.block.index,
      blockHash:  result.block.hash,
      message:    `API key rotated for ${doc.data().name}. ` +
                  "Save the new key — it will not be shown again. " +
                  "Update the setup wizard on all facility devices with this new key.",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/moh/facilities/:id/suspend ─────────────────────────────────────
router.post("/facilities/:id/suspend", requireMoH, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "reason required" });
    const result = await chain.suspendFacility(req.params.id, reason, req.moh.email);
    if (!result.success) return res.status(404).json(result);
    await col.facilities.doc(req.params.id).update({
      active: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await logAudit({ event: "facility_suspended", facilityId: req.params.id, success: true, ipAddress: req.ip });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/moh/facilities/:id/reactivate ───────────────────────────────────
router.post("/facilities/:id/reactivate", requireMoH, async (req, res) => {
  try {
    const result = await chain.reactivateFacility(req.params.id, req.moh.email);
    if (!result.success) return res.status(404).json(result);
    await col.facilities.doc(req.params.id).update({
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/moh/facilities ───────────────────────────────────────────────────
router.get("/facilities", requireMoH, async (req, res) => {
  try {
    const snap       = await col.facilities.get();
    const facilities = snap.docs.map(d => {
      const data = d.data();
      return {
        ...data,
        firebaseConfigured: !!data.firebaseConfig?.apiKey,
        // Never return actual Firebase credentials in list view
        firebaseConfig: undefined,
        chainStatus:  chain.getFacility(data.facilityId)?.status || "NOT_ON_CHAIN",
        registeredAt: data.registeredAt?.toDate?.() || data.registeredAt,
      };
    });
    res.json({
      success: true, facilities,
      count:   facilities.length,
      unconfigured: facilities.filter(f => !f.firebaseConfigured).length,
      chainStats: chain.getStats(),
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/moh/staff/credential ───────────────────────────────────────────
router.post("/staff/credential", requireMoH, async (req, res) => {
  try {
    const { staffId, facilityId, name, role } = req.body;
    if (!staffId || !facilityId || !name || !role)
      return res.status(400).json({ error: "staffId, facilityId, name, role required" });
    const result = await chain.credentialStaff({ staffId, facilityId, name, role, addedBy: req.moh.email });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Chain admin ───────────────────────────────────────────────────────────────
router.get("/chain/stats",       requireMoH, (req, res) => res.json({ success: true, ...chain.getStats() }));
router.get("/chain/verify",      requireMoH, (req, res) => res.json(chain.verifyIntegrity()));
router.get("/chain/blocks",      requireMoH, (req, res) => res.json({ success: true, blocks: chain.recentBlocks(parseInt(req.query.limit) || 20) }));
router.get("/chain/audit/:nupi", requireMoH, (req, res) => res.json({ success: true, trail: chain.getAuditTrail(req.params.nupi) }));

export default router;