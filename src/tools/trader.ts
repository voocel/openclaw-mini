/**
 * 股票交易工具集
 *
 * 集成东方财富证券交易接口，提供以下功能:
 * - trader_login: 登录交易账户（可选，如未配置环境变量则使用）
 * - trader_balance: 查询账户资金
 * - trader_position: 查询持仓
 * - trader_entrust: 查询当日委托
 * - trader_deal: 查询当日成交
 * - trader_buy: 买入股票
 * - trader_sell: 卖出股票
 * - trader_cancel: 撤销委托
 * - trader_stock_info: 查询股票信息
 */

import type { Tool } from "./types.js";
import { EastMoneyTrader } from "../trader/eastmoney.js";
import { TradeError } from "../trader/exceptions.js";

// ============== 登录工具 ==============

export const traderLoginTool: Tool<{
  user?: string;
  password?: string;
}> = {
  name: "trader_login",
  description: "登录东方财富证券交易账户（如未配置环境变量，可通过此工具手动登录）",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(input, _ctx) {
    try {
      await EastMoneyTrader.getInstance();
      return "登录成功";
    } catch (error) {
      return `登录失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询账户资金 ==============

export const traderBalanceTool: Tool<{}> = {
  name: "trader_balance",
  description: "查询账户资金状况（总资产、可用资金、冻结资金等）",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      const balances = await trader.getBalance();

      if (!balances || balances.length === 0) {
        return "未获取到资金信息";
      }

      const balance = balances[0];
      const result = {
        "总资产": balance.assetBalance,
        "当前余额": balance.currentBalance,
        "可用资金": balance.enableBalance,
        "冻结资金": balance.frozenBalance,
        "市值": balance.marketValue,
        "币种": balance.moneyType,
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询持仓 ==============

export const traderPositionTool: Tool<{}> = {
  name: "trader_position",
  description: "查询当前持仓股票列表",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      const positions = await trader.getPosition();

      if (!positions || positions.length === 0) {
        return "当前无持仓";
      }

      const result = positions.map(pos => ({
        "股票代码": pos.stockCode,
        "股票名称": pos.stockName,
        "当前数量": pos.currentAmount,
        "可用数量": pos.enableAmount,
        "成本价": pos.costPrice,
        "最新价": pos.lastPrice,
        "市值": pos.marketValue,
      }));

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询当日委托 ==============

export const traderEntrustTool: Tool<{}> = {
  name: "trader_entrust",
  description: "查询当日委托列表",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      const entrusts = await trader.getEntrust();

      if (!entrusts || entrusts.length === 0) {
        return "当日无委托";
      }

      const result = entrusts.map(e => ({
        "委托编号": e.entrustNo,
        "股票代码": e.stockCode,
        "股票名称": e.stockName,
        "买卖类别": e.bsType,
        "委托数量": e.entrustAmount,
        "委托价格": e.entrustPrice,
        "申报时间": e.reportTime,
        "委托状态": e.entrustStatus,
      }));

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询当日成交 ==============

export const traderDealTool: Tool<{}> = {
  name: "trader_deal",
  description: "查询当日成交列表",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      const deals = await trader.getCurrentDeal();

      if (!deals || deals.length === 0) {
        return "当日无成交";
      }

      const result = deals.map(d => ({
        "成交编号": d.dealNo,
        "委托编号": d.entrustNo,
        "股票代码": d.stockCode,
        "股票名称": d.stockName,
        "买卖类别": d.bsType,
        "委托数量": d.entrustAmount,
        "成交数量": d.dealAmount,
        "成交价格": d.dealPrice,
        "委托价格": d.entrustPrice,
        "成交时间": d.dealTime,
      }));

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 买入股票 ==============

export const traderBuyTool: Tool<{
  stock_code: string;
  price: number;
  amount: number;
}> = {
  name: "trader_buy",
  description: "买入股票",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 '600000'" },
      price: { type: "number", description: "买入价格" },
      amount: { type: "number", description: "买入股数（100 的整数倍）" },
    },
    required: ["stock_code", "price", "amount"],
  },
  async execute(input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      await trader.buy(input.stock_code, input.price, input.amount);
      return `买入委托已提交：${input.stock_code}，价格 ${input.price}，数量 ${input.amount}`;
    } catch (error) {
      if (error instanceof TradeError) {
        return `买入失败：${error.message}`;
      }
      return `买入失败：${(error as Error).message}`;
    }
  },
};

// ============== 卖出股票 ==============

export const traderSellTool: Tool<{
  stock_code: string;
  price: number;
  amount: number;
}> = {
  name: "trader_sell",
  description: "卖出股票",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 '600000'" },
      price: { type: "number", description: "卖出价格" },
      amount: { type: "number", description: "卖出股数" },
    },
    required: ["stock_code", "price", "amount"],
  },
  async execute(input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      await trader.sell(input.stock_code, input.price, input.amount);
      return `卖出委托已提交：${input.stock_code}，价格 ${input.price}，数量 ${input.amount}`;
    } catch (error) {
      if (error instanceof TradeError) {
        return `卖出失败：${error.message}`;
      }
      return `卖出失败：${(error as Error).message}`;
    }
  },
};

// ============== 撤销委托 ==============

export const traderCancelTool: Tool<{
  entrust_no: string;
}> = {
  name: "trader_cancel",
  description: "撤销委托单",
  inputSchema: {
    type: "object",
    properties: {
      entrust_no: { type: "string", description: "委托编号" },
    },
    required: ["entrust_no"],
  },
  async execute(input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      const success = await (trader as any).cancelEntrust(input.entrust_no);
      if (success) {
        return `委托 ${input.entrust_no} 撤销成功`;
      } else {
        return `委托 ${input.entrust_no} 撤销失败`;
      }
    } catch (error) {
      return `撤销失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询股票信息 ==============

export const traderStockInfoTool: Tool<{
  stock_code: string;
}> = {
  name: "trader_stock_info",
  description: "查询股票信息（名称、市场、涨跌停价格等）",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 '600000'" },
    },
    required: ["stock_code"],
  },
  async execute(input, _ctx) {
    try {
      const trader = await EastMoneyTrader.getInstance();
      const stockInfo = await (trader as any).getStockInfo(input.stock_code);

      const result = {
        "股票代码": stockInfo.Code,
        "股票名称": stockInfo.Name,
        "市场": stockInfo.Market,
        "涨停价": stockInfo.MaxPrice,
        "跌停价": stockInfo.MinPrice,
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 工具列表导出 ==============

export const traderTools = [
  traderLoginTool,
  traderBalanceTool,
  traderPositionTool,
  traderEntrustTool,
  traderDealTool,
  traderBuyTool,
  traderSellTool,
  traderCancelTool,
  traderStockInfoTool,
];
