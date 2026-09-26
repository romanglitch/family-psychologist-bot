require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// ─── Конфигурация ────────────────────────────────────────────────
const CONFIG = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    openWebUI: {
        baseUrl: process.env.OPENWEBUI_BASE_URL || 'http://localhost:8080',
        apiKey: process.env.OPENWEBUI_API_KEY,
        modelId: process.env.OPENWEBUI_MODEL_ID,
    },
    botUsername: process.env.BOT_USERNAME,
    maxHistory: parseInt(process.env.MAX_HISTORY_MESSAGES || '20', 10),
};

// ─── Системный промт ─────────────────────────────────────────────
const SYSTEM_PROMPT = `ТЫ — «Семейный Психолог», эмпатичный ИИ-ассистент в Telegram-группе Алёны и Ромы.
ПРИНЦИПЫ: Нейтральность (не принимай стороны), безопасность (при угрозах — контакты кризисных служб), конфиденциальность.
ФОРМАТ: Кратко (до 4 предложений), тёплый профессиональный тон, без канцеляризмов. Обращайся по именам.
ПРАВИЛА: Отвечай ТОЛЬКО при упоминании @${CONFIG.botUsername} или ответе на твоё сообщение. Не ставь диагнозы. При выходе за рамки компетенции — перенаправляй к специалисту. Проактивно предлагай техники коммуникации. Используй эмодзи умеренно.`;

// ─── Хранилище истории сообщений (in-memory) ─────────────────────
// Для продакшена замени на Redis / БД
const chatHistories = new Map();

function getChatHistory(chatId) {
    if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
    }
    return chatHistories.get(chatId);
}

function addToHistory(chatId, role, content) {
    const history = getChatHistory(chatId);
    history.push({ role, content });
    // Ограничиваем историю, чтобы не превысить контекстное окно модели
    if (history.length > CONFIG.maxHistory * 2) {
        history.splice(0, history.length - CONFIG.maxHistory * 2);
    }
}

// ─── Клиент Open WebUI API ───────────────────────────────────────
async function queryOpenWebUI(chatId, userMessage) {
    const history = getChatHistory(chatId);

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: userMessage },
    ];

    try {
        const response = await axios.post(
            `${CONFIG.openWebUI.baseUrl}/api/chat/completions`,
            {
                model: CONFIG.openWebUI.modelId,
                messages,
                stream: false,
            },
            {
                headers: {
                    Authorization: `Bearer ${CONFIG.openWebUI.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 60000, // Таймаут 60с, т.к. генерация может быть долгой
            }
        );

        const assistantMessage = response.data.choices?.[0]?.message?.content;
        if (!assistantMessage) throw new Error('Empty response from Open WebUI');

        // Сохраняем оба сообщения в историю
        addToHistory(chatId, 'user', userMessage);
        addToHistory(chatId, 'assistant', assistantMessage);

        return assistantMessage;
    } catch (error) {
        console.error('[OpenWebUI Error]', error.response?.data || error.message);
        return 'Извините, сейчас не могу ответить. Попробуйте позже 🙏';
    }
}

// ─── Проверка: нужно ли боту реагировать ─────────────────────────
function shouldRespond(ctx) {
    const msg = ctx.message;
    if (!msg || !msg.text) return false;

    // 1. Ответ на сообщение бота
    if (msg.reply_to_message?.from?.username === CONFIG.botUsername) return true;

    // 2. Упоминание @bot_username в тексте
    const mentionRegex = new RegExp(`@${CONFIG.botUsername}`, 'i');
    if (mentionRegex.test(msg.text)) return true;

    return false;
}

// ─── Извлечение имени отправителя ────────────────────────────────
function getSenderName(ctx) {
    const user = ctx.from;
    return user.first_name || user.username || 'Неизвестный пользователь';
}

// ─── Инициализация бота ──────────────────────────────────────────
const bot = new Telegraf(CONFIG.telegramToken);

// Команда /start
bot.start((ctx) => {
    ctx.reply(
        'Привет! 👋 Я семейный психолог-ассистент.\n\n' +
        'Я помогаю Алёне и Роме общаться бережнее.\n' +
        'Упомяни меня или ответь на моё сообщение, чтобы я подключился к разговору.',
        Markup.inlineKeyboard([
            [{ text: '📖 Как я работаю', callback_data: 'how_it_works' }],
        ])
    );
});

bot.action('how_it_works', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
        '• Отвечаю только когда меня упоминают\n' +
        '• Не принимаю ничью сторону\n' +
        '• Предлагаю конкретные техники общения\n' +
        '• Всё сказанное в группе — конфиденциально\n' +
        '• Не заменяю клинического психолога'
    );
});

// Обработка всех текстовых сообщений
bot.on('text', async (ctx) => {
    if (!shouldRespond(ctx)) return;

    const senderName = getSenderName(ctx);
    const rawText = ctx.message.text;

    // Убираем упоминание бота из текста перед отправкой в модель
    const cleanText = rawText
        .replace(new RegExp(`@${CONFIG.botUsername}`, 'gi'), '')
        .trim();

    if (!cleanText) {
        ctx.reply('Напиши мне свой вопрос или опиши ситуацию 😊');
        return;
    }

    // Форматируем сообщение с указанием автора для модели
    const formattedMessage = `${senderName}: ${cleanText}`;

    // Индикатор "печатает..." пока модель думает
    await ctx.sendChatAction('typing');

    const reply = await queryOpenWebUI(ctx.chat.id, formattedMessage);
    ctx.reply(reply, { reply_to_message_id: ctx.message.message_id });
});

// Глобальная обработка ошибок
bot.catch((err, ctx) => {
    console.error(`[Bot Error] for update ${ctx.update.update_id}:`, err);
    ctx.reply('Произошла ошибка. Попробуйте ещё раз позже.');
});

// ─── Запуск ──────────────────────────────────────────────────────
bot.launch().then(() => {
    console.log(`✅ Бот запущен | Модель: ${CONFIG.openWebUI.modelId}`);
    console.log(`📡 Open WebUI: ${CONFIG.openWebUI.baseUrl}`);
});

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));