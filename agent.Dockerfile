FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache \
    git \
    openssh-client \
    python3 \
    py3-pip \
    build-base \
    chromium \
    chromium-chromedriver

# Install global packages and CLI tools
RUN npm install -g \
    typescript \
    @playwright/test \
    eslint \
    prettier

# Install LLM CLI tools
RUN npm install -g @openai/codex || echo "Warning: @openai/codex not available"
RUN npm install -g @anthropic-ai/claude-code || curl -o /usr/local/bin/claude https://github.com/anthropics/claude-cli/releases/latest/download/claude-linux && chmod +x /usr/local/bin/claude
RUN npm install -g @google/gemini-cli || echo "Warning: @google/gemini-cli not available"

# Set up Playwright
RUN npx playwright install-deps

# Create app directory
WORKDIR /app

# Copy agent runner
COPY agent-runner.js /app/
COPY package*.json /app/

# Install dependencies
RUN npm install --production

# Create results directory
RUN mkdir -p /results

# Set environment variables for Chromium
ENV CHROME_BIN=/usr/bin/chromium-browser
ENV CHROME_PATH=/usr/bin/chromium-browser

# Create non-root user for security
RUN addgroup -g 1001 -S agent && \
    adduser -S agent -u 1001 -G agent

# Change ownership of app directory
RUN chown -R agent:agent /app /results

USER agent

CMD ["node", "agent-runner.js"]