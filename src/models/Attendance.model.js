import MasterModel from './MasterModel.js';

class AttendanceLocationModel extends MasterModel {
  constructor() {
    super('attendance_locations');
  }

  async findAllActive(pool) {
    const result = await pool.query(
      `SELECT * FROM ${this.tableName} WHERE is_active = true ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async findAllWithCreator(pool) {
    const result = await pool.query(`
      SELECT al.*, u.name as created_by_name
      FROM ${this.tableName} al
      LEFT JOIN users u ON al.created_by = u.id
      ORDER BY al.created_at DESC
    `);
    return result.rows;
  }

  /** Locations with a configured + enabled ZKTeco device — used by the poller. */
  async findZktecoEnabled(pool) {
    const result = await pool.query(
      `SELECT * FROM ${this.tableName}
       WHERE is_active = true AND zkteco_enabled = true AND zkteco_ip IS NOT NULL
       ORDER BY id ASC`,
    );
    return result.rows;
  }

  /** Update the device sync watermark + last error after a poll cycle. */
  async setZktecoSyncStatus(id, { lastLogId, lastError, syncedAt }, pool) {
    const updates = ['zkteco_last_synced_at = $2'];
    const values = [id, syncedAt || new Date()];
    let i = 3;
    if (lastLogId !== undefined) { updates.push(`zkteco_last_log_id = $${i++}`); values.push(lastLogId); }
    updates.push(`zkteco_last_error = $${i++}`); values.push(lastError ?? null);
    await pool.query(
      `UPDATE ${this.tableName} SET ${updates.join(', ')} WHERE id = $1`,
      values,
    );
  }
}

class AttendanceRecordModel extends MasterModel {
  constructor() {
    super('attendance_records');
  }

  /** Get today's record for a user at a specific location */
  async findTodayRecord(userId, locationId, pool) {
    const result = await pool.query(
      `SELECT * FROM ${this.tableName} WHERE user_id = $1 AND location_id = $2 AND date = CURRENT_DATE`,
      [userId, locationId]
    );
    return result.rows[0];
  }

  /** Get today's records for a user across all locations */
  async findTodayRecordsByUser(userId, pool) {
    const result = await pool.query(`
      SELECT ar.*, al.name as location_name, al.latitude as loc_lat, al.longitude as loc_lng
      FROM ${this.tableName} ar
      JOIN attendance_locations al ON ar.location_id = al.id
      WHERE ar.user_id = $1 AND ar.date = CURRENT_DATE
      ORDER BY ar.check_in_time DESC
    `, [userId]);
    return result.rows;
  }

  /** Get attendance history for a user with pagination */
  async findByUser(userId, { page = 1, limit = 20, startDate, endDate } = {}, pool) {
    const offset = (page - 1) * limit;
    let where = 'ar.user_id = $1';
    const params = [userId];
    let paramIdx = 2;

    if (startDate) {
      where += ` AND ar.date >= $${paramIdx}`;
      params.push(startDate);
      paramIdx++;
    }
    if (endDate) {
      where += ` AND ar.date <= $${paramIdx}`;
      params.push(endDate);
      paramIdx++;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${this.tableName} ar WHERE ${where}`, params
    );

    const result = await pool.query(`
      SELECT ar.*, al.name as location_name,
             al.latitude as loc_lat, al.longitude as loc_lng, al.radius_meters
      FROM ${this.tableName} ar
      JOIN attendance_locations al ON ar.location_id = al.id
      WHERE ${where}
      ORDER BY ar.date DESC, ar.check_in_time DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, [...params, limit, offset]);

    return {
      records: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    };
  }

  /** Admin: get all attendance records with user info */
  async findAllRecords({ page = 1, limit = 20, date, startDate, endDate, userId, locationId, status } = {}, pool) {
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];
    let paramIdx = 1;

    if (date) {
      where += ` AND ar.date = $${paramIdx}`;
      params.push(date);
      paramIdx++;
    }
    if (startDate) {
      where += ` AND ar.date >= $${paramIdx}`;
      params.push(startDate);
      paramIdx++;
    }
    if (endDate) {
      where += ` AND ar.date <= $${paramIdx}`;
      params.push(endDate);
      paramIdx++;
    }
    if (userId) {
      where += ` AND ar.user_id = $${paramIdx}`;
      params.push(userId);
      paramIdx++;
    }
    if (locationId) {
      where += ` AND ar.location_id = $${paramIdx}`;
      params.push(locationId);
      paramIdx++;
    }
    if (status) {
      where += ` AND ar.status = $${paramIdx}`;
      params.push(status);
      paramIdx++;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${this.tableName} ar WHERE ${where}`, params
    );

    const result = await pool.query(`
      SELECT ar.*,
             u.name as user_name, u.email as user_email, u.phone as user_phone, u.profile_photo,
             u.primary_site_id, u.zkteco_user_id,
             al.name as location_name, al.latitude as loc_lat, al.longitude as loc_lng, al.radius_meters,
             al.site_id as location_site_id
      FROM ${this.tableName} ar
      JOIN users u ON ar.user_id = u.id
      JOIN attendance_locations al ON ar.location_id = al.id
      WHERE ${where}
      ORDER BY ar.date DESC, ar.check_in_time DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, [...params, limit, offset]);

    return {
      records: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    };
  }

  /** Get attendance stats for dashboard */
  async getDailyStats(date, pool) {
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT ar.user_id) FILTER (WHERE ar.is_secondary = false) as total_present,
        COUNT(DISTINCT CASE WHEN ar.status = 'LATE' AND ar.is_secondary = false THEN ar.user_id END) as total_late,
        COUNT(DISTINCT CASE WHEN ar.check_out_time IS NOT NULL AND ar.is_secondary = false THEN ar.user_id END) as total_checked_out,
        COUNT(DISTINCT CASE WHEN ar.check_out_time IS NULL AND ar.check_in_time IS NOT NULL AND ar.is_secondary = false THEN ar.user_id END) as total_still_in,
        COUNT(*) FILTER (WHERE ar.is_secondary = true) as total_secondary_visits
      FROM ${this.tableName} ar
      WHERE ar.date = $1
    `, [date || new Date().toISOString().split('T')[0]]);
    return result.rows[0];
  }

