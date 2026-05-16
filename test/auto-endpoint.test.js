import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';

const createTestApp = (overrides = {}) => {
    const runtime = {
        kv: overrides.kv ?? new MemoryKVAdapter(),
        assetFetcher: overrides.assetFetcher ?? null,
        logger: console,
        config: {
            configTtlSeconds: 60,
            shortLinkTtlSeconds: null,
            ...(overrides.config || {})
        }
    };
    return createApp(runtime);
};

const VMESS_SAMPLE = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';

describe('GET /auto', () => {
    it('detects sing-box and returns JSON config', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/auto?config=${encodeURIComponent(VMESS_SAMPLE)}`, {
            headers: { 'User-Agent': 'SFA/1.12.12 (587; sing-box 1.12.12; language zh_Hans_CN)' }
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('x-sublink-detected-client')).toBe('singbox');
        expect(res.headers.get('vary')).toContain('User-Agent');
        expect(res.headers.get('content-type')).toContain('application/json');
        const json = await res.json();
        expect(json).toHaveProperty('outbounds');
    });

    it('detects clash and returns YAML config', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/auto?config=${encodeURIComponent(VMESS_SAMPLE)}`, {
            headers: { 'User-Agent': 'Clash.Meta/1.18.0' }
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('x-sublink-detected-client')).toBe('clash');
        expect(res.headers.get('vary')).toContain('User-Agent');
        expect(res.headers.get('content-type')).toContain('text/yaml');
        const text = await res.text();
        expect(text).toContain('proxies:');
    });

    it('detects surge and returns surge text config', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/auto?config=${encodeURIComponent(VMESS_SAMPLE)}`, {
            headers: { 'User-Agent': 'Surge iOS/3000' }
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('x-sublink-detected-client')).toBe('surge');
        expect(res.headers.get('vary')).toContain('User-Agent');
        const text = await res.text();
        expect(text).toContain('[General]');
    });

    it('detects xray and returns base64 subscription', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/auto?config=${encodeURIComponent(VMESS_SAMPLE)}`, {
            headers: { 'User-Agent': 'v2rayNG/1.8.27' }
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('x-sublink-detected-client')).toBe('xray');
        expect(res.headers.get('vary')).toContain('User-Agent');
        const text = await res.text();
        expect(text).not.toContain('[General]');
        expect(text).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('detects karing as singbox and returns JSON config', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/auto?config=${encodeURIComponent(VMESS_SAMPLE)}`, {
            headers: { 'User-Agent': 'Karing/1.0.0 (sing-box 1.12.0)' }
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('x-sublink-detected-client')).toBe('singbox');
        expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('falls back to clash when user-agent is unknown', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/auto?config=${encodeURIComponent(VMESS_SAMPLE)}`, {
            headers: { 'User-Agent': 'SomeUnknownClient/0.1' }
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('x-sublink-detected-client')).toBe('clash');
        expect(res.headers.get('content-type')).toContain('text/yaml');
    });
});