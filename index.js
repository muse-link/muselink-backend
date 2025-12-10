// ===============================
//  MuseLink Backend - index.js
// ===============================

// Cargar variables de entorno
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
//  PostgreSQL Connection
// ===============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render necesita SSL
});

// ===============================
//  JWT SECRET
// ===============================
const JWT_SECRET = process.env.JWT_SECRET || "cambia_esta_clave_antes_de_producir";

// ===============================
//  Middlewares
// ===============================
app.use(cors());
app.use(express.json());

// ===============================
//  Health Check
// ===============================
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "MuseLink backend funcionando ✅" });
});

// ===============================
//  Roles Helper
// ===============================
async function getRoleIdByName(roleName) {
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)",
    [roleName]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

// ===============================
//  AUTH - REGISTRO
// ===============================
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email y password obligatorios" });
    }

    const existing = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    const hash = await bcrypt.hash(password, 10);

    // rol del backend: cliente / artista / admin
    const desiredRole = role || "cliente";
    let roleId = await getRoleIdByName(desiredRole);
    if (!roleId) roleId = 1; // default: cliente

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id, fecha_registro)
       VALUES ($1, $2, $3, $4, NOW())
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
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// ===============================
//  AUTH - LOGIN
// ===============================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT id, nombre, email, password, rol_id FROM usuarios WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password);

    if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

    delete user.password;

    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ user, token });
  } catch (err) {
    console.error("❌ Error en /auth/login:", err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// ===============================
//  CREAR SOLICITUD
// ===============================
app.post("/solicitudes", async (req, res) => {
  try {
    const {
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO solicitudes
      (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado, fecha_creacion)
      VALUES ($1, $2, $3, $4, NULL, $5, 'abierta', NOW())
      RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creando solicitud:", err);
    res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// ===============================
//  MERCADO PAGO
// ===============================
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

app.post("/create_preference", async (req, res) => {
  try {
    const { title, quantity, price } = req.body;

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            title: title || "Pack de créditos",
            quantity: quantity || 1,
            unit_price: Number(price),
            currency_id: "CLP",
          },
        ],
      },
    });

    res.json({ id: result.id });
  } catch (err) {
    console.error("❌ Error en Mercado Pago:", err);
    res.status(500).json({ error: "No se pudo crear preferencia" });
  }
});

// ===============================
//  GEMINI IA
// ===============================
app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt)
      return res.status(400).json({ error: "Falta el prompt en la petición" });

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    res.json({ text: result.text });
  } catch (err) {
    console.error("❌ Error en Gemini:", err);
    res.status(500).json({ error: "Error al generar respuesta IA" });
  }
});

// ===============================
//  LEVANTAR SERVIDOR
// ===============================
app.listen(PORT, () => {
  console.log(`🔥 MuseLink backend funcionando en http://localhost:${PORT}`);
});
