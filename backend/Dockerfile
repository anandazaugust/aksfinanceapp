# Use Node 18 base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first
COPY package*.json ./

# Install dependencies (production only)
# --legacy-peer-deps avoids npm conflicts in Docker
RUN npm install --production --legacy-peer-deps

# Copy the rest of the app
COPY . .

# Set environment variable for app
ENV PORT=3000

# Expose the port the app listens on
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
