/**
 * 东方财富交易客户端示例
 *
 * 使用说明：
 * 1. 安装依赖：确保已安装Node.js 18+
 * 2. 运行：npx tsx examples/trader-example.ts
 *
 * 注意：实际使用时需要真实的东方财富账户，且验证码识别需要额外实现
 */
import "dotenv/config";
import EastMoneyTrader from '../src/trader/index.js';
async function main() {
    console.log('=== 东方财富交易客户端示例 ===');

    // 创建交易客户端
    const trader = new EastMoneyTrader({});

    try {
        // 准备账户（模拟账户，实际需要真实账户）
        console.log('1. 准备账户...');
        await trader.prepare(process.env.STOCK_EASTMONEY_USERNAME, process.env.STOCK_EASTMONEY_PASSWORD);

        console.log('2. 获取资金余额...');
        const balance = await trader.getBalance();
        console.log('资金余额:', balance);

        console.log('3. 获取持仓...');
        const positions = await trader.getPosition();
        console.log('持仓数量:', positions.length);
        if (positions.length > 0) {
            console.log('第一个持仓:', positions[0]);
        }

        console.log('4. 获取委托单...');
        const entrusts = await trader.getEntrust();
        console.log('委托单数量:', entrusts.length);

        console.log('5. 获取当日成交...');
        const deals = await trader.getCurrentDeal();
        console.log('当日成交数量:', deals.length);

        // 注意：以下交易操作是示例，实际执行需要真实账户和正确的参数
        console.log('\n=== 交易操作示例（模拟）===');
        console.log('注：以下操作不会实际执行，仅展示API调用方式');

        // 示例：买入100股某股票，价格10元
        // await trader.buy('000001', 10.0, 100);

        // 示例：卖出50股某股票，价格11元
        // await trader.sell('000001', 11.0, 50);

        console.log('\n=== 示例完成 ===');

    } catch (error) {
        console.error('发生错误:', error);
    } finally {
        // 退出客户端
        trader.exit();
    }
}

// 运行示例
main().catch(console.error);