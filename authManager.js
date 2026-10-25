
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

class AuthManager {
    constructor() {
        this.accessToken = process.env.TOKEN || '';
        this.refreshToken = process.env.REFRESH_TOKEN || '';
        this.refreshPromise = null;
        this.envPath = path.resolve(process.cwd(), '.env');
    }

    getTokenExpiration() {
        try {
            const decoded = jwt.decode(this.accessToken || '');
            return typeof decoded?.exp === 'number'
                ? decoded.exp * 1000
                : null;
        } catch {
            return null;
        }
    }

    async getAccessToken() {
        if (!this.accessToken) {
            return await this.refresh();
        }

        return this.accessToken;
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
            throw new Error('REFRESH_TOKEN bulunamadı.');
        }

        console.log('🔄 Refresh token kullanılıyor...');

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
                `Refresh yanıtı JSON değil. HTTP ${response.status}`
            );
        }

        if (!response.ok || !result.success || !result.data) {
            throw new Error(
                `Refresh başarısız: HTTP ${response.status} - ${
                    result.error || 'Bilinmeyen hata'
                }`
            );
        }

        const newAccessToken = result.data.access_token;
        const newRefreshToken = result.data.refresh_token;

        if (!newAccessToken || !newRefreshToken) {
            throw new Error('Yanıtta yeni tokenlar bulunamadı.');
        }

        this.accessToken = newAccessToken;
        this.refreshToken = newRefreshToken;
        this.saveTokensToEnv();

        const expiration = this.getTokenExpiration();

        console.log('✅ Tokenlar yenilendi ve .env güncellendi.');

        if (expiration) {
            console.log(
                `⏰ Yeni token son kullanma zamanı: ${
                    new Date(expiration).toISOString()
                }`
            );
        }

        return this.accessToken;
    }

    saveTokensToEnv() {
        let envContent = '';

        if (fs.existsSync(this.envPath)) {
            envContent = fs.readFileSync(this.envPath, 'utf8');
        }

        const setEnvValue = (content, key, value) => {
            const line = `${key}=${value}`;
            const pattern = new RegExp(`^${key}=.*$`, 'm');

            if (pattern.test(content)) {
                return content.replace(pattern, line);
            }

            return content + (content && !content.endsWith('\n') ? '\n' : '')
                + line + '\n';
        };

        envContent = setEnvValue(
            envContent,
            'TOKEN',
            this.accessToken
        );

        envContent = setEnvValue(
            envContent,
            'REFRESH_TOKEN',
            this.refreshToken
        );

        fs.writeFileSync(this.envPath, envContent, {
            encoding: 'utf8',
            mode: 0o600
        });

        process.env.TOKEN = this.accessToken;
        process.env.REFRESH_TOKEN = this.refreshToken;
    }
}

module.exports = AuthManager;
