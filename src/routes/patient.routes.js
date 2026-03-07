import { Router }     from "express";
import { chain }      from "../services/chain.js";
import { logAudit }   from "../services/audit.js";
import { issueAccessToken } from "../services/tokens.js";
import { requireFacility }  from "../middleware/auth.js";

const router = Router();

// POST /api/patients/register
router.post("/register", requireFacility, async (req, res) => {
  try {
    const { nationalId, dob, name, securityQuestion, securityAnswer, pin } = req.body;
    if (!nationalId || !dob || !name || !securityQuestion || !securityAnswer || !pin)
      return res.status(400).json({ error: "nationalId, dob, name, securityQuestion, securityAnswer, pin required" });
    if (pin.toString().length !== 4)
      return res.status(400).json({ error: "PIN must be exactly 4 digits" });

    const result = await chain.registerPatient({ nationalId, dob, name, securityQuestion, securityAnswer, pin, facilityId: req.facilityId });
    await logAudit({ event: "patient_registered", patientNupi: result.nupi, facilityId: req.facilityId, success: true, ipAddress: req.ip });

    res.json({
      success:       true,
      nupi:          result.nupi,
      alreadyExists: result.alreadyExists,
      blockIndex:    result.block?.index,
      message:       result.alreadyExists ? "Patient already on AfyaNet" : "Patient registered — block minted",
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/patients/encounter
router.post("/encounter", requireFacility, async (req, res) => {
  try {
    const { nupi, encounterId, encounterType, encounterDate, chiefComplaint, practitionerName } = req.body;
    if (!nupi || !encounterId) return res.status(400).json({ error: "nupi and encounterId required" });

    const result = await chain.recordEncounter({
      nupi, facilityId: req.facilityId, encounterId,
      encounterType:    encounterType    || "outpatient",
      encounterDate:    encounterDate    || new Date().toISOString(),
      chiefComplaint:   chiefComplaint   || null,
      practitionerName: practitionerName || null,
    });
    if (!result.success) return res.status(400).json(result);

    await logAudit({ event: "encounter_recorded", patientNupi: nupi, facilityId: req.facilityId, success: true, metadata: { encounterId, encounterType }, ipAddress: req.ip });
    res.json({ success: true, encounterId, blockIndex: result.blockIndex, message: `Encounter recorded on blockchain at ${req.facility.name}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/patients/nupi
router.post("/nupi", requireFacility, async (req, res) => {
  const { nationalId, dob } = req.body;
  if (!nationalId || !dob) return res.status(400).json({ error: "nationalId and dob required" });
  res.json({ success: true, nupi: chain.generateNupi(nationalId, dob) });
});

// GET /api/patients/:nupi/consents
router.get("/:nupi/consents", requireFacility, (req, res) => {
  res.json({ success: true, consents: chain.listConsents(req.params.nupi) });
});

// GET /api/patients/:nupi/history
router.get("/:nupi/history", requireFacility, async (req, res) => {
  try {
    const { nupi }   = req.params;
    const patient    = chain.getPatient(nupi);
    if (!patient) return res.status(404).json({ error: "Patient not on AfyaNet" });

    const encounterIndex    = chain.getPatientEncounterIndex(nupi);
    const facilitiesVisited = chain.getPatientFacilities(nupi).map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county, status: f?.status };
    });

    await logAudit({ event: "patient_history_accessed", patientNupi: nupi, facilityId: req.facilityId, success: true, ipAddress: req.ip });
    res.json({
      success: true, nupi,
      patient: { name: patient.name, registeredAt: patient.registeredAt, registeredAtFacility: patient.facilityId, lastSeenAt: patient.lastSeenAt, lastEncounterDate: patient.lastEncounterDate },
      facilitiesVisited, encounterIndex,
      auditTrail: chain.getAuditTrail(nupi),
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;