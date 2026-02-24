import MasterModel from './MasterModel.js';

class UserProfileModel extends MasterModel {
    constructor() {
        super('user_profiles');
    }

    async findByUserId(userId, pool) {
        const query = `
      SELECT up.*, uc.name as category_name, uc.field_groups
      FROM ${this.tableName} up
      LEFT JOIN user_categories uc ON up.category_id = uc.id
      WHERE up.user_id = $1
    `;
        const result = await pool.query(query, [userId]);
        return result.rows[0];
    }

    async upsertByUserId(userId, siteId, categoryId, profileData, pool) {
        const query = `
      INSERT INTO ${this.tableName} (user_id, site_id, category_id, profile_data)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id)
      DO UPDATE SET
        category_id = EXCLUDED.category_id,
        profile_data = EXCLUDED.profile_data,
        updated_at = NOW()
      RETURNING *
    `;
        const result = await pool.query(query, [userId, siteId, categoryId, JSON.stringify(profileData)]);
        return result.rows[0];
    }
}

export default new UserProfileModel();
