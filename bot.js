
require('dotenv').config();

const WebSocket = require('ws');
const zlib = require('zlib');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const AuthManager = require('./authManager');

const WS_URL = process.env.WS_URL;
const PORT = process.env.PORT || 3000;

const auth = new AuthManager();

if (!WS_URL) {
    console.error('❌ ERROR: WS_URL not found in .env file!');
    process.exit(1);
}

const itemNamesMap = {};
const itemFilenamesMap = {};

try {
    const dataPath = path.join(__dirname, 'data.json');
    const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    let hasChanges = false;

    dataJson.forEach(item => {
        if (item.id) {
            let name = item.name;

            if (
                name &&
                typeof name === 'string' &&
                name.trim().startsWith('{')
            ) {
                try {
                    name = JSON.parse(name);
                } catch (e) {}
            }

            if (name && typeof name === 'object') {
                item.name = name.en || item.id;
                hasChanges = true;
            }

            if (item.name) itemNamesMap[item.id] = item.name;
            if (item.filename) itemFilenamesMap[item.id] = item.filename;
        }
    });

    if (hasChanges) {
        fs.writeFileSync(
            dataPath,
            JSON.stringify(dataJson, null, 2),
            'utf8'
        );

        console.log('🧹 Cleaned up localized name entries in data.json');
    }

    console.log(
        `ℹ️ data.json successfully loaded. ${Object.keys(itemNamesMap).length} items matched.`
    );
} catch (err) {
    console.log(`⚠️ Failed to load data.json: ${err.message}`);
}

const app = express();
const server = http.createServer(app);
const localWss = new WebSocket.Server({ server });

let totalScannedCount = 0;
let cumulativeProfitSum = 0;

const activeSinceTime =
    new Date('2026-08-17T01:32:48+03:00').getTime();

const statsPath = path.join(__dirname, 'stats.json');

try {
    if (fs.existsSync(statsPath)) {
        const stats = JSON.parse(
            fs.readFileSync(statsPath, 'utf8')
        );

        totalScannedCount = stats.totalScanned || 0;
        cumulativeProfitSum = stats.cumulativeProfit || 0;
    }
} catch (e) {}

function saveStats() {
    try {
        fs.writeFileSync(
            statsPath,
            JSON.stringify(
                {
                    totalScanned: totalScannedCount,
                    cumulativeProfit: cumulativeProfitSum
                },
                null,
                2
            ),
            'utf8'
        );
    } catch (e) {}
}

const opportunitiesHistory = [];

const frontendDistPath = path.join(
    __dirname,
    'frontend',
    'dist'
);

app.use(express.static(frontendDistPath));

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});

localWss.on('connection', ws => {
    ws.send(
        JSON.stringify({
            type: 'history',
            data: opportunitiesHistory,
            totalScanned: totalScannedCount,
            cumulativeProfit: cumulativeProfitSum,
            activeSince: activeSinceTime
        })
    );
});

function broadcastToClients(data) {
    const payload = JSON.stringify(data);

    localWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

const headers = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    Origin: 'https://rollercoin.com'
};

function findRawPrice(tradeOffersBase64, guidePrice) {
    if (!tradeOffersBase64 || !guidePrice) {
        return null;
    }

    try {
        const compressedBuffer = Buffer.from(
            tradeOffersBase64,
            'base64'
        );

        let rawBuffer;

        try {
            rawBuffer = zlib.unzipSync(compressedBuffer);
        } catch (e1) {
            try {
                rawBuffer = zlib.inflateSync(compressedBuffer);
            } catch (e2) {
                rawBuffer = zlib.inflateRawSync(compressedBuffer);
            }
        }

        try {
            const msgpack = require('@msgpack/msgpack');
            const decoded = msgpack.decode(rawBuffer);

            if (Array.isArray(decoded) && decoded.length > 0) {
                const prices = decoded
                    .map(d => d.price || d.p || null)
                    .filter(p => p !== null);

                if (prices.length > 0) {
                    return Math.min(...prices);
                }
            } else if (
                typeof decoded === 'object' &&
                decoded !== null
            ) {
                if (decoded.price) return decoded.price;
                if (decoded.p) return decoded.p;
            }
        } catch (eMsgpack) {}

        const scanLimit = Math.min(rawBuffer.length - 4, 150);

        for (let i = 0; i <= scanLimit; i++) {
            const bePrice = rawBuffer.readUInt32BE(i);

            if (Math.abs(bePrice - guidePrice) <= 50000) {
                return bePrice;
            }
        }

        return null;
    } catch (error) {
        return null;
    }
}

