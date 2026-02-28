/**
 * 交易模块入口
 */

export * from './model.js';
export * from './exceptions.js';
export * from './config.js';
export * from './webtrader.js';
export * from './eastmoney.js';
export * from './captcha/index.js';

// 默认导出 EastMoneyTrader
import { EastMoneyTrader } from './eastmoney.js';
export default EastMoneyTrader;