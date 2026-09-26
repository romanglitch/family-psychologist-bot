const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSenderName(ctx) {
    return ctx.from?.first_name || ctx.from?.username || 'Неизвестный пользователь';
}

class PsychBot {
    constructor(config) {
        this.config = config;
        this.bot = new Telegraf(config.telegramToken);
        this.chatHistories = new Map();

        const safeUsername = escapeRegExp(config.botUsername);
        this.mentionRegex = new RegExp(`@${safeUsername}`, 'gi');
        this.checkMentionRegex = new RegExp(`@${safeUsername}`, 'i');

        this.systemPrompt = this._buildSystemPrompt();
        this._setupHandlers();
    }

    _buildSystemPrompt() {
        return `ТЫ — «${this.config.roleName}», эмпатичный ИИ-ассистент в Telegram-группе Алёны и Ромы.
            ТВОЯ РОЛЬ: ${this.config.roleDescription}
            ПРИНЦИПЫ: Нейтральность, безопасность, конфиденциальность.
            ФОРМАТ: Кратко (до 4 предложений), тёплый профессиональный тон, без канцеляризмов. Обращайся по именам.
            ПРАВИЛА: 
            1. Отвечай ТОЛЬКО при упоминании @${this.config.botUsername} или ответе на твоё сообщение.
            2. Не ставь диагнозы и не назначай лечение. При выходе за рамки — перенаправляй к живому специалисту.
            3. Проактивно предлагай конкретные техники коммуникации.
            4. Используй эмодзи умеренно.`;
    }

    _getHistory(chatId) {
        if (!this.chatHistories.has(chatId)) this.chatHistories.set(chatId, []);
        return this.chatHistories.get(chatId);
    }

    _addToHistory(chatId, role, content) {
        const history = this._getHistory(chatId);
        history.push({ role, content });
        const limit = this.config.maxHistory * 2;
        if (history.length > limit) history.splice(0, history.length - limit);
    }

    async _queryOpenWebUI(chatId, userMessage) {
        const history = this._getHistory(chatId);
        const messages = [
            { role: 'system', content: this.systemPrompt },
            ...history,
            { role: 'user', content: userMessage },
        ];

        try {
            const response = await axios.post(
                `${this.config.openWebUI.baseUrl}/api/chat/completions`,
                { model: this.config.openWebUI.modelId, messages, stream: false },
                {
                    headers: {
                        Authorization: `Bearer ${this.config.openWebUI.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 60000,
                }
            );

            const content = response.data.choices?.[0]?.message?.content;
            if (!content) throw new Error('Empty response from Open WebUI');

            this._addToHistory(chatId, 'user', userMessage);
            this._addToHistory(chatId, 'assistant', content);
            return content;
        } catch (error) {
            console.error(`[${this.config.roleName}]`, error.response?.data || error.message);
            return 'Извините, сейчас не могу ответить. Попробуйте позже 🙏';
        }
    }

    _shouldRespond(ctx) {
        const msg = ctx.message;
        if (!msg?.text) return false;
        if (msg.reply_to_message?.from?.username === this.config.botUsername) return true;
        return this.checkMentionRegex.test(msg.text);
    }

    _setupHandlers() {
        this.bot.start((ctx) => {
            ctx.reply(
                `Привет! 👋 Я ${this.config.roleName.toLowerCase()}.\n\nУпомяни меня или ответь на моё сообщение, чтобы я подключился.`,
                Markup.inlineKeyboard([[{ text: '📖 Как я работаю', callback_data: 'how_it_works' }]])
            );
        });

        this.bot.action('how_it_works', (ctx) => {
            ctx.answerCbQuery();
            ctx.reply(this.config.howItWorksText);
        });

        this.bot.on('text', async (ctx) => {
            // Дебаг-лог для диагностики — убери когда всё заработает
            console.log(`[${this.config.roleName}] text: "${ctx.message.text?.slice(0, 40)}" | shouldRespond: ${this._shouldRespond(ctx)}`);

            if (!this._shouldRespond(ctx)) return;

            const senderName = getSenderName(ctx);
            const cleanText = ctx.message.text.replace(this.mentionRegex, '').trim();

            if (!cleanText) return ctx.reply('Напиши мне свой вопрос или опиши ситуацию 😊');

            await ctx.sendChatAction('typing');
            const reply = await this._queryOpenWebUI(ctx.chat.id, `${senderName}: ${cleanText}`);
            ctx.reply(reply, { reply_to_message_id: ctx.message.message_id });
        });

        this.bot.catch((err, ctx) => {
            console.error(`[${this.config.roleName} Error]`, err);
            ctx.reply('Произошла ошибка. Попробуйте ещё раз позже.');
        });
    }

    launch() {
        return this.bot.launch().then(() => {
            console.log(`✅ ${this.config.roleName} запущен | @${this.config.botUsername}`);
        });
    }

    stop(reason) { this.bot.stop(reason); }
}

module.exports = { PsychBot };