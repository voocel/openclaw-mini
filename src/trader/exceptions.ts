/**
 * 交易异常
 */

export class TradeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TradeError';
    }
}

export class NotLoginError extends Error {
    result: any;

    constructor(result?: any) {
        super('未登录或登录已过期');
        this.name = 'NotLoginError';
        this.result = result;
    }
}