import { parseServerInfo, parseUrlParams, decodeBase64 } from '../../utils.js';

/**
 * Parse socks:// URL into sing-box compatible proxy object.
 * Format: socks://<base64-encoded-user:password>@<host>:<port>#<name>
 */
export function parseSocks(url) {
    const { addressPart, name } = parseUrlParams(url);
    const [userinfoEncoded, serverInfo] = addressPart.split('@');

    const { host, port } = parseServerInfo(serverInfo);

    let username, password;
    try {
        const decoded = decodeBase64(userinfoEncoded);
        const colonIndex = decoded.indexOf(':');
        if (colonIndex > -1) {
            username = decoded.slice(0, colonIndex);
            password = decoded.slice(colonIndex + 1);
        } else {
            username = decoded;
            password = '';
        }
    } catch (_) {
        return undefined;
    }

    return {
        type: 'socks',
        tag: name,
        server: host,
        server_port: port,
        version: '5',
        username,
        password
    };
}