import MasterModel from './MasterModel.js';

class SiteModel extends MasterModel {
  constructor() {
    super('sites');
  }

  async findByOwner(ownerId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE created_by = $1 ORDER BY created_at DESC`;
    const result = await pool.query(query, [ownerId]);
    return result.rows;
  }

  async findActiveByOwner(ownerId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE created_by = $1 AND is_active = true ORDER BY created_at DESC`;
    const result = await pool.query(query, [ownerId]);
    return result.rows;
  }

  async countByOwner(ownerId, pool) {
    const query = `SELECT COUNT(*) FROM ${this.tableName} WHERE created_by = $1`;
    const result = await pool.query(query, [ownerId]);
    return parseInt(result.rows[0].count, 10);
  }

  async findWithAdminCount(ownerId, pool) {
    const query = `
      SELECT s.*,
        (SELECT COUNT(*) FROM users u WHERE u.site_id = s.id AND u.role = 'ADMIN') as admin_count,
        (SELECT COUNT(*) FROM users u WHERE u.site_id = s.id) as total_users
      FROM ${this.tableName} s
      WHERE s.created_by = $1
      ORDER BY s.created_at DESC
    `;
    const result = await pool.query(query, [ownerId]);
    return result.rows;
  }
}

export default new SiteModel();
