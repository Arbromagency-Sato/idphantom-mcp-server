FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

RUN npm install --ignore-scripts && npm run build && npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "dist/src/index.js"]
