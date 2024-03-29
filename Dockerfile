FROM node:18.14.0

WORKDIR /app
COPY . .
RUN yarn install

EXPOSE 3010

CMD ["yarn", "start:prod"]