// ========================================
// 🔥 MuseLink Backend - CommonJS + Express
// ========================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const MercadoPago = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ============================
//  DB Connection (Render PG)
// ============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============================
//  HEALTH CHECK
// ============================
app.get("/", (req, res) => {
  res.send("🔥 MuseLink Backend Activo");
});

// ============================
//  AUTH REGISTER
// ============================
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    const exists = await pool.query("SELECT id FROM usuarios WHERE email = $1", [email]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    const hash = await bcrypt.hash(password, 10);

    // rol_id: 1 = admin, 2 = artista, 3 = cliente
    let rol_id = 3;
    if (role === "artista") rol_id = 2;
    if (role === "admin") rol_id = 1;

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id)
       VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, rol_id`,
      [nombre, email, hash, rol_id]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("❌ Error REGISTER:", err);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// ============================
//  AUTH LOGIN
// ============================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const query = await pool.query(
      "SELECT id, nombre, email, password, rol_id FROM usuarios WHERE email = $1",
      [email]
    );

    if (query.rows.length === 0) return res.status(401).json({ error: "No existe usuario" });

    const user = query.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });

    delete user.password;

    res.json({ user });
  } catch (err) {
    console.error("❌ Error LOGIN:", err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// ============================
//  CREAR SOLICITUD
// ============================
app.post("/solicitudes", async (req, res) => {
  try {
    const { cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas } = req.body;

    const result = await pool.query(
      `INSERT INTO solicitudes 
       (cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creando solicitud:", err);
    res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// ============================
//  LISTAR TODAS LAS SOLICITUDES (cliente)
// ============================
app.get("/solicitudes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM solicitudes ORDER BY fecha_creacion DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes:", err);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// ================================================================
// 🔥 LISTAR SOLICITUDES ESPECÍFICAS PARA ARTISTA (incluye contacto)
// ================================================================
app.get("/solicitudes/artista/:id", async (req, res) => {
  const artistaId = parseInt(req.params.id, 10);

  try {
    const result = await pool.query(
      `
      SELECT 
        s.*,
        COUNT(d.id) AS desbloqueos,
        (MAX(CASE WHEN d.artista_id = $1 THEN 1 ELSE 0 END) = 1) AS desbloqueada,
        u.email AS contact_email,
        c.telefono AS contact_phone
      FROM solicitudes s
      JOIN usuarios u ON u.id = s.cliente_id
      LEFT JOIN clientes c ON c.id = s.cliente_id
      LEFT JOIN desbloqueos d ON d.solicitud_id = s.id
      GROUP BY s.id, u.email, c.telefono
      ORDER BY s.fecha_creacion DESC
      `,
      [artistaId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error solicitudes artista:", err);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// ============================
//  DESBLOQUEAR CONTACTO
// ============================
app.post("/solicitudes/desbloquear", async (req, res) => {
  try {
    const { artista_id, solicitud_id } = req.body;

    const already = await pool.query(
      "SELECT id FROM desbloqueos WHERE artista_id = $1 AND solicitud_id = $2",
      [artista_id, solicitud_id]
    );

    if (already.rows.length > 0)
      return res.status(400).json({ error: "Ya la desbloqueaste" });

    await pool.query(
      `INSERT INTO desbloqueos (solicitud_id, artista_id)
       VALUES ($1, $2)`,
      [solicitud_id, artista_id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error desbloqueando:", err);
    res.status(500).json({ error: "No se pudo desbloquear" });
  }
});

// ============================
//  SERVER LISTEN
// ============================
app.listen(PORT, () => {
  console.log(`🔥 MuseLink backend escuchando en http://localhost:${PORT}`);
});
