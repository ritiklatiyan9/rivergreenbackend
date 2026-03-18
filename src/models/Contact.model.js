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

        const whereString = 'WHERE ' + whereClauses.join(' AND ');

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM ${this.tableName} c ${whereString}`,
            params
        );
        const total = parseInt(countResult.rows[0].count);

        const offset = (page - 1) * limit;
        params.push(limit, offset);

        const dataResult = await pool.query(
                        `SELECT c.*, u.name as created_by_name,
                                        COALESCE(cc.total_calls, 0)::int AS calls_dialed
             FROM ${this.tableName} c
             LEFT JOIN users u ON c.created_by = u.id
                         LEFT JOIN LATERAL (
                                SELECT COUNT(*)::int AS total_calls
                                FROM calls cl
                                WHERE cl.site_id = c.site_id
                                    AND c.converted_lead_id IS NOT NULL
                                    AND cl.lead_id = c.converted_lead_id
                         ) cc ON TRUE
             ${whereString}
             ORDER BY c.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            params
        );

        return {
            items: dataResult.rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
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
