/**
 * AfyaLink Kenya — HIE Gateway + Blockchain  v4
 */

import express   from "express";
import axios     from "axios";
import cors      from "cors";
import helmet    from "helmet";
import crypto    from "crypto";
import admin     from "firebase-admin";
import jwt       from "jsonwebtoken";
import "dotenv/config";

//  EXPRESS

const app = express();
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } } }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*", credentials: true }));
app.use(express.json({ limit: "10mb" }));

//  FIREBASE

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();
console.log("✅ Firebase Firestore connected");

const col = {
  facilities:   db.collection("facilities"),
  accessTokens: db.collection("access_tokens"),
  auditLog:     db.collection("audit_log"),
};

const BC = "hie_chain";
const cref = {
  meta:      ()   => db.collection(BC).doc("meta"),
  facility:  (id) => db.collection(BC).doc("facilities").collection("docs").doc(id),
  facs:      ()   => db.collection(BC).doc("facilities").collection("docs"),
  patient:   (id) => db.collection(BC).doc("patients").collection("docs").doc(id),
  pats:      ()   => db.collection(BC).doc("patients").collection("docs"),
  consent:   (id) => db.collection(BC).doc("consents").collection("docs").doc(id),
  cons:      ()   => db.collection(BC).doc("consents").collection("docs"),
  identity:  (id) => db.collection(BC).doc("identities").collection("docs").doc(id),
  ids:       ()   => db.collection(BC).doc("identities").collection("docs"),
  staff:     (id) => db.collection(BC).doc("staff").collection("docs").doc(id),
  allStaff:  ()   => db.collection(BC).doc("staff").collection("docs"),
  encounter: (id) => db.collection(BC).doc("encounters").collection("docs").doc(id),
  encounters:()   => db.collection(BC).doc("encounters").collection("docs"),
};

//  BLOCKCHAIN ENGINE

class AfyaChain {
  constructor() {
    this.chain      = [];
    this.facilities = {};
    this.patients   = {};
    this.consents   = {};
    this.identities = {};
    this.staff      = {};
    this.encounters = {};
    this._ready       = false;
    this._initPromise = this._init();
  }

  async _init() {
    try {
      await this._loadAll();
      if (!this.chain.length) await this._genesis();
      this._ready = true;
      console.log(`⛓  AfyaChain: ${this.chain.length} blocks | ${Object.keys(this.facilities).length} facilities | ${Object.keys(this.patients).length} patients | ${Object.keys(this.encounters).length} encounters`);
    } catch (err) {
      console.error("⛓  AfyaChain init failed —", err.message);
      if (!this.chain.length) this._genesisSync();
      this._ready = true;
    }
  }

  async ready() { if (!this._ready) await this._initPromise; }

  async _loadAll() {
    const [meta, facSnap, patSnap, conSnap, idSnap, staffSnap, encSnap] = await Promise.all([
      cref.meta().get(), cref.facs().get(), cref.pats().get(),
      cref.cons().get(), cref.ids().get(),  cref.allStaff().get(),
      cref.encounters().get(),
    ]);
    this.chain = meta.exists ? (meta.data().chain || []) : [];
    facSnap.docs.forEach(d   => { this.facilities[d.id] = d.data(); });
    patSnap.docs.forEach(d   => { this.patients[d.id]   = d.data(); });
    conSnap.docs.forEach(d   => { this.consents[d.id]   = d.data().list || []; });
    idSnap.docs.forEach(d    => { this.identities[d.id] = d.data(); });
    staffSnap.docs.forEach(d => { this.staff[d.id]      = d.data(); });
    encSnap.docs.forEach(d   => { this.encounters[d.id] = d.data(); });
  }

  async _persist(opts = {}) {
    const batch = db.batch();
    batch.set(cref.meta(), { chain: this.chain, updatedAt: new Date().toISOString() }, { merge: false });
    if (opts.facility)   batch.set(cref.facility(opts.facility),   this.facilities[opts.facility]);
    if (opts.patient)    batch.set(cref.patient(opts.patient),     this.patients[opts.patient]);
    if (opts.consent)    batch.set(cref.consent(opts.consent),     { list: this.consents[opts.consent] || [] });
    if (opts.identity)   batch.set(cref.identity(opts.identity),   this.identities[opts.identity]);
    if (opts.staffId)    batch.set(cref.staff(opts.staffId),       this.staff[opts.staffId]);
    if (opts.encounterId)batch.set(cref.encounter(opts.encounterId),this.encounters[opts.encounterId]);
    await batch.commit();
  }

  static sha256(data) {
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
  }
  static hashSecret(s) {
    return AfyaChain.sha256(s.toString().toLowerCase().trim());
  }
  static genNupi(nationalId, dob) {
    return "NUPI-" + AfyaChain.sha256(
      `${nationalId.toUpperCase().trim()}|${dob}|AFYALINK_KENYA_2025`
    ).substring(0, 40).toUpperCase();
  }

