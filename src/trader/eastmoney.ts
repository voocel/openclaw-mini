/**
 * 东方财富证券交易客户端
 */

import { WebTrader } from './webtrader.js';
import { Balance, Position, Entrust, Deal } from './model.js';
import { TradeError, NotLoginError } from './exceptions.js';
import { eastMoneyConfig, EastMoneyConfig } from './config.js';
import type { CaptchaRecognizerObject } from './captcha/types.js';
import { CaptchaRecognizer } from './captcha/captcha-recognizer.js';
import * as crypto from 'crypto';
import * as fs from 'fs';

// session.js
import axios, { Axios } from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

// RSA公钥
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDHdsyxT66pDG4p73yope7jxA92
c0AT4qIJ/xtbBcHkFPK77upnsfDTJiVEuQDH+MiMeb+XhCLNKZGp0yaUU6GlxZdp
+nLW8b7Kmijr3iepaDhcbVTsYBWchaWUXauj9Lrhz58/6AE/NF0aMolxIGpsi+ST
2hSHPu3GSXMdhPCkWQIDAQAB
-----END PUBLIC KEY-----`;

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/536.66",
    "Host": "jywg.18.cn",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7",
    "Cache-Control": "no-cache",
    "Referer": "https://jywg.18.cn/Login?el=1&clear=1",
    "X-Requested-With": "XMLHttpRequest",
}

/**
 * 登录响应接口
 */
interface LoginResponse {
    Status: number;
    [key: string]: any;
}

/**
 * API响应接口
 */
interface ApiResponse {
    Status: number;
    Data: any;
    Message?: string;
}

/**
 * RSA加密密码
 */
function encryptData(pwd: string): string {
    try {
        const buffer = Buffer.from(pwd, 'utf8');
        const encrypted = crypto.publicEncrypt({
            key: PUBLIC_KEY,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, buffer);
        return encrypted.toString('base64');
    } catch (error) {
        console.error('RSA加密失败:', error);
        throw new Error('密码加密失败');
    }
}

/**
 * 东方财富交易客户端选项
 */
export interface EastMoneyTraderOptions {
    /**
     * 验证码识别器
     * 如果不提供，将使用默认识别器
     */
    captchaRecognizer?: CaptchaRecognizerObject;
}

export class EastMoneyTrader extends WebTrader {
    protected config: EastMoneyConfig = eastMoneyConfig;
    private validateKey: string | null = null;
    private sessionFile: string = 'eastmoney_trader.session';
    private randomNumber: string = '0.9033461201665647898';
    private captchaRecognizer: CaptchaRecognizerObject;
    private client: Axios;

    // HTTP会话
    private session: any; // 使用简单的对象存储cookie等，实际可使用fetch with cookie jar
    constructor(options?: EastMoneyTraderOptions) {
        super();

        // 启用 cookie 支持
        const jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar,
            headers: HEADERS,
            withCredentials: true  // 关键：发送 cookies
        }));
        this.session = jar;

        // 验证码识别器
        if (options?.captchaRecognizer) {
            this.captchaRecognizer = options.captchaRecognizer;
        } else {
            // 使用模拟识别器作为默认
            this.captchaRecognizer = new CaptchaRecognizer();
        }

    }

    /**
     * 识别验证码
     * 实际下载验证码图片并使用识别器进行识别
     */
    private async _recognizeVerificationCode(): Promise<string> {
        // 生成随机数用于验证码URL
        this.randomNumber = '0.305' + Math.floor(100000 + Math.random() * 900000);

        const maxRetries = 3;
        const retryDelay = 2000; // 2秒

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // 下载验证码图片
                const response = await this.client.get(`${this.config.yzm}${this.randomNumber}`, { responseType: 'arraybuffer' });
                if (!response.status) {
                    throw new Error(`验证码下载失败: HTTP ${response.status}`);
                }

                const imageBuffer = Buffer.from(await response.data);

                // 使用验证码识别器识别
                const code = await this.captchaRecognizer.recognize(imageBuffer);

                // 清理识别结果：移除空格和换行
                const cleanedCode = code.replace(/\s+/g, '');

                // 验证码长度应该为4位
                if (cleanedCode.length === 4) {
                    console.log(`验证码识别成功 (尝试 ${attempt}): ${cleanedCode}`);
                    return cleanedCode;
                } else {
                    console.warn(`验证码长度异常: 期望 4, 实际 ${cleanedCode.length}, 内容: ${cleanedCode}`);

                    if (attempt < maxRetries) {
                        console.log(`等待 ${retryDelay}ms 后重试...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                        continue;
                    }
                }
            } catch (error) {
                console.error(`验证码识别尝试 ${attempt} 失败:`, error);

                if (attempt < maxRetries) {
                    console.log(`等待 ${retryDelay}ms 后重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    throw new Error(`验证码识别失败，最大重试次数 ${maxRetries} 已用完: ${error}`);
                }
            }
        }

        // 如果所有重试都失败，抛出错误
        throw new Error('验证码识别失败');
    }

    /**
     * 保存会话到缓存文件
     */
    private async _saveSession(): Promise<void> {
        const sessionData = {
            validateKey: this.validateKey,
            cookies: await this.getCookies(),
            timestamp: Date.now()
        };

        try {
            fs.writeFileSync(this.sessionFile, JSON.stringify(sessionData, null, 2));
            console.log(`updated session cache-file ${this.sessionFile}`);
        } catch (error) {
            console.error('保存会话失败:', error);
        }
    }

    /**
     * 从缓存文件恢复会话
     */
    private async _reloadSession(): Promise<boolean> {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const data = fs.readFileSync(this.sessionFile, 'utf8');
                const sessionData = JSON.parse(data);
                this.validateKey = sessionData.validateKey;
                const cookies = sessionData.cookies;
                // 反序列化到新 CookieJar
                const restoredJar = await CookieJar.deserialize({ cookies });
                const nowTime = Date.now()
                // 过滤过期 cookies（关键！）
                const validCookies = restoredJar.getCookiesSync(eastMoneyConfig.domain).filter(c => {
                    return c.expiryDate()?.getTime() || 0 > nowTime
                });
                if (validCookies.length === 0) {
                    console.log('⚠️  所有 cookies 已过期，跳过恢复');
                    return false;
                } else {
                    // 恢复 cookies
                    this.session = restoredJar;
                    (this.client.defaults as any).jar = this.session;
                    console.log(`通过会话文件${this.sessionFile}恢复Session`);
                    return true;
                }
            }
        } catch (error) {
            console.error('加载会话失败:', error);
            return false;
        }
        return false;
    }

    /**
     * 获取当前cookies
     */
    private async getCookies(): Promise<Record<string, string>> {
        // 获取当前cookies
        if (!this.session) return Promise.resolve({});
        // 简化实现，实际需要从HTTP客户端获取cookies
        try {
            // 序列化 CookieJar（保留所有属性）
            const serialized = await this.session.serialize({ format: 'json' });
            return serialized.cookies;
        } catch (error) {
            console.error('序列化CookieJar失败:', error);
            throw error;
        }
    }

    /**
     * 自动登录
     */
    async autoLogin(kwargs?: any): Promise<void> {
        if (await this._reloadSession()) {
            return;
        }

        if (!this.accountConfig) {
            throw new Error('账户配置未设置，请先调用 prepare 方法');
        }

        while (true) {

            const password = encryptData(this.accountConfig.password);
            const identifyCode = await this._recognizeVerificationCode();
            const secInfo = ''; // 安全信息，实际可能需要获取

            const formData = new URLSearchParams();
            formData.append('duration', '1800');
            formData.append('password', password);
            formData.append('identifyCode', identifyCode);
            formData.append('type', 'Z');
            formData.append('userId', this.accountConfig.user);
            formData.append('randNumber', this.randomNumber);
            formData.append('authCode', '');
            formData.append('secInfo', secInfo);

            try {
                const response = await this.client.post(this.config.authentication, formData, {
                    headers: {
                        "Content-Type": 'application/x-www-form-urlencoded',  // 必须设置！
                        "gw_reqtimestamp": Math.floor(10 + Math.random() * 1000),
                    }
                });

                const loginRes = await response.data as LoginResponse;

                if (loginRes.Status !== 0) {
                    console.log('auto login error, try again later');
                    console.log(loginRes);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                }

                break;
            } catch (error) {
                console.error('登录请求失败:', error);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        await this._getValidKey();
        this._saveSession();
    }

    /**
     * 获取验证key
     */
    private async _getValidKey(): Promise<void> {
        try {
            const response = await this.client.get(this.config.authentication_check, {
                responseType: 'text'  // 关键：必须设置为 'text'
            });
            const content = await response.data;
            const key = 'input id="em_validatekey" type="hidden" value="';
            const begin = content.indexOf(key) + key.length;
            const end = content.indexOf('" />', begin);
            this.validateKey = content.substring(begin, end);
        } catch (error) {
            console.error('获取验证key失败:', error);
            throw new Error('获取验证key失败');
        }
    }

    /**
     * 准备账户信息
     */
    protected _prepareAccount(user?: string, password?: string, kwargs?: any): void {
        if (!user || !password) {
            throw new Error('用户名和密码不能为空');
        }

        this.accountConfig = {
            user: user,
            password: password
        };
    }

    /**
     * 获取API URL
     */
    private _getApiUrl(key: keyof EastMoneyConfig): string {
        if (!this.validateKey) {
            throw new NotLoginError('未登录，请先登录');
        }
        return this.config[key].replace('%s', this.validateKey);
    }

    /**
     * 请求数据
     */
    private async _requestData(apiName: keyof EastMoneyConfig, params?: any): Promise<any> {
        const api = this._getApiUrl(apiName);
        const url = new URL(api);

        if (params) {
            Object.keys(params).forEach(key => {
                url.searchParams.append(key, params[key]);
            });
        }

        const response = await this.client.get(url.toString(), {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const result = await response.data as ApiResponse;
        if (result.Status === 0) {
            return result.Data;
        }

        // TODO: 错误处理
        console.error('请求失败:', result);
        return null;
    }

    /**
     * 获取账户资金状况
     */
    async getBalance(): Promise<Balance[]> {
        const assets = await this._requestData('assets');

        if (!assets) {
            throw new TradeError('获取资金失败');
        }

        const assetData = assets[0];
        return [
            new Balance(
                parseFloat(assetData.Zzc),      // 总资产
                parseFloat(assetData.Kqzj),     // 可取资金
                parseFloat(assetData.Kyzj),     // 可用资金
                parseFloat(assetData.Djzj),     // 冻结资金
                parseFloat(assetData.Zzc) - parseFloat(assetData.Kyzj), // 市值
                '人民币'                         // 币种
            )
        ];
    }

    /**
     * 获取持仓
     */
    async getPosition(): Promise<Position[]> {
        const serverPositions = await this._requestData('get_stock_list');

        if (!serverPositions) {
            throw new TradeError('获取持仓失败');
        }

        const positionList: Position[] = [];
        for (const pos of serverPositions) {
            positionList.push(new Position(
                parseInt(pos.Zqsl),           // 当前数量
                parseInt(pos.Kysl),           // 可用数量
                0,                            // 收益余额
                parseFloat(pos.Cbjg),         // 成本价
                parseFloat(pos.Zxjg),         // 最新价
                parseFloat(pos.Zxjg) * parseInt(pos.Zqsl), // 市值
                'random',                     // 持仓字符串
                pos.Zqdm,                     // 股票代码
                pos.Zqmc                      // 股票名称
            ));
        }

        return positionList;
    }

    /**
     * 格式化时间 HHmmss -> HH:mm:ss
     */
    private _formatTime(timeStr: string): string {
        if (timeStr.length >= 6) {
            return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
        }
        return timeStr;
    }

    /**
     * 获取委托单
     */
    async getEntrust(): Promise<Entrust[]> {
        const xqEntrustList = await this._requestData('get_orders_data');
        const entrustList: Entrust[] = [];

        for (const xqEntrust of xqEntrustList) {
            entrustList.push(new Entrust(
                xqEntrust.Wtbh,               // 委托编号
                xqEntrust.Mmlb,               // 买卖类别
                parseInt(xqEntrust.Wtsl),     // 委托数量
                parseFloat(xqEntrust.Wtjg),   // 委托价格
                this._formatTime(xqEntrust.Bpsj), // 申报时间
                xqEntrust.Wtzt,               // 委托状态
                xqEntrust.Zqdm,               // 股票代码
                xqEntrust.Zqmc                // 股票名称
            ));
        }

        return entrustList;
    }

    /**
     * 获取当日成交列表
     */
    async getCurrentDeal(): Promise<Deal[]> {
        const dataList = await this._requestData('get_deal_data');
        const result: Deal[] = [];

        for (const item of dataList) {
            result.push(new Deal(
                item.Cjbh,                    // 成交编号
                item.Wtbh,                    // 委托编号
                item.Mmlb,                    // 买卖类别
                parseInt(item.Wtsl),          // 委托数量
                parseInt(item.Cjsl),          // 成交数量
                parseFloat(item.Cjjg),        // 成交价格
                parseFloat(item.Wtjg),        // 委托价格
                this._formatTime(item.Cjsj),  // 成交时间
                item.Zqdm,                    // 股票代码
                item.Zqmc                     // 股票名称
            ));
        }

        return result;
    }

    /**
     * 撤销委托
     */
    async cancelEntrust(entrustNo: string): Promise<boolean> {
        // TODO: 实现撤销委托
        console.log(`撤销委托 ${entrustNo} (功能待实现)`);
        return true;
    }

    /**
     * 交易核心方法
     */
    private async _trade(security: string, price: number = 0, amount: number = 0, volume: number = 0, entrustBs: string = 'B'): Promise<void> {
        const balance = (await this.getBalance())[0];

        if (!volume) {
            volume = Math.floor(price * amount);
        }

        if (balance.enableBalance < volume && entrustBs === 'B') {
            throw new TradeError('没有足够的现金进行操作');
        }

        if (amount === 0) {
            throw new TradeError('数量不能为0');
        }

        const formData = new URLSearchParams();
        formData.append('stockCode', security);
        formData.append('price', price.toString());
        formData.append('amount', amount.toString());
        formData.append('zqmc', 'unknown');
        formData.append('tradeType', entrustBs);

        const response = await this.client.post(this._getApiUrl('submit'), {
            body: formData
        });

        const result = await response.data as ApiResponse;
        if (result.Status !== 0) {
            throw new TradeError(`下单失败, ${JSON.stringify(result)}`);
        }

        console.log('下单成功');
    }

    /**
     * 买入股票
     */
    async buy(security: string, price: number = 0, amount: number = 0, volume: number = 0, entrustProp: number = 0): Promise<void> {
        return this._trade(security, price, amount, volume, 'B');
    }

    /**
     * 卖出股票
     */
    async sell(security: string, price: number = 0, amount: number = 0, volume: number = 0, entrustProp: number = 0): Promise<void> {
        return this._trade(security, price, amount, volume, 'S');
    }

    /**
     * 登录方法
     */
    async login(): Promise<boolean> {
        try {
            await this.autoLogin();
            return true;
        } catch (error) {
            console.error('登录失败:', error);
            return false;
        }
    }

    /**
     * 心跳检测
     */
    async heartbeat(): Promise<any> {
        return await Promise.resolve();
    }
}