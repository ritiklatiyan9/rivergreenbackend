import MasterModel from './MasterModel.js';

class ClientActivityModel extends MasterModel {
  constructor() {
    super('client_activities');
  }

  // Get activities with filters
  async findWithDetails({ siteId, leadId, plotId, bookingId, activityType, status, assignedTo, dateFrom, dateTo, page = 1, limit = 20 }, pool) {
    const conditions = ['ca.site_id = $1'];
    const params = [siteId];
    let idx = 2;

    if (leadId) {
      conditions.push(`ca.lead_id = $${idx++}`);
      params.push(leadId);
    }
    if (plotId) {
      conditions.push(`ca.plot_id = $${idx++}`);
      params.push(plotId);
    }
    if (bookingId) {
      conditions.push(`ca.booking_id = $${idx++}`);
      params.push(bookingId);
    }
    if (activityType) {
      conditions.push(`ca.activity_type = $${idx++}`);
      params.push(activityType);
    }
    if (status) {
      conditions.push(`ca.status = $${idx++}`);
      params.push(status);
    }
    if (assignedTo) {
      conditions.push(`ca.assigned_to = $${idx++}`);
      params.push(assignedTo);
    }
    if (dateFrom) {
      conditions.push(`ca.scheduled_at >= $${idx++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`ca.scheduled_at <= $${idx++}`);
      params.push(dateTo);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countQuery = `SELECT COUNT(*) as total FROM ${this.tableName} ca WHERE ${where}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const query = `
      SELECT ca.*,
        l.name as lead_name, l.phone as lead_phone,
        mp.plot_number, mp.block,
        pb.client_name as booking_client_name,
        u_assigned.name as assigned_to_name,
        u_created.name as created_by_name
      FROM ${this.tableName} ca
      LEFT JOIN leads l ON ca.lead_id = l.id
      LEFT JOIN map_plots mp ON ca.plot_id = mp.id
      LEFT JOIN plot_bookings pb ON ca.booking_id = pb.id
      LEFT JOIN users u_assigned ON ca.assigned_to = u_assigned.id
      LEFT JOIN users u_created ON ca.created_by = u_created.id
      WHERE ${where}
      ORDER BY COALESCE(ca.scheduled_at, ca.created_at) DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(limit, offset);
    const result = await pool.query(query, params);

    return {
      activities: result.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Today's activities
  async findToday(siteId, assignedTo, pool) {
    const userFilter = assignedTo ? `AND ca.assigned_to = $2` : '';
    const params = assignedTo ? [siteId, assignedTo] : [siteId];

    const query = `
      SELECT ca.*,
        l.name as lead_name, l.phone as lead_phone,
        mp.plot_number,
        u_assigned.name as assigned_to_name
      FROM ${this.tableName} ca
      LEFT JOIN leads l ON ca.lead_id = l.id
      LEFT JOIN map_plots mp ON ca.plot_id = mp.id
      LEFT JOIN users u_assigned ON ca.assigned_to = u_assigned.id
      WHERE ca.site_id = $1
        AND ca.scheduled_at::date = CURRENT_DATE
        ${userFilter}
      ORDER BY ca.scheduled_at ASC
    `;
    const result = await pool.query(query, params);
    return result.rows;
  }

  // Dashboard stats
  async getStats(siteId, assignedTo, pool) {
    const userFilter = assignedTo ? `AND assigned_to = $2` : '';
    const params = assignedTo ? [siteId, assignedTo] : [siteId];

    const query = `
      SELECT
        COUNT(*) as total_activities,
        COUNT(*) FILTER (WHERE scheduled_at::date = CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE status = 'SCHEDULED') as scheduled,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
        COUNT(*) FILTER (WHERE status = 'NO_SHOW') as no_shows,
        COUNT(*) FILTER (WHERE activity_type = 'VISIT') as total_visits,
        COUNT(*) FILTER (WHERE activity_type = 'MEETING') as total_meetings,
        COUNT(*) FILTER (WHERE activity_type = 'PLOT_SHOWING') as total_showings,
        COUNT(*) FILTER (WHERE activity_type IN ('CALL_INCOMING', 'CALL_OUTGOING')) as total_calls,
        COUNT(*) FILTER (WHERE status = 'SCHEDULED' AND scheduled_at < NOW()) as overdue
      FROM ${this.tableName}
      WHERE site_id = $1 ${userFilter}
    `;
    const result = await pool.query(query, params);
    return result.rows[0];
  }
}

export default new ClientActivityModel();
