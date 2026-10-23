FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY crm-mock ./crm-mock
COPY middleware ./middleware
COPY scripts ./scripts
COPY samples ./samples
ENV NODE_ENV=production
# No npm install needed: the project only uses Node's built in modules.
CMD ["node", "middleware/server.js"]
