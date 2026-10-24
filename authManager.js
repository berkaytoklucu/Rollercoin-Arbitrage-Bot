
const jwt = require('jsonwebtoken');

class AuthManager {
    constructor() {
        this.accessToken = process.env.TOKEN || '';
        this.refreshToken = process.env.REFRESH_TOKEN || '';
        this.refreshPromise = null;
    }

    isAccessTokenExpired() {
        console.log(
            'TOKEN exists:',
            Boolean(this.accessToken)
        );

        let decoded;

        try {
            decoded = jwt.decode(this.accessToken || '');
        } catch {
            decoded = null;
        }

        const exp = decoded?.exp;

        console.log(
            'TOKEN exp:',
            typeof exp === 'number' ? exp : 'missing'
        );

        const expired =
            !this.accessToken ||
            typeof exp !== 'number' ||
            Date.now() >= exp * 1000 - 60000;

        console.log('TOKEN expired:', expired);

        return expired;
    }

    getTokenExpiration() {
        if (!this.accessToken) {
            return null;
        }

        try {
            const decoded = jwt.decode(this.accessToken);

            if (typeof decoded?.exp !== 'number') {
                return null;
            }

            return decoded.exp * 1000;
        } catch {
            return null;
        }
    }

    async refresh() {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = this._refresh();

        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    async _refresh() {
        if (!this.refreshToken) {
            throw new Error('REFRESH_TOKEN not found.');
        }

        console.log('🔄 Refresh token is being used...');

        const response = await fetch(
            'https://rollercoin.com/api/auth/refresh',
            {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Origin: 'https://rollercoin.com',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115.0.0.0 Safari/537.36'
                },
                body: JSON.stringify({
                    refresh_token: this.refreshToken
                })
            }
        );

        const responseText = await response.text();

        let result;

        try {
            result = JSON.parse(responseText);
        } catch {
            throw new Error(
                `Refresh endpoint returned non-JSON response (HTTP ${response.status})`
            );
        }

        if (!response.ok) {
            console.error(
                '❌ Refresh response:',
                JSON.stringify(result, null, 2)
            );

            throw new Error(
                `Refresh failed: HTTP ${response.status} - ${result.error || 'Unknown error'}`
            );
        }

        if (!result.success || !result.data) {
            throw new Error(
                `Refresh denied: ${result.error || 'Unknown error'}`
            );
        }

        const newAccessToken = result.data.access_token;
        const newRefreshToken = result.data.refresh_token;

        if (!newAccessToken || !newRefreshToken) {
            throw new Error('Tokens not found in refresh response.');
        }

        this.accessToken = newAccessToken;
        this.refreshToken = newRefreshToken;

        process.env.TOKEN = newAccessToken;
        process.env.REFRESH_TOKEN = newRefreshToken;

        const expiration = this.getTokenExpiration();

        console.log('✅ Access token refreshed.');

        if (expiration) {
            console.log(
                `⏰ New token expires: ${new Date(expiration).toISOString()}`
            );
        }

        return this.accessToken;
    }

    async getAccessToken() {
        if (this.isAccessTokenExpired()) {
            return await this.refresh();
        }

        return this.accessToken;
    }
}

module.exports = AuthManager;
