# Use official Node LTS image
FROM node:18-bullseye-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json if present
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY . ./

# Make sure the repos and node_modules directories are writable
RUN chmod -R a+rX /usr/src/app

# Default command is to run the CLI interactively
CMD ["node", "cli.js"]
