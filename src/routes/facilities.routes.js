// gateway/src/routes/facilities.routes.js
// Public directory of registered facilities — no auth required.
// This is intentionally open so facilities can discover each other for referrals.

import { Router }   from 'express';
import { col }      from '../services/firebase.js';

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
        facilityId: data.facilityId,
        name:       data.name,
        type:       data.type       || 'Hospital',
        county:     data.county     || '',
        subCounty:  data.subCounty  || '',
        apiUrl:     data.apiUrl     || '',
        active:     data.active     ?? true,
        registeredAt: data.registeredAt?.toDate?.() || data.registeredAt || null,
      };
    });

    // Client-side text search if ?q= provided
    if (q) {
      const search = q.toLowerCase();
      facilities = facilities.filter(f =>
        f.name.toLowerCase().includes(search) ||
        f.county.toLowerCase().includes(search) ||
        f.type.toLowerCase().includes(search)
      );
    }

    // Sort by name
    facilities.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, facilities, count: facilities.length });
  } catch (err) {
    console.error('GET /api/facilities error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/facilities/:facilityId
// Single facility lookup — used by the gateway itself internally.
router.get('/:facilityId', async (req, res) => {
  try {
    const doc = await col.facilities.doc(req.params.facilityId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Facility not found' });

    const data = doc.data();
    res.json({
      success: true,
      facility: {
        facilityId:   data.facilityId,
        name:         data.name,
        type:         data.type     || 'Hospital',
        county:       data.county   || '',
        subCounty:    data.subCounty|| '',
        apiUrl:       data.apiUrl   || '',
        active:       data.active   ?? true,
        registeredAt: data.registeredAt?.toDate?.() || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;