import MasterModel from './MasterModel.js';

class TeamModel extends MasterModel {
  constructor() {
    super('teams');
  }

  // List teams for a site with head info and member count
  async findBySiteWithDetails(siteId, pool) {
    const query = `
      SELECT t.*,
        u.name as head_name,
        u.email as head_email,
        (SELECT COUNT(*) FROM users m WHERE m.team_id = t.id) as member_count,
        COALESCE((SELECT SUM(pb.total_amount) FROM plot_bookings pb JOIN users ub ON pb.booked_by = ub.id WHERE ub.team_id = t.id AND pb.status IN ('ACTIVE','COMPLETED')), 0) as total_revenue
      FROM ${this.tableName} t
      LEFT JOIN users u ON t.head_id = u.id
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
}

export default new TeamModel();
