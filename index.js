const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(cors());
app.use(express.json());

const rooms = {}; // in-memory for demo

app.get('/health', async (req, res) => {
  try {
    // A simple DB query
    const result = await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('DB Connection Error:', err);
    res
      .status(500)
      .json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// 1. Add debounce map
const saveTimeouts = {};

io.on('connection', (socket) => {
  socket.on('join', async (roomId) => {
    socket.join(roomId);

    if (rooms[roomId]) {
      socket.emit('load-canvas', rooms[roomId]);
      return;
    }

    try {
      const session = await prisma.session.findUnique({ where: { roomId } });
      if (session) {
        rooms[roomId] = session.data;
        socket.emit('load-canvas', session.data);
      }
    } catch (err) {
      console.error('DB error during join:', err);
    }
  });

  socket.on('draw', ({ roomId, ...data }) => {
    socket.to(roomId).emit('draw', data);

    // Update in-memory
    if (!rooms[roomId]) rooms[roomId] = [];
    rooms[roomId].push(data);

    // Debounce DB write per room
    if (saveTimeouts[roomId]) clearTimeout(saveTimeouts[roomId]);

    saveTimeouts[roomId] = setTimeout(async () => {
      try {
        await prisma.session.upsert({
          where: { roomId },
          update: { data: rooms[roomId] },
          create: {
            roomId,
            data: rooms[roomId],
          },
        });
      } catch (err) {
        console.error('DB save error in draw:', err);
      }
    }, 1000); // wait 1s before writing to DB
  });

  socket.on('save', async (roomId) => {
    try {
      await prisma.session.upsert({
        where: { roomId },
        update: { data: rooms[roomId] || [] },
        create: {
          roomId,
          data: rooms[roomId] || [],
        },
      });
    } catch (err) {
      console.error('DB error in save:', err);
    }
  });
});

app.get('/rooms/:id', async (req, res) => {
  const session = await prisma.session.findUnique({
    where: { roomId: req.params.id },
  });
  res.json(session?.data || []);
});

server.listen(5001, () =>
  console.log('Backend running on http://localhost:5001')
);

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
