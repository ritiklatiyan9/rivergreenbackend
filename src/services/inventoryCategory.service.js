import inventoryCategoryModel from '../models/InventoryCategory.model.js';
import {
    createHttpError,
    normalizeNullableString,
    normalizeString,
    parsePagination,
} from './inventoryCommon.service.js';

class InventoryCategoryService {
    async getCategories(siteId, query, pool) {
        const { page, limit } = parsePagination(query, { defaultLimit: 12, maxLimit: 100 });
        const search = normalizeString(query.search);

        return inventoryCategoryModel.findBySite(
            siteId,
            {
                search: search || undefined,
                page,
                limit,
            },
            pool,
        );
    }

    async createCategory(siteId, payload, pool) {
        const name = normalizeString(payload.name);
        const description = normalizeNullableString(payload.description);

        if (!name) {
            throw createHttpError(400, 'Category name is required');
        }

        const existing = await inventoryCategoryModel.findByName(siteId, name, pool);
        if (existing) {
            throw createHttpError(409, 'Category name already exists');
        }

        return inventoryCategoryModel.create(
            {
                site_id: siteId,
                name,
                description,
            },
            pool,
        );
    }

    async updateCategory(siteId, categoryId, payload, pool) {
        const category = await inventoryCategoryModel.findByIdForSite(categoryId, siteId, pool);
        if (!category) {
            throw createHttpError(404, 'Category not found');
        }

        const updates = {};

        if (payload.name !== undefined) {
            const nextName = normalizeString(payload.name);
            if (!nextName) {
                throw createHttpError(400, 'Category name is required');
            }

            const duplicate = await inventoryCategoryModel.findByName(siteId, nextName, pool, { excludeId: categoryId });
            if (duplicate) {
                throw createHttpError(409, 'Category name already exists');
            }
            updates.name = nextName;
        }

        if (payload.description !== undefined) {
            updates.description = normalizeNullableString(payload.description);
        }

        if (Object.keys(updates).length === 0) {
            throw createHttpError(400, 'No valid fields to update');
        }

        return inventoryCategoryModel.update(categoryId, updates, pool);
    }

    async deleteCategory(siteId, categoryId, pool) {
        const category = await inventoryCategoryModel.findByIdForSite(categoryId, siteId, pool);
        if (!category) {
            throw createHttpError(404, 'Category not found');
        }

        const inUse = await inventoryCategoryModel.hasProducts(categoryId, siteId, pool);
        if (inUse) {
            throw createHttpError(400, 'Category cannot be deleted because products are linked to it');
        }

        return inventoryCategoryModel.delete(categoryId, pool);
    }
}

export default new InventoryCategoryService();