async function fetchItemMetadata(itemId, itemType) {
    try {
        const token = await auth.getAccessToken();

        const response = await fetch(
            `https://rollercoin.com/api/marketplace/item-info?itemId=${itemId}&itemType=${itemType}&currency=RLT`,
            {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    Cookie: `token=${token}`,
                    'User-Agent': headers['User-Agent'],
                    Origin: 'https://rollercoin.com'
                }
            }
        );

        if (!response.ok) {
            console.error(
                `❌ RollerCoin API Error (item-info): HTTP status ${response.status} ${response.statusText}`
            );

            const body = await response.text();
            console.error('Error body:', body);

            if (response.status === 401) {
                console.warn(
                    '🔐 item-info API returned HTTP 401. Token may be invalid.'
                );
            }

            return null;
        }

        const result = await response.json();
        const itemInfo = result.data || result;

        if (itemInfo && (itemInfo.name || itemInfo.title)) {
            let name = itemInfo.name || itemInfo.title;

            if (
                typeof name === 'string' &&
                name.trim().startsWith('{')
            ) {
                try {
                    name = JSON.parse(name);
                } catch (e) {}
            }

            if (name && typeof name === 'object') {
                name = name.en || itemId;
            }

            const filename =
                itemInfo.filename ||
                itemInfo.item_filename ||
                itemInfo.image ||
                '';

            return {
                id: itemId,
                name,
                filename
            };
        }
    } catch (e) {
        console.error(
            `⚠️ Failed to fetch metadata for item ${itemId}:`,
            e.message
        );
    }

    return null;
}

function subtractOneUnit(priceMicro) {
    let trailingZeros = 0;
    let temp = priceMicro;

    while (temp > 0 && temp % 10 === 0) {
        trailingZeros++;
        temp = Math.floor(temp / 10);
    }

    const exponent = Math.min(4, trailingZeros);
    const amountToSubtract = Math.pow(10, exponent);

    return Math.max(1, priceMicro - amountToSubtract);
}

/*
 * =========================================================
 * WEBSOCKET AUTHENTICATION AND RECONNECTION
 * =========================================================
 */

let reconnectTimer = null;
let authRefreshInProgress = false;
let connecting = false;

