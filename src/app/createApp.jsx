/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from 'hono';
import { Layout } from '../components/Layout.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { Form } from '../components/Form.jsx';
import { Footer } from '../components/Footer.jsx';
import { UpdateChecker } from '../components/UpdateChecker.jsx';
import { SingboxConfigBuilder } from '../builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../builders/SurgeConfigBuilder.js';
import { createTranslator, resolveLanguage } from '../i18n/index.js';
import { encodeBase64, tryDecodeSubscriptionLines } from '../utils.js';
import { APP_NAME, APP_SUBTITLE } from '../constants.js';
import { ShortLinkService } from '../services/shortLinkService.js';
import { ConfigStorageService } from '../services/configStorageService.js';
import { ServiceError, MissingDependencyError } from '../services/errors.js';
import { normalizeRuntime } from '../runtime/runtimeConfig.js';
import { PREDEFINED_RULE_SETS, SING_BOX_CONFIG, SING_BOX_CONFIG_V1_11, generateSubconverterConfig } from '../config/index.js';

const DEFAULT_USER_AGENT = 'curl/7.74.0';
const ADMIN_PASSWORD_HASH_KEY = '__admin_password_hash__';
const ADMIN_SESSION_TOKEN_KEY = '__admin_session_token__';

export function createApp(bindings = {}) {
    const runtime = normalizeRuntime(bindings);
    const services = {
        shortLinks: runtime.kv ? new ShortLinkService(runtime.kv, { shortLinkTtlSeconds: runtime.config.shortLinkTtlSeconds }) : null,
        configStorage: runtime.kv ? new ConfigStorageService(runtime.kv, { configTtlSeconds: runtime.config.configTtlSeconds }) : null
    };

    const app = new Hono();

    app.use('*', async (c, next) => {
        const acceptLanguage = getRequestHeader(c.req, 'Accept-Language');
        const lang = c.req.query('lang') || acceptLanguage?.split(',')[0] || 'zh-CN';
        c.set('lang', lang);
        c.set('t', createTranslator(lang));
        await next();
    });

    app.get('/', async (c) => {
        const t = c.get('t');
        const lang = resolveLanguage(c.get('lang'));
        const subtitle = APP_SUBTITLE[lang] || APP_SUBTITLE['zh-CN'];

        return c.html(
            <Layout title={t('pageTitle')} description={t('pageDescription')} keywords={t('pageKeywords')}>
                <div class="flex flex-col min-h-screen">
                    <Navbar />
                    <main class="flex-1">
                        <div class="container mx-auto px-4 py-8 pt-24">
                            <div class="max-w-4xl mx-auto">
                                <div class="text-center mb-12 pt-8">
                                    <h1 class="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight">
                                        {APP_NAME}
                                    </h1>
                                    <p class="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
                                        {subtitle}
                                    </p>
                                </div>
                                <Form t={t} lang={lang} />
                            </div>
                        </div>
                    </main>
                    <Footer />
                    <UpdateChecker />
                </div>
            </Layout>
        );
    });

    app.get('/auth/status', async (c) => {
        const state = await getAdminAuthState(runtime.kv, c);
        return c.json(state);
    });

    app.post('/auth/setup', async (c) => {
        if (!runtime.kv) {
            throw new MissingDependencyError('Admin auth requires KV store');
        }

        const { password } = await c.req.json();
        if (typeof password !== 'string') {
            return c.text('Password is required', 400);
        }

        const existingHash = await runtime.kv.get(ADMIN_PASSWORD_HASH_KEY);
        if (existingHash) {
            return c.text('Admin password is already set', 409);
        }

        await runtime.kv.put(ADMIN_PASSWORD_HASH_KEY, await sha256Hex(password));
        const token = await createAdminSession(runtime.kv);
        c.header('Set-Cookie', buildSessionCookie(token));
        return c.text('OK');
    });

    app.post('/auth/login', async (c) => {
        if (!runtime.kv) {
            throw new MissingDependencyError('Admin auth requires KV store');
        }

        const { password } = await c.req.json();
        if (typeof password !== 'string') {
            return c.text('Password is required', 400);
        }

        const storedHash = await runtime.kv.get(ADMIN_PASSWORD_HASH_KEY);
        if (!storedHash) {
            return c.text('Admin password is not initialized', 400);
        }

        const inputHash = await sha256Hex(password);
        if (inputHash !== storedHash) {
            return c.text('Invalid password', 401);
        }

        const token = await createAdminSession(runtime.kv);
        c.header('Set-Cookie', buildSessionCookie(token));
        return c.text('OK');
    });

    app.post('/auth/logout', async (c) => {
        if (runtime.kv) {
            await runtime.kv.delete(ADMIN_SESSION_TOKEN_KEY);
        }
        c.header('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
        return c.text('OK');
    });

    app.get('/singbox', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const ua = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const enableClashUI = parseBooleanFlag(c.req.query('enable_clash_ui'));
            const externalController = c.req.query('external_controller');
            const externalUiDownloadUrl = c.req.query('external_ui_download_url');
            const configId = c.req.query('configId');
            const lang = c.get('lang');

            const requestedSingboxVersion = c.req.query('singbox_version') || c.req.query('sb_version') || c.req.query('sb_ver');
            const requestUserAgent = getRequestHeader(c.req, 'User-Agent');
            const singboxConfigVersion = resolveSingboxConfigVersion(requestedSingboxVersion, requestUserAgent);

            let baseConfig = singboxConfigVersion === '1.11' ? SING_BOX_CONFIG_V1_11 : SING_BOX_CONFIG;
            if (configId) {
                const storage = requireConfigStorage(services.configStorage);
                const storedConfig = await storage.getConfigById(configId);
                if (storedConfig) {
                    baseConfig = storedConfig;
                }
            }

            const builder = new SingboxConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                ua,
                groupByCountry,
                enableClashUI,
                externalController,
                externalUiDownloadUrl,
                singboxConfigVersion,
                includeAutoSelect
            );
            await builder.build();
            const userinfo = builder.getSubscriptionUserinfo();
            if (userinfo) {
                c.header('subscription-userinfo', userinfo);
            }
            return c.json(builder.config);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/clash', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const ua = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const enableClashUI = parseBooleanFlag(c.req.query('enable_clash_ui'));
            const externalController = c.req.query('external_controller');
            const externalUiDownloadUrl = c.req.query('external_ui_download_url');
            const configId = c.req.query('configId');
            const lang = c.get('lang');

            let baseConfig;
            if (configId) {
                const storage = requireConfigStorage(services.configStorage);
                baseConfig = await storage.getConfigById(configId);
            }

            const builder = new ClashConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                ua,
                groupByCountry,
                enableClashUI,
                externalController,
                externalUiDownloadUrl,
                includeAutoSelect
            );
            await builder.build();
            const userinfo = builder.getSubscriptionUserinfo();
            const headers = { 'Content-Type': 'text/yaml; charset=utf-8' };
            if (userinfo) {
                headers['subscription-userinfo'] = userinfo;
            }
            return c.text(builder.formatConfig(), 200, headers);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/surge', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const ua = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const configId = c.req.query('configId');
            const lang = c.get('lang');

            let baseConfig;
            if (configId) {
                const storage = requireConfigStorage(services.configStorage);
                baseConfig = await storage.getConfigById(configId);
            }

            const builder = new SurgeConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                ua,
                groupByCountry,
                includeAutoSelect
            );
            builder.setSubscriptionUrl(c.req.url);
            await builder.build();

            const userinfo = builder.getSubscriptionUserinfo();
            if (userinfo) {
                c.header('subscription-userinfo', userinfo);
            }
            return c.text(builder.formatConfig());
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/subconverter', (c) => {
        try {
            const rawSelectedRules = c.req.query('selectedRules');
            let selectedRules;

            if (!rawSelectedRules) {
                selectedRules = PREDEFINED_RULE_SETS.balanced;
            } else if (PREDEFINED_RULE_SETS[rawSelectedRules]) {
                selectedRules = PREDEFINED_RULE_SETS[rawSelectedRules];
            } else {
                try {
                    const parsed = JSON.parse(rawSelectedRules);
                    if (Array.isArray(parsed)) {
                        selectedRules = parsed;
                    } else {
                        return c.text('Invalid selectedRules: must be a preset name (minimal, balanced, comprehensive) or a JSON array', 400);
                    }
                } catch {
                    return c.text(`Invalid selectedRules: "${rawSelectedRules}" is not a valid preset name or JSON array. Valid presets: minimal, balanced, comprehensive`, 400);
                }
            }

            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const lang = c.get('lang');

            const config = generateSubconverterConfig({
                selectedRules,
                customRules,
                lang,
                includeAutoSelect,
                groupByCountry
            });

            return c.text(config, 200, {
                'Content-Type': 'text/plain; charset=utf-8'
            });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/xray', async (c) => {
        const inputString = c.req.query('config');
        if (!inputString) {
            return c.text('Missing config parameter', 400);
        }

        const proxylist = inputString.split('\n');
        const finalProxyList = [];
        let subscriptionUserinfo;
        const userAgent = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
        const headers = { 'User-Agent': userAgent };

        for (const proxy of proxylist) {
            const trimmedProxy = proxy.trim();
            if (!trimmedProxy) continue;

            if (trimmedProxy.startsWith('http://') || trimmedProxy.startsWith('https://')) {
                try {
                    const response = await fetch(trimmedProxy, { method: 'GET', headers });
                    const fetchedUserinfo = response.headers.get('subscription-userinfo');
                    if (fetchedUserinfo && subscriptionUserinfo === undefined) {
                        subscriptionUserinfo = fetchedUserinfo;
                    }
                    const text = await response.text();
                    let processed = tryDecodeSubscriptionLines(text, { decodeUriComponent: true });
                    if (!Array.isArray(processed)) processed = [processed];
                    finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
                } catch (e) {
                    runtime.logger.warn('Failed to fetch the proxy', e);
                }
            } else {
                let processed = tryDecodeSubscriptionLines(trimmedProxy);
                if (!Array.isArray(processed)) processed = [processed];
                finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
            }
        }

        const finalString = finalProxyList.join('\n');
        if (!finalString) {
            return c.text('Missing config parameter', 400);
        }

        const responseHeaders = {};
        if (subscriptionUserinfo) {
            responseHeaders['subscription-userinfo'] = subscriptionUserinfo;
        }

        return c.text(encodeBase64(finalString), 200, responseHeaders);
    });

    app.get('/auto', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const userAgent = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const detectedClient = detectSubscriptionClient(userAgent);
            const lang = c.get('lang');

            if (detectedClient === 'singbox') {
                const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
                const customRules = parseJsonArray(c.req.query('customRules'));
                const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
                const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
                const enableClashUI = parseBooleanFlag(c.req.query('enable_clash_ui'));
                const externalController = c.req.query('external_controller');
                const externalUiDownloadUrl = c.req.query('external_ui_download_url');
                const configId = c.req.query('configId');

                const requestedSingboxVersion = c.req.query('singbox_version') || c.req.query('sb_version') || c.req.query('sb_ver');
                const requestUserAgent = getRequestHeader(c.req, 'User-Agent');
                const singboxConfigVersion = resolveSingboxConfigVersion(requestedSingboxVersion, requestUserAgent);

                let baseConfig = singboxConfigVersion === '1.11' ? SING_BOX_CONFIG_V1_11 : SING_BOX_CONFIG;
                if (configId) {
                    const storage = requireConfigStorage(services.configStorage);
                    const storedConfig = await storage.getConfigById(configId);
                    if (storedConfig) {
                        baseConfig = storedConfig;
                    }
                }

                const builder = new SingboxConfigBuilder(
                    config,
                    selectedRules,
                    customRules,
                    baseConfig,
                    lang,
                    userAgent,
                    groupByCountry,
                    enableClashUI,
                    externalController,
                    externalUiDownloadUrl,
                    singboxConfigVersion,
                    includeAutoSelect
                );
                await builder.build();
                const userinfo = builder.getSubscriptionUserinfo();
                if (userinfo) {
                    c.header('subscription-userinfo', userinfo);
                }
                c.header('X-SubLink-Detected-Client', detectedClient);
                c.header('Vary', 'User-Agent');
                return c.json(builder.config);
            }

            if (detectedClient === 'surge') {
                const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
                const customRules = parseJsonArray(c.req.query('customRules'));
                const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
                const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
                const configId = c.req.query('configId');

                let baseConfig;
                if (configId) {
                    const storage = requireConfigStorage(services.configStorage);
                    baseConfig = await storage.getConfigById(configId);
                }

                const builder = new SurgeConfigBuilder(
                    config,
                    selectedRules,
                    customRules,
                    baseConfig,
                    lang,
                    userAgent,
                    groupByCountry,
                    includeAutoSelect
                );
                builder.setSubscriptionUrl(c.req.url);
                await builder.build();
                const userinfo = builder.getSubscriptionUserinfo();
                if (userinfo) {
                    c.header('subscription-userinfo', userinfo);
                }
                c.header('X-SubLink-Detected-Client', detectedClient);
                c.header('Vary', 'User-Agent');
                return c.text(builder.formatConfig());
            }

            if (detectedClient === 'xray') {
                const proxylist = config.split('\n');
                const finalProxyList = [];
                let subscriptionUserinfo;
                const headers = { 'User-Agent': userAgent };

                for (const proxy of proxylist) {
                    const trimmedProxy = proxy.trim();
                    if (!trimmedProxy) continue;

                    if (trimmedProxy.startsWith('http://') || trimmedProxy.startsWith('https://')) {
                        try {
                            const response = await fetch(trimmedProxy, { method: 'GET', headers });
                            const fetchedUserinfo = response.headers.get('subscription-userinfo');
                            if (fetchedUserinfo && subscriptionUserinfo === undefined) {
                                subscriptionUserinfo = fetchedUserinfo;
                            }
                            const text = await response.text();
                            let processed = tryDecodeSubscriptionLines(text, { decodeUriComponent: true });
                            if (!Array.isArray(processed)) processed = [processed];
                            finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
                        } catch (e) {
                            runtime.logger.warn('Failed to fetch the proxy', e);
                        }
                    } else {
                        let processed = tryDecodeSubscriptionLines(trimmedProxy);
                        if (!Array.isArray(processed)) processed = [processed];
                        finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
                    }
                }

                const finalString = finalProxyList.join('\n');
                if (!finalString) {
                    return c.text('Missing config parameter', 400);
                }

                if (subscriptionUserinfo) {
                    c.header('subscription-userinfo', subscriptionUserinfo);
                }
                c.header('X-SubLink-Detected-Client', detectedClient);
                c.header('Vary', 'User-Agent');
                return c.text(encodeBase64(finalString));
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const enableClashUI = parseBooleanFlag(c.req.query('enable_clash_ui'));
            const externalController = c.req.query('external_controller');
            const externalUiDownloadUrl = c.req.query('external_ui_download_url');
            const configId = c.req.query('configId');

            let baseConfig;
            if (configId) {
                const storage = requireConfigStorage(services.configStorage);
                baseConfig = await storage.getConfigById(configId);
            }

            const builder = new ClashConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                userAgent,
                groupByCountry,
                enableClashUI,
                externalController,
                externalUiDownloadUrl,
                includeAutoSelect
            );
            await builder.build();
            const userinfo = builder.getSubscriptionUserinfo();
            const headers = {
                'Content-Type': 'text/yaml; charset=utf-8',
                'X-SubLink-Detected-Client': detectedClient,
                Vary: 'User-Agent'
            };
            if (userinfo) {
                headers['subscription-userinfo'] = userinfo;
            }
            return c.text(builder.formatConfig(), 200, headers);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/shorten-v2', async (c) => {
        try {
            const url = c.req.query('url');
            if (!url) {
                return c.text('Missing URL parameter', 400);
            }
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch {
                return c.text('Invalid URL parameter', 400);
            }
            const queryString = parsedUrl.search;

            const shortLinks = requireShortLinkService(services.shortLinks);
            const code = await shortLinks.createShortLink(queryString, c.req.query('shortCode'));
            return c.text(code);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    const redirectHandler = (prefix) => async (c) => {
        try {
            const code = c.req.param('code');
            const shortLinks = requireShortLinkService(services.shortLinks);
            const originalParam = await shortLinks.resolveShortCode(code);
            if (!originalParam) return c.text('Short URL not found', 404);

            const url = new URL(c.req.url);
            return c.redirect(`${url.origin}/${prefix}${originalParam}`);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    };

    app.get('/s/:code', redirectHandler('surge'));
    app.get('/b/:code', redirectHandler('singbox'));
    app.get('/c/:code', redirectHandler('clash'));
    app.get('/x/:code', redirectHandler('xray'));
    app.get('/a/:code', redirectHandler('auto'));

    app.post('/config', async (c) => {
        try {
            const { type, content } = await c.req.json();
            const storage = requireConfigStorage(services.configStorage);
            const configId = await storage.saveConfig(type, content);
            return c.text(configId);
        } catch (error) {
            if (error instanceof SyntaxError) {
                return c.text(`Invalid format: ${error.message}`, 400);
            }
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/resolve', async (c) => {
        try {
            const shortUrl = c.req.query('url');
            const t = c.get('t');
            if (!shortUrl) return c.text(t('missingUrl'), 400);

            let urlObj;
            try {
                urlObj = new URL(shortUrl);
            } catch {
                return c.text(t('invalidShortUrl'), 400);
            }
            const pathParts = urlObj.pathname.split('/');
            if (pathParts.length < 3) return c.text(t('invalidShortUrl'), 400);

            const prefix = pathParts[1];
            const shortCode = pathParts[2];
            if (!['a', 'b', 'c', 'x', 's'].includes(prefix)) return c.text(t('invalidShortUrl'), 400);

            const shortLinks = requireShortLinkService(services.shortLinks);
            const originalParam = await shortLinks.resolveShortCode(shortCode);
            if (!originalParam) return c.text(t('shortUrlNotFound'), 404);

            const mapping = { a: 'auto', b: 'singbox', c: 'clash', x: 'xray', s: 'surge' };
            const originalUrl = `${urlObj.origin}/${mapping[prefix]}${originalParam}`;
            return c.json({ originalUrl });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/list', async (c) => {
        const authState = await getAdminAuthState(runtime.kv, c);
        if (!authState.initialized) {
            return c.html(renderAdminAuthPage({ initialized: false, next: '/list' }));
        }
        if (!authState.authenticated) {
            return c.html(renderAdminAuthPage({ initialized: true, next: '/list' }));
        }

        const shortLinks = requireShortLinkService(services.shortLinks);
        const list = await shortLinks.listShortLinks();
        return c.json({ list });
    });

    app.get('/favicon.ico', async (c) => {
        if (!runtime.assetFetcher) {
            return c.notFound();
        }
        try {
            return await runtime.assetFetcher(c.req.raw);
        } catch (error) {
            runtime.logger.warn('Asset fetch failed', error);
            return c.notFound();
        }
    });

    return app;
}

export function parseSelectedRules(raw) {
    if (!raw) return [];

    // 首先检查是否是预设名称 (minimal, balanced, comprehensive)
    // 这确保向后兼容主分支的 API 行为
    if (typeof raw === 'string' && PREDEFINED_RULE_SETS[raw]) {
        return PREDEFINED_RULE_SETS[raw];
    }

    // 尝试解析为 JSON 数组
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // 解析失败，回退到 minimal 预设
        console.warn(`Failed to parse selectedRules: ${raw}, falling back to minimal`);
        return PREDEFINED_RULE_SETS.minimal;
    }
}

function parseJsonArray(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseBooleanFlag(value) {
    return value === 'true' || value === true;
}

function parseSemverLike(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const match = trimmed.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: match[3] ? Number(match[3]) : 0
    };
}

function isSingboxLegacyConfig(version) {
    if (!version || Number.isNaN(version.major) || Number.isNaN(version.minor)) {
        return false;
    }
    if (version.major !== 1) {
        return version.major < 1;
    }
    return version.minor < 12;
}

function resolveSingboxConfigVersion(requestedVersion, userAgent) {
    const normalizedRequested = typeof requestedVersion === 'string' ? requestedVersion.trim().toLowerCase() : '';
    if (normalizedRequested && normalizedRequested !== 'auto') {
        if (normalizedRequested === 'legacy') return '1.11';
        if (normalizedRequested === 'latest') return '1.12';
        const parsed = parseSemverLike(normalizedRequested);
        if (parsed) {
            return isSingboxLegacyConfig(parsed) ? '1.11' : '1.12';
        }
    }

    if (typeof userAgent === 'string' && userAgent) {
        const uaMatch = userAgent.match(/sing-box\/(\d+\.\d+(?:\.\d+)?)/i) || userAgent.match(/sing-box\s+(\d+\.\d+(?:\.\d+)?)/i);
        const versionString = uaMatch?.[1];
        const parsed = versionString ? parseSemverLike(versionString) : null;
        if (parsed) {
            return isSingboxLegacyConfig(parsed) ? '1.11' : '1.12';
        }
    }

    return '1.12';
}

function detectSubscriptionClient(userAgent) {
    const ua = typeof userAgent === 'string' ? userAgent.toLowerCase() : '';
    if (!ua) {
        return 'clash';
    }

    if (
        ua.includes('sing-box') ||
        ua.includes('singbox') ||
        ua.includes('sfa/') ||
        ua.includes('sfi/') ||
        ua.includes('karing') ||
        ua.includes('hiddify') ||
        ua.includes('nekoray') ||
        ua.includes('nekobox') ||
        ua.includes('foxray') ||
        ua.includes('v2box')
    ) {
        return 'singbox';
    }

    if (
        ua.includes('mihomo') ||
        ua.includes('clash') ||
        ua.includes('meta') ||
        ua.includes('clash-verge') ||
        ua.includes('clashx') ||
        ua.includes('stash') ||
        ua.includes('loon') ||
        ua.includes('shadowrocket')
    ) {
        return 'clash';
    }

    if (ua.includes('surge')) {
        return 'surge';
    }

    if (ua.includes('xray') || ua.includes('v2ray') || ua.includes('v2rayng') || ua.includes('nekobox')) {
        return 'xray';
    }

    return 'clash';
}

function getRequestHeader(request, name) {
    if (!request || !name) {
        return undefined;
    }

    try {
        const value = request.header(name);
        if (value !== undefined) {
            return value;
        }
    } catch {
        // Fallback if HonoRequest.header cannot read from the raw request.
    }

    const headers = request.raw?.headers;
    if (!headers) {
        return undefined;
    }

    if (typeof headers.get === 'function') {
        return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
    }

    if (typeof headers === 'object') {
        const lowerName = name.toLowerCase();
        const headerValue = headers[lowerName] ?? headers[name];
        if (Array.isArray(headerValue)) {
            return headerValue[0];
        }
        return headerValue;
    }

    return undefined;
}

function requireShortLinkService(service) {
    if (!service) {
        throw new MissingDependencyError('Short link functionality is unavailable');
    }
    return service;
}

function requireConfigStorage(service) {
    if (!service) {
        throw new MissingDependencyError('Config storage functionality is unavailable');
    }
    return service;
}

function handleError(c, error, logger) {
    if (error instanceof ServiceError) {
        return c.text(error.message, error.status);
    }
    logger.error?.('Unhandled error', error);
    return c.text(`Error: ${error.message}`, 500);
}

async function getAdminAuthState(kv, c) {
    if (!kv) {
        return { initialized: false, authenticated: true };
    }

    const storedHash = await kv.get(ADMIN_PASSWORD_HASH_KEY);
    const initialized = Boolean(storedHash);
    if (!initialized) {
        return { initialized: false, authenticated: false };
    }

    const sessionToken = getCookieValue(c.req, 'admin_session');
    if (!sessionToken) {
        return { initialized: true, authenticated: false };
    }

    const storedSessionToken = await kv.get(ADMIN_SESSION_TOKEN_KEY);
    return {
        initialized: true,
        authenticated: Boolean(storedSessionToken && sessionToken === storedSessionToken)
    };
}

function getCookieValue(request, name) {
    const cookieHeader = getRequestHeader(request, 'Cookie');
    if (!cookieHeader) return null;
    const pairs = cookieHeader.split(';');
    for (const pair of pairs) {
        const [rawKey, ...rawValue] = pair.split('=');
        if (!rawKey) continue;
        if (rawKey.trim() === name) {
            return decodeURIComponent(rawValue.join('=').trim());
        }
    }
    return null;
}

async function sha256Hex(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function createAdminSession(kv) {
    const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await kv.put(ADMIN_SESSION_TOKEN_KEY, token);
    return token;
}

function buildSessionCookie(token) {
    return `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`;
}

function renderAdminAuthPage({ initialized, next = '/' }) {
    const action = initialized ? '/auth/login' : '/auth/setup';
    const title = initialized ? 'Admin Login' : 'Set Admin Password';
    const subtitle = initialized ? 'Please enter admin password to access panel.' : 'First visit detected. Please set admin password.';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0f172a; color:#e2e8f0; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    .card { width: 92%; max-width: 420px; background:#111827; border:1px solid #334155; border-radius:12px; padding:24px; }
    input,button { width:100%; box-sizing:border-box; padding:12px; border-radius:8px; border:1px solid #334155; margin-top:12px; }
    input { background:#0b1220; color:#e2e8f0; }
    button { background:#2563eb; color:white; cursor:pointer; }
    p { color:#94a3b8; margin:0 0 8px 0; }
    #msg { margin-top: 10px; color: #fca5a5; min-height: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${title}</h2>
    <p>${subtitle}</p>
    <input id="password" type="password" placeholder="Password" />
    <button id="submit">Submit</button>
    <div id="msg"></div>
  </div>
  <script>
    document.getElementById('submit').addEventListener('click', async () => {
      const password = document.getElementById('password').value;
      const res = await fetch('${action}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (!res.ok) {
        document.getElementById('msg').textContent = await res.text();
        return;
      }
      location.href = '${next}';
    });
  </script>
</body>
</html>`;
}
