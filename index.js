// Cargar variables de entorno desde .env
require('dotenv').config();

const { Pool } = require("pg");
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const { GoogleGenAI } = require("@google/genai");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 3000;

// 🔐 Clave para firmar tokens (ideal moverla a env)
const JWT_SECRET = process.env.JWT_SECRET || "cambia_esta_clave_por_una_larga_y_secreta";

// Conexión a Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // En Render debe existir
  ssl: { rejectUnauthorized: false }
});

// Cliente de Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Middlewares
app.use(cors());
app.use(express.json());

// Endpoint simple
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'MuseLink backend funcionando ✅' });
});

// =====================================================
// 🔐 AUTH: REGISTRO Y LOGIN CON PERFILES (cliente / artista / admin)
// =====================================================

// Helper: obtener rol_id desde tabla roles según nombre rol
async function getRoleIdByName(roleName) {
  // roleName esperado: 'cliente' | 'artista' | 'admin'
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)",
    [roleName]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0].id;
}

// POST /auth/register
// body: { nombre, email, password, role }
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email y password son obligatorios" });
    }

    // 1. Ver si el correo ya existe
    const existing = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    // 2. Hashear password
    const hash = await bcrypt.hash(password, 10);

    // 3. Resolver rol (cliente / artista / admin)
    const desiredRole = role || "cliente"; // por defecto cliente
    let roleId = await getRoleIdByName(desiredRole);
    if (!roleId) {
      // Si no existe ese rol en la tabla, fuerza rol_id = 1
      roleId = 1;
    }

    // 4. Insertar usuario
    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id, fecha_registro)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, nombre, email, rol_id`,
      [nombre, email, hash, roleId]
    );

    const user = result.rows[0];

    // 5. Crear token
    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ user, token });
  } catch (error) {
    console.error("❌ Error en /auth/register:", error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// POST /auth/login
// body: { email, password }
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
    if (!ok) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // no mandamos el hash al frontend
    delete user.password;

    res.json({ user, token });
  } catch (error) {
    console.error("❌ Error en /auth/login:", error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// =====================================================
// 💳 Crear preferencia de Mercado Pago
// =====================================================
app.post('/create_preference', async (req, res) => {
  try {
    const { title, quantity, price } = req.body;

    const body = {
      items: [
        {
          title: title || 'Pack de créditos',
          quantity: Number(quantity) || 1,
          unit_price: Number(price),
          currency_id: 'CLP',
        },
      ],
    };

    const preference = new Preference(client);
    const result = await preference.create({ body });

    res.json({ id: result.id });
  } catch (error) {
    console.error('❌ Error creando preferencia en Mercado Pago:', error);
    res.status(500).json({ error: 'Error al crear preferencia' });
  }
});

// =====================================================
// 🤖 RUTA /api/gemini usando el cliente Google GenAI
// =====================================================
app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Falta el prompt" });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    const text = result.text;

    return res.json({ text });
  } catch (error) {
    console.error("❌ Error en /api/gemini:", error);
    return res.status(500).json({ error: "Error al generar respuesta con Gemini" });
  }
});

// =====================================================
// 🎵 RUTA PARA CREAR SOLICITUDES (queda igual que ya la tenías)
// =====================================================
app.post("/solicitudes", async (req, res) => {
  try {
    const {
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas
    } = req.body;

    const result = await pool.query(
      `INSERT INTO solicitudes
       (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado)
       VALUES ($1, $2, $3, $4, NULL, $5, 'abierta')
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    return res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error creando solicitud:", error);
    return res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// Levantar servidor
app.listen(port, () => {
  console.log(`Servidor MercadoPago escuchando en http://localhost:${port}`);
});

