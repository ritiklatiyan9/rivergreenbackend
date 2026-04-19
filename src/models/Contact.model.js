import MasterModel from './MasterModel.js';

class Contact extends MasterModel {
    constructor() {
        super('contacts');
    }

    async findWithDetails(filters, page, limit, pool) {
        const whereClauses = ['c.site_id = $1'];
        const params = [filters.site_id];
        let paramIndex = 2;

        if (filters.created_by) {
            whereClauses.push(`c.created_by = $${paramIndex}`);
            params.push(filters.created_by);
            paramIndex++;
        }

        if (filters.search) {
            whereClauses.push(`(c.name ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex})`);
            params.push(`%${filters.search}%`);
            paramIndex++;
        }

        // Filter directly on contacts' own columns (no lead join needed)
        if (filters.status) {
            whereClauses.push(`c.status = $${paramIndex}`);
            params.push(filters.status);
            paramIndex++;
        }

        if (filters.lead_category) {
            whereClauses.push(`c.lead_category = $${paramIndex}`);
            params.push(filters.lead_category);
            paramIndex++;
        }

        const whereString = 'WHERE ' + whereClauses.join(' AND ');

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM ${this.tableName} c ${whereString}`,
            params
        );
        const total = parseInt(countResult.rows[0].count);

        const baseQuery = `
            SELECT c.*, u.name as created_by_name,
                     COALESCE(cc.total_calls, 0)::int AS calls_dialed
            FROM ${this.tableName} c
            LEFT JOIN users u ON c.created_by = u.id
            LEFT JOIN (
                SELECT lead_id, COUNT(*)::int AS total_calls
                FROM calls
                GROUP BY lead_id
            ) cc ON c.converted_lead_id = cc.lead_id
            ${whereString}
            ORDER BY c.created_at DESC
        `;

        let dataResult;
        let resolvedPage = page;
        let resolvedLimit = limit;
        let totalPages;

        if (limit <= 0) {
            dataResult = await pool.query(baseQuery, params);
            resolvedPage = 1;
            resolvedLimit = total;
            totalPages = 1;
        } else {
            const offset = (page - 1) * limit;
            const pagedParams = [...params, limit, offset];
            dataResult = await pool.query(
                `${baseQuery}
                 LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
                pagedParams
            );
            totalPages = Math.ceil(total / limit);
        }

        return {
            items: dataResult.rows,
            pagination: { total, page: resolvedPage, limit: resolvedLimit, totalPages },
        };
    }

    async findByPhone(siteId, phone, pool) {
        const result = await pool.query(
            `SELECT * FROM ${this.tableName} WHERE site_id = $1 AND phone = $2`,
            [siteId, phone]
        );
        return result.rows[0];
    }
}

export default new Contact();
