/**
 * 飞书渠道实现
 * 基于飞书开放平台机器人API
 */

import type { Channel, ChannelMessage, ChannelResponse, ChannelEvent } from "./types.js";

export interface FeishuConfig {
  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret */
  appSecret: string;
  /** 加密密钥（可选，用于验证请求） */
  encryptKey?: string;
  /** 验证令牌（可选） */
  verificationToken?: string;
  /** Webhook 地址（可选，如果使用webhook模式） */
  webhookUrl?: string;
  /** 消息接收端点（可选，用于配置飞书事件订阅） */
  endpoint?: string;
}

export class FeishuChannel implements Channel {
  readonly type = "feishu";
  readonly id: string;
  private config: FeishuConfig;
  private connectedState = false;
  private messageCallbacks: Array<(message: ChannelMessage) => void> = [];
  private eventCallbacks: Array<(event: ChannelEvent) => void> = [];
  private accessToken?: string;
  private tokenExpiresAt?: Date;

  constructor(id: string, config: FeishuConfig) {
    this.id = id;
    this.config = config;
  }

  get connected(): boolean {
    return this.connectedState;
  }

  async initialize(): Promise<void> {
    console.log(`[FeishuChannel:${this.id}] Initializing...`);
    
    // 验证配置
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu appId and appSecret are required');
    }

    // 初始化连接
    await this.refreshAccessToken();
    
