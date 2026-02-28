/**
 * 测试 TesseractCaptchaRecognizer 的 recognize 方法
 *
 * 使用方法:
 * 1. 确保已安装依赖: npm install tesseract.js
 * 3. 运行: npx tsx examples/test.ts
 */

import { TesseractCaptchaRecognizer } from '../src/trader/captcha/tesseract-recognizer.js';
import http from 'http';
async function main() {
    console.log('=== TesseractCaptchaRecognizer 测试 ===\n');

    // 创建识别器实例
    const recognizer = new TesseractCaptchaRecognizer({
        expectedLength: 4,      // 期望验证码长度为4位
        charset: '0123456789',  // 只识别数字
        maxRetries: 3,
        retryDelay: 1000
    });

    console.log(`识别器名称: ${recognizer.name}`);
    console.log(`字符白名单: ${recognizer.getCharWhitelist()}`);

    try {
        // 读取图片文件
        const randomNumber = '0.305' + Math.floor(100000 + Math.random() * 900000);
        const imageUrl = `https://jywg.18.cn/Login/YZM?randNum=${randomNumber}`;

        console.log(`正在读取图片: ${imageUrl}`);
        const response = await fetch(imageUrl);
        // 检查响应状态
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        // 将响应转换为 ArrayBuffer
        const arrayBuffer = await response.arrayBuffer();

        // 转换为 Buffer（Node.js 专用）
        const imageBuffer = Buffer.from(arrayBuffer);

        console.log(`图片大小: ${imageBuffer.length} bytes`);

        // 执行识别
        console.log('开始识别验证码...');
        const result = await recognizer.recognize(imageBuffer);
        // const result = '2323'

        http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                    <body>
                        <img src="data:image/jpeg;base64,${imageBuffer.toString('base64')}"
                        <br />
                        <div>Result: ${result}</div>
                    </body>
                </html>
            `);
        }).listen(3050, () => {
            console.log('Server running at http://localhost:3050');
        });

    } catch (error) {
        console.error('\n识别失败:', error);
        process.exit(1);
    } finally {
        // 释放资源
        await recognizer.terminate();
        console.log('\n=== 测试完成 ===');
    }
}

// 运行测试
main().catch(console.error);
