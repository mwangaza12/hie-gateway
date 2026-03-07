import { Router }        from "express";
import { chain }         from "../services/chain.js";
import { col, admin }    from "../services/firebase.js";
import { logAudit }      from "../services/audit.js";
import { AfyaChain }     from "../services/chain.js";
import { signMohToken, requireMoH } from "../middleware/auth.js";

const router = Router();

// POST /api/moh/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (email !== (process.env.MOH_ADMIN_EMAIL || "admin@health.go.ke") ||
      password !== process.env.MOH_ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid MoH credentials" });
  await logAudit({ event: "moh_login", email, success: true, ipAddress: req.ip });
  res.json({ success: true, token: signMohToken(email), role: "MOH_ADMIN" });
});

// POST /api/moh/facilities/register
router.post("/facilities/register", requireMoH, async (req, res) => {
  try {
    const { facilityId, name, mohLicense, type, county, apiUrl, fhirEndpoints, adminEmail, address } = req.body;
    if (!facilityId || !name || !mohLicense || !apiUrl || !adminEmail)
      return res.status(400).json({ error: "facilityId, name, mohLicense, apiUrl, adminEmail required" });

    const existing = await col.facilities.doc(facilityId).get();
    if (existing.exists) return res.status(409).json({ error: "Facility already registered" });

    const chainResult = await chain.registerFacility({
      facilityId, name, mohLicense,
      type:      type   || "Hospital",
      county:    county || "Unknown",
      fhirUrl:   apiUrl,
      adminEmail, approvedBy: req.moh.email,
    });
    if (!chainResult.success) return res.status(409).json(chainResult);

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
      adminEmail, address: address || null,
      active: true, verified: false,
      blockIndex:   chainResult.block.index,
      blockHash:    chainResult.block.hash,
      registeredBy: req.moh.email,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    await logAudit({ event: "facility_registered", facilityId, success: true, ipAddress: req.ip, metadata: { name, blockIndex: chainResult.block.index } });
    console.log(`✅ Facility registered: ${name} | Block #${chainResult.block.index}`);

    res.json({
      success: true, facilityId,
      apiKey:     chainResult.apiKey,
      blockIndex: chainResult.block.index,
      blockHash:  chainResult.block.hash,
      message:   `${name} registered. Save the API key — it will not be shown again.`,
      usage:     "Set X-Facility-Id and X-Api-Key headers on all requests to the gateway",
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/moh/facilities/:id/suspend
router.post("/facilities/:id/suspend", requireMoH, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "reason required" });
    const result = await chain.suspendFacility(req.params.id, reason, req.moh.email);
    if (!result.success) return res.status(404).json(result);
    await col.facilities.doc(req.params.id).update({ active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await logAudit({ event: "facility_suspended", facilityId: req.params.id, success: true, ipAddress: req.ip });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/moh/facilities/:id/reactivate
router.post("/facilities/:id/reactivate", requireMoH, async (req, res) => {
  try {
    const result = await chain.reactivateFacility(req.params.id, req.moh.email);
    if (!result.success) return res.status(404).json(result);
    await col.facilities.doc(req.params.id).update({ active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/moh/facilities
router.get("/facilities", requireMoH, async (req, res) => {
  try {
    const snap       = await col.facilities.get();
    const facilities = snap.docs.map(d => {
      const data = d.data();
      return { ...data, chainStatus: chain.getFacility(data.facilityId)?.status || "NOT_ON_CHAIN", registeredAt: data.registeredAt?.toDate?.() || data.registeredAt };
    });
    res.json({ success: true, facilities, count: facilities.length, chainStats: chain.getStats() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/moh/staff/credential
router.post("/staff/credential", requireMoH, async (req, res) => {
  try {
    const { staffId, facilityId, name, role } = req.body;
    if (!staffId || !facilityId || !name || !role)
      return res.status(400).json({ error: "staffId, facilityId, name, role required" });
    const result = await chain.credentialStaff({ staffId, facilityId, name, role, addedBy: req.moh.email });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Chain stats & admin
router.get("/chain/stats",       requireMoH, (req, res) => res.json({ success: true, ...chain.getStats() }));
router.get("/chain/verify",      requireMoH, (req, res) => res.json(chain.verifyIntegrity()));
router.get("/chain/blocks",      requireMoH, (req, res) => res.json({ success: true, blocks: chain.recentBlocks(parseInt(req.query.limit) || 20) }));
router.get("/chain/audit/:nupi", requireMoH, (req, res) => res.json({ success: true, trail: chain.getAuditTrail(req.params.nupi) }));

export default router;