# Controller image. NOT BUILT OR RUN here (the Docker daemon was down); the entry point itself
# was smoke-tested directly with node. No secrets are baked in: mount PRINCIPALS_FILE and pass
# the DS_BOT_DB_*, R2_*, DAYTONA_* and OPENAI_* values as environment from a secret manager.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/serve.mjs"]
