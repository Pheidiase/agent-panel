import http from "node:http";
import { Duplex } from "node:stream";

// Exercise Node's HTTP parser and Express without a listening port.
export function requestApp(app, { method = "GET", path = "/", headers = {}, body = "", chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app), output = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } });
    socket.remoteAddress = "127.0.0.1";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("In-memory HTTP timeout")); }, 10000);
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.on("finish", () => {
      clearTimeout(timer); socket.destroy(); server.close();
      const raw = Buffer.concat(output).toString("utf8"), split = raw.indexOf("\r\n\r\n");
      const lines = raw.slice(0, split).split("\r\n"), status = Number(lines.shift()?.split(" ")[1]);
      const responseHeaders = {};
      for (const line of lines) { const i = line.indexOf(":"); responseHeaders[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
      let responseBody = raw.slice(split + 4);
      if (responseHeaders["transfer-encoding"] === "chunked") {
        let decoded = "";
        while (responseBody) {
          const end = responseBody.indexOf("\r\n"), size = parseInt(responseBody.slice(0, end), 16);
          if (!size) break;
          decoded += responseBody.slice(end + 2, end + 2 + size); responseBody = responseBody.slice(end + 4 + size);
        }
        responseBody = decoded;
      }
      resolve({ status, headers: responseHeaders, body: responseBody, json: () => JSON.parse(responseBody) });
    });
    server.emit("connection", socket);
    const payload = Buffer.from(body);
    const requestHeaders = { Host: "127.0.0.1:4317", Connection: "close", ...headers,
      ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": payload.length }) };
    socket.push(Buffer.from(`${method} ${path} HTTP/1.1\r\n${Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`));
    if (chunked) {
      if (payload.length) socket.push(Buffer.concat([Buffer.from(payload.length.toString(16) + "\r\n"), payload, Buffer.from("\r\n")]));
      socket.push(Buffer.from("0\r\n\r\n"));
    } else if (payload.length) socket.push(payload);
  });
}
