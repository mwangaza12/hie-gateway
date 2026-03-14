// One-off script — run once then delete.
// Usage: node patch-facility.js
// Run from the root of your hie-gateway project.

import { col } from "./src/services/firebase.js";

await col.facilities.doc("NYH_001").update({
  "fhirEndpoints.encounterById": "/fhir/Encounter/:id",
});

console.log("✅ NYH_001 fhirEndpoints.encounterById set");
process.exit(0);