  get _last() { return this.chain[this.chain.length - 1]; }

  _mkBlock(type, data) {
    const index    = this.chain.length;
    const prevHash = this._last?.hash || "0".repeat(64);
    const ts       = new Date().toISOString();
    const body     = { index, type, data, timestamp: ts, previousHash: prevHash };
    return { ...body, hash: AfyaChain.sha256({ ...body, nonce: index * 13 }) };
  }

  _genesisSync() {
    this.chain.push(this._mkBlock("GENESIS", {
      message: "AfyaLink Kenya Health Information Exchange",
      version: "4.0.0", authority: "Ministry of Health Kenya",
    }));
  }

  async _genesis() { this._genesisSync(); await this._persist(); }

  async _append(type, data) {
    const b = this._mkBlock(type, data);
    this.chain.push(b);
    return b;
  }

  async registerFacility({ facilityId, name, mohLicense, type, county, fhirUrl, adminEmail, approvedBy }) {
    await this.ready();
    if (this.facilities[facilityId]) return { success: false, error: "Facility already on chain" };

    const apiKey  = "FAC-" + AfyaChain.sha256(facilityId + Date.now()).substring(0, 32).toUpperCase();
    const keyHash = AfyaChain.sha256(apiKey);

    const block = await this._append("FACILITY_REGISTERED", {
      facilityId, name, mohLicense, type, county, fhirUrl, adminEmail, approvedBy, keyHash,
    });

    this.facilities[facilityId] = {
      facilityId, name, mohLicense, type, county, fhirUrl, adminEmail,
      status: "ACTIVE", registeredAt: block.timestamp, blockIndex: block.index, keyHash,
    };

    await this._persist({ facility: facilityId });
    return { success: true, facilityId, apiKey, block };
  }

  async suspendFacility(facilityId, reason, by) {
    await this.ready();
    if (!this.facilities[facilityId]) return { success: false, error: "Not found" };
    const block = await this._append("FACILITY_SUSPENDED", { facilityId, reason, suspendedBy: by });
    this.facilities[facilityId].status = "SUSPENDED";
    await this._persist({ facility: facilityId });
    return { success: true, block };
  }

  async reactivateFacility(facilityId, by) {
    await this.ready();
    if (!this.facilities[facilityId]) return { success: false, error: "Not found" };
    const block = await this._append("FACILITY_REACTIVATED", { facilityId, reactivatedBy: by });
    this.facilities[facilityId].status = "ACTIVE";
    await this._persist({ facility: facilityId });
    return { success: true, block };
  }

  async verifyFacilityKey(facilityId, apiKey) {
    await this.ready();
    const fac = this.facilities[facilityId];
    if (!fac)                     return { valid: false, reason: "Facility not registered on AfyaNet" };
    if (fac.status !== "ACTIVE")  return { valid: false, reason: `Facility is ${fac.status}` };
    const match = AfyaChain.sha256(apiKey) === fac.keyHash;
    return match ? { valid: true, facility: fac } : { valid: false, reason: "Invalid API key" };
  }

  getFacility(facilityId) { return this.facilities[facilityId] || null; }
  listFacilities()        { return Object.values(this.facilities); }

  async credentialStaff({ staffId, facilityId, name, role, addedBy }) {
    await this.ready();
    const block = await this._append("STAFF_CREDENTIALED", { staffId, facilityId, name, role, addedBy });
    this.staff[staffId] = { staffId, facilityId, name, role, credentialedAt: block.timestamp };
    await this._persist({ staffId });
    return { success: true, block };
  }

  async registerPatient({ nationalId, dob, name, securityQuestion, securityAnswer, pin, facilityId }) {
    await this.ready();
    const nupi = AfyaChain.genNupi(nationalId, dob);
    if (this.patients[nupi]) return { success: true, nupi, alreadyExists: true };

    this.identities[nupi] = {
      question:       securityQuestion,
      answerHash:     AfyaChain.hashSecret(securityAnswer),
      pinHash:        AfyaChain.hashSecret(pin),
      failedAttempts: 0,
      lockedUntil:    null,
    };

    const block = await this._append("PATIENT_REGISTERED", {
      nupi,
      idMasked:     nationalId.slice(0, 2) + "****" + nationalId.slice(-2),
      dobYear:      dob.split("-")[0],
      registeredAt: facilityId,
    });

    this.patients[nupi] = {
      nupi, name, facilityId,
      facilitiesVisited: [facilityId],
      registeredAt: block.timestamp,
      blockIndex:   block.index,
    };

    if (!this.consents[nupi]) this.consents[nupi] = [];
    this.consents[nupi].push({
      consentId:   "NETCON-" + nupi.slice(5, 21),
      facilityId:  "ALL_NETWORK",
      consentType: "NETWORK_DEFAULT",
      status:      "ACTIVE",
      grantedAt:   block.timestamp,
      expiresAt:   null,
    });

    await this._persist({ patient: nupi, consent: nupi, identity: nupi });
    return { success: true, nupi, alreadyExists: false, block };
  }

