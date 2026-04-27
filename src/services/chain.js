// hie-gateway-main/src/services/chain.js
// COMPLETE UPDATED FILE WITH DISEASE PROGRAM SUPPORT

import crypto from "crypto";
import { db, cref, admin } from "./firebase.js";

export class AfyaChain {
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
    if (opts.facility)    batch.set(cref.facility(opts.facility),    this.facilities[opts.facility]);
    if (opts.patient)     batch.set(cref.patient(opts.patient),      this.patients[opts.patient]);
    if (opts.consent)     batch.set(cref.consent(opts.consent),      { list: this.consents[opts.consent] || [] });
    if (opts.identity)    batch.set(cref.identity(opts.identity),    this.identities[opts.identity]);
    if (opts.staffId)     batch.set(cref.staff(opts.staffId),        this.staff[opts.staffId]);
    if (opts.encounterId) batch.set(cref.encounter(opts.encounterId),this.encounters[opts.encounterId]);
    await batch.commit();
  }

  static sha256(data)      { return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"); }
  static hashSecret(s)     { return AfyaChain.sha256(s.toString().toLowerCase().trim()); }
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

  // ── Facilities ──────────────────────────────────────────────────

  async registerFacility({ facilityId, name, mohLicense, type, county, fhirUrl, adminEmail, approvedBy }) {
    await this.ready();
    if (this.facilities[facilityId]) return { success: false, error: "Facility already on chain" };
    const apiKey  = "FAC-" + AfyaChain.sha256(facilityId + Date.now()).substring(0, 32).toUpperCase();
    const keyHash = AfyaChain.sha256(apiKey);
    const block   = await this._append("FACILITY_REGISTERED", { facilityId, name, mohLicense, type, county, fhirUrl, adminEmail, approvedBy, keyHash });
    this.facilities[facilityId] = { facilityId, name, mohLicense, type, county, fhirUrl, adminEmail, status: "ACTIVE", registeredAt: block.timestamp, blockIndex: block.index, keyHash };
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

  async rotateApiKey(facilityId, rotatedBy) {
    await this.ready();
    const fac = this.facilities[facilityId];
    if (!fac)                    return { success: false, error: 'Facility not found' };
    if (fac.status !== 'ACTIVE') return { success: false, error: `Facility is ${fac.status} — reactivate before rotating key` };

    const newApiKey  = 'FAC-' + AfyaChain.sha256(facilityId + Date.now() + 'ROTATE').substring(0, 32).toUpperCase();
    const newKeyHash = AfyaChain.sha256(newApiKey);

    const block = await this._append('FACILITY_KEY_ROTATED', {
      facilityId,
      oldKeyHash:  fac.keyHash,
      newKeyHash,
      rotatedBy,
      rotatedAt:   new Date().toISOString(),
    });

    this.facilities[facilityId].keyHash = newKeyHash;
    await this._persist({ facility: facilityId });

    return { success: true, facilityId, apiKey: newApiKey, block };
  }

  async verifyFacilityKey(facilityId, apiKey) {
    await this.ready();
    console.log("🔑 verifyFacilityKey:", facilityId, "| match:", AfyaChain.sha256(apiKey) === this.facilities[facilityId]?.keyHash);
    const fac = this.facilities[facilityId];
    if (!fac)                    return { valid: false, reason: "Facility not registered on AfyaNet" };
    if (fac.status !== "ACTIVE") return { valid: false, reason: `Facility is ${fac.status}` };
    return AfyaChain.sha256(apiKey) === fac.keyHash
      ? { valid: true, facility: fac }
      : { valid: false, reason: "Invalid API key" };
  }

  getFacility(facilityId)  { return this.facilities[facilityId] || null; }
  listFacilities()         { return Object.values(this.facilities); }

  // ── Staff ───────────────────────────────────────────────────────

  async credentialStaff({ staffId, facilityId, name, role, addedBy }) {
    await this.ready();
    const block = await this._append("STAFF_CREDENTIALED", { staffId, facilityId, name, role, addedBy });
    this.staff[staffId] = { staffId, facilityId, name, role, credentialedAt: block.timestamp };
    await this._persist({ staffId });
    return { success: true, block };
  }

  // ── Patients ────────────────────────────────────────────────────

  async registerPatient({ nationalId, dob, name, securityQuestion, securityAnswer, pin, facilityId,
                           gender, phoneNumber, email, county, subCounty, ward, village }) {
    await this.ready();
    const nupi = AfyaChain.genNupi(nationalId, dob);
    if (this.patients[nupi]) return { success: true, nupi, alreadyExists: true };

    this.identities[nupi] = {
      question: securityQuestion, answerHash: AfyaChain.hashSecret(securityAnswer),
      pinHash: AfyaChain.hashSecret(pin), failedAttempts: 0, lockedUntil: null,
    };

    const block = await this._append("PATIENT_REGISTERED", {
      nupi, idMasked: nationalId.slice(0, 2) + "****" + nationalId.slice(-2),
      dobYear: dob.split("-")[0], registeredAt: facilityId,
    });

    this.patients[nupi] = {
      nupi, name, facilityId,
      facilitiesVisited: [facilityId],
      registeredAt: block.timestamp,
      blockIndex:   block.index,
      dob:         dob         || null,
      gender:      gender      || null,
      phoneNumber: phoneNumber || null,
      email:       email       || null,
      county:      county      || null,
      subCounty:   subCounty   || null,
      ward:        ward        || null,
      village:     village     || null,
      diseasePrograms: [],  // ← NEW: Initialize empty disease programs array
    };

    if (!this.consents[nupi]) this.consents[nupi] = [];
    this.consents[nupi].push({
      consentId: "NETCON-" + nupi.slice(5, 21), facilityId: "ALL_NETWORK",
      consentType: "NETWORK_DEFAULT", status: "ACTIVE",
      grantedAt: block.timestamp, expiresAt: null,
    });

    await this._persist({ patient: nupi, consent: nupi, identity: nupi });
    return { success: true, nupi, alreadyExists: false, block };
  }

  generateNupi(nationalId, dob) { return AfyaChain.genNupi(nationalId, dob); }
  getPatient(nupi)               { return this.patients[nupi] || null; }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW: Disease Program Methods
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get disease programs (CarePlans) for a patient
   */
  getPatientDiseasePrograms(nupi) {
    const patient = this.patients[nupi];
    if (!patient) return [];

    // Disease programs stored as array in patient record
    return patient.diseasePrograms || [];
  }

  /**
   * Enroll patient in disease program.
   * Async so the route can await it and surface Firestore errors cleanly.
   */
  async enrollInDiseaseProgram({ nupi, programId, programName, startDate, conditions = [] }) {
    const patient = this.patients[nupi];
    if (!patient) throw new Error("Patient not found");

    if (!patient.diseasePrograms) patient.diseasePrograms = [];

    const existing = patient.diseasePrograms.find(p => p.id === programId);
    if (existing) {
      return { success: false, error: "Patient already enrolled in this program" };
    }

    const enrollmentDate = startDate || new Date().toISOString();
    const facility = this.getFacility(patient.facilityId);

    const program = {
      id: programId,
      programName,
      status: "active",
      enrollmentDate,
      conditions,
      lastUpdated: new Date().toISOString(),
      enrolledByFacility:   facility?.name || "Unknown",
      enrolledByFacilityId: patient.facilityId,
    };

    patient.diseasePrograms.push(program);

    // Persist to Firestore with retry — must succeed before chain block is written
    await this._retryPersistPatient(nupi, "DISEASE_PROGRAM_ENROLLMENT");

    await this._append("DISEASE_PROGRAM_ENROLLMENT", {
      nupi,
      programId,
      programName,
      facilityId: patient.facilityId,
      enrollmentDate,
      conditions,
      timestamp: new Date().toISOString(),
    });

    return { success: true, program };
  }

  /**
   * Update disease program status.
   * Async so the route can await it and surface Firestore errors cleanly.
   */
  async updateDiseaseProgramStatus({ nupi, programId, status, notes }) {
    const patient = this.patients[nupi];
    if (!patient || !patient.diseasePrograms)
      throw new Error("Patient or programs not found");

    const program = patient.diseasePrograms.find(p => p.id === programId);
    if (!program) throw new Error("Disease program not found");

    const oldStatus = program.status;
    program.status      = status;
    program.lastUpdated = new Date().toISOString();
    if (notes) program.notes = notes;
    if (status === "completed") program.completedDate = new Date().toISOString();

    // Persist to Firestore with retry — must succeed before chain block is written
    await this._retryPersistPatient(nupi, "DISEASE_PROGRAM_STATUS_CHANGE");

    await this._append("DISEASE_PROGRAM_STATUS_CHANGE", {
      nupi,
      programId,
      programName: program.programName,
      oldStatus,
      newStatus: status,
      notes: notes || null,
      timestamp: new Date().toISOString(),
    });

    return { success: true, program };
  }

  /**
   * Persist a patient document to Firestore with exponential-backoff retry.
   *
   * Attempts: 1 immediate + up to MAX_RETRIES more, doubling the delay each
   * time (1 s → 2 s → 4 s).  On final failure the patient snapshot and the
   * operation name are written to col.failedPersists so an admin or background
   * job can replay them without losing data.
   *
   * @param {string} nupi        - Patient NUPI (document key)
   * @param {string} operation   - Label for failure logging (e.g. "DISEASE_PROGRAM_ENROLLMENT")
   * @param {number} [maxRetries=3]
   */
  async _retryPersistPatient(nupi, operation, maxRetries = 3) {
    const patient = this.patients[nupi];
    if (!patient) return;

    const payload = {
      ...patient,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    };

    let attempt = 0;
    let delayMs  = 1000;

    while (attempt <= maxRetries) {
      try {
        await cref.patient(nupi).set(payload, { merge: true });
        if (attempt > 0) {
          console.log(`⛓  _retryPersistPatient: ${nupi} succeeded on attempt ${attempt + 1}`);
        }
        return;
      } catch (err) {
        attempt++;
        if (attempt > maxRetries) break;
        console.warn(
          `⛓  _retryPersistPatient: attempt ${attempt}/${maxRetries} failed for ${nupi} ` +
          `(${operation}) — retrying in ${delayMs}ms. Error: ${err.message}`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }

    // All retries exhausted — write to dead-letter collection for manual replay
    const failureId = `${nupi}_${Date.now()}`;
    console.error(
      `⛓  _retryPersistPatient: all ${maxRetries} retries exhausted for ${nupi} ` +
      `(${operation}). Writing to failed_persists/${failureId}`
    );

    try {
      await col.failedPersists.doc(failureId).set({
        nupi,
        operation,
        patientSnapshot: patient,
        failedAt:        new Date().toISOString(),
        retries:         maxRetries,
        resolved:        false,
      });
    } catch (deadLetterErr) {
      // Absolute last resort — at least the in-memory state is correct
      console.error(
        `⛓  _retryPersistPatient: CRITICAL — failed_persists write also failed for ${nupi}. ` +
        `Error: ${deadLetterErr.message}`
      );
    }

    // Re-throw so the caller (route handler) can return a 500 to the client
    // rather than silently returning success with a diverged Firestore state.
    throw new Error(
      `Firestore persist failed for patient ${nupi} after ${maxRetries} retries (${operation})`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // END: Disease Program Methods
  // ═══════════════════════════════════════════════════════════════════════════════

  // ── Encounters ──────────────────────────────────────────────────

  async recordEncounter({ nupi, facilityId, encounterId, encounterType, encounterDate, chiefComplaint, practitionerName }) {
    await this.ready();
    if (!this.patients[nupi]) return { success: false, error: "Patient not on AfyaNet" };
    const block = await this._append("ENCOUNTER_RECORDED", {
      nupi, facilityId, encounterId, encounterType,
      encounterDate: encounterDate || new Date().toISOString(),
      chiefComplaint: chiefComplaint || null,
      practitionerName: practitionerName || null,
    });
    this.encounters[encounterId] = { encounterId, nupi, facilityId, encounterType, encounterDate: encounterDate || block.timestamp, blockIndex: block.index };
    const patient = this.patients[nupi];
    if (!patient.facilitiesVisited.includes(facilityId)) patient.facilitiesVisited.push(facilityId);
    patient.lastSeenAt        = facilityId;
    patient.lastEncounterDate = block.timestamp;
    await this._persist({ patient: nupi, encounterId });
    return { success: true, encounterId, blockIndex: block.index, block };
  }

  getPatientFacilities(nupi)     { return this.patients[nupi]?.facilitiesVisited || []; }
  getPatientEncounterList(nupi)  {
    return Object.values(this.encounters)
      .filter(e => e.nupi === nupi)
      .sort((a, b) => new Date(b.encounterDate) - new Date(a.encounterDate))
      .map(e => ({
        encounterId:   e.encounterId,
        facilityId:    e.facilityId,
        facilityName:  this.getFacility(e.facilityId)?.name || e.facilityId,
        encounterType: e.encounterType,
        encounterDate: e.encounterDate,
        blockIndex:    e.blockIndex,
      }));
  }
  // In chain.js getPatientEncounterIndex method:
  getPatientEncounterIndex(nupi) {
    const encounters = this.getPatientEncounterList(nupi);
    console.log('🔍 Raw encounters for', nupi, ':', JSON.stringify(encounters, null, 2));
    return encounters;
  }

  // In your chain service, add a method to list all encounters:
  getAllEncounters() {
    const allEncounters = [];
    for (const block of this.chain) {
      if (block.data?.type === 'encounter') {
        allEncounters.push(block.data);
      }
    }
    return allEncounters;
  }
  // ── Consents ────────────────────────────────────────────────────

  async grantConsent({ nupi, facilityId, consentType, durationDays, notes, grantedBy }) {
    await this.ready();
    if (!this.consents[nupi]) this.consents[nupi] = [];
    const consentId = "CON-" + AfyaChain.sha256(nupi + facilityId + Date.now()).slice(0, 16).toUpperCase();
    const expiresAt = durationDays ? new Date(Date.now() + durationDays * 86400000).toISOString() : null;
    const block     = await this._append("CONSENT_GRANTED", { nupi, facilityId, consentType, expiresAt, grantedBy });
    this.consents[nupi].push({ consentId, facilityId, consentType, status: "ACTIVE", grantedAt: block.timestamp, expiresAt, notes });
    await this._persist({ consent: nupi });
    return { success: true, consentId, block };
  }

  async revokeConsent(nupi, consentId, by) {
    await this.ready();
    const c = (this.consents[nupi] || []).find(x => x.consentId === consentId);
    if (!c) return { success: false, error: "Consent not found" };
    c.status = "REVOKED";
    await this._append("CONSENT_REVOKED", { nupi, consentId, revokedBy: by });
    await this._persist({ consent: nupi });
    return { success: true };
  }

  hasConsent(nupi, facilityId) {
    const now = new Date();
    return (this.consents[nupi] || []).some(c =>
      (c.facilityId === facilityId || c.facilityId === "ALL_NETWORK") &&
      c.status === "ACTIVE" && (!c.expiresAt || new Date(c.expiresAt) > now)
    );
  }

  listConsents(nupi) { return this.consents[nupi] || []; }

  // ── Identity Verification ───────────────────────────────────────

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
      if (id.failedAttempts >= 5) id.lockedUntil = new Date(Date.now() + 30 * 60000).toISOString();
      await this._persist({ identity: nupi });
      return { success: false, error: `Incorrect ${type === "pin" ? "PIN" : "answer"}. ${Math.max(0, 5 - id.failedAttempts)} attempts remaining.`, attemptsRemaining: Math.max(0, 5 - id.failedAttempts) };
    }

    id.failedAttempts = 0;
    id.lockedUntil    = null;
    await this._append("IDENTITY_VERIFIED", { nupi, method: type, idMasked: nationalId.slice(0, 2) + "****" + nationalId.slice(-2) });
    await this._persist({ identity: nupi });
    const p = this.patients[nupi];
    return {
      success: true, nupi,
      patient: {
        nupi: p.nupi, name: p.name, facilityId: p.facilityId,
        registeredAt: p.registeredAt, facilitiesVisited: p.facilitiesVisited,
        dob: p.dob || null, gender: p.gender || null,
        phoneNumber: p.phoneNumber || null, email: p.email || null,
        county: p.county || null, subCounty: p.subCounty || null,
        ward: p.ward || null, village: p.village || null,
      },
    };
  }

  // ── Referrals ───────────────────────────────────────────────────

  async logReferral({ nupi, fromFacility, toFacility, reason, urgency, issuedBy,
                      patientName, clinicalNotes }) {
    await this.ready();
    const referralId = "REF-" + AfyaChain.sha256(nupi + Date.now()).slice(0, 16).toUpperCase();
    const block      = await this._append("REFERRAL_ISSUED", {
      referralId, nupi, fromFacility, toFacility, reason, urgency, issuedBy,
      patientName:   patientName   || null,
      clinicalNotes: clinicalNotes || null,
    });
    await this._persist();
    return { success: true, referralId, block };
  }

  async updateReferralStatus({ referralId, status, updatedBy, notes }) {
    await this.ready();
    const block = await this._append("REFERRAL_STATUS_UPDATED", {
      referralId, status, updatedBy: updatedBy || null,
      notes: notes || null, updatedAt: new Date().toISOString(),
    });
    await this._persist();
    return { success: true, referralId, status, block };
  }

  _getReferralLatestStatus(referralId) {
    const updates = this.chain
      .filter(b => b.type === "REFERRAL_STATUS_UPDATED" && b.data?.referralId === referralId)
      .sort((a, b) => b.index - a.index);
    return updates.length ? updates[0].data.status : null;
  }

  getReferralsForFacility(facilityId, direction) {
    const field = direction === "incoming" ? "toFacility" : "fromFacility";
    return this.chain
      .filter(b => b.type === "REFERRAL_ISSUED" && b.data?.[field] === facilityId)
      .map(b => {
        const latestStatus = this._getReferralLatestStatus(b.data.referralId);
        return {
          referralId:       b.data.referralId,
          patientNupi:      b.data.nupi,
          patientName:      b.data.patientName   || null,
          fromFacilityId:   b.data.fromFacility,
          fromFacilityName: this.getFacility(b.data.fromFacility)?.name || b.data.fromFacility,
          toFacilityId:     b.data.toFacility,
          toFacilityName:   this.getFacility(b.data.toFacility)?.name   || b.data.toFacility,
          reason:           b.data.reason,
          urgency:          b.data.urgency       || "ROUTINE",
          issuedBy:         b.data.issuedBy      || null,
          clinicalNotes:    b.data.clinicalNotes  || null,
          status:           latestStatus          || "pending",
          blockIndex:       b.index,
          createdAt:        b.timestamp,
        };
      });
  }

  // ── Audit & Integrity ───────────────────────────────────────────

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
      totalBlocks: this.chain.length,
      facilities:       Object.keys(this.facilities).length,
      activeFacilities: Object.values(this.facilities).filter(f => f.status === "ACTIVE").length,
      patients:    Object.keys(this.patients).length,
      encounters:  Object.keys(this.encounters).length,
      eventTypes:  types,
      latestBlock: this._last,
    };
  }

  recentBlocks(n = 20) { return this.chain.slice(-n).reverse(); }
}

export const chain = new AfyaChain();