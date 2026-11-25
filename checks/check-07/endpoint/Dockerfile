FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
RUN apk add --no-cache iptables=1.8.13-r0 tcpdump=4.99.6-r1
COPY endpoint.mjs /app/endpoint.mjs
CMD ["node", "/app/endpoint.mjs"]
