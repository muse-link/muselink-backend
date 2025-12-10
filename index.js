// ================================
// Backend MuseLink - CommonJS
// Compatible con Render
// ================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET || "clave_secreta_cambiar";

// ================================
// PostgreSQL
// ================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================================
// Middleware
// ================================
app.use(cors());
app.use(express.json());

// ================================
// Test
// ================================
app.get("/", (req, res) => {
  res.send("MuseLink Backend OK 🚀");
});

// ================================
// Helper para roles
// ================================
async function getRoleId(role) {
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)",
    [role]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].id;
}

// ================================
// REGISTRO
// ================================
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    // Verificar duplicado
    const exists = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    const hash = await bcrypt.hash(password, 10);

    const resolvedRole = role || "cliente";
    let roleId = await getRoleId(resolvedRole);
    if (!roleId) roleId = 3; // cliente por defecto

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, email, rol_id`,
      [nombre, email, hash, roleId]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ user, token });

  } catch (err) {
    console.error("❌ Error en /auth/register:", err);
    res.status(500).json({ error: "Error registrando usuario" });
  }
});

// ================================
// LOGIN
// ================================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ error: "Credenciales inválidas" });

    const user = result.rows[0];

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ error: "Credenciales inválidas" });

    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    delete user.password;

    res.json({ user, token });

  } catch (err) {
    console.error("❌ Error en /auth/login:", err);
    res.status(500).json({ error: "Error iniciando sesión" });
  }
});

// ================================
// OBTENER SOLICITUDES (TODAS) - ARTISTA
// ================================
app.get("/solicitudes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM solicitudes ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes:", err);
    res.status(500).json({ error: "Error obteniendo solicitudes" });
  }
});

// ================================
// OBTENER SOLICITUDES POR CLIENTE
// ================================
app.get("/solicitudes/cliente/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM solicitudes WHERE cliente_id = $1 ORDER BY id DESC",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes por cliente:", err);
    res.status(500).json({ error: "Error obteniendo solicitudes" });
  }
});

// ================================
// CREAR SOLICITUD
// ================================
app.post("/solicitudes", async (req, res) => {
  try {
    const { cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas } = req.body;

    const result = await pool.query(
      `INSERT INTO solicitudes (cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error("❌ Error creando solicitud:", err);
    res.status(500).json({ error: "Error creando solicitud" });
  }
});

// ================================
// DESBLOQUEAR SOLICITUD
// ================================
app.post("/solicitudes/:id/unlock", async (req, res) => {
  try {
    const { artista_id } = req.body;
    const { id } = req.params;

    await pool.query(
      `INSERT INTO desbloqueos (solicitud_id, artista_id)
       VALUES ($1, $2)`,
      [id, artista_id]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("❌ Error desbloqueando solicitud:", err);
    res.status(500).json({ error: "Error desbloqueando solicitud" });
  }
});

// ================================
// SERVIDOR
// ================================
app.listen(port, () => {
  console.log(`🔥 MuseLink backend funcionando en http://localhost:${port}`);
});