  generateNupi(nationalId, dob) { return AfyaChain.genNupi(nationalId, dob); }
  getPatient(nupi)               { return this.patients[nupi] || null; }

  async recordEncounter({ nupi, facilityId, encounterId, encounterType, encounterDate, chiefComplaint, practitionerName }) {
    await this.ready();
    if (!this.patients[nupi]) return { success: false, error: "Patient not on AfyaNet" };

    const block = await this._append("ENCOUNTER_RECORDED", {
      nupi, facilityId, encounterId, encounterType,
      encounterDate: encounterDate || new Date().toISOString(),
      chiefComplaint: chiefComplaint || null,
      practitionerName: practitionerName || null,
    });

    this.encounters[encounterId] = {
      encounterId, nupi, facilityId, encounterType,
      encounterDate: encounterDate || block.timestamp,
      blockIndex: block.index,
    };

    const patient = this.patients[nupi];
    if (!patient.facilitiesVisited.includes(facilityId)) {
      patient.facilitiesVisited.push(facilityId);
    }
    patient.lastSeenAt        = facilityId;
    patient.lastEncounterDate = block.timestamp;

    await this._persist({ patient: nupi, encounterId });
    return { success: true, encounterId, blockIndex: block.index, block };
  }

  getPatientFacilities(nupi) {
    const patient = this.patients[nupi];
    if (!patient) return [];
    return patient.facilitiesVisited || [];
  }

  getPatientEncounterIndex(nupi) {
    return Object.values(this.encounters).filter(e => e.nupi === nupi);
  }

  async grantConsent({ nupi, facilityId, consentType, durationDays, notes, grantedBy }) {
    await this.ready();
    if (!this.consents[nupi]) this.consents[nupi] = [];
    const consentId = "CON-" + AfyaChain.sha256(nupi + facilityId + Date.now()).slice(0, 16).toUpperCase();
    const expiresAt = durationDays ? new Date(Date.now() + durationDays * 86400000).toISOString() : null;
    const block = await this._append("CONSENT_GRANTED", { nupi, facilityId, consentType, expiresAt, grantedBy });
    this.consents[nupi].push({ consentId, facilityId, consentType, status: "ACTIVE", grantedAt: block.timestamp, expiresAt, notes });
    await this._persist({ consent: nupi });
    return { success: true, consentId, block };
  }

  async revokeConsent(nupi, consentId, by) {
    await this.ready();
    const c = (this.consents[nupi] || []).find(x => x.consentId === consentId);
    if (!c) return { success: false, error: "Consent not found" };
    c.status = "REVOKED";
    const block = await this._append("CONSENT_REVOKED", { nupi, consentId, revokedBy: by });
    await this._persist({ consent: nupi });
    return { success: true, block };
  }

  hasConsent(nupi, facilityId) {
    const now = new Date();
    return (this.consents[nupi] || []).some(c =>
      (c.facilityId === facilityId || c.facilityId === "ALL_NETWORK") &&
      c.status === "ACTIVE" && (!c.expiresAt || new Date(c.expiresAt) > now)
    );
  }

  listConsents(nupi) { return this.consents[nupi] || []; }

  getSecurityQuestion(nationalId, dob) {
    const nupi = AfyaChain.genNupi(nationalId, dob);
    const id   = this.identities[nupi];
    if (!id) return { found: false };
    return { found: true, nupi, question: id.question };
  }

  async verifyByAnswer(nationalId, dob, answer) {
    return this._checkSecret(AfyaChain.genNupi(nationalId, dob), nationalId, "answer", answer);
  }

  async verifyByPin(nationalId, dob, pin) {
    return this._checkSecret(AfyaChain.genNupi(nationalId, dob), nationalId, "pin", pin);
  }

