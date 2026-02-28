/**
 * Web交易基类
 */

import { Balance, Position, Entrust, Deal } from './model.js';
import { TradeError, NotLoginError } from './exceptions.js';

export abstract class WebTrader {
    protected config: any;
    protected globalConfig: any;
    protected accountConfig: any;
    protected tradePrefix: string = '';
    protected heartActive: boolean = true;
    protected heartThread: NodeJS.Timeout | null = null;

    constructor(protected debug: boolean = true) {
        this.__readConfig();
    }

    /**
     * 设置时间
     */
    setTime(time: Date): void {
        // 占位实现
    }

    /**
     * 读取配置文件
     */
    readConfig(path: string): void {
        // 占位实现，子类可覆盖
        console.warn('readConfig 方法需要子类实现');
    }

    /**
     * 登录的统一接口
     * @param configFile 登录数据文件，若无则选择参数登录模式
     * @param user 各家券商的账号
     * @param password 密码, 券商为加密后的密码
     * @param kwargs 其他参数
     */
    async prepare(configFile?: string, user?: string, password?: string, kwargs?: any): Promise<void> {
        if (configFile !== undefined) {
            this.readConfig(configFile);
        } else {
            this._prepareAccount(user, password, kwargs);
        }
        await this.autoLogin();
    }

    /**
     * 映射用户名密码到对应的字段
     */
    protected _prepareAccount(user?: string, password?: string, kwargs?: any): void {
        throw new Error('支持参数登录需要实现此方法');
    }

    /**
     * 计算交易成本
     * @param amount 数量
     * @param price 价格
     * @param entrustBs 买卖类型 'B' 或 'S'
     */
    calculateCost(amount: number, price: number, entrustBs: string = 'B'): number {
        const total = amount * price;
        let cost = Math.max(5, total * 0.003);
        if (entrustBs === 'S') {
            cost += total * 0.001;
        }
        return cost;
    }

    /**
     * 自动登录
     * @param limit 登录次数限制
     */
    async autoLogin(limit: number = 10): Promise<void> {
        for (let i = 0; i < limit; i++) {
            if (await this.login()) {
                break;
            }
            if (i === limit - 1) {
                throw new NotLoginError('登录失败次数过多, 请检查密码是否正确 / 券商服务器是否处于维护中 / 网络连接是否正常');
            }
        }
        this.keepalive();
    }

    /**
     * 登录方法，子类实现
     */
    async login(): Promise<boolean> {
        throw new Error('子类必须实现 login 方法');
    }

    /**
     * 保持在线
     */
    keepalive(): void {
        if (this.heartThread) {
            this.heartActive = true;
        } else {
            this.heartThread = setInterval(() => {
                if (this.heartActive) {
                    this.checkLogin();
                }
            }, 10000);
        }
    }

    /**
     * 检查登录状态
     */
    async checkLogin(sleepy: number = 30): Promise<void> {
        try {
            const response = await this.heartbeat();
            this.checkAccountLive(response);
        } catch (error) {
            console.error('心跳线程发现账户出现错误:', error);
            await this.autoLogin();
        } finally {
            // 延迟
            await new Promise(resolve => setTimeout(resolve, sleepy * 1000));
        }
    }

    /**
     * 心跳检测
     */
    async heartbeat(): Promise<any> {
        return await this.getBalance();
    }

    /**
     * 检查账户活跃状态
     */
    checkAccountLive(response: any): void {
        // 默认实现，子类可覆盖
    }

    /**
     * 结束保持 token 在线的进程
     */
    exit(): void {
        this.heartActive = false;
        if (this.heartThread) {
            clearInterval(this.heartThread);
            this.heartThread = null;
        }
    }

    /**
     * 读取配置
     */
    private __readConfig(): void {
        // 占位实现，子类应该覆盖
        this.config = {};
        this.globalConfig = {};
    }

    /**
     * 获取账户资金状况
     */
    async getBalance(): Promise<Balance[]> {
        throw new Error('子类必须实现 getBalance 方法');
    }

    /**
     * 获取持仓
     */
    async getPosition(): Promise<Position[]> {
        throw new Error('子类必须实现 getPosition 方法');
    }

    /**
     * 获取当日委托列表
     */
    async getEntrust(): Promise<Entrust[]> {
        throw new Error('子类必须实现 getEntrust 方法');
    }

    /**
     * 获取当日成交列表
     */
    async getCurrentDeal(): Promise<Deal[]> {
        throw new Error('子类必须实现 getCurrentDeal 方法');
    }

    /**
     * 获取最近30天的交割单
     */
    async getExchangebill(startDate?: string, endDate?: string): Promise<any> {
        console.warn('目前仅在特定子类中实现, 其余券商需要补充');
        return [];
    }

    /**
     * 查询新股申购额度申购上限
     */
    async getIpoLimit(stockCode: string): Promise<any> {
        console.warn('目前仅在特定子类中实现, 其余券商需要补充');
        return null;
    }

    /**
     * 买入股票
     * @param security 股票代码
     * @param price 买入价格
     * @param amount 买入股数
     * @param volume 买入总金额 由 volume / price 取整，若指定 price 则此参数无效
     * @param entrustProp 委托属性
     */
    async buy(security: string, price: number = 0, amount: number = 0, volume: number = 0, entrustProp: number = 0): Promise<void> {
        throw new Error('子类必须实现 buy 方法');
    }

    /**
     * 卖出股票
     * @param security 股票代码
     * @param price 卖出价格
     * @param amount 卖出股数
     * @param volume 卖出总金额 由 volume / price 取整，若指定 price 则此参数无效
     * @param entrustProp 委托属性
     */
    async sell(security: string, price: number = 0, amount: number = 0, volume: number = 0, entrustProp: number = 0): Promise<void> {
        throw new Error('子类必须实现 sell 方法');
    }

    /**
     * 发起对 api 的请求并过滤返回结果
     */
    protected async do(params: any): Promise<any> {
        const requestParams = this.createBasicParams();
        Object.assign(requestParams, params);
        const responseData = await this.request(requestParams);
        let formatJsonData;
        try {
            formatJsonData = this.formatResponseData(responseData);
        } catch (error) {
            // 服务器强制登出
            return null;
        }
        const returnData = this.fixErrorData(formatJsonData);
        try {
            this.checkLoginStatus(returnData);
        } catch (error) {
            if (error instanceof NotLoginError) {
                await this.autoLogin();
            }
            throw error;
        }
        return returnData;
    }

    /**
     * 生成基本的参数
     */
    protected createBasicParams(): any {
        return {};
    }

    /**
     * 请求并获取 JSON 数据
     */
    protected async request(params: any): Promise<any> {
        throw new Error('子类必须实现 request 方法');
    }

    /**
     * 格式化返回的 json 数据
     */
    protected formatResponseData(data: any): any {
        return data;
    }

    /**
     * 若是返回错误移除外层的列表
     */
    protected fixErrorData(data: any): any {
        return data;
    }

    /**
     * 检查登录状态
     */
    protected checkLoginStatus(returnData: any): void {
        // 默认实现，子类可覆盖
    }
}