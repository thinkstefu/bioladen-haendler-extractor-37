FROM apify/actor-node-playwright:20

WORKDIR /usr/src/app

# Ensure correct permissions for non-root user (myuser) used by Apify base images
USER root
RUN chown -R myuser:myuser /usr/src/app

# Install dependencies as myuser
USER myuser
COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source
COPY --chown=myuser:myuser . ./

# Browsers are preinstalled in the Playwright base image
CMD ["node", "src/main.js"]
