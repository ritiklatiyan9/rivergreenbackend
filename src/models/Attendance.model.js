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
             al.name as location_name, al.latitude as loc_lat, al.longitude as loc_lng, al.radius_meters
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
        COUNT(DISTINCT ar.user_id) as total_present,
        COUNT(DISTINCT CASE WHEN ar.status = 'LATE' THEN ar.user_id END) as total_late,
        COUNT(DISTINCT CASE WHEN ar.check_out_time IS NOT NULL THEN ar.user_id END) as total_checked_out,
        COUNT(DISTINCT CASE WHEN ar.check_out_time IS NULL AND ar.check_in_time IS NOT NULL THEN ar.user_id END) as total_still_in
      FROM ${this.tableName} ar
      WHERE ar.date = $1
    `, [date || new Date().toISOString().split('T')[0]]);
    return result.rows[0];
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
