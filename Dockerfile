FROM node:22-slim
WORKDIR /app

COPY package.json yarn.lock ./
COPY route-calculator/package.json route-calculator/

RUN yarn install --frozen-lockfile

COPY tsconfig.base.json ./
COPY route-calculator/tsconfig.json route-calculator/tsconfig.build.json route-calculator/
COPY route-calculator/src route-calculator/src

RUN yarn build:api

ENV DATA_ROOT=/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "route-calculator/dist/lib/server/index.js"]