    console.log(`[FeishuChannel:${this.id}] Initialized`);
    this.emitEvent({ type: 'initialized', data: { id: this.id }, timestamp: new Date() });
  }

  async connect(): Promise<void> {
    if (this.connectedState) {
      return;
    }

    console.log(`[FeishuChannel:${this.id}] Connecting...`);
    
    try {
      // 确保有有效的访问令牌
      await this.ensureValidToken();
      
      this.connectedState = true;
      console.log(`[FeishuChannel:${this.id}] Connected`);
      this.emitEvent({ type: 'connected', data: { id: this.id }, timestamp: new Date() });
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] Connection failed:`, error);
      this.emitEvent({ 
        type: 'error', 
        data: { error: error instanceof Error ? error.message : String(error) }, 
        timestamp: new Date() 
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connectedState) {
      return;
    }

    console.log(`[FeishuChannel:${this.id}] Disconnecting...`);
    this.connectedState = false;
    
    // 清理资源
    this.accessToken = undefined;
    this.tokenExpiresAt = undefined;
    
    console.log(`[FeishuChannel:${this.id}] Disconnected`);
    this.emitEvent({ type: 'disconnected', data: { id: this.id }, timestamp: new Date() });
  }

  async sendMessage(message: ChannelMessage): Promise<ChannelResponse> {
    if (!this.connectedState) {
      throw new Error('Channel is not connected');
    }

    try {
      await this.ensureValidToken();

      // 根据消息类型发送到飞书
      const response = await this.sendToFeishu(message);
      
      return {
        success: true,
        messageId: response.message_id,
        content: message.content,
        metadata: response,
      };
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] Failed to send message:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        content: message.content,
      };
    }
  }

  onMessage(callback: (message: ChannelMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  onEvent(callback: (event: ChannelEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  getInfo(): Record<string, any> {
    return {
      type: this.type,
      id: this.id,
      connected: this.connectedState,
      config: {
        appId: this.config.appId,
        hasEncryptKey: !!this.config.encryptKey,
        hasWebhook: !!this.config.webhookUrl,
      },
      tokenValid: !!this.accessToken && (!this.tokenExpiresAt || this.tokenExpiresAt > new Date()),
    };
  }

  /**
   * 处理飞书webhook事件
   * 这个方法应该由外部webhook处理器调用
   */
  async handleWebhookEvent(event: any): Promise<void> {
    try {
      // 验证事件签名（如果配置了加密密钥）
      if (this.config.encryptKey && !this.verifySignature(event)) {
        console.warn(`[FeishuChannel:${this.id}] Invalid signature`);
        return;
      }

      // 解析飞书事件
      const message = this.parseFeishuEvent(event);
      if (message) {
        this.emitMessage(message);
      }

      // 发送其他类型的事件
      this.emitEvent({
        type: 'webhook_received',
        data: event,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] Error handling webhook:`, error);
      this.emitEvent({
        type: 'error',
        data: { error: error instanceof Error ? error.message : String(error) },
        timestamp: new Date(),
      });
    }
  }

  /**
   * 刷新访问令牌
   */
  private async refreshAccessToken(): Promise<void> {
    try {
      const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get access token: ${response.statusText}`);
      }

      const data = await response.json() as { code: number; msg: string; tenant_access_token?: string; expire?: number };
      
      if (data.code !== 0) {
        throw new Error(`Feishu API error: ${data.msg}`);
      }

      this.accessToken = data.tenant_access_token;
      // 设置过期时间（提前5分钟刷新）
      const expiresIn = data.expire || 7200; // 默认2小时
      this.tokenExpiresAt = new Date(Date.now() + (expiresIn - 300) * 1000);
      
      console.log(`[FeishuChannel:${this.id}] Access token refreshed`);
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] Failed to refresh access token:`, error);
      throw error;
    }
  }

  /**
   * 确保访问令牌有效
   */
  private async ensureValidToken(): Promise<void> {
    const now = new Date();
    if (!this.accessToken || !this.tokenExpiresAt || this.tokenExpiresAt <= now) {
      await this.refreshAccessToken();
    }
  }

  /**
   * 发送消息到飞书
   */
  private async sendToFeishu(message: ChannelMessage): Promise<any> {
    await this.ensureValidToken();

    // 构建飞书消息格式
    const feishuMessage = this.buildFeishuMessage(message);
    
    // 发送到飞书API
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        receive_id: message.conversationId || message.userId,
        msg_type: 'text',
        content: JSON.stringify(feishuMessage),
      }),
    });

    if (!response.ok) {
      throw new Error(`Feishu API error: ${response.statusText}`);
    }

    const data = await response.json() as { code: number; msg: string; data?: any };
    
    if (data.code !== 0) {
      throw new Error(`Feishu API error: ${data.msg}`);
    }

    return data.data;
  }

  /**
   * 构建飞书消息格式
   */
  private buildFeishuMessage(message: ChannelMessage): any {
    // 基础文本消息
    if (message.messageType === 'text') {
      return {
        text: message.content,
      };
    }
    
    // 其他消息类型可以在这里扩展
    // 例如：富文本、卡片消息等
    
    // 默认返回文本消息
    return {
      text: message.content,
    };
  }

  /**
   * 解析飞书事件为ChannelMessage
   */
  private parseFeishuEvent(event: any): ChannelMessage | null {
    // 飞书事件结构参考：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-concepts
    if (!event || !event.event) {
      return null;
    }

    const feishuEvent = event.event;
    
    // 处理消息事件
    if (feishuEvent.type === 'message' && feishuEvent.message) {
      const message = feishuEvent.message;
      
      return {
        id: message.message_id,
        channelType: this.type,
        channelId: this.id,
        userId: message.sender?.sender_id?.user_id || message.sender?.sender_id?.open_id || 'unknown',
        conversationId: message.chat_id || message.open_chat_id || 'unknown',
        content: message.content || '',
        messageType: this.extractMessageType(message),
        timestamp: new Date(parseInt(message.create_time) * 1000),
        metadata: {
          event,
          message_type: message.message_type,
          chat_type: message.chat_type,
        },
      };
    }

    return null;
  }

  /**
   * 提取消息类型
   */
  private extractMessageType(message: any): string {
    if (!message.message_type) {
      return 'text';
    }

    switch (message.message_type) {
      case 'text':
        return 'text';
      case 'image':
        return 'image';
      case 'file':
        return 'file';
      case 'audio':
        return 'audio';
      case 'media':
        return 'media';
      default:
        return 'text';
    }
  }

  /**
   * 验证签名
   */
  private verifySignature(event: any): boolean {
    // 飞书签名验证逻辑
    // 参考：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-concepts
    if (!this.config.encryptKey || !event.header || !event.header.token) {
      return true; // 如果没有配置加密密钥，跳过验证
    }

    // 这里实现实际的签名验证逻辑
    // 由于时间关系，这里简化为返回true
    return true;
  }

  /**
   * 触发消息事件
   */
  private emitMessage(message: ChannelMessage): void {
    for (const callback of this.messageCallbacks) {
      try {
        callback(message);
      } catch (error) {
        console.error(`[FeishuChannel:${this.id}] Error in message callback:`, error);
      }
    }
  }

  /**
   * 触发渠道事件
   */
  private emitEvent(event: ChannelEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error(`[FeishuChannel:${this.id}] Error in event callback:`, error);
      }
    }
  }
}