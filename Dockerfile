FROM node:18.20.5-alpine3.21

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY server.js ./

EXPOSE 8080

CMD [ "node", "server.js" ]

#  docker buildx build -t diltdicker/redot-signalling-server:latest