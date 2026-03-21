import MasterModel from './MasterModel.js';

class AgentLiveLocationModel extends MasterModel {
  constructor() {
    super('agent_live_locations');
  }

  // Upsert the latest location of an agent
  async upsertLocation(userId, latitude, longitude, pool) {
    const query = `
      INSERT INTO ${this.tableName} (user_id, latitude, longitude, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        updated_at = NOW()
      RETURNING *
    `;
    const result = await pool.query(query, [userId, latitude, longitude]);
    return result.rows[0];
  }

  // Get all active locations within the last 12 hours
  async getAllActiveLocations(pool) {
    const query = `
      SELECT al.*, u.name as user_name, u.profile_photo, u.phone, u.role
      FROM ${this.tableName} al
      JOIN users u ON al.user_id = u.id
      WHERE al.updated_at >= NOW() - INTERVAL '12 hours'
      ORDER BY al.updated_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  }
}

export default new AgentLiveLocationModel();
