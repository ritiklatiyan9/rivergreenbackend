import MasterModel from './MasterModel.js';

class Contact extends MasterModel {
    constructor() {
        super('contacts');
    }

    async findWithDetails(filters, page, limit, pool) {
        const whereClauses = ['c.site_id = $1', 'c.is_converted = FALSE'];
        const params = [filters.site_id];
        let paramIndex = 2;

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
            `SELECT c.*, u.name as created_by_name
             FROM ${this.tableName} c
             LEFT JOIN users u ON c.created_by = u.id
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
