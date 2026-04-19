import MasterModel from './MasterModel.js';

class InventoryProductModel extends MasterModel {
    constructor() {
        super('inventory_products');
    }

    async findBySite(siteId, { search, categoryId, page = 1, limit = 20 } = {}, pool) {
        const whereClauses = ['p.site_id = $1'];
        const params = [siteId];
        let idx = 2;

        if (search) {
            whereClauses.push(`p.name ILIKE $${idx}`);
            params.push(`%${search}%`);
            idx += 1;
        }

        if (categoryId) {
            whereClauses.push(`p.category_id = $${idx}`);
            params.push(categoryId);
            idx += 1;
        }

        const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM ${this.tableName} p ${whereSql}`,
            params,
        );
        const total = countResult.rows[0]?.total || 0;

        const baseQuery = `
            SELECT p.*, c.name AS category_name,
                   c.description AS category_description
            FROM ${this.tableName} p
            JOIN inventory_categories c ON c.id = p.category_id
            ${whereSql}
            ORDER BY p.created_at DESC
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

    async findByName(siteId, name, pool, { excludeId } = {}) {
        const params = [siteId, name.trim()];
        let query = `
            SELECT *
            FROM ${this.tableName}
            WHERE site_id = $1 AND LOWER(name) = LOWER($2)
        `;

        if (excludeId) {
            params.push(excludeId);
            query += ' AND id <> $3';
        }

        query += ' LIMIT 1';
        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    async findByIdForSite(id, siteId, db, { lock = false } = {}) {
        const result = await db.query(
            `
            SELECT p.*, c.name AS category_name
            FROM ${this.tableName} p
            JOIN inventory_categories c ON c.id = p.category_id
            WHERE p.id = $1 AND p.site_id = $2
            ${lock ? 'FOR UPDATE' : ''}
            LIMIT 1
            `,
            [id, siteId],
        );

        return result.rows[0] || null;
    }

    async updateCurrentStock(id, siteId, currentStock, db) {
        const result = await db.query(
            `
            UPDATE ${this.tableName}
            SET current_stock = $1, updated_at = NOW()
            WHERE id = $2 AND site_id = $3
            RETURNING *
            `,
            [currentStock, id, siteId],
        );

        return result.rows[0] || null;
    }
}

export default new InventoryProductModel();
