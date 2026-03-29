import MasterModel from './MasterModel.js';

class TeamModel extends MasterModel {
  constructor() {
    super('teams');
  }

  // List teams for a site with head info (multiple heads) and member count
  async findBySiteWithDetails(siteId, pool) {
    const query = `
      SELECT t.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY th.created_at)
           FROM team_heads th JOIN users u ON th.user_id = u.id
           WHERE th.team_id = t.id), '[]'::json
        ) as heads,
        (SELECT COUNT(*) FROM users m WHERE m.team_id = t.id) as member_count,
        COALESCE((SELECT SUM(pb.total_amount) FROM plot_bookings pb JOIN users ub ON pb.booked_by = ub.id WHERE ub.team_id = t.id AND pb.status IN ('ACTIVE','COMPLETED')), 0) as total_revenue
      FROM ${this.tableName} t
      WHERE t.site_id = $1
      ORDER BY t.created_at DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  // Find team by id ensuring site scope
  async findByIdAndSite(id, siteId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE id = $1 AND site_id = $2`;
    const result = await pool.query(query, [id, siteId]);
    return result.rows[0];
  }

  // Find team by name ensuring site scope (case-insensitive)
  async findByNameAndSite(name, siteId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE name ILIKE $1 AND site_id = $2`;
    const result = await pool.query(query, [name, siteId]);
    return result.rows[0];
  }

  // Get performance stats for a team
  async getPerformance(teamId, pool) {
    const query = `
      SELECT
        (SELECT COUNT(*) FROM users WHERE team_id = $1) as total_members,
        (SELECT COUNT(*) FROM leads WHERE team_id = $1) as total_leads,
        (SELECT COUNT(*) FROM plot_bookings pb2 JOIN users ub2 ON pb2.booked_by = ub2.id WHERE ub2.team_id = $1 AND pb2.status IN ('ACTIVE','COMPLETED')) as total_bookings,
        COALESCE((SELECT SUM(pb3.total_amount) FROM plot_bookings pb3 JOIN users ub3 ON pb3.booked_by = ub3.id WHERE ub3.team_id = $1 AND pb3.status IN ('ACTIVE','COMPLETED')), 0) as total_revenue,
        CASE
          WHEN (SELECT COUNT(*) FROM leads WHERE team_id = $1) > 0
          THEN ROUND(
            (SELECT COUNT(*) FROM plot_bookings pb4 JOIN users ub4 ON pb4.booked_by = ub4.id WHERE ub4.team_id = $1 AND pb4.status IN ('ACTIVE','COMPLETED'))::numeric /
            (SELECT COUNT(*) FROM leads WHERE team_id = $1)::numeric * 100, 2
          )
          ELSE 0
        END as conversion_rate
    `;
    const result = await pool.query(query, [teamId]);
    return result.rows[0];
  }

  // Get members of a team
  async getMembers(teamId, pool) {
    const query = `
      SELECT id, name, email, phone, role, sponsor_code, is_active, created_at
      FROM users
      WHERE team_id = $1
      ORDER BY
        CASE role
          WHEN 'TEAM_HEAD' THEN 1
          WHEN 'AGENT' THEN 2
          WHEN 'CLIENT' THEN 3
          WHEN 'VISITOR' THEN 4
        END,
        created_at DESC
    `;
    const result = await pool.query(query, [teamId]);
    return result.rows;
  }

  // Add a head to a team (junction table)
  async addHead(teamId, userId, pool) {
    const query = `
      INSERT INTO team_heads (team_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (team_id, user_id) DO NOTHING
      RETURNING *
    `;
    const result = await pool.query(query, [teamId, userId]);
    return result.rows[0];
  }

  // Remove a head from a team
  async removeHead(teamId, userId, pool) {
    const query = `DELETE FROM team_heads WHERE team_id = $1 AND user_id = $2 RETURNING *`;
    const result = await pool.query(query, [teamId, userId]);
    return result.rows[0];
  }

  // Get all heads of a team
  async getHeads(teamId, pool) {
    const query = `
      SELECT u.id, u.name, u.email, u.role
      FROM team_heads th
      JOIN users u ON th.user_id = u.id
      WHERE th.team_id = $1
      ORDER BY th.created_at
    `;
    const result = await pool.query(query, [teamId]);
    return result.rows;
  }

  // Check if a user is head of a team
  async isHead(teamId, userId, pool) {
    const result = await pool.query(
      'SELECT 1 FROM team_heads WHERE team_id = $1 AND user_id = $2',
      [teamId, userId]
    );
    return result.rows.length > 0;
  }

  // Get head IDs for a team
  async getHeadIds(teamId, pool) {
    const result = await pool.query(
      'SELECT user_id FROM team_heads WHERE team_id = $1',
      [teamId]
    );
    return result.rows.map(r => r.user_id);
  }
}

export default new TeamModel();