  /**
   * Idempotent upsert for one biometric punch. Per the unique
   * (user_id, location_id, date) constraint there is at most one row.
   *
   * check_in_time  → earliest punch we've ever seen for this bucket.
   * check_out_time → latest distinct punch (NULL until a *second* time arrives).
   *
   * Why GREATEST over four candidates with a NULLIF guard:
   * ADMS push-mode delivers one punch per HTTP request, so each call has
   * checkOut=NULL in the reducer output. We still need the SECOND such
   * call to promote its punch into check_out_time on the existing row —
   * `GREATEST(...)` of all four timestamps does that, and `NULLIF(max, min)`
   * keeps check_out NULL when only one distinct time has been observed
   * (so a single duplicate-punch doesn't fake a 0-duration shift).
   */
  async upsertFromPunch({ userId, locationId, dateKey, checkIn, checkOut, status, isSecondary, source, raw }, pool) {
    const tn = this.tableName;
    const result = await pool.query(
      `INSERT INTO ${tn}
        (user_id, location_id, date, check_in_time, check_out_time, status, is_secondary, source, raw_zkteco)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, location_id, date) DO UPDATE SET
         check_in_time   = LEAST(${tn}.check_in_time, EXCLUDED.check_in_time),
         check_out_time  = NULLIF(
                             GREATEST(
                               ${tn}.check_in_time,
                               ${tn}.check_out_time,
                               EXCLUDED.check_in_time,
                               EXCLUDED.check_out_time
                             ),
                             LEAST(${tn}.check_in_time, EXCLUDED.check_in_time)
                           ),
         status          = CASE
                             WHEN ${tn}.status = 'LATE' OR EXCLUDED.status = 'LATE' THEN 'LATE'
                             ELSE ${tn}.status
                           END,
         is_secondary    = EXCLUDED.is_secondary,
         source          = EXCLUDED.source,
         raw_zkteco      = EXCLUDED.raw_zkteco,
         updated_at      = NOW()
       RETURNING *`,
      [userId, locationId, dateKey, checkIn, checkOut, status, isSecondary, source, raw],
    );
    return result.rows[0];
  }

  // ── Analytics ──────────────────────────────────────────────────────