function scheduleReconnect(delay = 5000) {
    if (reconnectTimer) {
        return;
    }

    console.log(
        `🔄 Reconnecting in ${Math.round(delay / 1000)} seconds...`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function isAuthenticationError(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const possibleCodes = [
        payload.code,
        payload.status,
        payload.statusCode,
        payload.error?.code
    ];

    if (
        possibleCodes.some(code =>
            code === 401 ||
            code === '401' ||
            code === 403 ||
            code === '403'
        )
    ) {
        return true;
    }

    const possibleMessages = [
        payload.message,
        payload.error,
        payload.reason,
        payload.msg,
        payload.error?.message
    ];

    const authErrorPattern =
        /invalid token|token expired|expired token|unauthorized|authentication failed|authentication required|jwt expired|jwt invalid|invalid access token/i;

    return possibleMessages.some(message => {
        if (typeof message !== 'string') {
            return false;
        }

        return authErrorPattern.test(message);
    });
}

function isAuthenticationClose(code, reason) {
    const reasonText = reason ? reason.toString() : '';

    const authReasonPattern =
        /invalid token|token expired|expired token|unauthorized|authentication failed|jwt expired|invalid access token/i;

    return authReasonPattern.test(reasonText);
}

async function handleAuthError(ws, source = 'WebSocket') {
    if (authRefreshInProgress) {
        return;
    }

    authRefreshInProgress = true;

    try {
        console.warn(
            `🔐 Authentication error detected (${source}). Refreshing token...`
        );

        await auth.refresh();

        console.log(
            '✅ Token refreshed. Reconnecting with the new access token...'
        );

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Authentication token refreshed');
        } else if (ws && ws.readyState === WebSocket.CONNECTING) {
            ws.terminate();
        }

        scheduleReconnect(1000);
    } catch (error) {
        console.error(
            '❌ Authentication token refresh failed:',
            error.message
        );

        scheduleReconnect(30000);
    } finally {
        authRefreshInProgress = false;
    }
}

/*
 * =========================================================
 * WEBSOCKET CONNECTION
 * =========================================================
 */

async function connect() {
    if (connecting || authRefreshInProgress) {
        return;
    }

    connecting = true;

    let ws;

    try {
        console.log('🔍 CONNECT: starting');

        // Token süresine göre proaktif refresh yapılmaz.
        const token = await auth.getAccessToken();

        console.log('🔍 CONNECT: token acquired');

        const wsUrl = WS_URL.replace('{token}', token);

        console.log('🔍 CONNECT: WS URL prepared');

        console.log(
            `🔗 Connecting to remote server: ${new URL(wsUrl).host}`
        );

        ws = new WebSocket(wsUrl, { headers });

        ws.on('open', () => {
            console.log(
                '🟢 Arbitrage Bot Active, waiting for profitable opportunities...'
            );

            console.log(`🌐 Site URL: http://localhost:${PORT}`);

            console.log(
                '------------------------------------------------------------------'
            );
        });

        ws.on('message', async data => {
            let payload;

            try {
                payload = JSON.parse(data.toString());
            } catch (error) {
                return;
            }

            if (isAuthenticationError(payload)) {
                await handleAuthError(ws, 'WebSocket message');
                return;
            }

            try {
                if (payload.cmd === 'marketplace_orders_update') {
                    const itemData = payload.value;
                    const marketData = itemData?.data;

                    if (
                        marketData &&
                        marketData.list &&
                        marketData.list.length >= 2
                    ) {
                        const order0 = marketData.list[0];
                        const order1 = marketData.list[1];

                        const index1PriceMicro = order1.price;

                        const targetListedPriceMicro =
                            subtractOneUnit(index1PriceMicro);

                        const targetListedPrice =
                            targetListedPriceMicro / 1000000;

                        const newSellingPrice =
                            targetListedPrice / 1.05;

                        const index0PriceRlt =
                            order0.price / 1000000;

                        const quantity = order0.quantity;

                        const preCheckProfitMargin =
                            (newSellingPrice - index0PriceRlt) *
                            quantity;

                        if (preCheckProfitMargin <= 0) {
                            return;
                        }

                        const itemId = itemData.item_id;
                        const itemType = itemData.item_type;

                        if (!itemNamesMap[itemId]) {
                            console.log(
                                `🔍 Unknown item detected (${itemId}). Fetching metadata from RollerCoin API...`
                            );

                            const metadata = await fetchItemMetadata(
                                itemId,
                                itemType
                            );

                            if (metadata) {
                                itemNamesMap[itemId] = metadata.name;
                                itemFilenamesMap[itemId] =
                                    metadata.filename;

                                try {
                                    const dataPath = path.join(
                                        __dirname,
                                        'data.json'
                                    );

                                    let currentData = [];

                                    if (fs.existsSync(dataPath)) {
                                        currentData = JSON.parse(
                                            fs.readFileSync(
                                                dataPath,
                                                'utf8'
                                            )
                                        );
                                    }

                                    currentData.push(metadata);

                                    fs.writeFileSync(
                                        dataPath,
                                        JSON.stringify(
                                            currentData,
                                            null,
                                            2
                                        ),
                                        'utf8'
                                    );

                                    console.log(
                                        `💾 Saved new item metadata for "${metadata.name}" to data.json`
                                    );
                                } catch (err) {
                                    console.error(
                                        '⚠️ Failed to save new item to data.json:',
                                        err.message
                                    );
                                }
                            }
                        }

                        let actualBuyPriceRlt = index0PriceRlt;

                        if (marketData.tradeOffers) {
                            const rawFound = findRawPrice(
                                marketData.tradeOffers,
                                order0.price
                            );

                            if (rawFound) {
                                actualBuyPriceRlt =
                                    rawFound / 1000000;
                            }
                        }

                        const netProfitMargin =
                            (newSellingPrice - actualBuyPriceRlt) *
                            quantity;

                        if (netProfitMargin > 0) {
                            totalScannedCount++;
                            cumulativeProfitSum += netProfitMargin;

                            saveStats();

                            const opportunity = {
                                itemId: itemData.item_id,

                                itemName:
                                    itemNamesMap[itemData.item_id] ||
                                    itemData.item_id,

                                itemFilename:
                                    itemFilenamesMap[itemData.item_id] ||
                                    '',

                                itemType: itemData.item_type,

                                actualBuyPriceRlt,
                                newSellingPrice,
                                quantity,
                                netProfitMargin,
                                timestamp: Date.now()
                            };

                            opportunitiesHistory.unshift(opportunity);

                            if (opportunitiesHistory.length > 50) {
                                opportunitiesHistory.pop();
                            }

                            console.log(
                                '\n🚀 ARBITRAGE OPPORTUNITY DETECTED!'
                            );

                            console.log(
                                `📦 Item: ${opportunity.itemName} (${opportunity.itemType})`
                            );

                            console.log(
                                `🏷️ Actual Buy Price : ${opportunity.actualBuyPriceRlt.toFixed(6)} RLT`
                            );

                            console.log(
                                `📈 Target Selling Price : ${opportunity.newSellingPrice.toFixed(6)} RLT (Qty: ${opportunity.quantity})`
                            );

                            console.log(
                                `\x1b[32m💚 NET PROFIT MARGIN   : +${opportunity.netProfitMargin.toFixed(6)} RLT\x1b[0m`
                            );

                            console.log(
                                '------------------------------------------------------------------'
                            );

                            broadcastToClients({
                                type: 'opportunity',
                                data: opportunity,
                                totalScanned: totalScannedCount,
                                cumulativeProfit: cumulativeProfitSum,
                                activeSince: activeSinceTime
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(
                    '⚠️ Failed to process marketplace message:',
                    error.message
                );
            }
        });

        ws.on('close', (code, reason) => {
            const reasonText = reason?.toString() || 'none';

            console.log(
                `🔴 Connection lost. Code: ${code} Reason: ${reasonText}`
            );

            if (isAuthenticationClose(code, reason)) {
                handleAuthError(ws, 'WebSocket close reason');
                return;
            }

            if (!authRefreshInProgress) {
                scheduleReconnect(5000);
            }
        });

        ws.on('error', err => {
            console.error('⚠️ WebSocket Error:', err.message);

            // WebSocket handshake sırasında HTTP 401 geldiyse
            // token refresh işlemini başlat.
            if (
                err.message &&
                /Unexpected server response:\s*401/i.test(err.message)
            ) {
                console.warn(
                    '🔐 WebSocket HTTP 401 döndürdü. Token yenileme başlatılıyor...'
                );

                handleAuthError(ws, 'WebSocket HTTP 401');
            }
        });
    } catch (error) {
        console.error(
            '❌ Connection/Auth error:',
            error.message
        );

        scheduleReconnect(5000);
    } finally {
        connecting = false;
    }
}

/*
 * =========================================================
 * HTTP SERVER
 * =========================================================
 */

server.listen(PORT, () => {
    console.log(`🚀 Server started: http://localhost:${PORT}`);
    connect();
});
