/**
 * 验证码识别模块入口
 * 提供多种验证码识别方案
 */

export * from './types.js';
export { TesseractCaptchaRecognizer } from './tesseract-recognizer.js';

/**
 * 验证码识别器工厂
 */
export class CaptchaRecognizerFactory {
    /**
     * 创建默认验证码识别器
     * 尝试使用 Tesseract.js
     */
    static async createDefault(): Promise<import('./types.js').CaptchaRecognizer> {
        try {
            // 尝试创建 Tesseract 识别器
            const { TesseractCaptchaRecognizer } = await import('./tesseract-recognizer.js');
            return new TesseractCaptchaRecognizer({
                expectedLength: 4,
                charset: '0123456789'
            });
        } catch (error) {
            console.warn('Tesseract.js 不可用，使用模拟识别器:', error);
            throw new Error('实例化失败');
        }
    }

    /**
     * 创建 Tesseract 识别器
     * @throws 如果 tesseract.js 未安装
     */
    static async createTesseract(options?: import('./types.js').CaptchaRecognizerOptions): Promise<import('./types.js').CaptchaRecognizer> {
        const { TesseractCaptchaRecognizer } = await import('./tesseract-recognizer.js');
        return new TesseractCaptchaRecognizer(options);
    }

    /**
     * 创建基于图像预处理的识别器（待实现）
     */
    static createImageProcessor(): import('./types.js').CaptchaRecognizer {
        throw new Error('图像预处理识别器尚未实现');
    }
}

/**
 * 默认导出工厂类
 */
export default CaptchaRecognizerFactory;