  async _checkSecret(nupi, nationalId, type, value) {
    await this.ready();
    if (!this.patients[nupi]) return { success: false, error: "Patient not registered on AfyaNet" };
    const id = this.identities[nupi];
    if (!id) return { success: false, error: "Identity record not found" };
    if (id.lockedUntil && new Date(id.lockedUntil) > new Date())
      return { success: false, locked: true, error: `Account locked until ${id.lockedUntil}` };

    const field = type === "pin" ? "pinHash" : "answerHash";
    if (AfyaChain.hashSecret(value) !== id[field]) {
      id.failedAttempts = (id.failedAttempts || 0) + 1;
      if (id.failedAttempts >= 5)
        id.lockedUntil = new Date(Date.now() + 30 * 60000).toISOString();
      await this._persist({ identity: nupi });
      return { success: false, error: `Incorrect ${type === "pin" ? "PIN" : "answer"}. ${Math.max(0, 5 - id.failedAttempts)} attempts remaining.`, attemptsRemaining: Math.max(0, 5 - id.failedAttempts) };
    }

    id.failedAttempts = 0;
    id.lockedUntil    = null;
    await this._append("IDENTITY_VERIFIED", {
      nupi, method: type,
      idMasked: nationalId.slice(0, 2) + "****" + nationalId.slice(-2),
    });
    await this._persist({ identity: nupi });
    return { success: true, nupi, patient: this.patients[nupi] };
  }

  async logReferral({ nupi, fromFacility, toFacility, reason, urgency, issuedBy }) {
    await this.ready();
    const referralId = "REF-" + AfyaChain.sha256(nupi + Date.now()).slice(0, 16).toUpperCase();
    const block = await this._append("REFERRAL_ISSUED", { referralId, nupi, fromFacility, toFacility, reason, urgency, issuedBy });
    await this._persist();
    return { success: true, referralId, block };
  }

  async logAccess(nupi, eventType, actor, details = {}) {
    await this.ready();
    const block = await this._append(eventType, { nupi, actor, ...details });
    await this._persist();
    return block;
  }

  getAuditTrail(nupi) { return this.chain.filter(b => b.data?.nupi === nupi); }

  verifyIntegrity() {
    for (let i = 1; i < this.chain.length; i++) {
      const b = this.chain[i], prev = this.chain[i - 1];
      if (b.previousHash !== prev.hash) return { valid: false, brokenAt: i };
      const { hash, ...rest } = b;
      if (AfyaChain.sha256({ ...rest, nonce: b.index * 13 }) !== hash) return { valid: false, tamperedAt: i };
    }
    return { valid: true, blocks: this.chain.length };
  }

  getStats() {
    const types = {};
    this.chain.forEach(b => { types[b.type] = (types[b.type] || 0) + 1; });
    return {
      totalBlocks:      this.chain.length,
      facilities:       Object.keys(this.facilities).length,
      activeFacilities: Object.values(this.facilities).filter(f => f.status === "ACTIVE").length,
      patients:         Object.keys(this.patients).length,
      encounters:       Object.keys(this.encounters).length,
      eventTypes:       types,
      latestBlock:      this._last,
    };
  }

  recentBlocks(n = 20) { return this.chain.slice(-n).reverse(); }
}

const chain = new AfyaChain();

// ── Rate limiting REMOVED ─────────────────────────────────────────
// Removed generalLimiter, verifyLimiter, mohLimiter
// No rate limiting on any routes

//  AUDIT LOGGING

async function logAudit(event) {
  try {
    await col.auditLog.add({ ...event, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    console.log("📝 AUDIT:", event.event);
  } catch (err) {
    console.error("Audit log failed:", err.message);
  }
}

//  FHIR R4 UTILITIES

const FHIR = {
  createBundle(type = "collection", entries = []) {
    return {
      resourceType: "Bundle", type,
      id: `bundle-${crypto.randomBytes(8).toString("hex")}`,
      meta: { lastUpdated: new Date().toISOString() },
      total: entries.length,
      entry: entries.map(r => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r })),
    };
  },
  operationOutcome(severity, code, diagnostics) {
    return { resourceType: "OperationOutcome", issue: [{ severity, code, diagnostics }] };
  },
};

//  MIDDLEWARE — MoH JWT

const MOH_SECRET = process.env.MOH_JWT_SECRET || "moh_dev_secret_change_me";

function signMohToken(email) {
  return jwt.sign({ email, role: "MOH_ADMIN" }, MOH_SECRET, { expiresIn: "10h" });
}

