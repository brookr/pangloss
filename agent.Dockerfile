FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install global Node packages
RUN npm install -g \
    typescript \
    eslint \
    prettier \
    @anthropic-ai/claude-code \
    @openai/codex

# Create app directory
WORKDIR /app

# Copy agent runner and package files
COPY agent-runner.js /app/
COPY package*.json /app/

# Install dependencies
RUN npm install --production

# Create directories
RUN mkdir -p /results /workspace

# Create non-root user
# Playwright needs access to specific groups for browser usage
RUN groupadd -r agent && useradd -r -g agent -G audio,video agent \
    && mkdir -p /home/agent && chown -R agent:agent /home/agent \
    && chown -R agent:agent /app /results /workspace

USER agent

CMD ["node", "agent-runner.js"]
