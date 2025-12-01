FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git \
       ca-certificates \
       python3 \
       build-essential \
  && rm -rf /var/lib/apt/lists/*

# You can keep this minimal package.json if you want,
# but it's no longer needed to fix the warning
RUN printf '{\n  "name": "depcheck-runner",\n  "version": "1.0.0",\n  "license": "MIT"\n}\n' > package.json

RUN npm install depcheck --omit=dev

COPY depcheck-runner.mjs /app/depcheck-runner.mjs

ENTRYPOINT ["node", "/app/depcheck-runner.mjs"]
