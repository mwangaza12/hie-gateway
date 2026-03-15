// gateway/src/routes/facilities.routes.js
// Public directory of registered facilities — no auth required.

import { Router } from 'express';
import { col }    from '../services/firebase.js';

const router = Router();

// GET /api/facilities
// Returns all active registered facilities.
// Optional query params: ?county=Nairobi  ?q=hospital  ?limit=100
router.get('/', async (req, res) => {
  try {
    const { county, q, limit = 100 } = req.query;

    let query = col.facilities.where('active', '==', true);
    if (county) query = query.where('county', '==', county);

    const snap = await query.limit(parseInt(limit)).get();

    let facilities = snap.docs.map(d => {
      const data = d.data();
      return {
        facilityId:   data.facilityId,
        name:         data.name,
        type:         data.type      || 'Hospital',
        county:       data.county    || '',
        subCounty:    data.subCounty || '',
        apiUrl:       data.apiUrl    || '',
        active:       data.active    ?? true,
        registeredAt: data.registeredAt?.toDate?.() || data.registeredAt || null,
      };
    });

    if (q) {
      const search = q.toLowerCase();
      facilities = facilities.filter(f =>
        f.name.toLowerCase().includes(search)   ||
        f.county.toLowerCase().includes(search) ||
        f.type.toLowerCase().includes(search)
      );
    }

    facilities.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, facilities, count: facilities.length });
  } catch (err) {
    console.error('GET /api/facilities error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/facilities/:facilityId
// Single facility lookup — name, county, type.
router.get('/:facilityId', async (req, res) => {
  try {
    const doc = await col.facilities.doc(req.params.facilityId).get();
    if (!doc.exists)
      return res.status(404).json({ success: false, error: 'Facility not found' });

    const data = doc.data();
    res.json({
      success: true,
      facility: {
        facilityId:   data.facilityId,
        name:         data.name,
        type:         data.type      || 'Hospital',
        county:       data.county    || '',
        subCounty:    data.subCounty || '',
        apiUrl:       data.apiUrl    || '',
        active:       data.active    ?? true,
        registeredAt: data.registeredAt?.toDate?.() || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/facilities/:facilityId/firebase-config
//
//  Returns the Firebase credentials for this facility's project.
//  Used by the mobile app during setup to initialize Firebase
//  dynamically — so ONE APK works for all facilities.
//
//  Protected by X-Api-Key so only registered facilities can fetch
//  their own config. The apiKey is verified against the chain.
//
//  The facility document in Firestore must include a
//  'firebaseConfig' map with the following fields:
//    {
//      apiKey:             "AIza...",
//      appId:              "1:123:android:abc",
//      projectId:          "clinic-connect-nairobi",
//      messagingSenderId:  "123456789",
//      storageBucket:      "clinic-connect-nairobi.appspot.com",
//      authDomain:         "clinic-connect-nairobi.firebaseapp.com"  (optional)
//    }
//
//  HOW TO ADD FIREBASE CONFIG TO A FACILITY:
//    In the MoH admin panel (or directly in Firestore), add the
//    firebaseConfig map to the facility document before onboarding.
// ══════════════════════════════════════════════════════════════════
router.get('/:facilityId/firebase-config', async (req, res) => {
  try {
    const { facilityId } = req.params;
    const apiKey         = req.headers['x-api-key'];

    if (!apiKey)
      return res.status(401).json({ success: false, error: 'X-Api-Key header required' });

    // Verify the API key against the chain before revealing Firebase creds
    const { chain } = await import('../services/chain.js');
    const check = await chain.verifyFacilityKey(facilityId, apiKey);
    if (!check.valid)
      return res.status(401).json({ success: false, error: 'Invalid facility credentials' });

    const doc = await col.facilities.doc(facilityId).get();
    if (!doc.exists)
      return res.status(404).json({ success: false, error: 'Facility not found' });

    const data = doc.data();

    if (!data.firebaseConfig || !data.firebaseConfig.apiKey)
      return res.status(404).json({
        success: false,
        error:   'Firebase configuration not set up for this facility. Contact your MoH administrator.',
      });

    // Return facility info + Firebase credentials together
    // so the app can display the facility name and init Firebase in one call.
    // apiUrl is the facility's own backend URL — the Flutter app saves it so
    // all subsequent calls go through the facility backend (not the gateway).
    res.json({
      success: true,
      facilityId:   data.facilityId,
      facilityName: data.name,
      county:       data.county    || '',
      subCounty:    data.subCounty || '',
      apiUrl:       data.apiUrl    || '',   // ← facility backend URL
      firebaseConfig: {
        apiKey:            data.firebaseConfig.apiKey,
        appId:             data.firebaseConfig.appId,
        projectId:         data.firebaseConfig.projectId,
        messagingSenderId: data.firebaseConfig.messagingSenderId || '',
        storageBucket:     data.firebaseConfig.storageBucket     || '',
        authDomain:        data.firebaseConfig.authDomain        || '',
      },
    });
  } catch (err) {
    console.error(`GET /api/facilities/${req.params.facilityId}/firebase-config error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;