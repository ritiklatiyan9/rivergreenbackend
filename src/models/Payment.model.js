import MasterModel from './MasterModel.js';

class PaymentModel extends MasterModel {
  constructor() {
    super('payments');
  }

  // Get payments for a booking
  async findByBooking(bookingId, pool) {
    const query = `
      SELECT p.*,
        u_received.name as received_by_name,
        u_created.name as created_by_name
      FROM ${this.tableName} p
      LEFT JOIN users u_received ON p.received_by = u_received.id
      LEFT JOIN users u_created ON p.created_by = u_created.id
      WHERE p.booking_id = $1
      ORDER BY COALESCE(p.due_date, p.payment_date) ASC
    `;
    const result = await pool.query(query, [bookingId]);
    return result.rows;
  }

  // Get all payments for a site with filters
  async findBySite({ siteId, status, paymentType, dateFrom, dateTo, page = 1, limit = 20 }, pool) {
    const conditions = ['p.site_id = $1'];
    const params = [siteId];
    let idx = 2;

    if (status) {
      conditions.push(`p.status = $${idx++}`);
      params.push(status);
    }
    if (paymentType) {
      conditions.push(`p.payment_type = $${idx++}`);
      params.push(paymentType);
    }
    if (dateFrom) {
      conditions.push(`p.payment_date >= $${idx++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`p.payment_date <= $${idx++}`);
      params.push(dateTo);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countQuery = `SELECT COUNT(*) as total FROM ${this.tableName} p WHERE ${where}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const query = `
      SELECT p.*,
        pb.client_name, pb.client_phone,
        pb.booking_amount, pb.total_amount,
        COALESCE((SELECT SUM(amount) FROM payments p2 WHERE p2.booking_id = pb.id AND p2.status = 'COMPLETED'), 0) as booking_total_paid,
        mp.plot_number, mp.block,
        cm.name as colony_name,
        u_received.name as received_by_name,
        u_created.name as created_by_name
      FROM ${this.tableName} p
      LEFT JOIN plot_bookings pb ON p.booking_id = pb.id
      LEFT JOIN map_plots mp ON p.plot_id = mp.id
      LEFT JOIN colony_maps cm ON mp.colony_map_id = cm.id
      LEFT JOIN users u_received ON p.received_by = u_received.id
      LEFT JOIN users u_created ON p.created_by = u_created.id
      WHERE ${where}
      ORDER BY p.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(limit, offset);
    const result = await pool.query(query, params);

    return {
      payments: result.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Get payment summary for a booking
  async getBookingSummary(bookingId, pool) {
    const query = `
      SELECT
        COUNT(*) as total_payments,
        COALESCE(SUM(amount) FILTER (WHERE status = 'COMPLETED'), 0) as total_paid,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0) as total_pending,
        COALESCE(SUM(amount) FILTER (WHERE status = 'REFUNDED'), 0) as total_refunded,
        COUNT(*) FILTER (WHERE status = 'PENDING' AND due_date < CURRENT_DATE) as overdue_count,
        MIN(due_date) FILTER (WHERE status = 'PENDING' AND due_date >= CURRENT_DATE) as next_due_date
      FROM ${this.tableName}
      WHERE booking_id = $1
    `;
    const result = await pool.query(query, [bookingId]);
    return result.rows[0];
  }

  // Get overdue payments
  async findOverdue(siteId, pool) {
    const query = `
      SELECT p.*,
        pb.client_name, pb.client_phone,
        mp.plot_number, mp.block,
        cm.name as colony_name
      FROM ${this.tableName} p
      LEFT JOIN plot_bookings pb ON p.booking_id = pb.id
      LEFT JOIN map_plots mp ON p.plot_id = mp.id
      LEFT JOIN colony_maps cm ON mp.colony_map_id = cm.id
      WHERE p.site_id = $1 AND p.status = 'PENDING' AND p.due_date < CURRENT_DATE
      ORDER BY p.due_date ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  // Dashboard stats
  async getStats(siteId, pool) {
    const query = `
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'COMPLETED'), 0) as total_collected,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0) as total_pending,
        COUNT(*) FILTER (WHERE status = 'PENDING' AND due_date < CURRENT_DATE) as overdue_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING' AND due_date < CURRENT_DATE), 0) as overdue_amount,
        COALESCE(SUM(amount) FILTER (WHERE status = 'COMPLETED' AND payment_date >= DATE_TRUNC('month', CURRENT_DATE)), 0) as this_month_collected,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND payment_date >= CURRENT_DATE - INTERVAL '7 days') as this_week_payments
      FROM ${this.tableName}
      WHERE site_id = $1
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }
}

export default new PaymentModel();
