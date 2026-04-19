import inventoryProductModel from '../models/InventoryProduct.model.js';
import stockTransactionModel from '../models/StockTransaction.model.js';
import {
    createHttpError,
    normalizeNullableString,
    normalizeString,
    parsePagination,
    parsePositiveInteger,
} from './inventoryCommon.service.js';

class InventoryStockService {
    async createTransaction(siteId, userId, payload, pool) {
        const productId = normalizeString(payload.productId || payload.product_id);
        const transactionType = normalizeString(payload.type).toUpperCase();
        const quantity = parsePositiveInteger(payload.quantity);
        const note = normalizeNullableString(payload.note);

        if (!productId) {
            throw createHttpError(400, 'Product is required');
        }

        if (!['IN', 'OUT'].includes(transactionType)) {
            throw createHttpError(400, 'Transaction type must be IN or OUT');
        }

        if (!quantity) {
            throw createHttpError(400, 'Quantity must be a positive number');
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const product = await inventoryProductModel.findByIdForSite(
                productId,
                siteId,
                client,
                { lock: true },
            );

            if (!product) {
                throw createHttpError(404, 'Product not found');
            }

            const currentStock = Number(product.current_stock || 0);
            const nextStock = transactionType === 'IN'
                ? currentStock + quantity
                : currentStock - quantity;

            if (nextStock < 0) {
                throw createHttpError(400, 'Stock OUT cannot exceed available stock');
            }

            const transaction = await stockTransactionModel.createEntry(
                {
                    site_id: siteId,
                    product_id: productId,
                    type: transactionType,
                    quantity,
                    note,
                    created_by: userId,
                },
                client,
            );

            const updatedProduct = await inventoryProductModel.updateCurrentStock(
                productId,
                siteId,
                nextStock,
                client,
            );

            await client.query('COMMIT');

            return {
                transaction,
                product: {
                    ...product,
                    ...updatedProduct,
                    category_name: product.category_name,
                },
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async getHistory(siteId, productId, query, pool) {
        if (!productId) {
            throw createHttpError(400, 'Product id is required');
        }

        const product = await inventoryProductModel.findByIdForSite(productId, siteId, pool);
        if (!product) {
            throw createHttpError(404, 'Product not found');
        }

        const { page, limit } = parsePagination(query, { defaultLimit: 15, maxLimit: 100 });
        const type = normalizeString(query.type).toUpperCase();
        const validType = ['IN', 'OUT'].includes(type) ? type : undefined;

        const historyResult = await stockTransactionModel.findByProduct(
            productId,
            siteId,
            {
                page,
                limit,
                type: validType,
            },
            pool,
        );

        return {
            product,
            items: historyResult.items,
            pagination: historyResult.pagination,
        };
    }
}

export default new InventoryStockService();
