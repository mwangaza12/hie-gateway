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

// ─── GET /api/fhir/Patient/:nupi ──────────────────────────────────────────────
router.get("/Patient/:nupi", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { nupi } = req.params;
    const facilityId = req.query.facility || req.facilityId;

    if (!req.query.facility) {
      console.warn(
        `⚠️  GET /fhir/Patient/${nupi} called without ?facility param. ` +
        `Falling back to requesting facility ${req.facilityId}. ` +
        `Demographics will be empty for cross-facility patients.`
      );
    }

    await fetchFromFacility(nupi, "patient", facilityId, req, res);
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
});

// ─── GET /api/fhir/Patient/:nupi/Encounter ────────────────────────────────────
router.get("/Patient/:nupi/Encounter", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "encounter", facilityId, req, res);
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
});

// ─── GET /api/fhir/Patient/:nupi/Observation ──────────────────────────────────
router.get("/Patient/:nupi/Observation", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "observation", facilityId, req, res);
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
});

// ─── GET /api/fhir/Patient/:nupi/Condition ────────────────────────────────────
router.get("/Patient/:nupi/Condition", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "condition", facilityId, req, res);
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
});

// ─── GET /api/fhir/Patient/:nupi/$everything ──────────────────────────────────
router.get("/Patient/:nupi/\\$everything", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { nupi } = req.params;
    const registeredFacilityId = req.query.registeredFacility || null;

    console.log(`🌐 $everything for ${nupi} — requested by ${req.facilityId}, registeredFacility=${registeredFacilityId ?? 'not provided'}`);

    const blockchainFacilityIds = chain.getPatientFacilities(nupi);

    const allFacilityIds = registeredFacilityId
      ? [...new Set([registeredFacilityId, ...blockchainFacilityIds])]
      : blockchainFacilityIds;

    if (!allFacilityIds.length) return res.json(FHIR.createBundle("collection", []));

    const facilities = (await Promise.all(
      allFacilityIds.map(id => col.facilities.doc(id).get())
    )).filter(d => d.exists && d.data().active).map(d => d.data());

    const results = await Promise.all(facilities.map(async (facility) => {
      try {
        const endpoint =
          facility.fhirEndpoints.bundle?.replace(":id", nupi) ||
          facility.fhirEndpoints.encounter?.replace(":id", nupi);

        if (!endpoint) {
          console.warn(`⚠️  Facility ${facility.facilityId} has no bundle/encounter endpoint`);
          return { facilityId: facility.facilityId, facilityName: facility.name, success: false };
        }

        const response = await axios.get(`${facility.apiUrl}${endpoint}`, {
          timeout: 10000,
          headers: {
            "Accept": "application/fhir+json",
            "X-Gateway-ID": "HIE_GATEWAY",
            "X-Requesting-Facility": req.facilityId,
          },
        });
        return { facilityId: facility.facilityId, facilityName: facility.name, data: response.data, success: true };
      } catch {
        return { facilityId: facility.facilityId, facilityName: facility.name, success: false };
      }
    }));

    const allResources = [];
    results.forEach(r => {
      if (!r.success || !r.data) return;
      const items = r.data.resourceType === "Bundle"
        ? r.data.entry?.map(e => e.resource).filter(Boolean)
        : [r.data];
      items?.forEach(resource => {
        resource.meta = { ...(resource.meta || {}), source: r.facilityId, sourceName: r.facilityName };
        allResources.push(resource);
      });
    });

    await chain.logAccess(nupi, "RECORD_ACCESSED", req.facilityId, {
      resource: "Bundle", method: "fhir_everything",
      facilitiesQueried: facilities.length,
      facilitiesSuccess: results.filter(r => r.success).length,
    });
    await logAudit({
      event: "federated_fhir_accessed", patientNupi: nupi, facilityId: req.facilityId, success: true,
      metadata: { facilitiesQueried: facilities.length, totalResources: allResources.length },
      ipAddress: req.ip,
    });

    console.log(`✅ $everything: ${allResources.length} resources from ${results.filter(r => r.success).length}/${facilities.length} facilities`);
    res.set("Content-Type", "application/fhir+json");
    res.json(FHIR.createBundle("collection", allResources));
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
});

