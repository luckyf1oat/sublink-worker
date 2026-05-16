import { generateWebPath } from '../utils.js';
import { MissingDependencyError, ServiceError } from './errors.js';

const SHORT_LINK_INDEX_KEY = '__shortlink_index__';

export class ShortLinkService {
    constructor(kv, options = {}) {
        this.kv = kv;
        this.options = options;
    }

    ensureKv() {
        if (!this.kv) {
            throw new MissingDependencyError('Short link service requires a KV store');
        }
        return this.kv;
    }

    async createShortLink(queryString, providedCode) {
        const kv = this.ensureKv();
        const shortCode = providedCode || generateWebPath();
        const existing = await kv.get(shortCode);
        if (existing !== null) {
            throw new ServiceError('Short code already exists', 409);
        }
        const ttl = this.options.shortLinkTtlSeconds;
        const putOptions = ttl ? { expirationTtl: ttl } : undefined;
        await kv.put(shortCode, queryString, putOptions);
        await this.addToIndex(shortCode, queryString);
        return shortCode;
    }

    async resolveShortCode(code) {
        const kv = this.ensureKv();
        return kv.get(code);
    }

    async listShortLinks() {
        const kv = this.ensureKv();
        const rawIndex = await kv.get(SHORT_LINK_INDEX_KEY);
        if (!rawIndex) return [];

        let indexList = [];
        try {
            indexList = JSON.parse(rawIndex);
        } catch {
            return [];
        }

        if (!Array.isArray(indexList)) return [];
        return indexList;
    }

    async addToIndex(code, queryString) {
        const kv = this.ensureKv();
        const rawIndex = await kv.get(SHORT_LINK_INDEX_KEY);
        let indexList = [];

        if (rawIndex) {
            try {
                const parsed = JSON.parse(rawIndex);
                if (Array.isArray(parsed)) {
                    indexList = parsed;
                }
            } catch {
                indexList = [];
            }
        }

        const now = new Date().toISOString();
        const nextList = [
            { code, queryString, createdAt: now },
            ...indexList.filter(item => item?.code !== code)
        ];
        await kv.put(SHORT_LINK_INDEX_KEY, JSON.stringify(nextList));
    }
}
