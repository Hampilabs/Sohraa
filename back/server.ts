// server.ts
import Fastify from 'fastify';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
dotenv.config();

const fastify = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function datesOverlap(startA: string, endA: string, startB: string, endB: string) {
  // strings like '2025-09-24' -> compare lexicographically works for ISO date format
  return (startA < endB) && (endA > startB);
}

/**
 * GET /rooms
 * list rooms for a property
 */
fastify.get('/properties/:propertyId/rooms', async (req, reply) => {
  const { propertyId } = (req.params as any);
  const { rows } = await pool.query('SELECT * FROM rooms WHERE property_id = $1', [propertyId]);
  return rows;
});

/**
 * GET /availability?propertyId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * returns available rooms (not booked) for the range
 */
fastify.get('/availability', async (req, reply) => {
  const q = req.query as any;
  const { propertyId, from, to } = q;
  if (!propertyId || !from || !to) {
    return reply.status(400).send({ error: 'propertyId, from, to required' });
  }

  // 1) get all rooms for property
  const roomsRes = await pool.query('SELECT id, room_number, room_type FROM rooms WHERE property_id = $1', [propertyId]);
  const rooms = roomsRes.rows;

  // 2) find rooms that have conflicting confirmed/hold bookings overlapping the requested window
  const bookingsRes = await pool.query(
    `SELECT room_id, start_date, end_date, status FROM bookings
     WHERE property_id = $1
       AND NOT (end_date <= $2 OR start_date >= $3)
       AND status IN ('confirmed','hold')`,
    [propertyId, from, to]
  );
  const blockedByRoom: Record<string, boolean> = {};
  for (const b of bookingsRes.rows) {
    blockedByRoom[b.room_id] = true;
  }

  const available = rooms.filter(r => !blockedByRoom[r.id]);
  return { from, to, available };
});

/**
 * POST /bookings
 * Body: { property_id, room_id, customer: {first_name,...} , start_date, end_date, hold:boolean }
 * Booking flow:
 *  - start tx
 *  - take advisory lock on room (pg_advisory_xact_lock)
 *  - check overlap with existing bookings (for confirmed/hold)
 *  - if free -> insert customer (if needed) and booking (status = hold or confirmed)
 *  - commit
 */
fastify.post('/bookings', async (req, reply) => {
  const body = req.body as any;
  const { property_id, room_id, customer, start_date, end_date, hold } = body;

  if (!property_id || !room_id || !start_date || !end_date || !customer) {
    return reply.status(400).send({ error: 'missing fields' });
  }
  if (!(start_date < end_date)) {
    return reply.status(400).send({ error: 'start_date must be before end_date' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Use an advisory lock per room to serialize booking creation for the room.
    // Convert UUID to a 64-bit key: simple approach: take hash or use pg functions.
    // For simplicity here we use pg_advisory_xact_lock(hashtext(room_id)::bigint).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [room_id]);

    // Check overlap
    const conflictRes = await client.query(
      `SELECT id, status FROM bookings
       WHERE room_id = $1
         AND NOT (end_date <= $2 OR start_date >= $3)
         AND status IN ('confirmed','hold') FOR UPDATE`,
      [room_id, start_date, end_date]
    );
    if (conflictRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return reply.status(409).send({ error: 'room not available for given dates' });
    }

    // Upsert (or create) customer
    let customerId = customer.id;
    if (!customerId) {
      const insertCust = await client.query(
        `INSERT INTO customers (id, first_name, last_name, email, phone, metadata)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uuidv4(), customer.first_name, customer.last_name, customer.email, customer.phone, customer.metadata || {}]
      );
      customerId = insertCust.rows[0].id;
    }

    const bookingId = uuidv4();
    const status = hold ? 'hold' : 'confirmed';

    await client.query(
      `INSERT INTO bookings (id, property_id, room_id, customer_id, status, start_date, end_date, total_amount, currency, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now())`,
      [bookingId, property_id, room_id, customerId, status, start_date, end_date, body.total_amount || null, body.currency || 'USD']
    );

    await client.query('COMMIT');
    return reply.status(201).send({ booking_id: bookingId, status });
  } catch (err) {
    await client.query('ROLLBACK');
    fastify.log.error(err);
    return reply.status(500).send({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
    console.log('listening');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
