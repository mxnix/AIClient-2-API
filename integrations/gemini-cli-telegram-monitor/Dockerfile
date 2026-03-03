FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY integrations/gemini-cli-telegram-monitor ./integrations/gemini-cli-telegram-monitor

CMD ["node", "integrations/gemini-cli-telegram-monitor/index.js"]
