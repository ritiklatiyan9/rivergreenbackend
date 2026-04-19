export const createHttpError = (statusCode, message) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
};

export const normalizeString = (value) => {
    if (value === undefined || value === null) return '';
    return String(value).trim();
};

export const normalizeNullableString = (value) => {
    const parsed = normalizeString(value);
    return parsed ? parsed : null;
};

export const parsePagination = (
    query = {},
    { defaultLimit = 20, maxLimit = 100 } = {},
) => {
    const pageRaw = Number.parseInt(query.page, 10);
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    if (String(query.limit || '').toLowerCase() === 'all') {
        return { page: 1, limit: -1 };
    }

    const limitRaw = Number.parseInt(query.limit, 10);
    const parsedLimit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : defaultLimit;
    const limit = Math.min(parsedLimit, maxLimit);

    return { page, limit };
};

export const parsePositiveInteger = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
};
