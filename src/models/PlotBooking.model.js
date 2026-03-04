import MasterModel from './MasterModel.js';

class PlotBookingModel extends MasterModel {
  constructor() {
    super('plot_bookings');
  }

  // Get all bookings for a site with joined data
  async findBySite({ siteId, status, plotId, bookedBy, page = 1, limit = 20 }, pool) {
    const conditions = ['pb.site_id = $1'];
    const params = [siteId];
    let idx = 2;

    if (status) {
      conditions.push(`pb.status = $${idx++}`);
      params.push(status);
    }
    if (plotId) {
      conditions.push(`pb.plot_id = $${idx++}`);
      params.push(plotId);
    }
    if (bookedBy) {
      conditions.push(`pb.booked_by = $${idx++}`);
      params.push(bookedBy);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countQuery = `SELECT COUNT(*) as total FROM ${this.tableName} pb WHERE ${where}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const query = `
      SELECT pb.*,
        mp.plot_number, mp.block, mp.area_sqft, mp.dimensions, mp.total_price as plot_price, mp.status as plot_status,
        cm.name as colony_name,
        u_booked.name as booked_by_name, u_booked.email as booked_by_email,
        u_referred.name as referred_by_name,
        u_approved.name as approved_by_name,
        l.name as lead_name, l.phone as lead_phone,
        COALESCE(
          (SELECT SUM(amount) FROM payments p WHERE p.booking_id = pb.id AND p.status = 'COMPLETED'), 0
        ) as total_paid,
        COALESCE(
          (SELECT COUNT(*) FROM payments p WHERE p.booking_id = pb.id AND p.status = 'COMPLETED'), 0
        ) as payments_count,
        COALESCE(
          (SELECT COUNT(*) FROM payments p WHERE p.booking_id = pb.id AND p.status = 'PENDING'), 0
        ) as pending_payments
      FROM ${this.tableName} pb
      LEFT JOIN map_plots mp ON pb.plot_id = mp.id
      LEFT JOIN colony_maps cm ON pb.colony_map_id = cm.id
      LEFT JOIN users u_booked ON pb.booked_by = u_booked.id
      LEFT JOIN users u_referred ON pb.referred_by = u_referred.id
      LEFT JOIN users u_approved ON pb.approved_by = u_approved.id
      LEFT JOIN leads l ON pb.lead_id = l.id
      WHERE ${where}
      ORDER BY pb.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(limit, offset);
    const result = await pool.query(query, params);

    return {
      bookings: result.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Get single booking with full details
  async findByIdFull(id, pool) {
    const query = `
      SELECT pb.*,
        mp.plot_number, mp.block, mp.area_sqft, mp.dimensions, mp.total_price as plot_price,
        mp.status as plot_status, mp.facing, mp.plot_type,
        cm.name as colony_name, cm.image_url as map_image_url,
        u_booked.name as booked_by_name, u_booked.email as booked_by_email, u_booked.phone as booked_by_phone,
        u_booked.sponsor_code as booked_by_sponsor_code,
        u_referred.name as referred_by_name, u_referred.sponsor_code as referred_by_sponsor_code,
        u_approved.name as approved_by_name,
        l.name as lead_name, l.phone as lead_phone, l.email as lead_email,
        COALESCE(
          (SELECT SUM(amount) FROM payments p WHERE p.booking_id = pb.id AND p.status = 'COMPLETED'), 0
        ) as total_paid,
        COALESCE(
          (SELECT COUNT(*) FROM payments p WHERE p.booking_id = pb.id), 0
        ) as payments_count
      FROM ${this.tableName} pb
      LEFT JOIN map_plots mp ON pb.plot_id = mp.id
      LEFT JOIN colony_maps cm ON pb.colony_map_id = cm.id
      LEFT JOIN users u_booked ON pb.booked_by = u_booked.id
      LEFT JOIN users u_referred ON pb.referred_by = u_referred.id
      LEFT JOIN users u_approved ON pb.approved_by = u_approved.id
      LEFT JOIN leads l ON pb.lead_id = l.id
      WHERE pb.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  // Find active booking for a plot
  async findActiveByPlot(plotId, pool) {
    const query = `
      SELECT * FROM ${this.tableName}
      WHERE plot_id = $1 AND status IN ('ACTIVE', 'PENDING_APPROVAL')
      LIMIT 1
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows[0];
  }

  // Dashboard stats
  async getStats(siteId, pool, bookedBy = null) {
    const params = [siteId];
    let whereClause = 'site_id = $1';
    if (bookedBy) {
      whereClause += ` AND booked_by = $2`;
      params.push(bookedBy);
    }
    const query = `
      SELECT
        COUNT(*) as total_bookings,
        COUNT(*) FILTER (WHERE status = 'ACTIVE') as active_bookings,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_bookings,
        COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_bookings,
        COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL') as pending_approvals,
        COALESCE(SUM(total_amount) FILTER (WHERE status IN ('ACTIVE', 'COMPLETED')), 0) as total_value,
        COALESCE(SUM(booking_amount) FILTER (WHERE status IN ('ACTIVE', 'COMPLETED')), 0) as total_booking_amount,
        COUNT(*) FILTER (WHERE booking_date >= CURRENT_DATE - INTERVAL '30 days') as this_month_bookings
      FROM ${this.tableName}
      WHERE ${whereClause}
    `;
    const result = await pool.query(query, params);
    return result.rows[0];
  }
}

export default new PlotBookingModel();
