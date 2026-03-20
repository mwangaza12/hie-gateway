// ═══════════════════════════════════════════════════════════════════════════════
// FILE 1: hie-gateway-main/src/routes/patient.routes.js
// COMPLETE UPDATED FILE
// ═══════════════════════════════════════════════════════════════════════════════

import { Router }            from "express";
import { chain }             from "../services/chain.js";
import { logAudit }          from "../services/audit.js";
import { issueAccessToken }  from "../services/tokens.js";
import { requireFacility }   from "../middleware/auth.js";

const router = Router();

// ─── POST /api/patients/register ─────────────────────────────────────────────
router.post("/register", requireFacility, async (req, res) => {
  try {
    const {
      nationalId, dob, name, securityQuestion, securityAnswer, pin,
      gender, phoneNumber, email, county, subCounty, ward, village,
    } = req.body;

    if (!nationalId || !dob || !name || !securityQuestion || !securityAnswer || !pin)
      return res.status(400).json({ error: "nationalId, dob, name, securityQuestion, securityAnswer, pin required" });

    const pinStr = pin.toString();
    if (pinStr.length < 4 || pinStr.length > 8)
      return res.status(400).json({ error: "PIN must be 4–8 digits" });

    const result = await chain.registerPatient({
      nationalId, dob, name,
      securityQuestion, securityAnswer,
      pin:         pinStr,
      facilityId:  req.facilityId,
      gender:      gender      || null,
      phoneNumber: phoneNumber || null,
      email:       email       || null,
      county:      county      || null,
      subCounty:   subCounty   || null,
      ward:        ward        || null,
      village:     village     || null,
    });

    await logAudit({
      event:       "patient_registered",
      patientNupi: result.nupi,
      facilityId:  req.facilityId,
      success:     true,
      ipAddress:   req.ip,
    });

    res.json({
      success:       true,
      nupi:          result.nupi,
      alreadyExists: result.alreadyExists,
      blockIndex:    result.block?.index,
      message:       result.alreadyExists
                       ? "Patient already on AfyaNet"
                       : "Patient registered — block minted",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/patients/encounter ────────────────────────────────────────────
router.post("/encounter", requireFacility, async (req, res) => {
  try {
    const {
      nupi, encounterId, encounterType,
      encounterDate, chiefComplaint, practitionerName,
    } = req.body;

    if (!nupi || !encounterId)
      return res.status(400).json({ error: "nupi and encounterId required" });

    const result = await chain.recordEncounter({
      nupi,
      facilityId:       req.facilityId,
      encounterId,
      encounterType:    encounterType    || "outpatient",
      encounterDate:    encounterDate    || new Date().toISOString(),
      chiefComplaint:   chiefComplaint   || null,
      practitionerName: practitionerName || null,
    });

    if (!result.success) return res.status(400).json(result);

    await logAudit({
      event:       "encounter_recorded",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      metadata:    { encounterId, encounterType },
      ipAddress:   req.ip,
    });

    res.json({
      success:    true,
      encounterId,
      blockIndex: result.blockIndex,
      message:    `Encounter recorded on blockchain at ${req.facility.name}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/patients/token ─────────────────────────────────────────────────
router.post("/token", requireFacility, async (req, res) => {
  try {
    const { nupi, pin, securityAnswer } = req.body;

    if (!nupi || !pin || !securityAnswer)
      return res.status(400).json({ error: "nupi, pin and securityAnswer required" });

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    const valid = await chain.verifyPatientCredentials({ nupi, pin: pin.toString(), securityAnswer });
    if (!valid) {
      await logAudit({
        event:       "invalid_access_token",
        patientNupi: nupi,
        facilityId:  req.facilityId,
        success:     false,
        ipAddress:   req.ip,
      });
      return res.status(401).json({ error: "Invalid PIN or security answer" });
    }

    const token = await issueAccessToken({ nupi, facilityId: req.facilityId });

    await logAudit({
      event:       "access_token_issued",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      ipAddress:   req.ip,
    });

    res.json({ success: true, token, nupi });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/patients/nupi ───────────────────────────────────────────────────
router.get("/nupi", requireFacility, (req, res) => {
  const { nationalId, dob } = req.query;
  if (!nationalId || !dob)
    return res.status(400).json({ error: "nationalId and dob required" });

  res.json({ success: true, nupi: chain.generateNupi(nationalId, dob) });
});

// ─── GET /api/patients/:nupi ──────────────────────────────────────────────────
router.get("/:nupi", requireFacility, async (req, res) => {
  try {
    const { nupi } = req.params;

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    await logAudit({
      event:       "patient_lookup",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      ipAddress:   req.ip,
    });

    res.json({
      success: true,
      nupi,
      patient: {
        name:                 patient.name,
        registeredAt:         patient.registeredAt,
        registeredAtFacility: patient.facilityId,
        lastSeenAt:           patient.lastSeenAt,
        lastEncounterDate:    patient.lastEncounterDate,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/patients/:nupi/consents ────────────────────────────────────────
router.get("/:nupi/consents", requireFacility, (req, res) => {
  res.json({ success: true, consents: chain.listConsents(req.params.nupi) });
});

// ─── GET /api/patients/:nupi/history ─────────────────────────────────────────
router.get("/:nupi/history", requireFacility, async (req, res) => {
  try {
    const { nupi } = req.params;

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    const encounterIndex    = chain.getPatientEncounterIndex(nupi);
    const facilitiesVisited = chain.getPatientFacilities(nupi).map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county, status: f?.status };
    });

    await logAudit({
      event:       "patient_history_accessed",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      ipAddress:   req.ip,
    });

    res.json({
      success: true,
      nupi,
      patient: {
        name:                 patient.name,
        registeredAt:         patient.registeredAt,
        registeredAtFacility: patient.facilityId,
        lastSeenAt:           patient.lastSeenAt,
        lastEncounterDate:    patient.lastEncounterDate,
      },
      facilitiesVisited,
      encounterIndex,
      auditTrail: chain.getAuditTrail(nupi),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/patients/:nupi/encounters ──────────────────────────────────────
router.get("/:nupi/encounters", requireFacility, async (req, res) => {
  try {
    const { nupi } = req.params;

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    const encounters = chain.getPatientEncounterList(nupi);

    await logAudit({
      event:       "patient_encounter_index_accessed",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      metadata:    { count: encounters.length },
      ipAddress:   req.ip,
    });

    res.json({ success: true, nupi, encounters, count: encounters.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ROUTE: GET /api/patients/:nupi/disease-programs
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:nupi/disease-programs", requireFacility, async (req, res) => {
  try {
    const { nupi } = req.params;

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    const diseasePrograms = chain.getPatientDiseasePrograms(nupi);

    await logAudit({
      event:       "patient_disease_programs_accessed",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      metadata:    { count: diseasePrograms.length },
      ipAddress:   req.ip,
    });

    res.json({ 
      success: true, 
      nupi, 
      diseasePrograms,
      count: diseasePrograms.length 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ROUTE: POST /api/patients/:nupi/disease-programs/enroll
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/:nupi/disease-programs/enroll", requireFacility, async (req, res) => {
  try {
    const { nupi } = req.params;
    const { programId, programName, startDate, conditions } = req.body;

    if (!programId || !programName)
      return res.status(400).json({ error: "programId and programName required" });

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    const result = chain.enrollInDiseaseProgram({
      nupi,
      programId,
      programName,
      startDate: startDate || new Date().toISOString(),
      conditions: conditions || [],
    });

    await logAudit({
      event:       "patient_enrolled_in_disease_program",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      metadata:    { programId, programName },
      ipAddress:   req.ip,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ROUTE: PATCH /api/patients/:nupi/disease-programs/:programId
// ═══════════════════════════════════════════════════════════════════════════════
router.patch("/:nupi/disease-programs/:programId", requireFacility, async (req, res) => {
  try {
    const { nupi, programId } = req.params;
    const { status, notes } = req.body;

    if (!status)
      return res.status(400).json({ error: "status required (active, on-hold, completed)" });

    const patient = chain.getPatient(nupi);
    if (!patient)
      return res.status(404).json({ error: "Patient not on AfyaNet" });

    const result = chain.updateDiseaseProgramStatus({
      nupi,
      programId,
      status,
      notes,
    });

    await logAudit({
      event:       "disease_program_status_updated",
      patientNupi: nupi,
      facilityId:  req.facilityId,
      success:     true,
      metadata:    { programId, status },
      ipAddress:   req.ip,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;