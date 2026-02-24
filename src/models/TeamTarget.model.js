import MasterModel from './MasterModel.js';

class TeamTargetModel extends MasterModel {
  constructor() {
    super('team_targets');
  }

  // Upsert target for a team/month/year
  async upsert(data, pool) {
    const query = `
      INSERT INTO ${this.tableName} (team_id, month, year, lead_target, booking_target, revenue_target)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (team_id, month, year)
      DO UPDATE SET
        lead_target = EXCLUDED.lead_target,
        booking_target = EXCLUDED.booking_target,
        revenue_target = EXCLUDED.revenue_target
      RETURNING *
    `;
    const result = await pool.query(query, [
      data.team_id,
      data.month,
      data.year,
      data.lead_target || 0,
      data.booking_target || 0,
      data.revenue_target || 0,
    ]);
    return result.rows[0];
  }

  // Get targets for a team with actuals comparison
  async findByTeamWithActuals(teamId, pool) {
    const query = `
      SELECT tt.*,
        COALESCE((
          SELECT COUNT(*) FROM leads l
          WHERE l.team_id = tt.team_id
            AND EXTRACT(MONTH FROM l.created_at) = tt.month
            AND EXTRACT(YEAR FROM l.created_at) = tt.year
        ), 0) as actual_leads,
        COALESCE((
          SELECT COUNT(*) FROM plot_bookings pb
          JOIN users ub ON pb.booked_by = ub.id
          WHERE ub.team_id = tt.team_id
            AND pb.status IN ('ACTIVE','COMPLETED')
            AND EXTRACT(MONTH FROM pb.booking_date) = tt.month
            AND EXTRACT(YEAR FROM pb.booking_date) = tt.year
        ), 0) as actual_bookings,
        COALESCE((
          SELECT SUM(pb2.total_amount) FROM plot_bookings pb2
          JOIN users ub2 ON pb2.booked_by = ub2.id
          WHERE ub2.team_id = tt.team_id
            AND pb2.status IN ('ACTIVE','COMPLETED')
            AND EXTRACT(MONTH FROM pb2.booking_date) = tt.month
            AND EXTRACT(YEAR FROM pb2.booking_date) = tt.year
        ), 0) as actual_revenue
      FROM ${this.tableName} tt
      WHERE tt.team_id = $1
      ORDER BY tt.year DESC, tt.month DESC
    `;
    const result = await pool.query(query, [teamId]);
    return result.rows;
  }

  // Get target for a specific month/year
  async findByTeamMonthYear(teamId, month, year, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE team_id = $1 AND month = $2 AND year = $3`;
    const result = await pool.query(query, [teamId, month, year]);
    return result.rows[0];
  }
}

export default new TeamTargetModel();
