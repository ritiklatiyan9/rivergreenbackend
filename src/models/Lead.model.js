import MasterModel from './MasterModel.js';

class LeadModel extends MasterModel {
    constructor() {
        super('leads');
    }

    async findBySiteAndTeam(siteId, teamId, pool) {
        let query = `SELECT * FROM ${this.tableName} WHERE site_id = $1`;
        let params = [siteId];

        if (teamId) {
            query += ` AND team_id = $2`;
            params.push(teamId);
        }

        query += ` ORDER BY created_at DESC`;

        const result = await pool.query(query, params);
        return result.rows;
    }

    async findAssignedTo(siteId, assignedToId, pool) {
        const query = `
            SELECT * FROM ${this.tableName} 
            WHERE site_id = $1 AND assigned_to = $2
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query, [siteId, assignedToId]);
        return result.rows;
    }

    // Advanced search with pagination — ownership-aware
    async findWithDetails(filters, page, limit, pool) {
        const offset = (page - 1) * limit;
        let whereClauses = [];
        let params = [];
        let paramIndex = 1;

        if (filters.site_id) {
            whereClauses.push(`l.site_id = $${paramIndex++}`);
            params.push(filters.site_id);
        }

        // Ownership filter: agent/team_head sees only leads they own OR are assigned to
        if (filters.owner_or_assigned) {
            whereClauses.push(`(l.owner_id = $${paramIndex} OR l.assigned_to = $${paramIndex})`);
            params.push(filters.owner_or_assigned);
            paramIndex++;
        } else if (filters.assigned_to) {
            whereClauses.push(`l.assigned_to = $${paramIndex++}`);
            params.push(filters.assigned_to);
        }

        if (filters.status) {
            whereClauses.push(`l.status = $${paramIndex++}`);
            params.push(filters.status);
        }

        if (filters.exclude_status) {
            whereClauses.push(`l.status != $${paramIndex++}`);
            params.push(filters.exclude_status);
        }

        if (filters.lead_category) {
            whereClauses.push(`l.lead_category = $${paramIndex++}`);
            params.push(filters.lead_category);
        }

        if (filters.search) {
            whereClauses.push(`(l.name ILIKE $${paramIndex} OR l.phone ILIKE $${paramIndex} OR l.email ILIKE $${paramIndex})`);
            params.push(`%${filters.search}%`);
            paramIndex++;
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Get total count
        const countQuery = `
            SELECT COUNT(*) FROM ${this.tableName} l
            ${whereString}
        `;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Get paginated data with user details
        let paginationClause = '';
        if (limit !== -1) {
            paginationClause = `LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            params.push(limit, offset);
        }

        const dataQuery = `
            SELECT l.*, 
                   u.name as assigned_to_name,
                   c.name as created_by_name,
                   o.name as owner_name,
                   COALESCE(cc.total_calls, 0)::int AS calls_dialed
            FROM ${this.tableName} l
            LEFT JOIN users u ON l.assigned_to = u.id
            LEFT JOIN users c ON l.created_by = c.id
            LEFT JOIN users o ON l.owner_id = o.id
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS total_calls
                FROM calls cl
                WHERE cl.site_id = l.site_id
                  AND cl.lead_id = l.id
            ) cc ON TRUE
            ${whereString}
            ORDER BY l.created_at DESC
            ${paginationClause}
        `;

        const dataResult = await pool.query(dataQuery, params);

        return {
            items: dataResult.rows,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    // Get status counts (pipeline breakdown) for a site/agent/team
    async getStatusCounts(filters, pool) {
        let whereClauses = [];
        let params = [];
        let paramIndex = 1;

        if (filters.site_id) {
            whereClauses.push(`site_id = $${paramIndex++}`);
            params.push(filters.site_id);
        }
        if (filters.owner_or_assigned) {
            whereClauses.push(`(owner_id = $${paramIndex} OR assigned_to = $${paramIndex})`);
            params.push(filters.owner_or_assigned);
            paramIndex++;
        } else if (filters.assigned_to) {
            whereClauses.push(`assigned_to = $${paramIndex++}`);
            params.push(filters.assigned_to);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const query = `
            SELECT status, COUNT(*)::int AS count
            FROM ${this.tableName}
            ${whereString}
            GROUP BY status
        `;
        const result = await pool.query(query, params);
        const counts = {};
        result.rows.forEach(r => { counts[r.status] = r.count; });
        return counts;
    }

    // Get assignment history for a lead
    async getAssignmentHistory(leadId, pool) {
        const query = `
            SELECT la.*,
                   af.name as assigned_from_name,
                   at2.name as assigned_to_name,
                   ab.name as assigned_by_name
            FROM lead_assignments la
            LEFT JOIN users af ON la.assigned_from = af.id
            LEFT JOIN users at2 ON la.assigned_to = at2.id
            LEFT JOIN users ab ON la.assigned_by = ab.id
            WHERE la.lead_id = $1
            ORDER BY la.created_at DESC
        `;
        const result = await pool.query(query, [leadId]);
        return result.rows;
    }

    // Get all assignment history for a site (with lead details)
    async getAllAssignmentHistory(siteId, filters, page, limit, pool) {
        const offset = (page - 1) * limit;
        let whereClauses = ['l.site_id = $1'];
        let params = [siteId];
        let paramIndex = 2;

        if (filters.user_id) {
            whereClauses.push(`(la.assigned_from = $${paramIndex} OR la.assigned_to = $${paramIndex} OR la.assigned_by = $${paramIndex})`);
            params.push(filters.user_id);
            paramIndex++;
        }

        if (filters.search) {
            whereClauses.push(`(l.name ILIKE $${paramIndex} OR l.phone ILIKE $${paramIndex})`);
            params.push(`%${filters.search}%`);
            paramIndex++;
        }

        const whereString = `WHERE ${whereClauses.join(' AND ')}`;

        const countQuery = `
            SELECT COUNT(*) FROM lead_assignments la
            JOIN leads l ON la.lead_id = l.id
            ${whereString}
        `;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        params.push(limit, offset);

        const dataQuery = `
            SELECT la.*,
                   l.name as lead_name,
                   l.phone as lead_phone,
                   l.status as lead_status,
                   af.name as assigned_from_name,
                   at2.name as assigned_to_name,
                   ab.name as assigned_by_name,
                   af.role as assigned_from_role,
                   at2.role as assigned_to_role
            FROM lead_assignments la
            JOIN leads l ON la.lead_id = l.id
            LEFT JOIN users af ON la.assigned_from = af.id
            LEFT JOIN users at2 ON la.assigned_to = at2.id
            LEFT JOIN users ab ON la.assigned_by = ab.id
            ${whereString}
            ORDER BY la.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `;

        const dataResult = await pool.query(dataQuery, params);

        return {
            items: dataResult.rows,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        };
    }
}

export default new LeadModel();
