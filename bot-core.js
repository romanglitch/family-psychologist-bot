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

        // Динамический флаг режима
        this.respondToAllInGroup = config.respondToAllInGroup || false;

        // НОВОЕ: Персональная команда для этого бота (например, 'psy_respond' или 'sex_respond')
        // Позволяет управлять ботами независимо в одном чате
        this.adminCommand = config.adminCommand || 'respond_all';

        this.systemPromptGroup = this._buildSystemPrompt('group');
        this.systemPromptPrivate = this._buildSystemPrompt('private');

        this._setupHandlers();
    }

    _buildSystemPrompt(chatType) {
        const baseIdentity = `ТЫ — «${this.config.roleName}», эмпатичный ИИ-ассистент.`;
        const role = `ТВОЯ РОЛЬ: ${this.config.roleDescription}`;
        const principles = `ПРИНЦИПЫ: Нейтральность, безопасность, конфиденциальность.`;
        const format = `ФОРМАТ: Кратко (до 4 предложений), тёплый профессиональный тон, без канцеляризмов. Обращайся по именам.`;

        if (chatType === 'private') {
            return `${baseIdentity}
                ${role}
                КОНТЕКСТ: Ты общаешься лично с пользователем один на один.
                ${principles}
                ${format}
                ПРАВИЛА: 
                1. Отвечай на каждое сообщение пользователя.
                2. Фокусируйся на личной поддержке, эмпатии и индивидуальных техниках.
                3. Не ставь диагнозы. При серьезных проблемах — рекомендуй очного специалиста.
                4. Используй эмодзи умеренно.`;
        }

        // Групповой промпт (оригинальная логика, но чище)
        return `${baseIdentity}
            ${role}
            КОНТЕКСТ: Ты находишься в Telegram-группе Алёны и Ромы.
            ${principles}
            ${format}
            ПРАВИЛА: 
            1. ${this.respondToAllInGroup ? 'Отвечай на все сообщения в чате, анализируя общий контекст.' : 'Отвечай ТОЛЬКО при упоминании @' + this.config.botUsername + ' или ответе на твоё сообщение.'}
            2. Не ставь диагнозы и не назначай лечение. При выходе за рамки — перенаправляй к живому специалисту.
            3. Проактивно предлагай конкретные техники коммуникации для пары.
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

    async _queryOpenWebUI(chatId, userMessage, isPrivate) {
        const history = this._getHistory(chatId);
        const systemPrompt = isPrivate ? this.systemPromptPrivate : this.systemPromptGroup;

        const messages = [
            { role: 'system', content: systemPrompt },
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

        // Игнорируем других ботов
        if (ctx.from?.is_bot) return false;

        if (ctx.chat.type === 'private') return true;

        // Режим "все сообщения"
        if (this.respondToAllInGroup) return true;

        // Стандартный режим
        if (msg.reply_to_message?.from?.username === this.config.botUsername) return true;
        return this.checkMentionRegex.test(msg.text);
    }

    _setupHandlers() {
        this.bot.start((ctx) => {
            const isPrivate = ctx.chat.type === 'private';
            const text = isPrivate
                ? `Привет! 👋 Я ${this.config.roleName.toLowerCase()}.\n\nПиши мне свои вопросы, я здесь, чтобы поддержать тебя.`
                : `Привет! 👋 Я ${this.config.roleName.toLowerCase()}.\n\nУпомяни меня или ответь на моё сообщение, чтобы я подключился.`;

            ctx.reply(text, Markup.inlineKeyboard([[{ text: '📖 Как я работаю', callback_data: 'how_it_works' }]]));
        });

        this.bot.action('how_it_works', (ctx) => {
            ctx.answerCbQuery();
            ctx.reply(this.config.howItWorksText);
        });

        // НОВАЯ ЛОГИКА: Регистрируем персональную команду
        // Используем this.adminCommand вместо жесткого 'respond_all'
        this.bot.command(this.adminCommand, async (ctx) => {
            const safeReply = async (text, extra = {}) => {
                try {
                    await ctx.reply(text, {
                        reply_to_message_id: ctx.message.message_id,
                        ...extra
                    });
                } catch (err) {
                    if (err.description?.includes('message to be replied not found')) {
                        await ctx.reply(text, extra);
                    } else {
                        console.error(`[${this.config.roleName}] Reply error:`, err.message);
                    }
                }
            };

            // Проверка прав администратора
            try {
                const chatMember = await ctx.getChatMember(ctx.from.id);
                if (chatMember.status !== 'administrator' && chatMember.status !== 'creator') {
                    return safeReply('⛔ Эта команда доступна только администраторам.');
                }
            } catch (e) {
                return safeReply('⚠️ Не удалось проверить права администратора.');
            }

            // Toggle логика: переключаем состояние
            this.respondToAllInGroup = !this.respondToAllInGroup;

            // Пересобираем системный промпт с новым состоянием
            this.systemPromptGroup = this._buildSystemPrompt('group');

            const statusText = this.respondToAllInGroup ? 'ВКЛЮЧЕН ✅' : 'ВЫКЛЮЧЕН ❌';
            const modeDesc = this.respondToAllInGroup
                ? 'Бот отвечает на ВСЕ сообщения'
                : 'Бот отвечает только на УПОМИНАНИЯ';

            return safeReply(
                `<b>${this.config.roleName}</b>: Режим реагирования ${statusText}\n\n${modeDesc}`,
                { parse_mode: 'HTML' }
            );
        });

        this.bot.on('text', async (ctx) => {
            if (!this._shouldRespond(ctx)) return;

            const isPrivate = ctx.chat.type === 'private';
            const senderName = getSenderName(ctx);

            let cleanText = ctx.message.text;
            if (!isPrivate) {
                cleanText = cleanText.replace(this.mentionRegex, '').trim();
            } else {
                cleanText = cleanText.trim();
            }

            if (!cleanText) return ctx.reply('Напиши мне свой вопрос или опиши ситуацию 😊');

            await ctx.sendChatAction('typing');

            const llmMessage = isPrivate ? cleanText : `${senderName}: ${cleanText}`;
            const reply = await this._queryOpenWebUI(ctx.chat.id, llmMessage, isPrivate);

            // ИСПРАВЛЕНИЕ: Безопасная отправка с fallback
            try {
                await ctx.reply(reply, { reply_to_message_id: ctx.message.message_id });
            } catch (err) {
                // Если исходное сообщение удалено или недоступно, отвечаем просто в чат
                if (err.description?.includes('message to be replied not found')) {
                    await ctx.reply(reply);
                } else {
                    throw err; // Пробрасываем другие ошибки дальше
                }
            }
        });

        this.bot.catch((err, ctx) => {
            console.error(`[${this.config.roleName} Error]`, err);
            ctx.reply('Произошла ошибка. Попробуйте ещё раз позже.');
        });
    }

    launch() {
        return this.bot.launch().then(() => {
            console.log(`✅ ${this.config.roleName} запущен | @${this.config.botUsername} | Mode: ${this.respondToAllInGroup ? 'ALL_MESSAGES' : 'MENTIONS_ONLY'}`);
        });
    }

    stop(reason) { this.bot.stop(reason); }
}

module.exports = { PsychBot };