/**
 * 验证码识别器接口
 */

export interface CaptchaRecognizer {
    /**
     * 识别验证码图片
     * @param imageBuffer 验证码图片的二进制数据
     * @returns 识别出的验证码文本
     */
    recognize(imageBuffer: Buffer): Promise<string>;

    /**
     * 识别器名称（用于调试和日志）
     */
    readonly name: string;
}

/**
 * 验证码识别选项
 */
export interface CaptchaRecognizerOptions {
    /**
     * 最大重试次数
     */
    maxRetries?: number;

    /**
     * 重试延迟（毫秒）
     */
    retryDelay?: number;

    /**
     * 验证码长度（如果已知）
     */
    expectedLength?: number;

    /**
     * 验证码字符集（如果已知）
     */
    charset?: string;
}

/**
 * 验证码识别结果
 */
export interface CaptchaRecognitionResult {
    /**
     * 识别出的文本
     */
    text: string;

    /**
     * 置信度（0-1）
     */
    confidence: number;

    /**
     * 识别器名称
     */
    recognizer: string;

    /**
     * 处理时间（毫秒）
     */
    processingTime: number;
}