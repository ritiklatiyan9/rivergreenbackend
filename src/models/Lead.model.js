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

    // Advanced search with pagination
    async findWithDetails(filters, page, limit, pool) {
        const offset = (page - 1) * limit;
        let whereClauses = [];
        let params = [];
        let paramIndex = 1;

        if (filters.site_id) {
            whereClauses.push(`l.site_id = $${paramIndex++}`);
            params.push(filters.site_id);
        }

        if (filters.assigned_to) {
            whereClauses.push(`l.assigned_to = $${paramIndex++}`);
            params.push(filters.assigned_to);
        }

        if (filters.status) {
            whereClauses.push(`l.status = $${paramIndex++}`);
            params.push(filters.status);
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
                   c.name as created_by_name
            FROM ${this.tableName} l
            LEFT JOIN users u ON l.assigned_to = u.id
            LEFT JOIN users c ON l.created_by = c.id
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
}

export default new LeadModel();
