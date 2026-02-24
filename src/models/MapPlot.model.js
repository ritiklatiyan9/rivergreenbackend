import MasterModel from './MasterModel.js';

class MapPlotModel extends MasterModel {
  constructor() {
    super('map_plots');
  }

  async findByMap(colonyMapId, pool) {
    const query = `
      SELECT mp.*,
        creator.name as created_by_name,
        updater.name as updated_by_name,
        agent.name as assigned_agent_name,
        referrer.name as referred_by_name,
        l.name as lead_name,
        l.phone as lead_phone
      FROM ${this.tableName} mp
      LEFT JOIN users creator ON mp.created_by = creator.id
      LEFT JOIN users updater ON mp.updated_by = updater.id
      LEFT JOIN users agent ON mp.assigned_agent = agent.id
      LEFT JOIN users referrer ON mp.referred_by = referrer.id
      LEFT JOIN leads l ON mp.lead_id = l.id
      WHERE mp.colony_map_id = $1
      ORDER BY mp.plot_number ASC
    `;
    const result = await pool.query(query, [colonyMapId]);
    return result.rows;
  }

  async findByIdFull(id, pool) {
    const query = `
      SELECT mp.*,
        creator.name as created_by_name,
        updater.name as updated_by_name,
        agent.name as assigned_agent_name,
        referrer.name as referred_by_name,
        l.name as lead_name,
        l.phone as lead_phone,
        l.email as lead_email,
        l.status as lead_status,
        cm.image_url as map_image_url,
        cm.name as map_name
      FROM ${this.tableName} mp
      LEFT JOIN colony_maps cm ON mp.colony_map_id = cm.id
      LEFT JOIN users creator ON mp.created_by = creator.id
      LEFT JOIN users updater ON mp.updated_by = updater.id
      LEFT JOIN users agent ON mp.assigned_agent = agent.id
      LEFT JOIN users referrer ON mp.referred_by = referrer.id
      LEFT JOIN leads l ON mp.lead_id = l.id
      WHERE mp.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  async updateStatus(id, status, updatedBy, pool) {
    const query = `
      UPDATE ${this.tableName}
      SET status = $1, updated_by = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `;
    const result = await pool.query(query, [status, updatedBy, id]);
    return result.rows[0];
  }

  async getStatusSummary(colonyMapId, pool) {
    const query = `
      SELECT status, COUNT(*) as count
      FROM ${this.tableName}
      WHERE colony_map_id = $1
      GROUP BY status
    `;
    const result = await pool.query(query, [colonyMapId]);
    return result.rows;
  }
}

export default new MapPlotModel();
