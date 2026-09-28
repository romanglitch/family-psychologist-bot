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

        // Парсинг белого списка из строки "123,456,789" в Set чисел
        this.allowedUserIds = null;
        if (config.allowedUserIds && config.allowedUserIds.length > 0) {
            this.allowedUserIds = new Set(config.allowedUserIds.map(id => Number(id)));
        }

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

    async _queryOpenWebUI(chatId, userMessage, isPrivate, imageBase64) {
        const history = this._getHistory(chatId);
        const systemPrompt = isPrivate ? this.systemPromptPrivate : this.systemPromptGroup;

        // Формируем контент пользователя
        let userContent;
        if (imageBase64) {
            userContent = [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
                { type: 'text', text: userMessage || 'Что изображено на этом фото?' }
            ];
        } else {
            userContent = userMessage;
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userContent },
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

            this._addToHistory(chatId, 'user', typeof userContent === 'string' ? userContent : userMessage);
            this._addToHistory(chatId, 'assistant', content);
            return content;
        } catch (error) {
            console.error(`[${this.config.roleName}]`, error.response?.data || error.message);
            return 'Извините, сейчас не могу ответить. Попробуйте позже 🙏';
        }
    }

    _shouldRespond(ctx) {
        const msg = ctx.message;

        // Игнорируем других ботов
        if (ctx.from?.is_bot) return false;

        // === НОВОЕ: Проверка белого списка ===
        // Если список задан, пропускаем ТОЛЬКО указанных пользователей
        // Администраторские команды обрабатываются отдельно в handler'е command
        if (this.allowedUserIds && !this.allowedUserIds.has(ctx.from.id)) {
            return false;
        }

        if (!msg?.text && !msg?.voice && !msg?.audio && !msg?.photo) return false;

        if (ctx.chat.type === 'private') return true;

        // Режим "все сообщения"
        if (this.respondToAllInGroup) return true;

        // Стандартный режим
        if (msg.reply_to_message?.from?.username === this.config.botUsername) return true;

        // Для текста проверяем mention, для медиа — только reply
        if (msg?.text) return this.checkMentionRegex.test(msg.text);
        return false; // Медиа в группе реагируем только на reply или в режиме ALL
    }

    async _transcribeAudio(fileLink) {
        try {
            // Скачиваем файл с Telegram
            const fileResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });

            // Создаем FormData для отправки в Open WebUI STT
            const FormData = require('form-data'); // Нужна зависимость form-data
            const formData = new FormData();
            formData.append('file', Buffer.from(fileResponse.data), {
                filename: 'voice.ogg',
                contentType: 'audio/ogg',
            });

            const response = await axios.post(
                `${this.config.openWebUI.baseUrl}/api/v1/audio/transcriptions`,
                formData,
                {
                    headers: {
                        ...formData.getHeaders(),
                        Authorization: `Bearer ${this.config.openWebUI.apiKey}`,
                    },
                    timeout: 60000,
                }
            );

            return response.data?.text || '';
        } catch (error) {
            console.error(`[${this.config.roleName}] STT Error:`, error.response?.data || error.message);
            return '';
        }
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

        // === ГОЛОСОВЫЕ СООБЩЕНИЯ ===
        this.bot.on(['voice', 'audio'], async (ctx) => {
            if (!this._shouldRespond(ctx)) return;

            await ctx.sendChatAction('typing');

            const fileLink = await ctx.telegram.getFileLink(ctx.message.voice?.file_id || ctx.message.audio.file_id);
            const transcribedText = await this._transcribeAudio(fileLink);

            if (!transcribedText) {
                return ctx.reply('Не удалось распознать голосовое сообщение 😔',
                    { reply_to_message_id: ctx.message.message_id });
            }

            const isPrivate = ctx.chat.type === 'private';
            const senderName = getSenderName(ctx);
            const llmMessage = isPrivate ? transcribedText : `${senderName}: ${transcribedText}`;

            const reply = await this._queryOpenWebUI(ctx.chat.id, llmMessage, isPrivate);

            try {
                await ctx.reply(reply, { reply_to_message_id: ctx.message.message_id });
            } catch (err) {
                if (err.description?.includes('message to be replied not found')) {
                    await ctx.reply(reply);
                } else throw err;
            }
        });

        // === ФОТО (VISION) ===
        this.bot.on('photo', async (ctx) => {
            if (!this._shouldRespond(ctx)) return;

            await ctx.sendChatAction('upload_photo');

            // Берем фото наибольшего размера
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);

            // Скачиваем и конвертируем в base64
            const fileResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const imageBase64 = Buffer.from(fileResponse.data).toString('base64');

            const caption = ctx.message.caption || '';
            const isPrivate = ctx.chat.type === 'private';
            const senderName = getSenderName(ctx);
            const llmMessage = isPrivate ? caption : `${senderName}: ${caption}`;

            const reply = await this._queryOpenWebUI(ctx.chat.id, llmMessage, isPrivate, imageBase64);

            try {
                await ctx.reply(reply, { reply_to_message_id: ctx.message.message_id });
            } catch (err) {
                if (err.description?.includes('message to be replied not found')) {
                    await ctx.reply(reply);
                } else throw err;
            }
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