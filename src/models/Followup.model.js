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
            params.push(dateTo + 'T23:59:59');
        }
        if (leadCategory && leadCategory !== 'ALL') {
            conditions.push(`l.lead_category = $${idx++}`);
            params.push(leadCategory);
        }

        const where = conditions.join(' AND ');
        const offset = (page - 1) * limit;

        // Single query: count + rows via window function (eliminates extra round-trip)
        const query = `
      SELECT f.*,
        l.name as lead_name, l.phone as lead_phone, l.lead_category,
        u_agent.name as agent_name, u_agent.email as agent_email,
        u_esc.name as escalated_to_name,
        c.call_type,
        COUNT(*) OVER() AS _total_count
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

        const total = result.rows.length > 0 ? parseInt(result.rows[0]._total_count) : 0;
        const followups = result.rows.map(({ _total_count, ...row }) => row);

        return {
            followups,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    // Get scheduled (pending + snoozed for future) with status counts
    async findScheduled({ siteId, assignedTo, teamId, leadCategory, dateFrom, dateTo, page = 1, limit = 20 }, pool) {
        // Build shared WHERE conditions for the counts query
        const countConditions = ['f.site_id = $1', "f.status = ANY($2)"];
        const countParams = [siteId, ['PENDING', 'SNOOZED']];
        let cIdx = 3;

        if (assignedTo) { countConditions.push(`f.assigned_to = $${cIdx++}`); countParams.push(assignedTo); }
        if (teamId) { countConditions.push(`u_agent.team_id = $${cIdx++}`); countParams.push(teamId); }
        if (leadCategory && leadCategory !== 'ALL') { countConditions.push(`l.lead_category = $${cIdx++}`); countParams.push(leadCategory); }
        if (dateFrom) { countConditions.push(`f.scheduled_at >= $${cIdx++}`); countParams.push(dateFrom); }
        if (dateTo) { countConditions.push(`f.scheduled_at <= $${cIdx++}`); countParams.push(dateTo + 'T23:59:59'); }

        const countWhere = countConditions.join(' AND ');
        const countsQuery = `
      SELECT
        COUNT(*) FILTER (WHERE f.status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE f.status = 'SNOOZED')::int AS snoozed,
        COUNT(*)::int AS total
      FROM ${this.tableName} f
      LEFT JOIN leads l ON f.lead_id = l.id
      LEFT JOIN users u_agent ON f.assigned_to = u_agent.id
      WHERE ${countWhere}
    `;

        // Run counts + data in parallel
        const [countsResult, dataResult] = await Promise.all([
            pool.query(countsQuery, countParams),
            this.findWithDetails({
                siteId, assignedTo, teamId, leadCategory,
                dateFrom, dateTo,
                status: ['PENDING', 'SNOOZED'],
                page, limit,
            }, pool),
        ]);

        // Completed today count (lightweight separate query)
        const todayConditions = ['f.site_id = $1', "f.status = 'COMPLETED'", "f.completed_at::date = CURRENT_DATE"];
        const todayParams = [siteId];
        let tIdx = 2;
        if (assignedTo) { todayConditions.push(`f.assigned_to = $${tIdx++}`); todayParams.push(assignedTo); }
        if (teamId) { todayConditions.push(`u_agent.team_id = $${tIdx++}`); todayParams.push(teamId); }
        const todayResult = await pool.query(
            `SELECT COUNT(*)::int AS done_today FROM ${this.tableName} f LEFT JOIN users u_agent ON f.assigned_to = u_agent.id WHERE ${todayConditions.join(' AND ')}`,
            todayParams
        );

        return {
            ...dataResult,
            counts: {
                pending: countsResult.rows[0]?.pending || 0,
                snoozed: countsResult.rows[0]?.snoozed || 0,
                total: countsResult.rows[0]?.total || 0,
                done_today: todayResult.rows[0]?.done_today || 0,
            },
        };
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

        // Single query: count + rows via window function
        const query = `
      SELECT f.*,
        l.name as lead_name, l.phone as lead_phone, l.lead_category,
        u_agent.name as agent_name, u_agent.email as agent_email,
        u_esc.name as escalated_to_name,
        c.call_type,
        COUNT(*) OVER() AS _total_count
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

        const total = result.rows.length > 0 ? parseInt(result.rows[0]._total_count) : 0;
        const followups = result.rows.map(({ _total_count, ...row }) => row);

        return {
            followups,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    // Dashboard counts
        async getCounts({ siteId, assignedTo = null, teamId = null }, pool) {
                const conditions = ['f.site_id = $1'];
                const params = [siteId];
                let idx = 2;

                if (assignedTo) {
                        conditions.push(`f.assigned_to = $${idx++}`);
                        params.push(assignedTo);
                }
                if (teamId) {
                        conditions.push(`u.team_id = $${idx++}`);
                        params.push(teamId);
                }

                const where = conditions.join(' AND ');
                const query = `
            SELECT
                COUNT(*) FILTER (WHERE f.status = 'PENDING' AND f.scheduled_at >= NOW()) as scheduled,
                COUNT(*) FILTER (WHERE f.status = 'PENDING' AND f.scheduled_at < NOW()) as missed,
                COUNT(*) FILTER (WHERE f.status = 'COMPLETED') as completed,
                COUNT(*) FILTER (WHERE f.status = 'ESCALATED') as escalated,
                COUNT(*) FILTER (WHERE f.scheduled_at::date = CURRENT_DATE AND f.status IN ('PENDING','SNOOZED')) as today
            FROM ${this.tableName} f
            LEFT JOIN users u ON f.assigned_to = u.id
            WHERE ${where}
        `;
                const result = await pool.query(query, params);
                return result.rows[0];
        }
}

export default new FollowupModel();
