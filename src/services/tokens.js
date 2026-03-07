import crypto from "crypto";
import { col, admin } from "./firebase.js";
import { chain } from "./chain.js";

export async function issueAccessToken(nupi, requestingFacility, method) {
  const consentResult = await chain.grantConsent({
    nupi, facilityId: requestingFacility,
    consentType:  method === "security_question" ? "ID_VERIFIED" : "PIN_VERIFIED",
    durationDays: 1,
    notes:        `Verified by ${method} at ${new Date().toISOString()}`,
    grantedBy:    requestingFacility,
  });

  const token = crypto.randomBytes(32).toString("hex");
  await col.accessTokens.doc(token).set({
    token, patientNupi: nupi, requestingFacility,
    verificationMethod: method,
    consentId:   consentResult.consentId,
    blockIndex:  consentResult.block?.index,
    scopes:      ["read:Patient", "read:Encounter", "read:Observation", "read:Condition", "read:Bundle", "write:Encounter"],
    grantedAt:   admin.firestore.FieldValue.serverTimestamp(),
    expiresAt:   new Date(Date.now() + 24 * 60 * 60 * 1000),
    useCount: 0, maxUses: 200,
  });

  return { token, nupi, consentId: consentResult.consentId, blockIndex: consentResult.block?.index, expiresIn: 86400 };
}