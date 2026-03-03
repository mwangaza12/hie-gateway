import express from "express";
import axios from "axios";
import cors from "cors";
import helmet from "helmet";
import crypto from "crypto";
import admin from "firebase-admin";
import rateLimit from "express-rate-limit";
import africastalking from "africastalking";
import "dotenv/config";

const app = express();

// SECURITY HEADERS
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
      },
    },
  })
);

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

// INITIALIZE FIREBASE

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

console.log('✅ Firebase Firestore connected');

// FIRESTORE COLLECTIONS
const collections = {
  facilities: db.collection('facilities'),
  otpRequests: db.collection('otp_requests'),
  accessTokens: db.collection('access_tokens'),
  auditLog: db.collection('audit_log'),
  fhirCache: db.collection('fhir_resource_cache')
};

// INITIALIZE AFRICA'S TALKING
const AT = africastalking({
  apiKey: process.env.AFRICASTALKING_API_KEY,
  username: process.env.AFRICASTALKING_USERNAME
});

const sms = AT.SMS;
console.log('✅ Africa\'s Talking SMS initialized');

// RATE LIMITING
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later'
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many OTP requests'
});

app.use('/api/', generalLimiter);
app.use('/api/otp/', otpLimiter);

// AUDIT LOGGING
async function logAudit(event) {
  try {
    await collections.auditLog.add({
      ...event,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('📝 AUDIT:', event.event);
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}

// AFRICA'S TALKING SMS SERVICE
async function sendOtpSms(phoneNumber, otp, patientNupi, requestingFacility) {
  try {
    // Format message
    const message = `Your Health Information Exchange OTP is: ${otp}
                    Valid for 5 minutes. Do NOT share this code.

                    Patient ID: ${patientNupi}
                    Requesting: ${requestingFacility}

                    HIE Gateway`;

    const options = {
      to: [phoneNumber],
      message: message,
    };

    // Add sender ID if provided
    if (process.env.AFRICASTALKING_SENDER_ID) {
      options.from = process.env.AFRICASTALKING_SENDER_ID;
    }

    console.log(`📱 Sending OTP SMS to ${phoneNumber}`);

    const response = await sms.send(options);
    
    console.log('✅ SMS Response:', response);
    
    // Check if SMS was sent successfully
    const recipient = response.SMSMessageData?.Recipients?.[0];
    if (recipient && recipient.statusCode === 101) {
      console.log('✅ SMS sent successfully');
      return {
        success: true,
        messageId: recipient.messageId,
        cost: recipient.cost
      };
    } else {
      console.error('❌ SMS failed:', recipient?.status);
      return {
        success: false,
        error: recipient?.status || 'SMS delivery failed'
      };
    }
    
  } catch (error) {
    console.error('❌ SMS sending error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// FHIR R4 UTILITIES
const FHIR = {
  /**
   * Convert internal patient to FHIR R4 Patient resource
   */
  toPatient(patient) {
    return {
      resourceType: 'Patient',
      id: patient.nupi,
      identifier: [
        {
          system: 'http://kenya.go.ke/fhir/identifier/nupi',
          value: patient.nupi,
          use: 'official'
        }
      ],
      active: true,
      name: [
        {
          use: 'official',
          family: patient.lastName,
          given: [patient.firstName, patient.middleName].filter(Boolean)
        }
      ],
      telecom: [
        patient.phoneNumber && {
          system: 'phone',
          value: patient.phoneNumber,
          use: 'mobile'
        },
        patient.email && {
          system: 'email',
          value: patient.email
        }
      ].filter(Boolean),
      gender: patient.gender === 'male' ? 'male' : patient.gender === 'female' ? 'female' : 'other',
      birthDate: patient.dateOfBirth,
      address: patient.address ? [
        {
          use: 'home',
          type: 'physical',
          country: 'KE',
          state: patient.address.county,
          district: patient.address.subCounty,
          city: patient.address.ward,
          text: `${patient.address.village}, ${patient.address.ward}, ${patient.address.subCounty}, ${patient.address.county}, Kenya`
        }
      ] : [],
      meta: {
        versionId: '1',
        lastUpdated: patient.updatedAt || new Date().toISOString(),
        profile: ['http://hl7.org/fhir/StructureDefinition/Patient']
      }
    };
  },

  /**
   * Convert internal encounter to FHIR R4 Encounter resource
   */
  toEncounter(encounter) {
    return {
      resourceType: 'Encounter',
      id: encounter.id,
      identifier: [
        {
          system: `http://${encounter.facilityId}/fhir/encounter`,
          value: encounter.id
        }
      ],
      status: encounter.status || 'finished',
      class: {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: encounter.encounterType === 'inpatient' ? 'IMP' : 
              encounter.encounterType === 'emergency' ? 'EMER' : 'AMB',
        display: encounter.encounterType === 'inpatient' ? 'inpatient encounter' : 
                encounter.encounterType === 'emergency' ? 'emergency' : 'ambulatory'
      },
      subject: {
        reference: `Patient/${encounter.patientNupi}`,
        display: `NUPI: ${encounter.patientNupi}`
      },
      period: {
        start: encounter.encounterDate,
        end: encounter.encounterDate
      },
      reasonCode: encounter.chiefComplaint ? [
        {
          coding: [],
          text: encounter.chiefComplaint
        }
      ] : [],
      serviceProvider: {
        reference: `Organization/${encounter.facilityId}`,
        display: encounter.facilityName
      },
      participant: encounter.practitionerName ? [
        {
          individual: {
            display: encounter.practitionerName
          }
        }
      ] : [],
      meta: {
        versionId: '1',
        lastUpdated: encounter.createdAt || new Date().toISOString(),
        source: encounter.facilityId,
        profile: ['http://hl7.org/fhir/StructureDefinition/Encounter']
      }
    };
  },

  /**
   * Convert vital signs to FHIR R4 Observation resources
   */
  toObservations(vitalSigns, encounterId, patientNupi) {
    if (!vitalSigns) return [];

    const observations = [];
    const vitalMap = {
      temperature: { 
        code: '8310-5', 
        display: 'Body temperature', 
        unit: 'Cel',
        system: 'http://unitsofmeasure.org'
      },
      pulse: { 
        code: '8867-4', 
        display: 'Heart rate', 
        unit: '/min',
        system: 'http://unitsofmeasure.org'
      },
      bloodPressureSystolic: { 
        code: '8480-6', 
        display: 'Systolic blood pressure', 
        unit: 'mm[Hg]',
        system: 'http://unitsofmeasure.org'
      },
      bloodPressureDiastolic: { 
        code: '8462-4', 
        display: 'Diastolic blood pressure', 
        unit: 'mm[Hg]',
        system: 'http://unitsofmeasure.org'
      },
      respiratoryRate: { 
        code: '9279-1', 
        display: 'Respiratory rate', 
        unit: '/min',
        system: 'http://unitsofmeasure.org'
      },
      oxygenSaturation: { 
        code: '2708-6', 
        display: 'Oxygen saturation', 
        unit: '%',
        system: 'http://unitsofmeasure.org'
      },
      weight: { 
        code: '29463-7', 
        display: 'Body weight', 
        unit: 'kg',
        system: 'http://unitsofmeasure.org'
      },
      height: { 
        code: '8302-2', 
        display: 'Body height', 
        unit: 'cm',
        system: 'http://unitsofmeasure.org'
      }
    };

    Object.entries(vitalSigns).forEach(([key, value]) => {
      if (vitalMap[key] && value != null) {
        const vital = vitalMap[key];
        observations.push({
          resourceType: 'Observation',
          id: `${encounterId}-obs-${key}`,
          status: 'final',
          category: [
            {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                  code: 'vital-signs',
                  display: 'Vital Signs'
                }
              ]
            }
          ],
          code: {
            coding: [
              {
                system: 'http://loinc.org',
                code: vital.code,
                display: vital.display
              }
            ],
            text: vital.display
          },
          subject: {
            reference: `Patient/${patientNupi}`
          },
          encounter: {
            reference: `Encounter/${encounterId}`
          },
          effectiveDateTime: new Date().toISOString(),
          valueQuantity: {
            value: parseFloat(value),
            unit: vital.unit,
            system: vital.system,
            code: vital.unit
          },
          meta: {
            profile: ['http://hl7.org/fhir/StructureDefinition/vitalsigns']
          }
        });
      }
    });

    return observations;
  },

  /**
   * Convert diagnoses to FHIR R4 Condition resources
   */
  toConditions(diagnoses, encounterId, patientNupi) {
    if (!diagnoses || !Array.isArray(diagnoses)) return [];

    return diagnoses.map((diagnosis, index) => ({
      resourceType: 'Condition',
      id: `${encounterId}-cond-${index}`,
      clinicalStatus: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
            code: 'active',
            display: 'Active'
          }
        ]
      },
      verificationStatus: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
            code: 'confirmed',
            display: 'Confirmed'
          }
        ]
      },
      category: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/condition-category',
              code: 'encounter-diagnosis',
              display: 'Encounter Diagnosis'
            }
          ]
        }
      ],
      code: {
        coding: [],
        text: diagnosis.name || diagnosis
      },
      subject: {
        reference: `Patient/${patientNupi}`
      },
      encounter: {
        reference: `Encounter/${encounterId}`
      },
      recordedDate: new Date().toISOString(),
      meta: {
        profile: ['http://hl7.org/fhir/StructureDefinition/Condition']
      }
    }));
  },

  /**
   * Create FHIR R4 Bundle
   */
  createBundle(type = 'collection', entries = []) {
    return {
      resourceType: 'Bundle',
      type: type,
      id: `bundle-${crypto.randomBytes(8).toString('hex')}`,
      meta: {
        lastUpdated: new Date().toISOString()
      },
      total: entries.length,
      entry: entries.map(resource => ({
        fullUrl: `${resource.resourceType}/${resource.id}`,
        resource: resource
      }))
    };
  },

  /**
   * Create FHIR OperationOutcome (for errors)
   */
  operationOutcome(severity, code, diagnostics) {
    return {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: severity, // fatal, error, warning, information
          code: code, // e.g., 'not-found', 'processing', 'invalid'
          diagnostics: diagnostics
        }
      ]
    };
  }
};

