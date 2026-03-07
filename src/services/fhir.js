import crypto from "crypto";

export const FHIR = {
  createBundle(type = "collection", entries = []) {
    return {
      resourceType: "Bundle", type,
      id:   `bundle-${crypto.randomBytes(8).toString("hex")}`,
      meta: { lastUpdated: new Date().toISOString() },
      total: entries.length,
      entry: entries.map(r => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r })),
    };
  },
  operationOutcome(severity, code, diagnostics) {
    return { resourceType: "OperationOutcome", issue: [{ severity, code, diagnostics }] };
  },
};