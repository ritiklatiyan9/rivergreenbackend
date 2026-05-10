import MasterModel from './MasterModel.js';

// ── Site HR Settings ─────────────────────────────────────────
class HrSettingsModel extends MasterModel {
  constructor() {
    super('site_hr_settings');
  }

  async findBySite(siteId, pool) {
    const r = await pool.query(`SELECT * FROM ${this.tableName} WHERE site_id = $1 LIMIT 1`, [siteId]);
    return r.rows[0] || null;
  }

  // First read auto-creates a default row so admin sees baseline values.
  async findOrCreateBySite(siteId, createdBy, pool) {
    const existing = await this.findBySite(siteId, pool);
    if (existing) return existing;
    return this.create({ site_id: siteId, created_by: createdBy || null }, pool);
  }

  async upsertBySite(siteId, data, pool) {
    const existing = await this.findBySite(siteId, pool);
    if (existing) {
      return this.update(existing.id, { ...data, updated_at: new Date() }, pool);
    }
    return this.create({ site_id: siteId, ...data }, pool);
  }
}

// ── Per-user salary (active row + history) ────────────────────
class UserSalaryModel extends MasterModel {
  constructor() {
    super('user_salaries');
  }

  async findActive(userId, pool) {
    const r = await pool.query(
      `SELECT * FROM ${this.tableName} WHERE user_id = $1 AND effective_to IS NULL LIMIT 1`,
      [userId],
    );
    return r.rows[0] || null;
  }

  async findHistory(userId, pool) {
    const r = await pool.query(
      `SELECT us.*, u.name as created_by_name
       FROM ${this.tableName} us
       LEFT JOIN users u ON us.created_by = u.id
       WHERE us.user_id = $1
       ORDER BY us.effective_from DESC, us.created_at DESC`,
      [userId],
    );
    return r.rows;
  }

  // Close current active row + insert new row in one transaction so the
  // partial unique index (one active per user) never trips.
  async upsertActive({ userId, siteId, monthlySalary, effectiveFrom, joinedAt, notes, createdBy }, pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const startDate = effectiveFrom || new Date().toISOString().slice(0, 10);

      // Close currently active row (if any) the day before the new one starts.
      await client.query(
        `UPDATE ${this.tableName}
         SET effective_to = ($1::date - INTERVAL '1 day')::date
         WHERE user_id = $2 AND effective_to IS NULL`,
        [startDate, userId],
      );

      const ins = await client.query(
        `INSERT INTO ${this.tableName}
           (user_id, site_id, monthly_salary, effective_from, joined_at, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [userId, siteId, monthlySalary, startDate, joinedAt || null, notes || null, createdBy || null],
      );
      await client.query('COMMIT');
      return ins.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => null);
      throw err;
    } finally {
      client.release();
    }
  }

  // List all panel-relevant users with their active salary + last paid month.
  async listAllWithActiveSalary({ siteId, search }, pool) {
    const params = [];
    const where = [`u.role IN ('ADMIN','SUPERVISOR','TEAM_HEAD','AGENT')`, `u.is_active = true`];
    if (siteId) { params.push(siteId); where.push(`u.site_id = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    const sql = `
      SELECT
        u.id, u.name, u.email, u.role, u.profile_photo, u.site_id,
        s.name AS site_name,
        us.id AS salary_id, us.monthly_salary, us.effective_from, us.joined_at,
        (
          SELECT json_build_object(
            'period_year', sp.period_year,
            'period_month', sp.period_month,
            'amount', sp.amount,
            'payment_date', sp.payment_date,
            'status', sp.status
          )
          FROM salary_payments sp
          WHERE sp.user_id = u.id
          ORDER BY sp.period_year DESC, sp.period_month DESC
          LIMIT 1
        ) AS last_payment
      FROM users u
      LEFT JOIN sites s ON s.id = u.site_id
      LEFT JOIN ${this.tableName} us ON us.user_id = u.id AND us.effective_to IS NULL
      WHERE ${where.join(' AND ')}
      ORDER BY u.name ASC
    `;
    const r = await pool.query(sql, params);
    return r.rows;
  }
}

// ── Leave overrides (admin marks paid/unpaid/half) ───────────
class HrLeaveModel extends MasterModel {
  constructor() {
    super('hr_leave_records');
  }

