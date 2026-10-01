const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const publicDir = path.join(__dirname, "public");
const rooms = new Map();

// [OT-01] 방마다 확정 문서, 글자 색, 리비전, 변환에 사용할 연산 이력을 하나의 상태로 유지한다.
function roomFor(id) {
  if (!rooms.has(id))
    rooms.set(id, {
      document: "",
      marks: [],
      revision: 0,
      history: [],
      clients: new Set(),
    });
  return rooms.get(id);
}

function cleanRoomId(value) {
  return (
    String(value || "presentation")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 48) || "presentation"
  );
}

function isNoop(op) {
  return (
    !op ||
    (op.type === "delete" && op.length <= 0) ||
    (op.type === "insert" && !op.text)
  );
}

// [OT-02] 서버가 확정한 삽입 또는 삭제를 문서 문자열에 적용한다.
function apply(document, op) {
  if (isNoop(op)) return document;
  const position = Math.max(0, Math.min(document.length, op.position));
  if (op.type === "insert")
    return document.slice(0, position) + op.text + document.slice(position);
  return (
    document.slice(0, position) +
    document.slice(position + Math.max(0, op.length))
  );
}

function applyMarks(marks, op) {
  const position = Math.max(0, Math.min(marks.length, op.position));
  if (op.type === "insert")
    marks.splice(
      position,
      0,
      ...Array.from({ length: op.text.length }, () => op.color || "#dbe7ef"),
    );
  if (op.type === "delete") marks.splice(position, Math.max(0, op.length));
}

// [OT-03] a를 b가 적용된 문서에서도 실행할 수 있게 위치나 삭제 길이를 조정한다.
// 같은 위치 삽입은 변경되지 않는 연산 ID로 순서를 정하고, 겹치는 삭제·삽입은 도착 순서의 영향을 받는다.
function transform(a, b) {
  if (isNoop(a) || isNoop(b)) return { ...a };
  const out = { ...a };
  if (a.type === "insert" && b.type === "insert") {
    if (
      b.position < a.position ||
      (b.position === a.position && String(b.id) < String(a.id))
    )
      out.position += b.text.length;
  } else if (a.type === "insert" && b.type === "delete") {
    const end = b.position + b.length;
    if (a.position > end) out.position -= b.length;
    else if (a.position > b.position) out.position = b.position;
  } else if (a.type === "delete" && b.type === "insert") {
    if (b.position <= a.position) out.position += b.text.length;
    else if (b.position < a.position + a.length) out.length += b.text.length;
  } else if (a.type === "delete" && b.type === "delete") {
    const start = a.position,
      end = a.position + a.length;
    const bEnd = b.position + b.length;
    const overlap = Math.max(
      0,
      Math.min(end, bEnd) - Math.max(start, b.position),
    );
    if (start >= bEnd) out.position -= b.length;
    else if (start > b.position) out.position = b.position;
    out.length -= overlap;
  }
  return out;
}

// [OT-09] 서버가 확정한 연산을 같은 방의 모든 연결에 같은 순서로 전달한다.
function broadcast(room, payload) {
  const body = JSON.stringify(payload);
  for (const client of room.clients)
    if (client.readyState === client.OPEN) client.send(body);
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.resolve(publicDir, `.${requested}`);
  if (
    !target.startsWith(publicDir) ||
    !fs.existsSync(target) ||
    fs.statSync(target).isDirectory()
  ) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(target)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  let activeRoom;
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    // [OT-04] 새 참여자에게 서버가 확정한 문서 스냅샷과 현재 리비전을 전달한다.
    if (message.type === "join") {
      const id = cleanRoomId(message.room);
      activeRoom = roomFor(id);
      activeRoom.clients.add(socket);
      socket.send(
        JSON.stringify({
          type: "snapshot",
          document: activeRoom.document,
          marks: activeRoom.marks,
          revision: activeRoom.revision,
          peers: activeRoom.clients.size,
        }),
      );
      broadcast(activeRoom, {
        type: "presence",
        peers: activeRoom.clients.size,
      });
      return;
    }
    if (message.type !== "operation" || !activeRoom || !message.operation)
      return;
    // [OT-05] 클라이언트가 본 baseRevision 이후의 이력을 모두 통과시켜 연산을 재기준화한 뒤 확정한다.
    let operation = message.operation;
    const fromRevision = Number(message.baseRevision);
    if (
      !Number.isInteger(fromRevision) ||
      fromRevision < 0 ||
      fromRevision > activeRoom.revision
    )
      return;
    for (const prior of activeRoom.history.slice(fromRevision))
      operation = transform(operation, prior);
    operation.position = Math.max(
      0,
      Math.min(activeRoom.document.length, Number(operation.position) || 0),
    );
    if (operation.type === "delete")
      operation.length = Math.min(
        Math.max(0, Number(operation.length) || 0),
        activeRoom.document.length - operation.position,
      );
    if (operation.type !== "insert" && operation.type !== "delete") return;
    activeRoom.document = apply(activeRoom.document, operation);
    applyMarks(activeRoom.marks, operation);
    activeRoom.history.push(operation);
    activeRoom.revision += 1;
    broadcast(activeRoom, {
      type: "operation",
      operation,
      revision: activeRoom.revision,
      author: message.clientId,
      timestamp: new Date().toISOString(),
    });
  });
  socket.on("close", () => {
    if (!activeRoom) return;
    activeRoom.clients.delete(socket);
    broadcast(activeRoom, { type: "presence", peers: activeRoom.clients.size });
    if (!activeRoom.clients.size && activeRoom.history.length > 10000)
      rooms.delete(
        [...rooms.entries()].find(([, room]) => room === activeRoom)?.[0],
      );
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () =>
  console.log(`OT demo listening on http://localhost:${port}`),
);
