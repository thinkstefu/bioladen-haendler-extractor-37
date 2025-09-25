FROM apify/actor-node-playwright:20
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Ensure browsers matching the installed Playwright version are present
RUN npx playwright install --with-deps
COPY . ./
CMD ["node", "src/main.js"]
