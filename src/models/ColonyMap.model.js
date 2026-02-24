import MasterModel from './MasterModel.js';

class ColonyMapModel extends MasterModel {
    constructor() {
        super('colony_maps');
    }

    async findBySite(siteId, pool) {
        const query = `
      SELECT cm.*,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM map_plots mp WHERE mp.colony_map_id = cm.id) as plot_count
      FROM ${this.tableName} cm
      LEFT JOIN users u ON cm.created_by = u.id
      WHERE cm.site_id = $1
      ORDER BY cm.created_at DESC
    `;
        const result = await pool.query(query, [siteId]);
        return result.rows;
    }

    async findByIdWithPlots(id, siteId, pool) {
        // Get the map
        const mapQuery = `
      SELECT cm.*, u.name as created_by_name
      FROM ${this.tableName} cm
      LEFT JOIN users u ON cm.created_by = u.id
      WHERE cm.id = $1 AND cm.site_id = $2
    `;
        const mapResult = await pool.query(mapQuery, [id, siteId]);
        const map = mapResult.rows[0];
        if (!map) return null;

        // Get all plots for this map
        const plotsQuery = `
      SELECT mp.*,
        creator.name as created_by_name,
        updater.name as updated_by_name,
        agent.name as assigned_agent_name,
        referrer.name as referred_by_name,
        l.name as lead_name,
        l.phone as lead_phone
      FROM map_plots mp
      LEFT JOIN users creator ON mp.created_by = creator.id
      LEFT JOIN users updater ON mp.updated_by = updater.id
      LEFT JOIN users agent ON mp.assigned_agent = agent.id
      LEFT JOIN users referrer ON mp.referred_by = referrer.id
      LEFT JOIN leads l ON mp.lead_id = l.id
      WHERE mp.colony_map_id = $1
      ORDER BY mp.plot_number ASC
    `;
        const plotsResult = await pool.query(plotsQuery, [id]);
        map.plots = plotsResult.rows;

        return map;
    }
}

export default new ColonyMapModel();
