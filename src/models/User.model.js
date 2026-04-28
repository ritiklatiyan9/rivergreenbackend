import MasterModel from './MasterModel.js';
import crypto from 'crypto';

class UserModel extends MasterModel {
  constructor() {
    super('users');
  }

  // Generate unique sponsor code like RG-A1B2C3
  generateSponsorCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'RG-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // Ensure sponsor code is unique
  async getUniqueSponsorCode(pool) {
    let code;
    let exists = true;
    while (exists) {
      code = this.generateSponsorCode();
      const result = await pool.query(
        `SELECT id FROM ${this.tableName} WHERE sponsor_code = $1`,
        [code]
      );
      exists = result.rows.length > 0;
    }
    return code;
  }

  async findByEmail(email, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE email = $1`;
    const result = await pool.query(query, [email]);
    return result.rows[0];
  }

  async findBySponsorCode(sponsorCode, pool) {
    // Compare sponsor codes case-insensitively and trim input to avoid mismatch
    const query = `SELECT * FROM ${this.tableName} WHERE UPPER(sponsor_code) = UPPER(TRIM($1))`;
    const result = await pool.query(query, [sponsorCode]);
    return result.rows[0];
  }

  async findAllByRole(role, pool) {
    const query = `
      SELECT id, name, email, phone, profile_photo, role, sponsor_code, site_id, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE role = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [role]);
    return result.rows;
  }

  // Get users by role within a specific site (multi-tenant)
  async findBySiteAndRole(siteId, role, pool) {
    const query = `
      SELECT id, name, email, phone, profile_photo, role, sponsor_code, sponsor_id, parent_id, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE site_id = $1 AND role = $2
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [siteId, role]);
    return result.rows;
  }

  // Get ALL users in a site (for admin dashboard)
  async findBySite(siteId, pool) {
    const query = `
      SELECT u.id, u.name, u.email, u.phone, u.profile_photo, u.role, u.sponsor_code, u.sponsor_id, u.parent_id, u.team_id, u.is_active, u.created_at, u.updated_at,
        s.name as sponsor_name, s.sponsor_code as sponsor_sponsor_code,
        p.name as parent_name,
        t.name as team_name
      FROM ${this.tableName} u
      LEFT JOIN ${this.tableName} s ON u.sponsor_id = s.id
      LEFT JOIN ${this.tableName} p ON u.parent_id = p.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE u.site_id = $1
      ORDER BY
        CASE u.role
          WHEN 'ADMIN' THEN 1
          WHEN 'SUPERVISOR' THEN 2
          WHEN 'TEAM_HEAD' THEN 3
          WHEN 'AGENT' THEN 4
          WHEN 'CLIENT' THEN 5
          WHEN 'VISITOR' THEN 6
        END,
        u.created_at DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  // Count users by role in a site
  async countBySiteAndRole(siteId, role, pool) {
    const query = `SELECT COUNT(*) FROM ${this.tableName} WHERE site_id = $1 AND role = $2`;
    const result = await pool.query(query, [siteId, role]);
    return parseInt(result.rows[0].count, 10);
  }

  // Count all users in a site
  async countBySite(siteId, pool) {
    const query = `SELECT COUNT(*) FROM ${this.tableName} WHERE site_id = $1`;
    const result = await pool.query(query, [siteId]);
    return parseInt(result.rows[0].count, 10);
  }

  async countByRole(role, pool) {
    const query = `SELECT COUNT(*) FROM ${this.tableName} WHERE role = $1`;
    const result = await pool.query(query, [role]);
    return parseInt(result.rows[0].count, 10);
  }

  async findByIdSafe(id, pool) {
    const query = `SELECT id, name, email, phone, profile_photo, role, sponsor_code, site_id, team_id, sponsor_id, parent_id, is_active, address, designation, bio, created_at, updated_at FROM ${this.tableName} WHERE id = $1`;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  // Get team hierarchy (who reports to this user)
  async getDownline(userId, pool) {
    const query = `
      SELECT id, name, email, phone, role, sponsor_code, is_active, created_at
      FROM ${this.tableName}
      WHERE parent_id = $1
      ORDER BY role, created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  // Get referral chain (who was referred by this user)
  async getReferrals(userId, pool) {
    const query = `
      SELECT id, name, email, phone, role, sponsor_code, is_active, created_at
      FROM ${this.tableName}
      WHERE sponsor_id = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  // Get site stats
  async getSiteStats(siteId, pool) {
    const query = `
      SELECT
        (SELECT COUNT(*) FROM ${this.tableName} WHERE site_id = $1 AND role = 'ADMIN') as admin_count,
        (SELECT COUNT(*) FROM teams WHERE site_id = $1 AND is_active = true) as team_head_count,
        (SELECT COUNT(*) FROM ${this.tableName} WHERE site_id = $1 AND role = 'AGENT') as agent_count,
        (SELECT COUNT(*) FROM plot_bookings WHERE site_id = $1 AND status IN ('ACTIVE', 'COMPLETED')) as client_count,
        (SELECT COUNT(*) FROM leads WHERE site_id = $1 AND status IN ('SITE_VISIT', 'NEGOTIATION', 'BOOKED')) as visitor_count,
        (SELECT COUNT(*) FROM ${this.tableName} WHERE site_id = $1) as total_count
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }

  // ── ZKTeco biometric mapping ──────────────────────────────────────────

  /**
   * Build a Map<zkteco_user_id, {id, primary_site_id}> across all active
   * users with a biometric mapping. Used by the poller's reducer to decide
   * whether a punch is at the user's primary site or a secondary one.
   *
   * The location argument is unused today — we return all mapped users
   * because a user's biometric ID may legitimately punch at any office
   * the company allows them into. Kept for forward compatibility if we
   * later restrict mappings per-site.
   */
  async buildZktecoUserMapForLocation(_locationId, pool) {
    const result = await pool.query(
      `SELECT id, zkteco_user_id, primary_site_id
       FROM ${this.tableName}
       WHERE zkteco_user_id IS NOT NULL AND is_active = true`,
      [],
    );
    const map = new Map();
    for (const r of result.rows) {
      map.set(Number(r.zkteco_user_id), {
        id: r.id,
        primary_site_id: r.primary_site_id ?? null,
      });
    }
    return map;
  }

  /** Look up one user by their device user-id. */
  async findByZktecoId(zktecoUserId, pool) {
    const result = await pool.query(
      `SELECT id, name, email, role, zkteco_user_id, primary_site_id
       FROM ${this.tableName}
       WHERE zkteco_user_id = $1 AND is_active = true LIMIT 1`,
      [zktecoUserId],
    );
    return result.rows[0];
  }

  /** Set or clear a user's biometric mapping + primary site in one call. */
  async setZktecoMapping(userId, { zktecoUserId, primarySiteId }, pool) {
    const result = await pool.query(
      `UPDATE ${this.tableName}
       SET zkteco_user_id = $2,
           primary_site_id = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, zkteco_user_id, primary_site_id`,
      [userId, zktecoUserId ?? null, primarySiteId ?? null],
    );
    return result.rows[0];
  }

  /** All users (with role) for the biometric mapping admin page. */
  async listForBiometricMapping(siteId, pool) {
    const params = [];
    let where = `role IN ('ADMIN','SUPERVISOR','TEAM_HEAD','AGENT') AND is_active = true`;
    if (siteId) {
      where += ` AND site_id = $1`;
      params.push(siteId);
    }
    const result = await pool.query(
      `SELECT id, name, email, phone, role, profile_photo,
              zkteco_user_id, primary_site_id
       FROM ${this.tableName}
       WHERE ${where}
       ORDER BY name ASC`,
      params,
    );
    return result.rows;
  }

  // Find admin for a specific site
  async findAdminBySite(siteId, pool) {
    const query = `
      SELECT id, name, email, phone, role, sponsor_code, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE site_id = $1 AND role = 'ADMIN'
      LIMIT 1
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }
}

export default new UserModel();