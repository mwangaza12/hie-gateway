import { Router }          from "express";
import { chain }           from "../services/chain.js";
import { logAudit }        from "../services/audit.js";
import { issueAccessToken }from "../services/tokens.js";
import { requireFacility } from "../middleware/auth.js";

const router = Router();

// POST /api/verify/question  (public — no facility auth needed)
router.post("/question", async (req, res) => {
  try {
    const { nationalId, dob } = req.body;
    if (!nationalId || !dob) return res.status(400).json({ error: "nationalId and dob required" });

    const result = chain.getSecurityQuestion(nationalId, dob);
    if (!result.found) return res.status(404).json({ success: false, error: "Patient not registered on AfyaNet" });

    await logAudit({ event: "security_question_fetched", patientNupi: result.nupi, success: true, ipAddress: req.ip });
    res.json({ success: true, nupi: result.nupi, question: result.question });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/verify/answer
router.post("/answer", requireFacility, async (req, res) => {
  try {
    const { nationalId, dob, answer } = req.body;
    if (!nationalId || !dob || !answer)
      return res.status(400).json({ error: "nationalId, dob and answer required" });

    const verification = await chain.verifyByAnswer(nationalId, dob, answer);
    if (!verification.success) {
      await logAudit({ event: "verification_failed", patientNupi: verification.nupi, facilityId: req.facilityId, success: false, ipAddress: req.ip });
      return res.status(401).json(verification);
    }

    const tokenData         = await issueAccessToken(verification.nupi, req.facilityId, "security_question");
    const encounterIndex    = chain.getPatientEncounterIndex(verification.nupi);
    const facilitiesVisited = chain.getPatientFacilities(verification.nupi).map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county };
    });

    await logAudit({ event: "patient_verified", patientNupi: verification.nupi, facilityId: req.facilityId, success: true, method: "security_question", ipAddress: req.ip });
    res.json({ success: true, ...tokenData, patient: verification.patient, facilitiesVisited, encounterIndex });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/verify/pin
router.post("/pin", requireFacility, async (req, res) => {
  try {
    const { nationalId, dob, pin } = req.body;
    if (!nationalId || !dob || !pin)
      return res.status(400).json({ error: "nationalId, dob and pin required" });

    const verification = await chain.verifyByPin(nationalId, dob, pin);
    if (!verification.success) return res.status(401).json(verification);

    const tokenData         = await issueAccessToken(verification.nupi, req.facilityId, "pin");
    const encounterIndex    = chain.getPatientEncounterIndex(verification.nupi);
    const facilitiesVisited = chain.getPatientFacilities(verification.nupi).map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county };
    });

    res.json({ success: true, ...tokenData, patient: verification.patient, facilitiesVisited, encounterIndex });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;