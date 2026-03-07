import { Router }          from "express";
import { chain }           from "../services/chain.js";
import { logAudit }        from "../services/audit.js";
import { requireFacility } from "../middleware/auth.js";

const router = Router();

// ══════════════════════════════════════════════════════════════════
//  REFERRAL ROUTES
//  All require facility credentials (X-Facility-Id + X-Api-Key)
//
//  STATUS TRANSITIONS (tracked locally per hospital):
//    PENDING → ACCEPTED  (receiving facility)
//    PENDING → REJECTED  (receiving facility)
//    PENDING → CANCELLED (sending facility)
//    ACCEPTED → COMPLETED (receiving facility)
// ══════════════════════════════════════════════════════════════════

// POST /api/referrals
// Create a referral — logs on blockchain
router.post("/", requireFacility, async (req, res) => {
  try {
    const { nupi, toFacility, reason, urgency, issuedBy } = req.body;
    if (!nupi || !toFacility || !reason)
      return res.status(400).json({ error: "nupi, toFacility, reason required" });

    const result = await chain.logReferral({
      nupi, fromFacility: req.facilityId,
      toFacility, reason,
      urgency:  urgency  || "ROUTINE",
      issuedBy: issuedBy || null,
    });

    await logAudit({ event: "referral_created", patientNupi: nupi, facilityId: req.facilityId, success: true, metadata: { toFacility, urgency, referralId: result.referralId }, ipAddress: req.ip });

    res.json({
      success:    true,
      referralId: result.referralId,
      blockIndex: result.block.index,
      block:      result.block,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Static routes BEFORE /:id wildcard ───────────────────────────

// GET /api/referrals/incoming/:facilityId
// Returns referrals TO this facility from the blockchain
router.get("/incoming/:facilityId", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;

    // Facility can only query its own incoming referrals
    if (facilityId !== req.facilityId)
      return res.status(403).json({ success: false, error: "You can only query your own incoming referrals" });

    const referrals = chain.getReferralsForFacility(facilityId, "incoming");

    await logAudit({ event: "referrals_queried", facilityId, direction: "incoming", count: referrals.length, success: true, ipAddress: req.ip });
    res.json({ success: true, referrals, count: referrals.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/referrals/outgoing/:facilityId
// Returns referrals FROM this facility on the blockchain
router.get("/outgoing/:facilityId", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;

    if (facilityId !== req.facilityId)
      return res.status(403).json({ success: false, error: "You can only query your own outgoing referrals" });

    const referrals = chain.getReferralsForFacility(facilityId, "outgoing");

    await logAudit({ event: "referrals_queried", facilityId, direction: "outgoing", count: referrals.length, success: true, ipAddress: req.ip });
    res.json({ success: true, referrals, count: referrals.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/referrals/patient/:nupi
// All referrals for a specific patient visible to this facility
router.get("/patient/:nupi", requireFacility, async (req, res) => {
  try {
    const { nupi }   = req.params;
    const facilityId = req.facilityId;

    // Return referrals where this facility is either sender or receiver
    const all = [
      ...chain.getReferralsForFacility(facilityId, "outgoing"),
      ...chain.getReferralsForFacility(facilityId, "incoming"),
    ].filter(r => r.patientNupi === nupi);

    // Deduplicate by referralId
    const seen = new Set();
    const referrals = all.filter(r => {
      if (seen.has(r.referralId)) return false;
      seen.add(r.referralId);
      return true;
    });

    res.json({ success: true, referrals, count: referrals.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/referrals/:referralId
// Look up a specific referral by referralId from the blockchain
router.get("/:referralId", requireFacility, async (req, res) => {
  try {
    const { referralId } = req.params;
    const block = chain.chain.find(b => b.type === "REFERRAL_ISSUED" && b.data?.referralId === referralId);

    if (!block) return res.status(404).json({ success: false, error: "Referral not found on chain" });

    const facilityId = req.facilityId;
    // Only sender or receiver can view the referral
    if (block.data.fromFacility !== facilityId && block.data.toFacility !== facilityId)
      return res.status(403).json({ success: false, error: "Access denied — not your referral" });

    res.json({
      success: true,
      referral: {
        referralId:       block.data.referralId,
        patientNupi:      block.data.nupi,
        fromFacilityId:   block.data.fromFacility,
        fromFacilityName: chain.getFacility(block.data.fromFacility)?.name || block.data.fromFacility,
        toFacilityId:     block.data.toFacility,
        toFacilityName:   chain.getFacility(block.data.toFacility)?.name   || block.data.toFacility,
        reason:           block.data.reason,
        urgency:          block.data.urgency  || "ROUTINE",
        issuedBy:         block.data.issuedBy || null,
        blockIndex:       block.index,
        createdAt:        block.timestamp,
      },
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;