  /**
   * Day-by-day attendance for one user + summary stats over the range.
   * Only counts the user's PRIMARY office days for the headline numbers
   * — punches at other sites are listed but flagged is_secondary so the
   * UI can break them out separately.
   */
  async getUserAnalytics(userId, startDate, endDate, pool) {
    const dailyRes = await pool.query(`
      SELECT
        ar.id,
        ar.date,
        ar.check_in_time,
        ar.check_out_time,
        ar.status,
        ar.source,
        ar.is_secondary,
        al.name as location_name,
        EXTRACT(EPOCH FROM (ar.check_out_time - ar.check_in_time))/3600.0 as hours
      FROM ${this.tableName} ar
      JOIN attendance_locations al ON ar.location_id = al.id
      WHERE ar.user_id = $1 AND ar.date BETWEEN $2 AND $3
      ORDER BY ar.date ASC, ar.check_in_time ASC
    `, [userId, startDate, endDate]);

    const summaryRes = await pool.query(`
      SELECT
        COUNT(DISTINCT ar.date) FILTER (WHERE ar.is_secondary = false) as present_days,
        COUNT(DISTINCT ar.date) FILTER (WHERE ar.status = 'LATE' AND ar.is_secondary = false) as late_days,
        COUNT(DISTINCT ar.date) FILTER (WHERE ar.status = 'HALF_DAY' AND ar.is_secondary = false) as half_days,
        COUNT(*) FILTER (WHERE ar.is_secondary = true) as secondary_visits,
        COALESCE(SUM(EXTRACT(EPOCH FROM (ar.check_out_time - ar.check_in_time))) / 3600.0, 0) as total_hours
      FROM ${this.tableName} ar
      WHERE ar.user_id = $1 AND ar.date BETWEEN $2 AND $3
    `, [userId, startDate, endDate]);

    return { daily: dailyRes.rows, summary: summaryRes.rows[0] };
  }

  /**
   * Per-member rollup for a team or for a whole site over a date range.
   * LEFT JOIN so members with zero attendance still appear in the report.
   * Pass either teamId (preferred) or siteId; if both are null the caller
   * gets every active employee in the system (admins should always pass
   * at least one filter).
   */
  async getTeamAnalytics({ teamId, siteId, startDate, endDate, role }, pool) {
    const where = [`u.is_active = true`, `u.role IN ('AGENT','TEAM_HEAD','SUPERVISOR','ADMIN')`];
    const params = [startDate, endDate];
    let i = 3;
    if (teamId) { where.push(`u.team_id = $${i++}`); params.push(teamId); }
    if (siteId) { where.push(`u.site_id = $${i++}`); params.push(siteId); }
    if (role)   { where.push(`u.role = $${i++}`);    params.push(role); }

    const sql = `
      SELECT
        u.id as user_id,
        u.name,
        u.email,
        u.role,
        u.profile_photo,
        t.name as team_name,
        COUNT(DISTINCT ar.date) FILTER (WHERE ar.is_secondary = false) as present_days,
        COUNT(DISTINCT ar.date) FILTER (WHERE ar.status = 'LATE' AND ar.is_secondary = false) as late_days,
        COUNT(DISTINCT ar.date) FILTER (WHERE ar.status = 'HALF_DAY' AND ar.is_secondary = false) as half_days,
        COUNT(*) FILTER (WHERE ar.is_secondary = true) as secondary_visits,
        COALESCE(SUM(EXTRACT(EPOCH FROM (ar.check_out_time - ar.check_in_time))) / 3600.0, 0) as total_hours,
        MAX(ar.date) as last_seen_date
      FROM users u
      LEFT JOIN teams t ON u.team_id = t.id
      LEFT JOIN ${this.tableName} ar
        ON ar.user_id = u.id AND ar.date BETWEEN $1 AND $2
      WHERE ${where.join(' AND ')}
      GROUP BY u.id, u.name, u.email, u.role, u.profile_photo, t.name
      ORDER BY u.name ASC
    `;
    const result = await pool.query(sql, params);
    return result.rows;
  }

  /** Get a user's per-location movement timeline for one date. */
  async findUserMovementByDate(userId, date, pool) {
    const result = await pool.query(`
      SELECT ar.id, ar.location_id, ar.check_in_time, ar.check_out_time, ar.is_secondary,
             al.name as location_name
      FROM ${this.tableName} ar
      JOIN attendance_locations al ON ar.location_id = al.id
      WHERE ar.user_id = $1 AND ar.date = $2
      ORDER BY ar.check_in_time ASC NULLS LAST
    `, [userId, date]);
    return result.rows;
  }

  /** Get monthly summary for a user */
  async getMonthlySummary(userId, year, month, pool) {
    const result = await pool.query(`
      SELECT 
        ar.date,
        ar.status,
        ar.check_in_time,
        ar.check_out_time,
        al.name as location_name,
        EXTRACT(EPOCH FROM (ar.check_out_time - ar.check_in_time))/3600 as hours_worked
      FROM ${this.tableName} ar
      JOIN attendance_locations al ON ar.location_id = al.id
      WHERE ar.user_id = $1 
        AND EXTRACT(YEAR FROM ar.date) = $2 
        AND EXTRACT(MONTH FROM ar.date) = $3
      ORDER BY ar.date ASC
    `, [userId, year, month]);
    return result.rows;
  }
}

export const attendanceLocationModel = new AttendanceLocationModel();
export const attendanceRecordModel = new AttendanceRecordModel();
