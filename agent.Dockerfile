FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache \
    git \
    openssh-client \
    python3 \
    py3-pip \
    build-base

# Install global packages and CLI tools
RUN npm install -g \
    typescript \
    eslint \
    prettier

# Install LLM CLI tools
RUN npm install -g @openai/codex || echo "Warning: @openai/codex not available"
RUN npm install -g @anthropic-ai/claude-code || curl -o /usr/local/bin/claude https://github.com/anthropics/claude-cli/releases/latest/download/claude-linux && chmod +x /usr/local/bin/claude
RUN npm install -g @google/gemini-cli || echo "Warning: @google/gemini-cli not available"

# Create app directory
WORKDIR /app

# Copy agent runner
COPY agent-runner.js /app/
COPY package*.json /app/

# Install dependencies
RUN npm install --production

# Create results and workspace directories
RUN mkdir -p /results /workspace


# Create non-root user for security
RUN addgroup -g 1001 -S agent && \
    adduser -S agent -u 1001 -G agent

# Change ownership of app, results, and workspace directories
RUN chown -R agent:agent /app /results /workspace

USER agent

CMD ["node", "agent-runner.js"]