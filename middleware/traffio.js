// Traffio integration — import jobs, bookings (→ allocations), and crew
const { getDb } = require('../db/database');
const axios = require('axios');
const {
  getIntegrationConfig,
  updateSyncStatus,
  startSyncLog,
  completeSyncLog,
  getInternalRef,
  setExternalRef,
} = require('./integrations');

// ---- API Client ----

function getTraffioClient() {
  const ic = getIntegrationConfig('traffio');
  if (!ic.enabled) throw new Error('Traffio integration is not enabled');
  if (!ic.config.api_url || !ic.config.api_key) {
    throw new Error('Traffio API URL and API Key are required');
  }

  return axios.create({
    baseURL: ic.config.api_url.replace(/\/+$/, ''),
    headers: {
      'Authorization': `Bearer ${ic.config.api_key}`,
      'Accept': 'application/json',
    },
    timeout: 30000,
  });
}

// ---- Sync Jobs ----

async function syncTraffioJobs(triggeredBy) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'job', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    const response = await client.get('/api/v1/jobs');
    const traffioJobs = response.data.data || response.data || [];

    for (const tj of traffioJobs) {
      stats.processed++;
      try {
        const externalId = String(tj.id || tj.job_id);

        // Check if we already have this mapped
        const existing = getInternalRef('traffio', 'job', externalId);

        if (existing) {
          // Update existing job
          db.prepare(`
            UPDATE jobs SET
              client = COALESCE(?, client),
              site_address = COALESCE(?, site_address),
              suburb = COALESCE(?, suburb),
              client_project_number = COALESCE(?, client_project_number),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            tj.client_name || null,
            tj.site_address || tj.address || null,
            tj.suburb || null,
            tj.reference || tj.job_number || null,
            existing.internal_id
          );
          setExternalRef('traffio', 'job', existing.internal_id, externalId, tj);
          stats.updated++;
        } else {
          // Try to match by client_project_number or job_number
          const matchByRef = db.prepare(`
            SELECT id FROM jobs WHERE client_project_number = ? OR job_number = ?
          `).get(tj.reference || '', tj.job_number || '');

          if (matchByRef) {
            setExternalRef('traffio', 'job', matchByRef.id, externalId, tj);
            stats.updated++;
          } else {
            // Create new job
            const jobNumber = tj.job_number || tj.reference || `TRF-${externalId}`;
            const result = db.prepare(`
              INSERT INTO jobs (job_number, job_name, client, site_address, suburb, status, stage, start_date, client_project_number)
              VALUES (?, ?, ?, ?, ?, 'active', 'delivery', ?, ?)
            `).run(
              jobNumber,
              tj.name || tj.job_name || jobNumber,
              tj.client_name || tj.client || 'Unknown Client',
              tj.site_address || tj.address || '',
              tj.suburb || '',
              tj.start_date || new Date().toISOString().split('T')[0],
              tj.reference || ''
            );
            setExternalRef('traffio', 'job', result.lastInsertRowid, externalId, tj);
            stats.created++;
          }
        }
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Job ${tj.id}: ${err.message}\n`;
      }
    }

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Sync Crew / Workers ----

async function syncTraffioCrew(triggeredBy) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'crew', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    const response = await client.get('/api/v1/workers');
    const workers = response.data.data || response.data || [];

    for (const w of workers) {
      stats.processed++;
      try {
        const externalId = String(w.id || w.worker_id);
        const employeeId = w.employee_id || w.payroll_id || externalId;

        // Try to find by employee_id first
        const existing = db.prepare('SELECT id FROM crew_members WHERE employee_id = ?').get(employeeId);

        if (existing) {
          db.prepare(`
            UPDATE crew_members SET
              full_name = COALESCE(?, full_name),
              phone = COALESCE(?, phone),
              email = COALESCE(?, email),
              role = COALESCE(?, role),
              licence_type = COALESCE(?, licence_type),
              licence_expiry = COALESCE(?, licence_expiry)
            WHERE id = ?
          `).run(
            w.name || w.full_name || null,
            w.phone || w.mobile || null,
            w.email || null,
            w.role || w.position || null,
            w.licence_type || w.license_class || null,
            w.licence_expiry || w.license_expiry || null,
            existing.id
          );
          setExternalRef('traffio', 'crew', existing.id, externalId, w);
          stats.updated++;
        } else {
          const result = db.prepare(`
            INSERT INTO crew_members (full_name, employee_id, role, phone, email, licence_type, licence_expiry, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          `).run(
            w.name || w.full_name || 'Unknown',
            employeeId,
            w.role || w.position || 'TC',
            w.phone || w.mobile || '',
            w.email || '',
            w.licence_type || w.license_class || '',
            w.licence_expiry || w.license_expiry || null
          );
          setExternalRef('traffio', 'crew', result.lastInsertRowid, externalId, w);
          stats.created++;
        }
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Worker ${w.id}: ${err.message}\n`;
      }
    }

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Sync Bookings → Allocations ----

async function syncTraffioBookings(triggeredBy, fromDate, toDate) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'allocation', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    const params = {};
    if (fromDate) params.from_date = fromDate;
    if (toDate) params.to_date = toDate;

    const response = await client.get('/api/v1/bookings', { params });
    const bookings = response.data.data || response.data || [];

    // Get the system user (admin) for allocated_by_id
    const systemUser = db.prepare("SELECT id FROM users WHERE role = 'management' LIMIT 1").get();
    const allocatedById = systemUser ? systemUser.id : 1;

    for (const b of bookings) {
      stats.processed++;
      try {
        const externalId = String(b.id || b.booking_id);

        // Resolve the job
        let jobId = null;
        if (b.job_id || b.job_reference) {
          const jobRef = getInternalRef('traffio', 'job', String(b.job_id || ''));
          if (jobRef) {
            jobId = jobRef.internal_id;
          } else {
            // Try to match by job number
            const jobByNum = db.prepare('SELECT id FROM jobs WHERE job_number = ? OR client_project_number = ?')
              .get(b.job_reference || '', b.job_reference || '');
            if (jobByNum) jobId = jobByNum.id;
          }
        }
        if (!jobId) {
          stats.failed++;
          stats.errorDetails += `Booking ${externalId}: No matching job found\n`;
          continue;
        }

        // Resolve the crew member
        let crewId = null;
        if (b.worker_id || b.employee_id) {
          const crewRef = getInternalRef('traffio', 'crew', String(b.worker_id || ''));
          if (crewRef) {
            crewId = crewRef.internal_id;
          } else {
            const crewByEmpId = db.prepare('SELECT id FROM crew_members WHERE employee_id = ?')
              .get(b.employee_id || String(b.worker_id || ''));
            if (crewByEmpId) crewId = crewByEmpId.id;
          }
        }
        if (!crewId) {
          stats.failed++;
          stats.errorDetails += `Booking ${externalId}: No matching crew member found\n`;
          continue;
        }

        // Check if allocation already mapped
        const existingRef = getInternalRef('traffio', 'allocation', externalId);
        const allocDate = b.date || b.booking_date || new Date().toISOString().split('T')[0];
        const startTime = b.start_time || '06:00';
        const endTime = b.end_time || '14:30';
        const shiftType = b.shift_type || 'day';

        if (existingRef) {
          db.prepare(`
            UPDATE crew_allocations SET
              job_id = ?, crew_member_id = ?, allocation_date = ?,
              start_time = ?, end_time = ?, shift_type = ?,
              role_on_site = ?, status = ?
            WHERE id = ?
          `).run(jobId, crewId, allocDate, startTime, endTime, shiftType,
            b.role || '', b.status === 'confirmed' ? 'confirmed' : 'allocated',
            existingRef.internal_id);
          setExternalRef('traffio', 'allocation', existingRef.internal_id, externalId, b);
          stats.updated++;
        } else {
          const result = db.prepare(`
            INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, allocated_by_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(jobId, crewId, allocDate, startTime, endTime, shiftType,
            b.role || '', b.status === 'confirmed' ? 'confirmed' : 'allocated',
            allocatedById);
          setExternalRef('traffio', 'allocation', result.lastInsertRowid, externalId, b);
          stats.created++;
        }
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Booking ${b.id}: ${err.message}\n`;
      }
    }

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Test Connection ----

async function testTraffioConnection() {
  const client = getTraffioClient();
  const response = await client.get('/api/v1/ping');
  return { status: response.status, data: response.data };
}

module.exports = {
  syncTraffioJobs,
  syncTraffioCrew,
  syncTraffioBookings,
  testTraffioConnection,
};