// ─── GET /api/fhir/Encounter/:encounterId ─────────────────────────────────────
// Fetches a single encounter by ID.
// Requires ?facility=FACILITY_ID (the facility that owns the encounter).
// Strategy:
//   1. Try facility's dedicated encounterById endpoint if configured.
//   2. Fallback: fetch the full encounter bundle and filter by ID.
router.get("/Encounter/:encounterId", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { encounterId } = req.params;
    const facilityId = req.query.facility;

    if (!facilityId)
      return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));

    const facDoc = await col.facilities.doc(facilityId).get();
    if (!facDoc.exists || !facDoc.data().active)
      return res.status(404).json(FHIR.operationOutcome("error", "not-found", `Facility ${facilityId} not found or inactive`));

    const facility = facDoc.data();

    // ── Strategy 1: dedicated single-encounter endpoint ──────────────
    const singlePath = facility.fhirEndpoints?.encounterById;
    if (singlePath) {
      const url = `${facility.apiUrl}${singlePath.replace(":id", encounterId)}`;
      try {
        const response = await axios.get(url, {
          timeout: 10000,
          headers: { "Accept": "application/fhir+json", "X-Gateway-ID": "HIE_GATEWAY", "X-Requesting-Facility": req.facilityId },
        });
        if (response.data?.resourceType === "Encounter") {
          response.data.meta = { ...(response.data.meta || {}), source: facilityId, sourceName: facility.name };
          res.set("Content-Type", "application/fhir+json");
          return res.json(response.data);
        }
      } catch (_) {
        console.warn(`⚠️  encounterById endpoint failed for ${facilityId}, falling back to bundle search`);
      }
    }

    // ── Strategy 2: fetch bundle, filter by ID ────────────────────────
    const bundlePath = facility.fhirEndpoints?.encounter;
    if (!bundlePath)
      return res.status(404).json(FHIR.operationOutcome("error", "not-found", "Facility has no encounter endpoint"));

    // NUPI is stored on the verified access token
    const nupi = req.accessToken?.patientNupi;
    if (!nupi)
      return res.status(400).json(FHIR.operationOutcome("error", "required", "Could not determine patient NUPI from access token"));

    const bundleUrl = `${facility.apiUrl}${bundlePath.replace(":id", nupi)}`;
    console.log(`🔄 Encounter/${encounterId} — bundle search at ${facility.name}: ${bundleUrl}`);

    const bundleResponse = await axios.get(bundleUrl, {
      timeout: 10000,
      headers: { "Accept": "application/fhir+json", "X-Gateway-ID": "HIE_GATEWAY", "X-Requesting-Facility": req.facilityId },
    });

    const entries = bundleResponse.data?.entry ?? [];
    const match = entries
      .map(e => e.resource ?? e)
      .find(r => r?.id === encounterId || r?.id?.toString() === encounterId);

    if (!match)
      return res.status(404).json(FHIR.operationOutcome("error", "not-found", `Encounter ${encounterId} not found at ${facility.name}`));

    match.meta = { ...(match.meta || {}), source: facilityId, sourceName: facility.name };

    await chain.logAccess(nupi, "RECORD_ACCESSED", req.facilityId, {
      resource: "Encounter", encounterId, sourceFacility: facilityId, method: "fhir_encounter_get",
    });
    await logAudit({
      event: "fhir_encounter_accessed", patientNupi: nupi, facilityId: req.facilityId,
      sourceFacility: facilityId, success: true, ipAddress: req.ip,
    });

    res.set("Content-Type", "application/fhir+json");
    res.json(match);
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
});

export default router;