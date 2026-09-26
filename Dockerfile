FROM node:20-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости отдельно для кэширования слоев
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# По умолчанию запускаем psychologist, но будем переопределять в compose
CMD ["node", "psychologist.js"]