function requireMoH(req, res, next) {
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

//  MIDDLEWARE — Facility API key

async function requireFacility(req, res, next) {
  const facilityId = req.headers["x-facility-id"];
  const apiKey     = req.headers["x-api-key"];

  if (!facilityId || !apiKey)
    return res.status(401).json({ error: "X-Facility-Id and X-Api-Key headers required" });

  const check = await chain.verifyFacilityKey(facilityId, apiKey);

  if (!check.valid) {
    await chain.logAccess("SYSTEM", "UNAUTHORIZED_ACCESS_ATTEMPT", facilityId, {
      reason: check.reason, ip: req.ip, path: req.path,
    });
    await logAudit({ event: "unauthorized_facility_attempt", facilityId, reason: check.reason, ipAddress: req.ip, success: false });
    return res.status(401).json({ error: check.reason });
  }

  req.facility   = check.facility;
  req.facilityId = facilityId;
  next();
}

//  MIDDLEWARE — Patient access token

async function requireAccessToken(req, res, next) {
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
    if (data.useCount >= data.maxUses)
      return res.status(429).json(FHIR.operationOutcome("error", "throttled", "Token usage limit reached"));

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

//  SHARED HELPER — Issue access token after successful verification

async function issueAccessToken(nupi, requestingFacility, method) {
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

//  ROUTES — MoH Admin  /api/moh/*

app.post("/api/moh/login", async (req, res) => {
  const { email, password } = req.body;
  if (email !== (process.env.MOH_ADMIN_EMAIL || "admin@health.go.ke") ||
      password !== process.env.MOH_ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid MoH credentials" });
  await logAudit({ event: "moh_login", email, success: true, ipAddress: req.ip });
  res.json({ success: true, token: signMohToken(email), role: "MOH_ADMIN" });
});

app.post("/api/moh/facilities/register", requireMoH, async (req, res) => {
  try {
    const { facilityId, name, mohLicense, type, county, apiUrl, fhirEndpoints, adminEmail, address } = req.body;
    if (!facilityId || !name || !mohLicense || !apiUrl || !adminEmail)
      return res.status(400).json({ error: "facilityId, name, mohLicense, apiUrl, adminEmail required" });

    const existing = await col.facilities.doc(facilityId).get();
    if (existing.exists) return res.status(409).json({ error: "Facility already registered" });

    const chainResult = await chain.registerFacility({
      facilityId, name, mohLicense,
      type:      type   || "Hospital",
      county:    county || "Unknown",
      fhirUrl:   apiUrl,
      adminEmail, approvedBy: req.moh.email,
    });
    if (!chainResult.success) return res.status(409).json(chainResult);

    await col.facilities.doc(facilityId).set({
      facilityId, name, mohLicense,
      type:    type   || "Hospital",
      county:  county || "Unknown",
      apiUrl,
      apiKeyHash: AfyaChain.sha256(chainResult.apiKey),
      fhirVersion: "R4",
      fhirEndpoints: {
        patient:     "/fhir/Patient/:id",
        encounter:   "/fhir/Encounter?patient=:id",
        observation: "/fhir/Observation?patient=:id",
        condition:   "/fhir/Condition?patient=:id",
        bundle:      "/fhir/Patient/:id/$everything",
        ...fhirEndpoints,
      },
      adminEmail, address: address || null,
      active: true, verified: false,
      blockIndex:   chainResult.block.index,
      blockHash:    chainResult.block.hash,
      registeredBy: req.moh.email,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    await logAudit({ event: "facility_registered", facilityId, success: true, ipAddress: req.ip, metadata: { name, blockIndex: chainResult.block.index } });
    console.log(`✅ Facility registered: ${name} | Block #${chainResult.block.index}`);

    res.json({
      success: true, facilityId,
      apiKey:    chainResult.apiKey,
      blockIndex: chainResult.block.index,
      blockHash:  chainResult.block.hash,
      message:   `${name} registered. Save the API key — it will not be shown again.`,
      usage:     "Set X-Facility-Id and X-Api-Key headers on all requests to the gateway",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/moh/facilities/:id/suspend", requireMoH, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "reason required" });
    const result = await chain.suspendFacility(req.params.id, reason, req.moh.email);
    if (!result.success) return res.status(404).json(result);
    await col.facilities.doc(req.params.id).update({ active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await logAudit({ event: "facility_suspended", facilityId: req.params.id, success: true, ipAddress: req.ip });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/moh/facilities/:id/reactivate", requireMoH, async (req, res) => {
  try {
    const result = await chain.reactivateFacility(req.params.id, req.moh.email);
    if (!result.success) return res.status(404).json(result);
    await col.facilities.doc(req.params.id).update({ active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/moh/facilities", requireMoH, async (req, res) => {
  try {
    const snap = await col.facilities.get();
    const facilities = snap.docs.map(d => {
      const data = d.data();
      return { ...data, chainStatus: chain.getFacility(data.facilityId)?.status || "NOT_ON_CHAIN", registeredAt: data.registeredAt?.toDate?.() || data.registeredAt };
    });
    res.json({ success: true, facilities, count: facilities.length, chainStats: chain.getStats() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/moh/staff/credential", requireMoH, async (req, res) => {
  try {
    const { staffId, facilityId, name, role } = req.body;
    if (!staffId || !facilityId || !name || !role)
      return res.status(400).json({ error: "staffId, facilityId, name, role required" });
    const result = await chain.credentialStaff({ staffId, facilityId, name, role, addedBy: req.moh.email });
    res.json({ success: true, blockIndex: result.block.index });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/moh/chain/stats",       requireMoH, (req, res) => res.json({ success: true, ...chain.getStats() }));
app.get("/api/moh/chain/verify",      requireMoH, (req, res) => res.json(chain.verifyIntegrity()));
app.get("/api/moh/chain/blocks",      requireMoH, (req, res) => res.json({ success: true, blocks: chain.recentBlocks(parseInt(req.query.limit) || 20) }));
app.get("/api/moh/chain/audit/:nupi", requireMoH, (req, res) => res.json({ success: true, trail: chain.getAuditTrail(req.params.nupi) }));

//  ROUTES — PUBLIC FACILITY LIST

app.get("/api/facilities", async (req, res) => {
  try {
    const snap = await col.facilities.where("active", "==", true).get();
    const facilities = snap.docs.map(d => {
      const data = d.data();
      return { facilityId: data.facilityId, name: data.name, county: data.county, type: data.type, active: data.active, verified: data.verified };
    });
    res.json({ success: true, facilities, count: facilities.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

//  ROUTES — PATIENT REGISTRATION

app.post("/api/patients/register", requireFacility, async (req, res) => {
  try {
    const { nationalId, dob, name, securityQuestion, securityAnswer, pin } = req.body;
    if (!nationalId || !dob || !name || !securityQuestion || !securityAnswer || !pin)
      return res.status(400).json({ error: "nationalId, dob, name, securityQuestion, securityAnswer, pin required" });
    if (pin.toString().length !== 4)
      return res.status(400).json({ error: "PIN must be exactly 4 digits" });

    const result = await chain.registerPatient({
      nationalId, dob, name, securityQuestion, securityAnswer, pin,
      facilityId: req.facilityId,
    });

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

app.post("/api/patients/encounter", requireFacility, async (req, res) => {
  try {
    const { nupi, encounterId, encounterType, encounterDate, chiefComplaint, practitionerName } = req.body;
    if (!nupi || !encounterId)
      return res.status(400).json({ error: "nupi and encounterId required" });

    const result = await chain.recordEncounter({
      nupi, facilityId: req.facilityId, encounterId,
      encounterType:    encounterType    || "outpatient",
      encounterDate:    encounterDate    || new Date().toISOString(),
      chiefComplaint:   chiefComplaint   || null,
      practitionerName: practitionerName || null,
    });

    if (!result.success) return res.status(400).json(result);

    await logAudit({ event: "encounter_recorded", patientNupi: nupi, facilityId: req.facilityId, success: true, metadata: { encounterId, encounterType }, ipAddress: req.ip });

    res.json({
      success:    true,
      encounterId,
      blockIndex: result.blockIndex,
      message:    `Encounter recorded on blockchain at ${req.facility.name}`,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/patients/nupi", requireFacility, async (req, res) => {
  const { nationalId, dob } = req.body;
  if (!nationalId || !dob) return res.status(400).json({ error: "nationalId and dob required" });
  res.json({ success: true, nupi: chain.generateNupi(nationalId, dob) });
});

app.get("/api/patients/:nupi/consents", requireFacility, (req, res) => {
  res.json({ success: true, consents: chain.listConsents(req.params.nupi) });
});

app.get("/api/patients/:nupi/history", requireFacility, async (req, res) => {
  try {
    const { nupi } = req.params;
    const patient  = chain.getPatient(nupi);
    if (!patient) return res.status(404).json({ error: "Patient not on AfyaNet" });

    const encounterIndex    = chain.getPatientEncounterIndex(nupi);
    const facilitiesVisited = chain.getPatientFacilities(nupi);

    const facilitiesDetail = facilitiesVisited.map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county, status: f?.status };
    });

    await logAudit({ event: "patient_history_accessed", patientNupi: nupi, facilityId: req.facilityId, success: true, ipAddress: req.ip });

    res.json({
      success: true, nupi,
      patient: { name: patient.name, registeredAt: patient.registeredAt, registeredAtFacility: patient.facilityId, lastSeenAt: patient.lastSeenAt, lastEncounterDate: patient.lastEncounterDate },
      facilitiesVisited: facilitiesDetail,
      encounterIndex,
      auditTrail: chain.getAuditTrail(nupi),
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

//  ROUTES — IDENTITY VERIFICATION

app.post("/api/verify/question", async (req, res) => {
  try {
    const { nationalId, dob } = req.body;
    if (!nationalId || !dob) return res.status(400).json({ error: "nationalId and dob required" });

    const result = chain.getSecurityQuestion(nationalId, dob);
    if (!result.found)
      return res.status(404).json({ success: false, error: "Patient not registered on AfyaNet" });

    await logAudit({ event: "security_question_fetched", patientNupi: result.nupi, success: true, ipAddress: req.ip });
    res.json({ success: true, nupi: result.nupi, question: result.question });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/verify/answer", async (req, res) => {
  try {
    const { nationalId, dob, answer, requestingFacility } = req.body;
    if (!nationalId || !dob || !answer || !requestingFacility)
      return res.status(400).json({ error: "nationalId, dob, answer, requestingFacility required" });

    const facCheck = await chain.verifyFacilityKey(requestingFacility, req.headers["x-api-key"] || "");
    if (!facCheck.valid)
      return res.status(403).json({ error: `Requesting facility not authorised: ${facCheck.reason}` });

    const verification = await chain.verifyByAnswer(nationalId, dob, answer);
    if (!verification.success) {
      await logAudit({ event: "verification_failed", patientNupi: verification.nupi, facilityId: requestingFacility, success: false, ipAddress: req.ip });
      return res.status(401).json(verification);
    }

    const tokenData = await issueAccessToken(verification.nupi, requestingFacility, "security_question");

    const encounterIndex    = chain.getPatientEncounterIndex(verification.nupi);
    const facilitiesVisited = chain.getPatientFacilities(verification.nupi).map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county };
    });

    await logAudit({ event: "patient_verified", patientNupi: verification.nupi, facilityId: requestingFacility, success: true, method: "security_question", ipAddress: req.ip });

    res.json({ success: true, ...tokenData, patient: verification.patient, facilitiesVisited, encounterIndex });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/verify/pin", async (req, res) => {
  try {
    const { nationalId, dob, pin, requestingFacility } = req.body;
    if (!nationalId || !dob || !pin || !requestingFacility)
      return res.status(400).json({ error: "nationalId, dob, pin, requestingFacility required" });

    const facCheck = await chain.verifyFacilityKey(requestingFacility, req.headers["x-api-key"] || "");
    if (!facCheck.valid)
      return res.status(403).json({ error: `Requesting facility not authorised: ${facCheck.reason}` });

    const verification = await chain.verifyByPin(nationalId, dob, pin);
    if (!verification.success) return res.status(401).json(verification);

    const tokenData         = await issueAccessToken(verification.nupi, requestingFacility, "pin");
    const encounterIndex    = chain.getPatientEncounterIndex(verification.nupi);
    const facilitiesVisited = chain.getPatientFacilities(verification.nupi).map(fid => {
      const f = chain.getFacility(fid);
      return { facilityId: fid, name: f?.name || "Unknown", county: f?.county };
    });

    res.json({ success: true, ...tokenData, patient: verification.patient, facilitiesVisited, encounterIndex });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

//  ROUTES — FHIR R4

async function fetchFromFacility(nupi, resourceType, targetFacilityId, req, res) {
  const facDoc = await col.facilities.doc(targetFacilityId).get();
  if (!facDoc.exists || !facDoc.data().active)
    return res.status(404).json(FHIR.operationOutcome("error", "not-found", `Facility ${targetFacilityId} not found or inactive`));

  const facility    = facDoc.data();
  const endpointKey = resourceType.toLowerCase();
  const path        = facility.fhirEndpoints[endpointKey];
  if (!path)
    return res.status(404).json(FHIR.operationOutcome("error", "not-found", `Facility has no ${resourceType} endpoint`));

  const url = `${facility.apiUrl}${path.replace(":id", nupi)}`;
  console.log(`🔄 ${resourceType} → ${facility.name} (${targetFacilityId}): ${nupi}`);

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "Accept": "application/fhir+json", "X-Gateway-ID": "HIE_GATEWAY", "X-Requesting-Facility": req.facilityId },
    });

    await chain.logAccess(nupi, "RECORD_ACCESSED", req.facilityId, {
      resource: resourceType, sourceFacility: targetFacilityId, method: "fhir_get",
    });
    await logAudit({ event: "fhir_accessed", patientNupi: nupi, facilityId: req.facilityId, sourceFacility: targetFacilityId, resource: resourceType, success: true, ipAddress: req.ip });

    res.set("Content-Type", "application/fhir+json");
    res.json(response.data);
  } catch (err) {
    if (err.response?.status === 404)
      return res.status(404).json(FHIR.operationOutcome("error", "not-found", `No ${resourceType} found for patient at ${facility.name}`));
    throw err;
  }
}

app.get("/api/fhir/Patient/:nupi", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { nupi }   = req.params;
    const facilityId = req.query.facility || req.facilityId;
    await fetchFromFacility(nupi, "patient", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

app.get("/api/fhir/Patient/:nupi/Encounter", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "encounter", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

app.get("/api/fhir/Patient/:nupi/Observation", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "observation", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

app.get("/api/fhir/Patient/:nupi/Condition", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const facilityId = req.query.facility;
    if (!facilityId) return res.status(400).json(FHIR.operationOutcome("error", "required", "?facility=FACILITY_ID required"));
    await fetchFromFacility(req.params.nupi, "condition", facilityId, req, res);
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

app.get("/api/fhir/Patient/:nupi/\\$everything", requireFacility, requireAccessToken, async (req, res) => {
  try {
    const { nupi } = req.params;
    console.log(`🌐 $everything for ${nupi} — requested by ${req.facilityId}`);

    const visitedFacilityIds = chain.getPatientFacilities(nupi);
    if (!visitedFacilityIds.length)
      return res.json(FHIR.createBundle("collection", []));

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

    await chain.logAccess(nupi, "RECORD_ACCESSED", req.facilityId, {
      resource: "Bundle", method: "fhir_everything",
      facilitiesQueried: facilities.length,
      facilitiesSuccess: results.filter(r => r.success).length,
    });
    await logAudit({ event: "federated_fhir_accessed", patientNupi: nupi, facilityId: req.facilityId, success: true, metadata: { facilitiesQueried: facilities.length, totalResources: allResources.length }, ipAddress: req.ip });

    console.log(`✅ $everything: ${allResources.length} resources from ${results.filter(r => r.success).length}/${facilities.length} facilities`);
    res.set("Content-Type", "application/fhir+json");
    res.json(FHIR.createBundle("collection", allResources));
  } catch (err) { res.status(500).json(FHIR.operationOutcome("error", "exception", err.message)); }
});

//  ROUTES — REFERRALS

app.post("/api/referrals", requireFacility, async (req, res) => {
  try {
    const { nupi, toFacility, reason, urgency, issuedBy } = req.body;
    if (!nupi || !toFacility || !reason)
      return res.status(400).json({ error: "nupi, toFacility, reason required" });
    res.json(await chain.logReferral({ nupi, fromFacility: req.facilityId, toFacility, reason, urgency: urgency || "ROUTINE", issuedBy }));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

//  ROUTES — AUDIT

app.get("/api/audit", requireFacility, async (req, res) => {
  try {
    const { limit = 100, event, patientNupi } = req.query;
    let query = col.auditLog.orderBy("timestamp", "desc").limit(parseInt(limit));
    if (event)       query = query.where("event",       "==", event);
    if (patientNupi) query = query.where("patientNupi", "==", patientNupi);
    const snap = await query.get();
    res.json({ success: true, logs: snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toDate() })), count: snap.size });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

//  HEALTH CHECK

app.get("/health", async (req, res) => {
  try {
    await db.collection("_health").doc("ping").set({ ts: admin.firestore.FieldValue.serverTimestamp() });
    const facilitiesCount = (await col.facilities.where("active", "==", true).get()).size;
    const stats = chain.getStats();
    res.json({
      status: "ok", uptime: process.uptime(),
      database: "Firebase Firestore", fhirVersion: "R4",
      blockchain: { blocks: stats.totalBlocks, facilities: stats.activeFacilities, patients: stats.patients, encounters: stats.encounters, integrity: chain.verifyIntegrity().valid ? "✅ valid" : "❌ BROKEN" },
      hie: { facilitiesCount },
      timestamp: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ status: "error", error: err.message }); }
});

//  START

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🏥 AfyaLink HIE Gateway + Blockchain v4`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n   MoH login:            POST /api/moh/login`);
  console.log(`   Register facility:    POST /api/moh/facilities/register  (MoH token)`);
  console.log(`   Register patient:     POST /api/patients/register        (X-Facility-Id + X-Api-Key)`);
  console.log(`   Record encounter:     POST /api/patients/encounter        (X-Facility-Id + X-Api-Key)`);
  console.log(`   Get question:         POST /api/verify/question`);
  console.log(`   Verify + get token:   POST /api/verify/answer             (X-Facility-Id + X-Api-Key)`);
  console.log(`   Patient history:      GET  /api/patients/:nupi/history    (X-Facility-Id + X-Api-Key)`);
  console.log(`   Federated records:    GET  /api/fhir/Patient/:nupi/$everything\n`);

  // ── Keep-alive — prevents Render free tier from sleeping ──────────
  // Render spins down free services after 15 min of inactivity.
  // Self-ping every 10 minutes keeps the server warm.
  if (process.env.RENDER_EXTERNAL_URL) {
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
    setInterval(() => {
      axios.get(pingUrl, { timeout: 10000 })
        .then(r => console.log(`🏓 Keep-alive ping → ${r.status}`))
        .catch(e => console.warn(`⚠️  Keep-alive ping failed: ${e.message}`));
    }, 10 * 60 * 1000); // every 10 minutes
    console.log(`🏓 Keep-alive active → ${pingUrl}`);
  }
});