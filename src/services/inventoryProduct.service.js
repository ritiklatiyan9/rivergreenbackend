import inventoryCategoryModel from '../models/InventoryCategory.model.js';
import inventoryProductModel from '../models/InventoryProduct.model.js';
import {
    createHttpError,
    normalizeString,
    parsePagination,
} from './inventoryCommon.service.js';

class InventoryProductService {
    async getProducts(siteId, query, pool) {
        const { page, limit } = parsePagination(query, { defaultLimit: 12, maxLimit: 100 });
        const search = normalizeString(query.search);
        const categoryId = normalizeString(query.categoryId || query.category_id);

        return inventoryProductModel.findBySite(
            siteId,
            {
                search: search || undefined,
                categoryId: categoryId || undefined,
                page,
                limit,
            },
            pool,
        );
    }

    async getProductById(siteId, productId, pool) {
        const product = await inventoryProductModel.findByIdForSite(productId, siteId, pool);
        if (!product) {
            throw createHttpError(404, 'Product not found');
        }

        return product;
    }

    async createProduct(siteId, payload, pool) {
        const name = normalizeString(payload.name);
        const categoryId = normalizeString(payload.categoryId || payload.category_id);

        if (!name) {
            throw createHttpError(400, 'Product name is required');
        }

        if (!categoryId) {
            throw createHttpError(400, 'Category is required');
        }

        const category = await inventoryCategoryModel.findByIdForSite(categoryId, siteId, pool);
        if (!category) {
            throw createHttpError(400, 'Invalid category selected');
        }

        const duplicate = await inventoryProductModel.findByName(siteId, name, pool);
        if (duplicate) {
            throw createHttpError(409, 'Product name already exists');
        }

        const created = await inventoryProductModel.create(
            {
                site_id: siteId,
                category_id: categoryId,
                name,
                current_stock: 0,
            },
            pool,
        );

        return inventoryProductModel.findByIdForSite(created.id, siteId, pool);
    }
}

export default new InventoryProductService();
