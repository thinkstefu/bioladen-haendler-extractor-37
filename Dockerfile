FROM apify/actor-node-playwright:20

WORKDIR /usr/src/app

# Install deps as root to avoid EACCES, then install matching Playwright browsers
USER root
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
RUN npx playwright install --with-deps

# Copy source with correct ownership for runtime user
COPY --chown=myuser:myuser . ./

# Switch back to non-root user for execution
USER myuser

CMD ["node", "src/main.js"]
