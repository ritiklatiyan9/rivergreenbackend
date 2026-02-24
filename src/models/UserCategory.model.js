import MasterModel from './MasterModel.js';

class UserCategoryModel extends MasterModel {
    constructor() {
        super('user_categories');
    }

    async findBySite(siteId, pool) {
        const query = `
      SELECT * FROM ${this.tableName}
      WHERE site_id = $1
      ORDER BY created_at DESC
    `;
        const result = await pool.query(query, [siteId]);
        return result.rows;
    }

    async findActiveBySite(siteId, pool) {
        const query = `
      SELECT * FROM ${this.tableName}
      WHERE site_id = $1 AND is_active = TRUE
      ORDER BY name ASC
    `;
        const result = await pool.query(query, [siteId]);
        return result.rows;
    }
}

export default new UserCategoryModel();
