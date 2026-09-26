require('dotenv').config();
const { PsychBot } = require('./bot-core');

const bot = new PsychBot({
    roleName: 'Семейный Сексолог',
    roleDescription: 'Специалист по интимной гармонии, сексуальной коммуникации и здоровым границам в паре.',
    telegramToken: process.env.SEXOLOGIST_TOKEN,
    botUsername: process.env.SEXOLOGIST_USERNAME,
    howItWorksText: '• Отвечаю на вопросы об интимности бережно\n• Помогаю обсуждать желания без стыда\n• Даю только образовательную информацию\n• Не назначаю терапию и препараты',
    openWebUI: {
        baseUrl: process.env.OPENWEBUI_BASE_URL || 'http://localhost:8080',
        apiKey: process.env.OPENWEBUI_API_KEY,
        modelId: process.env.SEXOLOGIST_MODEL_ID || process.env.OPENWEBUI_MODEL_ID,
    },
    maxHistory: parseInt(process.env.MAX_HISTORY_MESSAGES || '20', 10),
});

bot.launch().catch(console.error);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));