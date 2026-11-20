FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5055

ENV PORT=5055
ENV NODE_ENV=production

CMD ["node", "server.js"]
