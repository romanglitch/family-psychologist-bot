require('dotenv').config();
const { PsychBot } = require('./bot-core');

const bot = new PsychBot({
    roleName: 'Семейный Психолог',
    roleDescription: 'Специалист по эмоциональной близости, разрешению конфликтов и ненасильственному общению.',
    telegramToken: process.env.PSYCHOLOGIST_TOKEN,
    botUsername: process.env.PSYCHOLOGIST_USERNAME,
    howItWorksText: '• Помогаю услышать друг друга\n• Не принимаю ничью сторону\n• Предлагаю техники ННО\n• Не заменяю клинического психолога',
    openWebUI: {
        baseUrl: process.env.OPENWEBUI_BASE_URL || 'http://localhost:8080',
        apiKey: process.env.OPENWEBUI_API_KEY,
        modelId: process.env.PSYCHOLOGIST_MODEL_ID || process.env.OPENWEBUI_MODEL_ID,
    },
    maxHistory: parseInt(process.env.MAX_HISTORY_MESSAGES || '20', 10),
    respondToAllInGroup: process.env.PSYCHOLOGIST_RESPOND_ALL === 'true',
    allowedUserIds: process.env.PSYCHOLOGIST_ALLOWED_USERS
        ? process.env.PSYCHOLOGIST_ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean)
        : [],
    adminCommand: 'psy',
});

bot.launch().catch(console.error);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));