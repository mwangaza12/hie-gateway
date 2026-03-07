import { Router } from "express";
import axios      from "axios";
import { chain }  from "../services/chain.js";
import { col }    from "../services/firebase.js";
import { logAudit }                         from "../services/audit.js";
import { FHIR }                             from "../services/fhir.js";
import { requireFacility, requireAccessToken } from "../middleware/auth.js";

const router = Router();

async function fetchFromFacility(nupi, resourceType, targetFacilityId, req, res) {
  const facDoc = await col.facilities.doc(targetFacilityId).get();
  if (!facDoc.exists || !facDoc.data().active)
    return res.status(404).json(FHIR.operationOutcome("error", "not-found", `Facility ${targetFacilityId} not found or inactive`));

  const facility    = facDoc.data();
  const endpointKey = resourceType.toLowerCase();
  const path        = facility.fhirEndpoints[endpointKey];
  if (!path) return res.status(404).json(FHIR.operationOutcome("error", "not-found", `Facility has no ${resourceType} endpoint`));

  const url = `${facility.apiUrl}${path.replace(":id", nupi)}`;
  console.log(`🔄 ${resourceType} → ${facility.name} (${targetFacilityId}): ${nupi}`);

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "Accept": "application/fhir+json", "X-Gateway-ID": "HIE_GATEWAY", "X-Requesting-Facility": req.facilityId },
    });
    await chain.logAccess(nupi, "RECORD_ACCESSED", req.facilityId, { resource: resourceType, sourceFacility: targetFacilityId, method: "fhir_get" });
    await logAudit({ event: "fhir_accessed", patientNupi: nupi, facilityId: req.facilityId, sourceFacility: targetFacilityId, resource: resourceType, success: true, ipAddress: req.ip });
    res.set("Content-Type", "application/fhir+json");
    res.json(response.data);
  } catch (err) {
    if (err.response?.status === 404)
      return res.status(404).json(FHIR.operationOutcome("error", "not-found", `No ${resourceType} found for patient at ${facility.name}`));
    throw err;
  }
}

router.get("/Patient/:nupi", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { nupi }   = req.params;
    const facilityId = req.query.facility || req.facilityId;
    await fetchFromFacility(nupi, "patient", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

router.get("/Patient/:nupi/Encounter", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "encounter", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

router.get("/Patient/:nupi/Observation", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "observation", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

router.get("/Patient/:nupi/Condition", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "condition", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

router.get("/Patient/:nupi/\\$everything", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { nupi } = req.params;
    console.log(`🌐 $everything for ${nupi} — requested by ${req.facilityId}`);

    const visitedFacilityIds = chain.getPatientFacilities(nupi);
    if (!visitedFacilityIds.length) return res.json(FHIR.createBundle("collection", []));

    const facilities = (await Promise.all(
      visitedFacilityIds.map(id => col.facilities.doc(id).get())
    )).filter(d => d.exists && d.data().active).map(d => d.data());

    const results = await Promise.all(facilities.map(async (facility) => {
      try {
        const endpoint = facility.fhirEndpoints.bundle?.replace(":id", nupi) || facility.fhirEndpoints.encounter?.replace(":id", nupi);
        const response = await axios.get(`${facility.apiUrl}${endpoint}`, {
          timeout: 10000,
          headers: { "Accept": "application/fhir+json", "X-Gateway-ID": "HIE_GATEWAY", "X-Requesting-Facility": req.facilityId },
        });
        return { facilityId: facility.facilityId, facilityName: facility.name, data: response.data, success: true };
      } catch {
        return { facilityId: facility.facilityId, facilityName: facility.name, success: false };
      }
    }));

    const allResources = [];
    results.forEach(r => {
      if (!r.success || !r.data) return;
      const items = r.data.resourceType === "Bundle" ? r.data.entry?.map(e => e.resource).filter(Boolean) : [r.data];
      items?.forEach(resource => {
        resource.meta = { ...(resource.meta || {}), source: r.facilityId, sourceName: r.facilityName };
        allResources.push(resource);
      });
    });

    await chain.logAccess(nupi, "RECORD_ACCESSED", req.facilityId, { resource: "Bundle", method: "fhir_everything", facilitiesQueried: facilities.length, facilitiesSuccess: results.filter(r => r.success).length });
    await logAudit({ event: "federated_fhir_accessed", patientNupi: nupi, facilityId: req.facilityId, success: true, metadata: { facilitiesQueried: facilities.length, totalResources: allResources.length }, ipAddress: req.ip });

    console.log(`✅ $everything: ${allResources.length} resources from ${results.filter(r => r.success).length}/${facilities.length} facilities`);
    res.set("Content-Type", "application/fhir+json");
    res.json(FHIR.createBundle("collection", allResources));
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

export default router;