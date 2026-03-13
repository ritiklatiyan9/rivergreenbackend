import MasterModel from './MasterModel.js';

class FollowupModel extends MasterModel {
    constructor() {
        super('followups');
    }

    // Paginated, filterable followups
    async findWithDetails({ siteId, assignedTo, teamId, status, followupType, dateFrom, dateTo, leadCategory, page = 1, limit = 20 }, pool) {
        const conditions = ['f.site_id = $1'];
        const params = [siteId];
        let idx = 2;

        if (assignedTo) {
            conditions.push(`f.assigned_to = $${idx++}`);
            params.push(assignedTo);
        }
        if (teamId) {
            conditions.push(`u_agent.team_id = $${idx++}`);
            params.push(teamId);
        }
        if (status) {
            if (Array.isArray(status)) {
                conditions.push(`f.status = ANY($${idx++})`);
                params.push(status);
            } else {
                conditions.push(`f.status = $${idx++}`);
                params.push(status);
            }
        }
        if (followupType) {
            conditions.push(`f.followup_type = $${idx++}`);
            params.push(followupType);
        }
        if (dateFrom) {
            conditions.push(`f.scheduled_at >= $${idx++}`);
            params.push(dateFrom);
        }
        if (dateTo) {
            conditions.push(`f.scheduled_at <= $${idx++}`);
            params.push(dateTo);
        }
        if (leadCategory && leadCategory !== 'ALL') {
            conditions.push(`l.lead_category = $${idx++}`);
            params.push(leadCategory);
        }

        const where = conditions.join(' AND ');
        const offset = (page - 1) * limit;

        const countQuery = `
      SELECT COUNT(*) as total
      FROM ${this.tableName} f
      JOIN users u_agent ON f.assigned_to = u_agent.id
      LEFT JOIN leads l ON f.lead_id = l.id
      WHERE ${where}
    `;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].total);

        const query = `
      SELECT f.*,
        l.name as lead_name, l.phone as lead_phone, l.lead_category,
        u_agent.name as agent_name, u_agent.email as agent_email,
        u_esc.name as escalated_to_name,
        c.call_type
      FROM ${this.tableName} f
      LEFT JOIN leads l ON f.lead_id = l.id
      LEFT JOIN users u_agent ON f.assigned_to = u_agent.id
      LEFT JOIN users u_esc ON f.escalated_to = u_esc.id
      LEFT JOIN calls c ON f.call_id = c.id
      WHERE ${where}
      ORDER BY f.scheduled_at ASC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
        params.push(limit, offset);
        const result = await pool.query(query, params);

        return {
            followups: result.rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    // Get scheduled (pending + snoozed for future)
    async findScheduled({ siteId, assignedTo, teamId, leadCategory, dateFrom, dateTo, page = 1, limit = 20 }, pool) {
        return this.findWithDetails({
            siteId,
            assignedTo,
            teamId,
            leadCategory,
            dateFrom,
            dateTo,
            status: ['PENDING', 'SNOOZED'],
            page,
            limit,
        }, pool);
    }

    // Get missed (past-due PENDING items)
    async findMissed({ siteId, assignedTo, teamId, leadCategory, dateFrom, dateTo, page = 1, limit = 20 }, pool) {
        const conditions = ['f.site_id = $1', 'f.status = \'PENDING\'', 'f.scheduled_at < NOW()'];
        const params = [siteId];
        let idx = 2;

        if (assignedTo) {
            conditions.push(`f.assigned_to = $${idx++}`);
            params.push(assignedTo);
        }
        if (teamId) {
            conditions.push(`u_agent.team_id = $${idx++}`);
            params.push(teamId);
        }
        if (leadCategory && leadCategory !== 'ALL') {
            conditions.push(`l.lead_category = $${idx++}`);
            params.push(leadCategory);
        }
        if (dateFrom) {
            conditions.push(`f.scheduled_at >= $${idx++}`);
            params.push(dateFrom);
        }
        if (dateTo) {
            conditions.push(`f.scheduled_at <= $${idx++}`);
            params.push(dateTo);
        }

        const where = conditions.join(' AND ');
        const offset = (page - 1) * limit;

        const countQuery = `
      SELECT COUNT(*) as total
      FROM ${this.tableName} f
      JOIN users u_agent ON f.assigned_to = u_agent.id
      LEFT JOIN leads l ON f.lead_id = l.id
      WHERE ${where}
    `;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].total);

        const query = `
      SELECT f.*,
        l.name as lead_name, l.phone as lead_phone, l.lead_category,
        u_agent.name as agent_name, u_agent.email as agent_email,
        u_esc.name as escalated_to_name,
        c.call_type
      FROM ${this.tableName} f
      LEFT JOIN leads l ON f.lead_id = l.id
      LEFT JOIN users u_agent ON f.assigned_to = u_agent.id
      LEFT JOIN users u_esc ON f.escalated_to = u_esc.id
      LEFT JOIN calls c ON f.call_id = c.id
      WHERE ${where}
      ORDER BY f.scheduled_at ASC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
        params.push(limit, offset);
        const result = await pool.query(query, params);

        return {
            followups: result.rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    // Dashboard counts
    async getCounts(siteId, assignedTo, pool) {
        const userFilter = assignedTo ? `AND assigned_to = $2` : '';
        const params = assignedTo ? [siteId, assignedTo] : [siteId];

        const query = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING' AND scheduled_at >= NOW()) as scheduled,
        COUNT(*) FILTER (WHERE status = 'PENDING' AND scheduled_at < NOW()) as missed,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
        COUNT(*) FILTER (WHERE status = 'ESCALATED') as escalated,
        COUNT(*) FILTER (WHERE scheduled_at::date = CURRENT_DATE AND status IN ('PENDING','SNOOZED')) as today
      FROM ${this.tableName}
      WHERE site_id = $1 ${userFilter}
    `;
        const result = await pool.query(query, params);
        return result.rows[0];
    }
}

export default new FollowupModel();
