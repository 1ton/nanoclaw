import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { transcribeAudio } from '../transcription.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await api.sendMessage(chatId, text, {
        ...options,
        parse_mode: 'Markdown',
      });
      return;
    } catch (markdownErr: any) {
      // Rate limit — wait and retry
      if (markdownErr?.error_code === 429) {
        const retryAfter = (markdownErr?.parameters?.retry_after ?? 5) * 1000;
        if (attempt < MAX_RETRIES) {
          logger.warn({ retryAfter, attempt }, 'Telegram rate limit, retrying…');
          await new Promise((r) => setTimeout(r, retryAfter));
          continue;
        }
        throw markdownErr;
      }
      // Markdown parse error — retry once as plain text
      try {
        await api.sendMessage(chatId, text, options);
        return;
      } catch (plainErr: any) {
        if (plainErr?.error_code === 429) {
          const retryAfter = (plainErr?.parameters?.retry_after ?? 5) * 1000;
          if (attempt < MAX_RETRIES) {
            logger.warn(
              { retryAfter, attempt },
              'Telegram rate limit on plain text, retrying…',
            );
            await new Promise((r) => setTimeout(r, retryAfter));
            continue;
          }
        }
        throw plainErr;
      }
    }
  }
}

function downloadToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
// Main bot API — set when TelegramChannel connects, used as fallback by pool
let mainBotApi: Api | null = null;

/**
 * Initialize send-only Api instances for the bot pool.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; stable per sender+group.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available, falling back to main bot');
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  const numericId = chatId.replace(/^tg:/, '');
  const MAX_LENGTH = 4096;
  const chunks =
    text.length <= MAX_LENGTH
      ? [text]
      : Array.from({ length: Math.ceil(text.length / MAX_LENGTH) }, (_, i) =>
          text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
        );

  try {
    for (const chunk of chunks) {
      await sendTelegramMessage(api, numericId, chunk);
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error(
      { chatId, sender, err },
      'Pool bot failed — falling back to main bot',
    );
    // Fall back to main bot so the message is never silently dropped
    if (mainBotApi) {
      try {
        for (const chunk of chunks) {
          await sendTelegramMessage(mainBotApi, numericId, chunk);
        }
        logger.info(
          { chatId, sender, length: text.length },
          'Pool message sent via main bot fallback',
        );
      } catch (fallbackErr) {
        logger.error(
          { chatId, sender, fallbackErr },
          'Main bot fallback also failed — message lost',
        );
      }
    } else {
      logger.error({ chatId }, 'No main bot available for fallback');
    }
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private async downloadAndSaveFile(
    fileId: string,
    filename: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const file = await this.bot!.api.getFile(fileId);
      if (!file.file_path) return null;
      const attachmentsDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
      fs.mkdirSync(attachmentsDir, { recursive: true });
      const destPath = path.join(attachmentsDir, filename);
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      await downloadToFile(url, destPath);
      logger.info({ filename, groupFolder }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${filename}`;
    } catch (err) {
      logger.warn({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });
    mainBotApi = this.bot.api;

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    /** Extract reply context from a Telegram message, if present. */
    const extractReplyTo = (
      msg: any,
    ): { sender_name: string; content: string } | undefined => {
      const replied = msg.reply_to_message;
      if (!replied) return undefined;
      const senderName =
        replied.from?.first_name ||
        replied.from?.username ||
        replied.from?.id?.toString() ||
        'Unknown';
      const content =
        replied.text ||
        replied.caption ||
        (replied.voice ? '[Voice message]' : undefined) ||
        (replied.audio ? '[Audio]' : undefined) ||
        (replied.photo ? '[Photo]' : undefined) ||
        (replied.video ? '[Video]' : undefined) ||
        (replied.document ? `[File: ${replied.document.file_name || 'file'}]` : undefined) ||
        (replied.sticker ? `[Sticker ${replied.sticker.emoji || ''}]` : undefined) ||
        '[Message]';
      return { sender_name: senderName, content };
    };

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        reply_to: extractReplyTo(ctx.message),
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        reply_to: extractReplyTo(ctx.message),
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) { storeNonText(ctx, '[Photo]'); return; }
      const photos = ctx.message.photo as any[] | undefined;
      if (!photos || photos.length === 0) { storeNonText(ctx, '[Photo]'); return; }
      const photo = photos[photos.length - 1];
      const ts = new Date(ctx.message.date * 1000).toISOString().replace(/[:.]/g, '-');
      const filename = `photo-${ts}.jpg`;
      const containerPath = await this.downloadAndSaveFile(photo.file_id, filename, group.folder);
      const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
      storeNonText(ctx, containerPath ? `[Image: ${containerPath}]${caption}` : `[Photo]${caption}`);
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const voice = ctx.message.voice;
      if (!group || !voice) { storeNonText(ctx, '[Voice message]'); return; }

      // Download voice to temp file, transcribe locally, then clean up
      try {
        const file = await this.bot!.api.getFile(voice.file_id);
        if (file.file_path) {
          const tmpPath = path.join(os.tmpdir(), `tg-voice-${Date.now()}.oga`);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          await downloadToFile(url, tmpPath);
          const transcript = await transcribeAudio(tmpPath);
          fs.unlink(tmpPath, () => {});
          if (transcript) {
            storeNonText(ctx, `[Voice: ${transcript}]`);
            return;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Voice transcription failed, storing placeholder');
      }
      storeNonText(ctx, '[Voice message]');
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';
      if (!group || !doc) { storeNonText(ctx, `[Document: ${name}]`); return; }
      const containerPath = await this.downloadAndSaveFile(doc.file_id, name, group.folder);
      const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
      storeNonText(ctx, containerPath ? `[File: ${containerPath}]${caption}` : `[Document: ${name}]${caption}`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling. Resolve as soon as Telegram confirms the bot is online,
    // or after 30 s — whichever comes first. grammY continues retrying in the
    // background, so the bot recovers automatically when the network is ready.
    return new Promise<void>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn(
            'Telegram API did not respond within 30 s — continuing startup. Bot will connect when network is available.',
          );
          resolve();
        }
      }, 30_000);

      this.bot!.start({
        onStart: (botInfo) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
          }
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
