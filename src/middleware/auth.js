import jwt    from "jsonwebtoken";
import { chain }     from "../services/chain.js";
import { col, admin }from "../services/firebase.js";
import { logAudit }  from "../services/audit.js";
import { FHIR }      from "../services/fhir.js";

const MOH_SECRET = process.env.MOH_JWT_SECRET || "moh_dev_secret_change_me";

export function signMohToken(email) {
  return jwt.sign({ email, role: "MOH_ADMIN" }, MOH_SECRET, { expiresIn: "10h" });
}

export function requireMoH(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "MoH token required" });
  try {
    const payload = jwt.verify(auth.slice(7), MOH_SECRET);
    if (payload.role !== "MOH_ADMIN") return res.status(403).json({ error: "MoH role required" });
    req.moh = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired MoH token" });
  }
}

export async function requireFacility(req, res, next) {
  const facilityId = req.headers["x-facility-id"];
  const apiKey     = req.headers["x-api-key"];

  if (!facilityId || !apiKey)
    return res.status(401).json({ error: "X-Facility-Id and X-Api-Key headers required" });

  const check = await chain.verifyFacilityKey(facilityId, apiKey);
  if (!check.valid) {
    await chain.logAccess("SYSTEM", "UNAUTHORIZED_ACCESS_ATTEMPT", facilityId, { reason: check.reason, ip: req.ip, path: req.path });
    await logAudit({ event: "unauthorized_facility_attempt", facilityId, reason: check.reason, ipAddress: req.ip, success: false });
    return res.status(401).json({ error: check.reason });
  }

  req.facility   = check.facility;
  req.facilityId = facilityId;
  next();
}

export async function requireAccessToken(req, res, next) {
  try {
    const token = req.headers["x-access-token"] || req.headers["authorization"]?.replace("Bearer ", "");
    if (!token) return res.status(401).json(FHIR.operationOutcome("error", "security", "Access token required"));

    const doc = await col.accessTokens.doc(token).get();
    if (!doc.exists) {
      await logAudit({ event: "invalid_access_token", eventCategory: "auth", success: false, ipAddress: req.ip });
      return res.status(401).json(FHIR.operationOutcome("error", "security", "Invalid access token"));
    }

    const data = doc.data();
    if (data.expiresAt.toDate() < new Date())
      return res.status(401).json(FHIR.operationOutcome("error", "security", "Access token expired"));
    // Rate limiting disabled for development — re-enable for production
    // if (data.useCount >= data.maxUses)
    //   return res.status(429).json(FHIR.operationOutcome("error", "throttled", "Token usage limit reached"));

    await col.accessTokens.doc(token).update({
      useCount:   admin.firestore.FieldValue.increment(1),
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    req.accessToken = data;
    next();
  } catch (err) {
    res.status(500).json(FHIR.operationOutcome("error", "exception", err.message));
  }
}