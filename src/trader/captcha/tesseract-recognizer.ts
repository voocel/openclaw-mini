/**
 * Tesseract.js 验证码识别器
 * 需要安装依赖: npm install tesseract.js
 */

import type { CaptchaRecognizer, CaptchaRecognitionResult, CaptchaRecognizerOptions } from './types.js';
import { PSM } from 'tesseract.js';

export class TesseractCaptchaRecognizer implements CaptchaRecognizer {
    readonly name = 'TesseractCaptchaRecognizer';
    private options: Required<CaptchaRecognizerOptions>;
    private tesseract: any = null;

    constructor(options: CaptchaRecognizerOptions = {}) {
        this.options = {
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1000,
            expectedLength: options.expectedLength ?? 4,
            charset: options.charset ?? '0123456789'
        };
    }

    /**
     * 初始化 Tesseract.js
     */
    private async initialize(): Promise<void> {
        if (this.tesseract) {
            return;
        }

        try {
            // 动态导入 tesseract.js
            // @ts-ignore - tesseract.js 是可选依赖
            const { createWorker } = await import('tesseract.js');
            const worker = await createWorker('eng'); // 使用英文语言包

            // 配置识别参数
            await worker.setParameters({
                tessedit_char_whitelist: this.options.charset,
                tessedit_pageseg_mode: PSM.SINGLE_CHAR, // 单字符模式
                user_defined_dpi: '300',
                oem: 1,
                preserve_interword_spaces: '0'
            });

            this.tesseract = worker;
        } catch (error) {
            throw new Error(`Failed to initialize Tesseract.js: ${error}. Make sure tesseract.js is installed: npm install tesseract.js`);
        }
    }

    /**
     * 识别验证码图片
     */
    async recognize(imageBuffer: Buffer): Promise<string> {
        const result = await this.recognizeWithDetails(imageBuffer);
        return result.text;
    }

    /**
     * 识别验证码图片并返回详细信息
     */
    async recognizeWithDetails(imageBuffer: Buffer): Promise<CaptchaRecognitionResult> {
        await this.initialize();

        const startTime = Date.now();
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
            try {
                // 使用 Tesseract 识别
                const { data: { text, confidence } } = await this.tesseract.recognize(imageBuffer);

                // 清理识别结果：移除空格和换行
                const cleanedText = text.replace(/\s+/g, '');

                // 验证结果长度
                if (this.options.expectedLength && cleanedText.length !== this.options.expectedLength) {
                    console.warn(`验证码长度不符: 期望 ${this.options.expectedLength}, 实际 ${cleanedText.length}, 文本: ${cleanedText}`);

                    // 如果置信度低或长度不对，可能识别错误，重试
                    if (attempt < this.options.maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, this.options.retryDelay));
                        continue;
                    }
                }

                const processingTime = Date.now() - startTime;

                return {
                    text: cleanedText,
                    confidence: confidence / 100, // 转换为 0-1 范围
                    recognizer: this.name,
                    processingTime
                };

            } catch (error) {
                lastError = error as Error;
                console.warn(`Tesseract 识别尝试 ${attempt} 失败:`, error);

                if (attempt < this.options.maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, this.options.retryDelay));
                }
            }
        }

        throw new Error(`验证码识别失败，最大重试次数 ${this.options.maxRetries} 已用完: ${lastError?.message}`);
    }

    /**
     * 释放资源
     */
    async terminate(): Promise<void> {
        if (this.tesseract) {
            await this.tesseract.terminate();
            this.tesseract = null;
        }
    }

    /**
     * 获取字符白名单配置
     */
    getCharWhitelist(): string {
        return this.options.charset;
    }

    /**
     * 设置字符白名单
     */
    setCharWhitelist(charset: string): void {
        this.options.charset = charset;
        if (this.tesseract) {
            // 更新工作器参数
            this.tesseract.setParameters({
                tessedit_char_whitelist: charset
            }).catch(console.error);
        }
    }
}