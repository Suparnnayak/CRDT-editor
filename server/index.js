const http = require('http');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const PORT = 3001;
const CLIENT_ORIGIN = 'http://localhost:5173';
const MONGO_URI = 'mongodb://127.0.0.1:27017/crdt_editor';
const GLOBAL_DOC_ID = 'global';

const characterSchema = new mongoose.Schema(
  {
    value: { type: String, required: true },
    position: { type: [Number], required: true },
    lamport_clock: { type: Number, required: true },
    client_id: { type: String, required: true },
    is_deleted: { type: Boolean, default: false },
  },
  { _id: false }
);

const DocumentSchema = new mongoose.Schema({
  docId: { type: String, default: GLOBAL_DOC_ID, unique: true, index: true },
  characters: { type: [characterSchema], default: [] },
  updated_at: { type: Date, default: Date.now },
});

const DocumentModel = mongoose.model('Document', DocumentSchema);

mongoose
  .connect(MONGO_URI)
  .then(() => console.log(`Mongo connected: ${MONGO_URI}`))
  .catch((err) =>
    console.error(`Mongo connection failed (${MONGO_URI}):`, err.message)
  );

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '20mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'crdt-relay',
    clients: io.engine.clientsCount,
    mongo: mongoose.connection.readyState,
  });
});

app.get('/api/document', async (_req, res) => {
  try {
    let doc = await DocumentModel.findOne({ docId: GLOBAL_DOC_ID });
    if (!doc) {
      doc = await DocumentModel.create({
        docId: GLOBAL_DOC_ID,
        characters: [],
      });
    }
    res.json({ characters: doc.characters });
  } catch (err) {
    console.error('GET /api/document failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/document/save', async (req, res) => {
  const { characters } = req.body || {};
  if (!Array.isArray(characters)) {
    return res
      .status(400)
      .json({ error: '`characters` must be an array of CRDT_Character' });
  }
  try {
    const doc = await DocumentModel.findOneAndUpdate(
      { docId: GLOBAL_DOC_ID },
      { docId: GLOBAL_DOC_ID, characters, updated_at: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, count: doc.characters.length });
  } catch (err) {
    console.error('POST /api/document/save failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`[+] connected: ${socket.id} (total: ${io.engine.clientsCount})`);

  socket.on('crdt_operation', (payload) => {
    socket.broadcast.emit('crdt_operation', payload);
  });

  socket.on('crdt_delete', (payload) => {
    socket.broadcast.emit('crdt_delete', payload);
  });

  socket.on('disconnect', (reason) => {
    console.log(
      `[-] disconnected: ${socket.id} (${reason}) (total: ${io.engine.clientsCount})`
    );
  });
});

httpServer.listen(PORT, () => {
  console.log(`CRDT relay listening on http://localhost:${PORT}`);
  console.log(`Accepting CORS from ${CLIENT_ORIGIN}`);
});
