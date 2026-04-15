// hie-gateway-main/src/routes/queue.routes.js
//
// Patient Queue & Triage Management API
//
// Endpoints:
//   GET  /api/queue/:facilityId/today          — today's full queue snapshot
//   GET  /api/queue/:facilityId/stats          — aggregate counts + avg wait
//   GET  /api/queue/:facilityId/critical       — critical patients only
//   PATCH /api/queue/:facilityId/:docId/status — update a queue entry status
//   POST /api/queue/:facilityId/bulk-action    — batch status update
//   GET  /api/queue/:facilityId/history        — historical queue data (date range)
//
// Auth: requireFacility middleware — X-Facility-Id + X-Api-Key headers
// All reads/writes go to the facility's Firestore instance via the
// admin SDK (same pattern as audit.js in index.js)

import { Router } from "express";
import { col, admin } from "../services/firebase.js";
import { logAudit }    from "../services/audit.js";
import { requireFacility } from "../middleware/auth.js";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function prioritySort(a, b) {
  const pa = PRIORITY_ORDER[a.priority] ?? 2;
  const pb = PRIORITY_ORDER[b.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  return new Date(a.created_at) - new Date(b.created_at);
}

function toDate(ts) {
  if (!ts) return null;
  if (ts._seconds != null) return new Date(ts._seconds * 1000);
  return new Date(ts);
}

function computeWaitMinutes(entry) {
  const created = toDate(entry.created_at);
  if (!created) return null;
  const end = toDate(entry.called_at) ?? toDate(entry.completed_at) ?? new Date();
  return Math.round((end - created) / 60000);
}

function sanitizeEntry(id, data) {
  return {
    id,
    patient_name:    data.patient_name    ?? "Unknown",
    patient_nupi:    data.patient_nupi    ?? "",
    patient_age:     data.patient_age     ?? null,
    patient_gender:  data.patient_gender  ?? "",
    priority:        data.priority        ?? "medium",
    status:          data.status          ?? "waiting",
    chief_complaint: data.chief_complaint ?? "",
    notes:           data.notes           ?? "",
    vitals:          data.vitals          ?? {},
    news2_score:     data.news2_score     ?? null,
    news2_risk:      data.news2_risk      ?? null,
    created_at:      toDate(data.created_at),
    updated_at:      toDate(data.updated_at),
    called_at:       toDate(data.called_at),
    completed_at:    toDate(data.completed_at),
    wait_minutes:    computeWaitMinutes(data),
  };
}

// Get or build a facility-specific Firestore collection reference.
// The gateway uses a single Firebase project where each facility has
// its own Firestore database named by facility ID (matching the Flutter
// FirebaseConfig.facilityDb pattern).
function facilityQueueCol(facilityId) {
  // Uses the default Firestore instance and facility-namespaced collection,
  // matching the flutter app's FirebaseConfig.facilityDb.collection pattern.
  return admin.firestore().collection(`facilities/${facilityId}/triage_queue`);
}

function todayRange() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end   = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// ─── GET /api/queue/:facilityId/today ─────────────────────────────────────────
// Returns today's queue sorted by priority then arrival time.
// Optional query params:
//   status=waiting|in_triage|ready_for_doctor|with_doctor|completed|all (default: all except completed)
//   include_completed=true

router.get("/:facilityId/today", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;
    const { status, include_completed } = req.query;

    // Enforce facility boundary — a facility can only read its own queue
    if (req.facilityId !== facilityId) {
      return res.status(403).json({ error: "Forbidden: facility mismatch" });
    }

    const { start, end } = todayRange();
    let q = facilityQueueCol(facilityId)
      .where("created_at", ">=", start)
      .where("created_at", "<",  end);

    if (status && status !== "all") {
      q = q.where("status", "==", status);
    }

    const snap  = await q.get();
    let entries = snap.docs.map(d => sanitizeEntry(d.id, d.data()));

    // Filter out completed unless explicitly requested
    if (!include_completed || include_completed === "false") {
      if (!status || status === "all") {
        entries = entries.filter(e => e.status !== "completed");
      }
    }

    entries.sort(prioritySort);

    return res.json({
      success:    true,
      facilityId,
      date:       start.toISOString().split("T")[0],
      total:      entries.length,
      entries,
    });
  } catch (err) {
    console.error("[queue] today error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/queue/:facilityId/stats ─────────────────────────────────────────
// Returns aggregate queue statistics for today.

router.get("/:facilityId/stats", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;

    if (req.facilityId !== facilityId) {
      return res.status(403).json({ error: "Forbidden: facility mismatch" });
    }

    const { start, end } = todayRange();
    const snap = await facilityQueueCol(facilityId)
      .where("created_at", ">=", start)
      .where("created_at", "<",  end)
      .get();

    const entries = snap.docs.map(d => sanitizeEntry(d.id, d.data()));

    const byStatus = {};
    const byPriority = {};
    let totalWait = 0;
    let waitCount = 0;

    for (const e of entries) {
      byStatus[e.status]     = (byStatus[e.status]     ?? 0) + 1;
      byPriority[e.priority] = (byPriority[e.priority] ?? 0) + 1;

      if (e.wait_minutes != null && (e.status === "completed" || e.status === "with_doctor")) {
        totalWait += e.wait_minutes;
        waitCount++;
      }
    }

    const criticalActive = entries.filter(
      e => e.priority === "critical" &&
           !["completed"].includes(e.status)
    ).length;

    const abnormalVitalsCount = entries.filter(e => {
      const v = e.vitals;
      if (!v) return false;
      const spo2 = v.oxygen_saturation;
      const sys  = v.systolic_bp;
      const hr   = v.pulse_rate;
      const temp = v.temperature;
      return (spo2 != null && spo2 < 95) ||
             (sys  != null && (sys < 90 || sys > 160)) ||
             (hr   != null && (hr  < 50 || hr  > 120)) ||
             (temp != null && (temp < 35 || temp > 38.5));
    }).length;

    return res.json({
      success:     true,
      facilityId,
      date:        start.toISOString().split("T")[0],
      total:       entries.length,
      byStatus,
      byPriority,
      criticalActive,
      abnormalVitalsCount,
      averageWaitMinutes: waitCount > 0 ? Math.round(totalWait / waitCount) : null,
      longestWaitMinutes: entries.reduce((max, e) => {
        const w = e.wait_minutes ?? 0;
        return w > max ? w : max;
      }, 0),
    });
  } catch (err) {
    console.error("[queue] stats error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/queue/:facilityId/critical ──────────────────────────────────────
// Returns only critical and high-priority active patients.

router.get("/:facilityId/critical", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;

    if (req.facilityId !== facilityId) {
      return res.status(403).json({ error: "Forbidden: facility mismatch" });
    }

    const { start, end } = todayRange();
    const snap = await facilityQueueCol(facilityId)
      .where("created_at", ">=", start)
      .where("created_at", "<",  end)
      .get();

    const entries = snap.docs
      .map(d => sanitizeEntry(d.id, d.data()))
      .filter(e =>
        (e.priority === "critical" || e.priority === "high") &&
        e.status !== "completed"
      )
      .sort(prioritySort);

    return res.json({
      success:    true,
      facilityId,
      total:      entries.length,
      entries,
    });
  } catch (err) {
    console.error("[queue] critical error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/queue/:facilityId/:docId/status ───────────────────────────────
// Update the status of a single queue entry.
// Body: { status: "in_triage" | "ready_for_doctor" | "with_doctor" | "completed" | "cancelled" }
// Also accepts: { priority, notes, news2_score, news2_risk }

const VALID_STATUSES = new Set([
  "waiting", "in_triage", "ready_for_doctor",
  "with_doctor", "completed", "cancelled",
]);

router.patch("/:facilityId/:docId/status", requireFacility, async (req, res) => {
  try {
    const { facilityId, docId } = req.params;
    const { status, priority, notes, news2_score, news2_risk } = req.body;

    if (req.facilityId !== facilityId) {
      return res.status(403).json({ error: "Forbidden: facility mismatch" });
    }

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
      });
    }

    const ref = facilityQueueCol(facilityId).doc(docId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Queue entry not found" });
    }

    const update = {
      status,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status === "with_doctor") {
      update.called_at = admin.firestore.FieldValue.serverTimestamp();
    }
    if (status === "completed") {
      update.completed_at = admin.firestore.FieldValue.serverTimestamp();
    }
    if (priority) update.priority = priority;
    if (notes !== undefined) update.notes = notes;
    if (news2_score != null) update.news2_score = news2_score;
    if (news2_risk)  update.news2_risk  = news2_risk;

    await ref.update(update);

    // Audit trail
    const data = doc.data();
    await logAudit({
      event:       "queue_status_updated",
      patientNupi: data.patient_nupi ?? "",
      facilityId,
      details: {
        docId,
        fromStatus: data.status,
        toStatus:   status,
      },
      success:   true,
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      docId,
      status,
      message: `Queue entry updated to '${status}'`,
    });
  } catch (err) {
    console.error("[queue] status update error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/queue/:facilityId/bulk-action ──────────────────────────────────
// Batch-update multiple queue entries at once.
// Body: { action: "complete_all" | "clear_completed", docIds?: string[] }
// Useful for end-of-day cleanup.

router.post("/:facilityId/bulk-action", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;
    const { action, docIds } = req.body;

    if (req.facilityId !== facilityId) {
      return res.status(403).json({ error: "Forbidden: facility mismatch" });
    }

    const { start, end } = todayRange();
    const batch = admin.firestore().batch();
    let count   = 0;

    if (action === "complete_all" && Array.isArray(docIds)) {
      for (const id of docIds) {
        const ref = facilityQueueCol(facilityId).doc(id);
        batch.update(ref, {
          status:       "completed",
          completed_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at:   admin.firestore.FieldValue.serverTimestamp(),
        });
        count++;
      }
    } else if (action === "clear_completed") {
      const snap = await facilityQueueCol(facilityId)
        .where("status", "==", "completed")
        .where("created_at", ">=", start)
        .where("created_at", "<",  end)
        .get();

      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        count++;
      }
    } else {
      return res.status(400).json({
        error: "Invalid action. Use 'complete_all' (with docIds) or 'clear_completed'.",
      });
    }

    await batch.commit();

    return res.json({
      success: true,
      action,
      affected: count,
    });
  } catch (err) {
    console.error("[queue] bulk-action error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/queue/:facilityId/history ───────────────────────────────────────
// Historical queue analytics for a date range (max 30 days).
// Query params: from=YYYY-MM-DD, to=YYYY-MM-DD (defaults: last 7 days)

router.get("/:facilityId/history", requireFacility, async (req, res) => {
  try {
    const { facilityId } = req.params;
    let { from, to } = req.query;

    if (req.facilityId !== facilityId) {
      return res.status(403).json({ error: "Forbidden: facility mismatch" });
    }

    const toDate2 = to   ? new Date(`${to}T23:59:59`)   : new Date();
    const fromDate = from ? new Date(`${from}T00:00:00`) : new Date(toDate2 - 7 * 24 * 60 * 60 * 1000);

    // Cap at 30 days
    const diffDays = (toDate2 - fromDate) / (24 * 60 * 60 * 1000);
    if (diffDays > 30) {
      return res.status(400).json({ error: "Date range cannot exceed 30 days" });
    }

    const snap = await facilityQueueCol(facilityId)
      .where("created_at", ">=", fromDate)
      .where("created_at", "<=", toDate2)
      .orderBy("created_at", "desc")
      .get();

    const entries = snap.docs.map(d => sanitizeEntry(d.id, d.data()));

    // Group by date
    const byDate = {};
    for (const e of entries) {
      const dateKey = (e.created_at ?? new Date())
        .toISOString().split("T")[0];
      if (!byDate[dateKey]) {
        byDate[dateKey] = {
          date: dateKey, total: 0, completed: 0, cancelled: 0,
          byPriority: {}, avgWaitMinutes: null,
        };
      }
      const d = byDate[dateKey];
      d.total++;
      if (e.status === "completed") d.completed++;
      if (e.status === "cancelled") d.cancelled++;
      d.byPriority[e.priority] = (d.byPriority[e.priority] ?? 0) + 1;
    }

    // Compute avg wait per day
    for (const dateKey of Object.keys(byDate)) {
      const dayEntries = entries.filter(e => {
        return (e.created_at ?? new Date()).toISOString().split("T")[0] === dateKey &&
               e.wait_minutes != null &&
               (e.status === "completed" || e.status === "with_doctor");
      });
      if (dayEntries.length > 0) {
        byDate[dateKey].avgWaitMinutes = Math.round(
          dayEntries.reduce((s, e) => s + e.wait_minutes, 0) / dayEntries.length
        );
      }
    }

    return res.json({
      success:    true,
      facilityId,
      from:       fromDate.toISOString().split("T")[0],
      to:         toDate2.toISOString().split("T")[0],
      totalVisits: entries.length,
      byDate:     Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    console.error("[queue] history error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;