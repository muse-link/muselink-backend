// Cargar variables de entorno
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { GoogleGenAI } = require("@google/genai");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ----------------------------------------------------
// Configuración básica
// ----------------------------------------------------
const app = express();
const port = process.env.PORT || 10000;

// Clave JWT (idealmente en .env)
const JWT_SECRET =
  process.env.JWT_SECRET || "cambia_esta_clave_por_una_larga_y_secreta";

// Conexión a Postgres (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Cliente de Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Middlewares
app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// Health check
// ----------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "MuseLink backend funcionando ✅" });
});

// ----------------------------------------------------
// Helper: obtener rol_id desde tabla roles
// roles: 1 = admin, 2 = artista, 3 = cliente (según tu BD)
// ----------------------------------------------------
async function getRoleIdByName(roleName) {
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)",
    [roleName]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].id;
}

// ----------------------------------------------------
// 🔐 AUTH: REGISTRO
// body: { nombre, email, password, role }
// role: 'admin' | 'artista' | 'cliente' (por defecto cliente)
// ----------------------------------------------------
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email y password son obligatorios" });
    }

    // ¿Correo ya registrado?
    const existing = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    // Hash de password
    const hash = await bcrypt.hash(password, 10);

    // Resolver rol
    let desiredRole = role || "cliente"; // por defecto cliente
    if (desiredRole === "client") desiredRole = "cliente";
    if (desiredRole === "artist") desiredRole = "artista";

    let roleId = await getRoleIdByName(desiredRole);
    if (!roleId) {
      // si algo falla, fuerza cliente
      roleId = await getRoleIdByName("cliente");
      if (!roleId) roleId = 3; // fallback duro
    }

    // Insertar usuario
    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id, fecha_registro)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, nombre, email, rol_id`,
      [nombre, email, hash, roleId]
    );

    const user = result.rows[0];

    // Token
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

// ----------------------------------------------------
// 🔐 AUTH: LOGIN
// body: { email, password }
// ----------------------------------------------------
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

    delete user.password;

    res.json({ user, token });
  } catch (error) {
    console.error("❌ Error en /auth/login:", error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// ----------------------------------------------------
// 💳 Mercado Pago: crear preferencia simple
// body: { title, quantity, price }
// ----------------------------------------------------
app.post("/create_preference", async (req, res) => {
  try {
    const { title, quantity, price } = req.body;

    const body = {
      items: [
        {
          title: title || "Pack de créditos",
          quantity: Number(quantity) || 1,
          unit_price: Number(price),
          currency_id: "CLP",
        },
      ],
    };

    const preference = new Preference(mpClient);
    const result = await preference.create({ body });

    res.json({ id: result.id });
  } catch (error) {
    console.error("❌ Error creando preferencia en Mercado Pago:", error);
    res.status(500).json({ error: "Error al crear preferencia" });
  }
});

// ----------------------------------------------------
// 🤖 IA: /api/gemini
// body: { prompt }
// ----------------------------------------------------
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
    res.json({ text });
  } catch (error) {
    console.error("❌ Error en /api/gemini:", error);
    res.status(500).json({ error: "Error al generar respuesta con Gemini" });
  }
});

// ----------------------------------------------------
// 🎵 Crear solicitud (cliente)
// body: { cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas }
// ----------------------------------------------------
app.post("/solicitudes", async (req, res) => {
  try {
    const {
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas,
    } = req.body;

    if (!cliente_id || !titulo || !descripcion || !tipo_musica) {
      return res
        .status(400)
        .json({ error: "Faltan campos obligatorios en la solicitud" });
    }

    const result = await pool.query(
      `INSERT INTO solicitudes
       (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado, fecha_creacion)
       VALUES ($1, $2, $3, $4, NULL, $5, 'abierta', NOW())
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas || 1]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error creando solicitud:", error);
    res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// ----------------------------------------------------
// 🎵 Obtener todas las solicitudes (para artistas)
// GET /solicitudes
// ----------------------------------------------------
app.get("/solicitudes", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         id,
         cliente_id,
         titulo,
         descripcion,
         tipo_musica,
         cantidad_ofertas,
         fecha_evento,
         estado,
         fecha_creacion
       FROM solicitudes
       ORDER BY fecha_creacion DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error en GET /solicitudes:", error);
    res.status(500).json({ error: "Error al obtener solicitudes" });
  }
});

// ----------------------------------------------------
// 🔓 Desbloquear contacto de una solicitud
// POST /solicitudes/:id/unlock
// body: { artista_id }
// (por ahora: stub simple que siempre responde ok)
// ----------------------------------------------------
app.post("/solicitudes/:id/unlock", async (req, res) => {
  const solicitudId = parseInt(req.params.id, 10);
  const { artista_id } = req.body;

  if (!artista_id || !solicitudId) {
    return res
      .status(400)
      .json({ error: "Falta artista_id o id de solicitud" });
  }

  try {
    // Aquí podrías guardar un registro en una tabla
    // solicitudes_desbloqueos (solicitud_id, artista_id, fecha)
    // De momento solo devolvemos ok para que el frontend funcione.

    console.log(
      `✅ Desbloqueo de solicitud ${solicitudId} por artista ${artista_id}`
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("❌ Error en unlock:", error);
    res.status(500).json({ error: "Error al desbloquear solicitud" });
  }
});

// ----------------------------------------------------
// Levantar servidor
// ----------------------------------------------------
app.listen(port, () => {
  console.log(`🔥 MuseLink backend funcionando en http://localhost:${port}`);
});
