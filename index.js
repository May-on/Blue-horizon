// index.js (backend) - rooms version
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ============================================
// GET /rooms - Entire 3BHK and the three rooms, each with its bookings
// ============================================
app.get('/rooms', async (req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: {
        booking: { orderBy: { check_in: 'asc' }, include: { guest: true } },
      },
    });
    res.json(rooms);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load rooms', details: error.message });
  }
});

// ============================================
// GET /bookings - every booking with its room and guest
// ============================================
app.get('/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      orderBy: { check_in: 'asc' },
      include: { guest: true, room: true },
    });
    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load bookings', details: error.message });
  }
});

// ============================================
// GET /property/:id - the property, its rooms, and a flat "booking" list
// (the flat list keeps the first React page working)
// ============================================
app.get('/property/:id', async (req, res) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id },
      include: {
        room: {
          orderBy: { name: 'asc' },
          include: {
            booking: { orderBy: { check_in: 'asc' }, include: { guest: true } },
          },
        },
      },
    });

    if (!property) return res.status(404).json({ error: 'Property not found' });

    const booking = property.room
      .flatMap((r) => r.booking.map((b) => ({ ...b, room_name: r.name })))
      .sort((a, b) => a.check_in - b.check_in);

    res.json({ ...property, booking });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong', details: error.message });
  }
});

// ============================================
// POST /bookings
// Body: { room_id, guest_name, guest_email, check_in, check_out, source }
// Dates as YYYY-MM-DD. Check-out day is free for the next guest.
// ============================================
app.post('/bookings', async (req, res) => {
  try {
    const { room_id, guest_name, guest_email, check_in, check_out, source } = req.body;

    if (!room_id || !guest_name || !check_in || !check_out) {
      return res.status(400).json({ error: 'Room, guest name, check-in and check-out are required.' });
    }
    if (!DATE_RE.test(check_in) || !DATE_RE.test(check_out)) {
      return res.status(400).json({ error: 'Dates must look like 2026-10-15.' });
    }
    if (check_out <= check_in) {
      return res.status(400).json({ error: 'Check-out must be after check-in.' });
    }

    const room = await prisma.room.findUnique({ where: { id: room_id } });
    if (!room) return res.status(404).json({ error: 'Room not found.' });

    // The 3-rooms-equals-one-3BHK rule lives in the database function.
    const rows = await prisma.$queryRaw`
      SELECT room_is_available(${room_id}::uuid, ${check_in}::date, ${check_out}::date) AS available
    `;
    if (!rows[0].available) {
      return res.status(409).json({ error: `${room.name} is not available for those dates.` });
    }

    const booking = await prisma.$transaction(async (tx) => {
      const guest = await tx.guest.create({
        data: { name: guest_name, email: guest_email || null },
      });
      return tx.booking.create({
        data: {
          room_id,
          guest_id: guest.id,
          check_in: new Date(check_in),
          check_out: new Date(check_out),
          source: source || 'direct',
        },
        include: { guest: true, room: true },
      });
    });

    res.status(201).json(booking);
  } catch (error) {
    console.error(error);
    if (String(error.message).includes('booking_no_same_room_overlap')) {
      return res.status(409).json({ error: 'Those dates overlap an existing booking for this room.' });
    }
    res.status(500).json({ error: 'Could not create booking', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});