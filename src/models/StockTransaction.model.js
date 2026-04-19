import MasterModel from './MasterModel.js';

class StockTransactionModel extends MasterModel {
    constructor() {
        super('stock_transactions');
    }

    async createEntry(data, db) {
        const result = await db.query(
            `
            INSERT INTO ${this.tableName}
                (site_id, product_id, type, quantity, note, created_by)
            VALUES
                ($1, $2, $3, $4, $5, $6)
            RETURNING *
            `,
            [
                data.site_id,
                data.product_id,
                data.type,
                data.quantity,
                data.note || null,
                data.created_by || null,
            ],
        );

        return result.rows[0] || null;
    }

    async findByProduct(productId, siteId, { page = 1, limit = 20, type } = {}, pool) {
        const whereClauses = ['st.product_id = $1', 'st.site_id = $2'];
        const params = [productId, siteId];
        let idx = 3;

        if (type && ['IN', 'OUT'].includes(type)) {
            whereClauses.push(`st.type = $${idx}`);
            params.push(type);
            idx += 1;
        }

        const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM ${this.tableName} st ${whereSql}`,
            params,
        );
        const total = countResult.rows[0]?.total || 0;

        const baseQuery = `
            SELECT st.*, u.name AS created_by_name
            FROM ${this.tableName} st
            LEFT JOIN users u ON u.id = st.created_by
            ${whereSql}
            ORDER BY st.created_at DESC
        `;

        if (limit <= 0) {
            const result = await pool.query(baseQuery, params);
            return {
                items: result.rows,
                pagination: {
                    total,
                    page: 1,
                    limit: total,
                    totalPages: 1,
                },
            };
        }

        const offset = (page - 1) * limit;
        const result = await pool.query(
            `${baseQuery} LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset],
        );

        return {
            items: result.rows,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        };
    }
}

export default new StockTransactionModel();
