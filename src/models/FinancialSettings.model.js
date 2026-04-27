import MasterModel from './MasterModel.js';

class FinancialSettingsModel extends MasterModel {
  constructor() {
    super('site_financial_settings');
  }

  // Site-wide default row (colony_map_id IS NULL) — used as fallback.
  async findBySite(siteId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE site_id = $1 AND colony_map_id IS NULL LIMIT 1`;
    const result = await pool.query(query, [siteId]);
    return result.rows[0] || null;
  }

  // Specific colony row (or null if not configured yet).
  async findByColony(siteId, colonyMapId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE site_id = $1 AND colony_map_id = $2 LIMIT 1`;
    const result = await pool.query(query, [siteId, colonyMapId]);
    return result.rows[0] || null;
  }

  // Effective settings for a colony: per-colony if present, else site-wide.
  async findEffective(siteId, colonyMapId, pool) {
    if (colonyMapId) {
      const own = await this.findByColony(siteId, colonyMapId, pool);
      if (own) return own;
    }
    return this.findBySite(siteId, pool);
  }

  // All rows for a site (default + every per-colony override) — admin overview.
  async listBySite(siteId, pool) {
    const query = `
      SELECT s.*, cm.name AS colony_name
      FROM ${this.tableName} s
      LEFT JOIN colony_maps cm ON cm.id = s.colony_map_id
      WHERE s.site_id = $1
      ORDER BY s.colony_map_id NULLS FIRST
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  // Upsert by (site_id, colony_map_id). Pass colonyMapId = null for the site-wide default.
  async upsert(siteId, colonyMapId, data, pool) {
    const existing = colonyMapId
      ? await this.findByColony(siteId, colonyMapId, pool)
      : await this.findBySite(siteId, pool);
    if (existing) {
      return this.update(existing.id, { ...data, updated_at: new Date() }, pool);
    }
    return this.create({ site_id: siteId, colony_map_id: colonyMapId || null, ...data }, pool);
  }
}

export default new FinancialSettingsModel();
