import MasterModel from './MasterModel.js';

class FinancialSettingsModel extends MasterModel {
  constructor() {
    super('site_financial_settings');
  }

  async findBySite(siteId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE site_id = $1`;
    const result = await pool.query(query, [siteId]);
    return result.rows[0] || null;
  }

  async upsert(siteId, data, pool) {
    const existing = await this.findBySite(siteId, pool);
    if (existing) {
      return this.update(existing.id, { ...data, updated_at: new Date() }, pool);
    }
    return this.create({ site_id: siteId, ...data }, pool);
  }
}

export default new FinancialSettingsModel();
