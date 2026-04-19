import MasterModel from './MasterModel.js';

class InventoryCategoryModel extends MasterModel {
    constructor() {
        super('inventory_categories');
    }

    async findBySite(siteId, { search, page = 1, limit = 20 } = {}, pool) {
        const whereClauses = ['c.site_id = $1'];
        const params = [siteId];
        let idx = 2;

        if (search) {
            whereClauses.push(`(c.name ILIKE $${idx} OR COALESCE(c.description, '') ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx += 1;
        }

        const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM ${this.tableName} c ${whereSql}`,
            params,
        );
        const total = countResult.rows[0]?.total || 0;

        const baseQuery = `
            SELECT c.*,
                   COUNT(p.id)::int AS product_count
            FROM ${this.tableName} c
            LEFT JOIN inventory_products p ON p.category_id = c.id
            ${whereSql}
            GROUP BY c.id
            ORDER BY c.created_at DESC
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

    async findByIdForSite(id, siteId, pool) {
        const result = await pool.query(
            `SELECT * FROM ${this.tableName} WHERE id = $1 AND site_id = $2 LIMIT 1`,
            [id, siteId],
        );
        return result.rows[0] || null;
    }

    async findByName(siteId, name, pool, { excludeId } = {}) {
        const params = [siteId, name.trim()];
        let query = `
            SELECT *
            FROM ${this.tableName}
            WHERE site_id = $1 AND LOWER(name) = LOWER($2)
        `;

        if (excludeId) {
            params.push(excludeId);
            query += ` AND id <> $3`;
        }

        query += ' LIMIT 1';

        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    async hasProducts(id, siteId, pool) {
        const result = await pool.query(
            `SELECT EXISTS(
                SELECT 1 FROM inventory_products
                WHERE category_id = $1 AND site_id = $2
            ) AS in_use`,
            [id, siteId],
        );

        return !!result.rows[0]?.in_use;
    }
}

export default new InventoryCategoryModel();
