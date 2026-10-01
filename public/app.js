const clientId = crypto.randomUUID();
const editor = document.querySelector('#editor');
const highlighter = document.querySelector('#highlighter');
const colorInput = document.querySelector('#color');
const roomInput = document.querySelector('#room');
const params = new URLSearchParams(location.search);
let room = (params.get('room') || 'presentation').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'presentation';
roomInput.value = room;
let socket, documentText = '', marks = [], serverRevision = 0, pending = [], applying = false, operationNumber = 0;
const $ = (selector) => document.querySelector(selector);
colorInput.value = localStorage.getItem('ot-editor-color') || colorInput.value;

function noop(op) { return !op || (op.type === 'delete' && op.length <= 0) || (op.type === 'insert' && !op.text); }
function apply(text, op) { if (noop(op)) return text; return op.type === 'insert' ? text.slice(0, op.position) + op.text + text.slice(op.position) : text.slice(0, op.position) + text.slice(op.position + op.length); }
function applyMarks(target, op) { const position = Math.max(0, Math.min(target.length, op.position)); if (op.type === 'insert') target.splice(position, 0, ...Array.from({ length: op.text.length }, () => op.color || '#dbe7ef')); if (op.type === 'delete') target.splice(position, Math.max(0, op.length)); }
function transform(a, b) {
  if (noop(a) || noop(b)) return { ...a }; const out = { ...a };
  if (a.type === 'insert' && b.type === 'insert') { if (b.position < a.position || (b.position === a.position && String(b.id) < String(a.id))) out.position += b.text.length; }
  else if (a.type === 'insert' && b.type === 'delete') { const end = b.position + b.length; if (a.position > end) out.position -= b.length; else if (a.position > b.position) out.position = b.position; }
  else if (a.type === 'delete' && b.type === 'insert') { if (b.position <= a.position) out.position += b.text.length; else if (b.position < a.position + a.length) out.length += b.text.length; }
  else if (a.type === 'delete' && b.type === 'delete') { const end = a.position + a.length, bEnd = b.position + b.length; const overlap = Math.max(0, Math.min(end, bEnd) - Math.max(a.position, b.position)); if (a.position >= bEnd) out.position -= b.length; else if (a.position > b.position) out.position = b.position; out.length -= overlap; }
  return out;
}
function transformIndex(index, op) { if (noop(op)) return index; if (op.type === 'insert') return op.position <= index ? index + op.text.length : index; return index <= op.position ? index : Math.max(op.position, index - op.length); }
function paint() { highlighter.replaceChildren(); let start = 0; while (start < documentText.length) { const color = marks[start] || '#dbe7ef'; let end = start + 1; while (end < documentText.length && (marks[end] || '#dbe7ef') === color) end++; const mark = document.createElement('span'); mark.className = 'author-mark'; mark.style.setProperty('--mark', color); mark.textContent = documentText.slice(start, end); highlighter.append(mark); start = end; } if (documentText.endsWith('\n')) highlighter.append(document.createElement('br')); highlighter.scrollTop = editor.scrollTop; highlighter.scrollLeft = editor.scrollLeft; }
function render(value, selectionStart = editor.selectionStart, selectionEnd = editor.selectionEnd) { applying = true; editor.value = value; paint(); editor.setSelectionRange(Math.min(selectionStart, value.length), Math.min(selectionEnd, value.length)); applying = false; $('#characters').textContent = `${value.length}자`; }
function timeOf(value = new Date()) { return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)); }
function operationLabel(op) { return op.type === 'insert' ? `삽입 “${op.text.replace(/\n/g, '↵').slice(0, 20)}” @ ${op.position}` : `삭제 ${op.length}자 @ ${op.position}`; }
function log(op, kind, timestamp) { const list = $('#log'); list.querySelector('.empty')?.remove(); const item = document.createElement('li'); item.style.gridTemplateColumns = '70px 10px 1fr'; item.innerHTML = `<time>${timeOf(timestamp)}</time><i class="log-swatch" style="--editor-color:${op.color || '#9aabb5'}"></i><span>${kind} · ${operationLabel(op)}</span>`; list.prepend(item); while (list.children.length > 16) list.lastElementChild.remove(); }
function updateStatus() { $('#revision').textContent = serverRevision; $('#pending').textContent = pending.length; }
function sendNext() { if (socket?.readyState !== WebSocket.OPEN || !pending.length || pending[0].sent) return; pending[0].sent = true; socket.send(JSON.stringify({ type: 'operation', clientId, baseRevision: serverRevision, operation: pending[0] })); updateStatus(); }
function queue(op) { if (noop(op)) return; pending.push(op); documentText = apply(documentText, op); applyMarks(marks, op); render(documentText); sendNext(); updateStatus(); }
function deriveOperations(before, after) { let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++; let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++; const removed = before.length - prefix - suffix, added = after.slice(prefix, after.length - suffix); const operations = []; if (removed) operations.push({ type: 'delete', position: prefix, length: removed, color: colorInput.value, id: `${clientId}:${++operationNumber}` }); if (added) operations.push({ type: 'insert', position: prefix, text: added, color: colorInput.value, id: `${clientId}:${++operationNumber}` }); return operations; }
editor.addEventListener('input', () => { if (applying) return; const next = editor.value; const ops = deriveOperations(documentText, next); if (!ops.length) return; for (const op of ops) queue(op); });
function receiveOperation(operation, author, revision, timestamp) {
  serverRevision = revision;
  if (author === clientId) { const mine = pending.shift(); if (!mine) return; // server sends operations in authoritative order; local view already contains it
    log(operation, '내 수정', timestamp); sendNext(); updateStatus(); return; }
  let visibleRemote = operation;
  pending = pending.map((local) => { const nextRemote = transform(visibleRemote, local); const nextLocal = transform(local, visibleRemote); visibleRemote = nextRemote; return nextLocal; });
  const start = transformIndex(editor.selectionStart, visibleRemote), end = transformIndex(editor.selectionEnd, visibleRemote);
  documentText = apply(documentText, visibleRemote); applyMarks(marks, visibleRemote); render(documentText, start, end); log(operation, '다른 사람', timestamp); updateStatus();
}
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener('open', () => { $('#connection').textContent = '연결됨'; socket.send(JSON.stringify({ type: 'join', room })); sendNext(); });
  socket.addEventListener('close', () => { $('#connection').textContent = '재연결 중'; setTimeout(connect, 1200); });
  socket.addEventListener('message', ({ data }) => { const message = JSON.parse(data); if (message.type === 'snapshot') { documentText = message.document; marks = Array.isArray(message.marks) ? message.marks.slice(0, documentText.length) : []; serverRevision = message.revision; render(documentText); $('#peers').textContent = `${message.peers}명`; updateStatus(); } if (message.type === 'operation') receiveOperation(message.operation, message.author, message.revision, message.timestamp); if (message.type === 'presence') $('#peers').textContent = `${message.peers}명`; });
}
editor.addEventListener('scroll', () => { highlighter.scrollTop = editor.scrollTop; highlighter.scrollLeft = editor.scrollLeft; });
colorInput.addEventListener('input', () => localStorage.setItem('ot-editor-color', colorInput.value));
function tickClock() { $('#clock').textContent = timeOf(); }
tickClock(); setInterval(tickClock, 1000);
$('#copy').addEventListener('click', async () => { const next = roomInput.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'presentation'; location.href = `${location.pathname}?room=${encodeURIComponent(next)}`; });
$('#clear-log').addEventListener('click', () => { $('#log').innerHTML = '<li class="empty">첫 편집을 기다리고 있습니다.</li>'; });
connect();
