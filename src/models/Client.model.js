import MasterModel from './MasterModel.js';

class ClientModel extends MasterModel {
  constructor() {
    super('plot_bookings');
  }

  // List clients (bookings with client info or completed/active bookings)
  // and ef
  async findClients({ siteId, search, status, colonyMapId, page = 1, limit = 20 }, pool) {
    const conditions = ['pb.site_id = $1'];
    const params = [siteId];
    let idx = 2;

    if (status) {
      conditions.push(`pb.status = $${idx++}`);
      params.push(status);
    } else {
      // default: include active and completed
      conditions.push(`pb.status IN ('ACTIVE','COMPLETED')`);
    }

    if (search) {
      conditions.push(`(pb.client_name ILIKE $${idx} OR pb.client_phone ILIKE $${idx} OR mp.plot_number::text ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    if (colonyMapId) {
      conditions.push(`pb.colony_map_id = $${idx++}`);
      params.push(colonyMapId);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countQ = `SELECT COUNT(*) as total FROM ${this.tableName} pb WHERE ${where}`;
    const countRes = await pool.query(countQ, params);
    const total = parseInt(countRes.rows[0].total);

    const q = `
      SELECT pb.id as booking_id, pb.client_name, pb.client_phone, pb.client_email,
        pb.total_amount, pb.booking_amount, pb.status, pb.created_at,
        mp.plot_number, mp.block, cm.name as colony_name,
        u_booked.name as booked_by_name,
        COALESCE((SELECT SUM(amount) FROM payments p WHERE p.booking_id = pb.id AND p.status = 'COMPLETED'), 0) as total_paid
      FROM ${this.tableName} pb
      LEFT JOIN map_plots mp ON pb.plot_id = mp.id
      LEFT JOIN colony_maps cm ON pb.colony_map_id = cm.id
      LEFT JOIN users u_booked ON pb.booked_by = u_booked.id
      WHERE ${where}
      ORDER BY pb.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(limit, offset);

    const res = await pool.query(q, params);
    return { clients: res.rows, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findById(bookingId, pool) {
    const q = `
      SELECT pb.*, mp.plot_number, mp.block, cm.name as colony_name,
             u_booked.name as booked_by_name
      FROM ${this.tableName} pb
      LEFT JOIN map_plots mp ON pb.plot_id = mp.id
      LEFT JOIN colony_maps cm ON pb.colony_map_id = cm.id
      LEFT JOIN users u_booked ON pb.booked_by = u_booked.id
      WHERE pb.id = $1
    `;
    const res = await pool.query(q, [bookingId]);
    return res.rows[0];
  }

  async updateClientInfo(bookingId, data, pool) {
    // Build set clause
    const keys = Object.keys(data);
    if (!keys.length) return null;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const values = keys.map(k => data[k]);
    const q = `UPDATE ${this.tableName} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const res = await pool.query(q, [bookingId, ...values]);
    return res.rows[0];
  }
}

export default new ClientModel();