// REGISTER FACILITY
app.post('/api/facilities/register', async (req, res) => {
  try {
    const { facilityId, name, apiUrl, apiKey, fhirEndpoints, contactEmail, address } = req.body;

    if (!facilityId || !name || !apiUrl || !fhirEndpoints) {
      return res.status(400).json({
        success: false,
        error: 'facilityId, name, apiUrl, and fhirEndpoints are required'
      });
    }

    // Check if exists
    const existingDoc = await collections.facilities.doc(facilityId).get();
    if (existingDoc.exists) {
      return res.status(409).json({
        success: false,
        error: 'Facility already registered'
      });
    }

    const apiKeyHash = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex') : null;

    // Default FHIR R4 endpoints
    const defaultEndpoints = {
      patient: '/fhir/Patient/:id',
      encounter: '/fhir/Encounter?patient=:id',
      observation: '/fhir/Observation?patient=:id',
      condition: '/fhir/Condition?patient=:id',
      bundle: '/fhir/Patient/:id/$everything',
      ...fhirEndpoints
    };

    await collections.facilities.doc(facilityId).set({
      facilityId,
      name,
      apiUrl,
      apiKeyHash,
      fhirVersion: 'R4',
      fhirEndpoints: defaultEndpoints,
      contactEmail: contactEmail || null,
      address: address || null,
      active: true,
      verified: false,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logAudit({
      event: 'facility_registered',
      eventCategory: 'admin',
      facilityId,
      action: 'create',
      success: true,
      ipAddress: req.ip,
      metadata: { name, apiUrl, fhirVersion: 'R4' }
    });

    console.log(`✅ Facility registered: ${name} (FHIR R4)`);

    res.json({
      success: true,
      message: `Facility ${name} registered with FHIR R4 support`
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// LIST FACILITIES
app.get('/api/facilities', async (req, res) => {
  try {
    const snapshot = await collections.facilities
      .where('active', '==', true)
      .get();

    const facilities = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        facilityId: data.facilityId,
        name: data.name,
        apiUrl: data.apiUrl,
        fhirVersion: data.fhirVersion,
        fhirEndpoints: data.fhirEndpoints,
        contactEmail: data.contactEmail,
        active: data.active,
        verified: data.verified
      };
    });

    res.json({
      success: true,
      facilities,
      count: facilities.length
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// REQUEST OTP
app.post('/api/otp/request', async (req, res) => {
  try {
    const { patientNupi, patientPhone, requestingFacility, requestingUser } = req.body;

    if (!patientNupi || !patientPhone || !requestingFacility) {
      return res.status(400).json({
        success: false,
        error: 'patientNupi, patientPhone, and requestingFacility are required'
      });
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const requestId = crypto.randomBytes(32).toString('hex');
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    // Save OTP request to Firestore
    await collections.otpRequests.doc(requestId).set({
      requestId,
      patientNupi,
      patientPhone,
      requestingFacility,
      requestingUser: requestingUser || 'anonymous',
      otpHash,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      smsStatus: 'pending'
    });

    // SEND REAL SMS VIA AFRICA'S TALKING
    const smsResult = await sendOtpSms(patientPhone, otp, patientNupi, requestingFacility);

    // Update OTP request with SMS status
    await collections.otpRequests.doc(requestId).update({
      smsStatus: smsResult.success ? 'sent' : 'failed',
      smsMessageId: smsResult.messageId || null,
      smsCost: smsResult.cost || null,
      smsError: smsResult.error || null
    });

    await logAudit({
      event: 'otp_requested',
      eventCategory: 'auth',
      patientNupi,
      facilityId: requestingFacility,
      success: true,
      metadata: {
        smsStatus: smsResult.success ? 'sent' : 'failed',
        messageId: smsResult.messageId
      },
      ipAddress: req.ip
    });

    console.log(`OTP ${otp} for ${patientNupi} - SMS ${smsResult.success ? 'SENT' : 'FAILED'}`);

    res.json({
      success: true,
      requestId,
      expiresIn: 300,
      message: smsResult.success 
        ? `OTP sent to ${patientPhone}` 
        : `OTP generated but SMS failed. Contact support.`,
      smsDelivered: smsResult.success,
      // Only show OTP in development if SMS failed
      _demoOtp: (process.env.NODE_ENV === 'development' || !smsResult.success) ? otp : undefined
    });

  } catch (error) {
    console.error('OTP request error:', error);
    await logAudit({
      event: 'otp_request_failed',
      eventCategory: 'auth',
      success: false,
      errorMessage: error.message,
      ipAddress: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// VERIFY OTP
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { requestId, otp } = req.body;

    if (!requestId || !otp) {
      return res.status(400).json({
        success: false,
        error: 'requestId and otp are required'
      });
    }

    const otpDoc = await collections.otpRequests.doc(requestId).get();

    if (!otpDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'OTP request not found'
      });
    }

    const otpData = otpDoc.data();

    if (otpData.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `OTP already ${otpData.status}`
      });
    }

    if (otpData.expiresAt.toDate() < new Date()) {
      await collections.otpRequests.doc(requestId).update({ status: 'expired' });
      return res.status(400).json({
        success: false,
        error: 'OTP expired'
      });
    }

    if (otpData.attempts >= otpData.maxAttempts) {
      await collections.otpRequests.doc(requestId).update({ status: 'denied' });
      return res.status(429).json({
        success: false,
        error: 'Too many failed attempts'
      });
    }

    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    if (otpHash !== otpData.otpHash) {
      await collections.otpRequests.doc(requestId).update({
        attempts: admin.firestore.FieldValue.increment(1)
      });
      return res.status(400).json({
        success: false,
        error: `Invalid OTP. ${otpData.maxAttempts - otpData.attempts - 1} attempts remaining`
      });
    }

    // OTP VERIFIED!
    await collections.otpRequests.doc(requestId).update({
      status: 'verified',
      verifiedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create access token
    const accessToken = crypto.randomBytes(32).toString('hex');
    await collections.accessTokens.doc(accessToken).set({
      token: accessToken,
      otpRequestId: requestId,
      patientNupi: otpData.patientNupi,
      requestingFacility: otpData.requestingFacility,
      scopes: ['read:Patient', 'read:Encounter', 'read:Observation', 'read:Condition', 'read:Bundle'],
      grantedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      useCount: 0,
      maxUses: 100
    });

    await logAudit({
      event: 'otp_verified',
      eventCategory: 'auth',
      patientNupi: otpData.patientNupi,
      facilityId: otpData.requestingFacility,
      success: true,
      consentMethod: 'otp',
      ipAddress: req.ip
    });

    console.log(`OTP verified for ${otpData.patientNupi}`);

    res.json({
      success: true,
      token: accessToken,
      patientNupi: otpData.patientNupi,
      expiresIn: 86400,
      scopes: ['read:Patient', 'read:Encounter', 'read:Observation', 'read:Condition']
    });

  } catch (error) {
    await logAudit({
      event: 'otp_verification_error',
      eventCategory: 'auth',
      success: false,
      errorMessage: error.message,
      ipAddress: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// VERIFY ACCESS TOKEN MIDDLEWARE
async function verifyAccessToken(req, res, next) {
  try {
    const token = req.headers['x-access-token'] || 
                 req.headers['authorization']?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json(FHIR.operationOutcome('error', 'security', 'Access token required'));
    }

    const tokenDoc = await collections.accessTokens.doc(token).get();

    if (!tokenDoc.exists) {
      await logAudit({
        event: 'invalid_access_token',
        eventCategory: 'auth',
        success: false,
        ipAddress: req.ip
      });
      return res.status(401).json(FHIR.operationOutcome('error', 'security', 'Invalid access token'));
    }

    const tokenData = tokenDoc.data();

    if (tokenData.expiresAt.toDate() < new Date()) {
      return res.status(401).json(FHIR.operationOutcome('error', 'security', 'Access token expired'));
    }

    if (tokenData.useCount >= tokenData.maxUses) {
      return res.status(429).json(FHIR.operationOutcome('error', 'throttled', 'Access token usage limit exceeded'));
    }

    await collections.accessTokens.doc(token).update({
      useCount: admin.firestore.FieldValue.increment(1),
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    req.accessToken = tokenData;
    next();

  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json(FHIR.operationOutcome('error', 'exception', error.message));
  }
}

// GET FHIR PATIENT
app.get('/api/fhir/Patient/:nupi', verifyAccessToken, async (req, res) => {
  try {
    const { nupi } = req.params;
    const facilityId = req.query.facility || req.accessToken.requestingFacility;

    const facilityDoc = await collections.facilities.doc(facilityId).get();

    if (!facilityDoc.exists) {
      return res.status(404).json(FHIR.operationOutcome('error', 'not-found', 'Facility not found'));
    }

    const facility = facilityDoc.data();
    const endpoint = facility.fhirEndpoints.patient.replace(':id', nupi);
    const url = `${facility.apiUrl}${endpoint}`;

    console.log(`🔄 Fetching FHIR Patient from ${facility.name}: ${nupi}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Accept': 'application/fhir+json',
        'X-Gateway-ID': 'HIE_GATEWAY'
      }
    });

    await logAudit({
      event: 'fhir_patient_accessed',
      eventCategory: 'data_access',
      resource: 'Patient',
      resourceId: nupi,
      patientNupi: nupi,
      facilityId,
      action: 'read',
      success: true,
      ipAddress: req.ip
    });

    res.set('Content-Type', 'application/fhir+json');
    res.json(response.data);

  } catch (error) {
    console.error('FHIR fetch error:', error.message);
    res.status(500).json(FHIR.operationOutcome('error', 'exception', error.message));
  }
});

// GET FEDERATED FHIR BUNDLE ($everything)
app.get('/api/fhir/Patient/:nupi/$everything', verifyAccessToken, async (req, res) => {
  try {
    const { nupi } = req.params;

    console.log(`🌐 Fetching federated FHIR Bundle for: ${nupi}`);

    const facilitiesSnapshot = await collections.facilities
      .where('active', '==', true)
      .get();

    const facilities = facilitiesSnapshot.docs.map(doc => doc.data());

    // Fetch from all facilities
    const facilityPromises = facilities.map(async (facility) => {
      try {
        const endpoint = facility.fhirEndpoints.bundle?.replace(':id', nupi) ||
                        facility.fhirEndpoints.encounter?.replace(':id', nupi);
        const url = `${facility.apiUrl}${endpoint}`;

        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            'Accept': 'application/fhir+json',
            'X-Gateway-ID': 'HIE_GATEWAY'
          }
        });

        return {
          facilityId: facility.facilityId,
          facilityName: facility.name,
          data: response.data,
          success: true
        };
      } catch (error) {
        console.error(`Failed from ${facility.name}:`, error.message);
        return {
          facilityId: facility.facilityId,
          facilityName: facility.name,
          success: false
        };
      }
    });

    const results = await Promise.all(facilityPromises);

    // Aggregate into FHIR Bundle
    const allResources = [];

    results.forEach(result => {
      if (result.success && result.data) {
        if (result.data.resourceType === 'Bundle' && result.data.entry) {
          result.data.entry.forEach(entry => {
            if (entry.resource) {
              entry.resource.meta = entry.resource.meta || {};
              entry.resource.meta.source = result.facilityId;
              allResources.push(entry.resource);
            }
          });
        } else if (result.data.resourceType) {
          result.data.meta = result.data.meta || {};
          result.data.meta.source = result.facilityId;
          allResources.push(result.data);
        }
      }
    });

    const bundle = FHIR.createBundle('collection', allResources);

    await logAudit({
      event: 'federated_fhir_accessed',
      eventCategory: 'data_access',
      resource: 'Bundle',
      resourceId: nupi,
      patientNupi: nupi,
      facilityId: req.accessToken.requestingFacility,
      action: 'read',
      success: true,
      metadata: {
        facilitiesQueried: facilities.length,
        facilitiesSuccess: results.filter(r => r.success).length,
        totalResources: allResources.length
      },
      ipAddress: req.ip
    });

    console.log(`✅ FHIR Bundle: ${allResources.length} resources from ${results.filter(r => r.success).length} facilities`);

    res.set('Content-Type', 'application/fhir+json');
    res.json(bundle);

  } catch (error) {
    await logAudit({
      event: 'federated_fhir_error',
      eventCategory: 'data_access',
      success: false,
      errorMessage: error.message,
      ipAddress: req.ip
    });

    res.status(500).json(FHIR.operationOutcome('error', 'exception', error.message));
  }
});

// GET AUDIT LOGS
app.get('/api/audit', async (req, res) => {
  try {
    const { limit = 100, event, patientNupi } = req.query;

    let query = collections.auditLog
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit));

    if (event) {
      query = query.where('event', '==', event);
    }

    if (patientNupi) {
      query = query.where('patientNupi', '==', patientNupi);
    }

    const snapshot = await query.get();

    const logs = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate()
    }));

    res.json({
      success: true,
      logs,
      count: logs.length
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// HEALTH CHECK
app.get('/health', async (req, res) => {
  try {
    await db.collection('_health_check').doc('test').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    const facilitiesCount = (await collections.facilities.where('active', '==', true).get()).size;
    const activeOTPs = (await collections.otpRequests.where('status', '==', 'pending').get()).size;

    res.json({
      status: 'ok',
      uptime: process.uptime(),
      database: 'Firebase Firestore',
      databaseStatus: 'connected',
      fhirVersion: 'R4',
      fhirCompliant: true,
      facilitiesCount,
      activeOTPs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// START SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`PRODUCTION HIE GATEWAY running on http://localhost:${PORT}`);
});
