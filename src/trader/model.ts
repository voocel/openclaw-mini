/**
 * 交易数据模型
 */

export class Balance {
    /**
     * 资产
     * @param assetBalance 总资产
     * @param currentBalance 当前余额
     * @param enableBalance 可用余额
     * @param frozenBalance 冻结余额
     * @param marketValue 市值
     * @param moneyType 币种
     * @param preInterest 预利息
     */
    constructor(
        public assetBalance: number,
        public currentBalance: number,
        public enableBalance: number,
        public frozenBalance: number,
        public marketValue: number,
        public moneyType: string,
        public preInterest: number = 0
    ) {}

    update(marketValue: number, currentBalance: number): void {
        this.marketValue = marketValue;
        this.currentBalance = currentBalance;
        this.assetBalance = this.currentBalance + this.marketValue;
    }

    updateTotal(): void {
        this.assetBalance = this.currentBalance + this.marketValue;
    }
}

export class Position {
    /**
     * 持仓
     * @param currentAmount 当前数量
     * @param enableAmount 可用数量
     * @param incomeBalance 收益余额
     * @param costPrice 成本价
     * @param lastPrice 最新价
     * @param marketValue 市值
     * @param positionStr 持仓字符串
     * @param stockCode 股票代码
     * @param stockName 股票名称
     */
    constructor(
        public currentAmount: number,
        public enableAmount: number,
        public incomeBalance: number,
        public costPrice: number,
        public lastPrice: number,
        public marketValue: number,
        public positionStr: string,
        public stockCode: string,
        public stockName: string
    ) {}

    update(lastPrice: number): void {
        this.lastPrice = lastPrice;
        this.marketValue = this.currentAmount * lastPrice;
    }
}

export class Entrust {
    /**
     * 历史委托
     * @param entrustNo 委托编号
     * @param bsType 买卖类别
     * @param entrustAmount 委托数量
     * @param entrustPrice 委托价格
     * @param reportTime 申报时间
     * @param entrustStatus 委托状态
     * @param stockCode 股票代码
     * @param stockName 股票名称
     * @param cost 费用
     */
    constructor(
        public entrustNo: string,
        public bsType: string,
        public entrustAmount: number,
        public entrustPrice: number,
        public reportTime: string,
        public entrustStatus: string,
        public stockCode: string,
        public stockName: string,
        public cost: number = 0
    ) {}
}

export class PerTrade {
    /**
     * 交易费用
     * 买入时佣金万分之三，卖出时佣金万分之三加千分之一印花税, 每笔交易佣金最低扣5块钱
     */
    static readonly closeTax: number = 0.001;
    static readonly buyCost: number = 0.0003;
    static readonly sellCost: number = 0.0004;
    static readonly minCost: number = 5;
}

export class Deal {
    /**
     * 当日成交
     * @param dealNo 成交编号
     * @param entrustNo 委托编号
     * @param bsType 买卖类别
     * @param entrustAmount 委托数量
     * @param dealAmount 成交数量
     * @param dealPrice 成交价格
     * @param entrustPrice 委托价格
     * @param dealTime 成交时间 (HHmmss)
     * @param stockCode 股票代码
     * @param stockName 股票名称
     */
    constructor(
        public dealNo: string,
        public entrustNo: string,
        public bsType: string,
        public entrustAmount: number,
        public dealAmount: number,
        public dealPrice: number,
        public entrustPrice: number,
        public dealTime: string,
        public stockCode: string,
        public stockName: string
    ) {}
}

export class IPOQuota {
    /**
     * IPO配额
     * @param accountCode 账户代码
     * @param market 市场
     * @param quota 配额
     */
    constructor(
        public accountCode: string,
        public market: string,
        public quota: number
    ) {}
}

export class IPO {
    /**
     * 新股申购
     */
    constructor(
        public market: string,
        public stockCode: string,
        public stockName: string
    ) {}
}