  async findInRange({ userId, startDate, endDate }, pool) {
    const r = await pool.query(
      `SELECT * FROM ${this.tableName}
       WHERE user_id = $1 AND leave_date BETWEEN $2 AND $3
       ORDER BY leave_date ASC`,
      [userId, startDate, endDate],
    );
    return r.rows;
  }

  // Idempotent: same (user, date) flips type rather than failing.
  async upsert({ userId, siteId, leaveDate, leaveType, reason, markedBy }, pool) {
    const r = await pool.query(
      `INSERT INTO ${this.tableName} (user_id, site_id, leave_date, leave_type, reason, marked_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, leave_date) DO UPDATE SET
         leave_type = EXCLUDED.leave_type,
         reason     = EXCLUDED.reason,
         marked_by  = EXCLUDED.marked_by
       RETURNING *`,
      [userId, siteId, leaveDate, leaveType, reason || null, markedBy || null],
    );
    return r.rows[0];
  }

  async deleteByUserDate({ userId, leaveDate }, pool) {
    const r = await pool.query(
      `DELETE FROM ${this.tableName} WHERE user_id = $1 AND leave_date = $2 RETURNING *`,
      [userId, leaveDate],
    );
    return r.rows[0] || null;
  }
}

// ── Salary payouts ───────────────────────────────────────────
class SalaryPaymentModel extends MasterModel {
  constructor() {
    super('salary_payments');
  }

  async findByPeriod({ userId, year, month }, pool) {
    const r = await pool.query(
      `SELECT * FROM ${this.tableName}
       WHERE user_id = $1 AND period_year = $2 AND period_month = $3 LIMIT 1`,
      [userId, year, month],
    );
    return r.rows[0] || null;
  }

  async findManyByPeriod({ year, month, siteId }, pool) {
    const params = [year, month];
    let where = `period_year = $1 AND period_month = $2`;
    if (siteId) { params.push(siteId); where += ` AND site_id = $${params.length}`; }
    const r = await pool.query(
      `SELECT * FROM ${this.tableName} WHERE ${where}`,
      params,
    );
    return r.rows;
  }

  async list({ page = 1, limit = 20, userId, year, month, status, siteId } = {}, pool) {
    const offset = (page - 1) * limit;
    const params = [];
    const where = ['1=1'];
    if (siteId) { params.push(siteId); where.push(`sp.site_id = $${params.length}`); }
    if (userId) { params.push(userId); where.push(`sp.user_id = $${params.length}`); }
    if (year)   { params.push(year);   where.push(`sp.period_year = $${params.length}`); }
    if (month)  { params.push(month);  where.push(`sp.period_month = $${params.length}`); }
    if (status) { params.push(status); where.push(`sp.status = $${params.length}`); }

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM ${this.tableName} sp WHERE ${where.join(' AND ')}`,
      params,
    );

    params.push(limit, offset);
    const rowsRes = await pool.query(
      `SELECT sp.*,
              u.name AS user_name, u.email AS user_email, u.role AS user_role, u.profile_photo,
              pb.name AS paid_by_name
       FROM ${this.tableName} sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN users pb ON pb.id = sp.paid_by
       WHERE ${where.join(' AND ')}
       ORDER BY sp.period_year DESC, sp.period_month DESC, sp.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      payments: rowsRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countRes.rows[0].count, 10) / limit),
    };
  }
}

export const hrSettingsModel    = new HrSettingsModel();
export const userSalaryModel    = new UserSalaryModel();
export const hrLeaveModel       = new HrLeaveModel();
export const salaryPaymentModel = new SalaryPaymentModel();
