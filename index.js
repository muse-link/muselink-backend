// ===============================
//    MuseLink Backend (CJS)
// ===============================

// 1) Cargar variables de entorno
require("dotenv").config();

// 2) Imports
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Preference } = mercadopago;
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { GoogleGenAI } = require("@google/genai");

// 3) Config básica
const app = express();
const port = process.env.PORT || 10000;

const JWT_SECRET =
  process.env.JWT_SECRET || "cambia_esta_clave_por_una_larga_y_secreta";

// 4) Pool de conexión a Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 5) MercadoPago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// 6) Gemini
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// 7) Middlewares
app.use(cors());
app.use(express.json());

// 8) Healthcheck
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    message: "MuseLink backend funcionando ✅",
  });
});

// ===============================
//        HELPERS BD
// ===============================

// Obtener rol_id según nombre en tabla roles
async function getRoleIdByName(roleName) {
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)",
    [roleName]
  );
  return result.rows[0]?.id || null;
}

// ===============================
//          AUTH
// ===============================

// POST /auth/register
// body: { nombre, email, password, role, telefono? }
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role, telefono } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email y password son obligatorios" });
    }

    // 1. ¿Ya existe correo?
    const existing = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    // 2. Hash password
    const hash = await bcrypt.hash(password, 10);

    // 3. Resolver rol: 'cliente' | 'artista' | 'admin'
    const desiredRole = role || "cliente";
    let roleId = await getRoleIdByName(desiredRole);
    if (!roleId) {
      // por si roles no están bien cargados
      roleId = 1; // admin por defecto, o ajusta si quieres
    }

    // Créditos iniciales: artistas 3, resto 0
    const initialCredits = desiredRole === "artista" ? 3 : 0;

    // 4. Insertar usuario
    const userResult = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id, fecha_registro, credits)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       RETURNING id, nombre, email, rol_id, credits`,
      [nombre, email, hash, roleId, initialCredits]
    );
    const user = userResult.rows[0];

    // 5. Si es cliente, guardamos teléfono en tabla clientes
    if (desiredRole === "cliente" && telefono) {
      await pool.query(
        `INSERT INTO clientes (id, telefono, direccion)
         VALUES ($1, $2, '')
         ON CONFLICT (id) DO UPDATE SET telefono = EXCLUDED.telefono`,
        [user.id, telefono]
      );
    }

    // Si es artista podrías inicializar info en tabla artistas si quieres

    // 6. Token
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
      "SELECT id, nombre, email, password, rol_id, credits FROM usuarios WHERE email = $1",
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

// ===============================
//      SOLICITUDES CLIENTE
// ===============================

// POST /solicitudes
// body: { cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas }
app.post("/solicitudes", async (req, res) => {
  try {
    const {
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas,
      fecha_evento,
    } = req.body;

    if (!cliente_id || !titulo || !descripcion || !tipo_musica) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const result = await pool.query(
      `INSERT INTO solicitudes
       (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado, fecha_creacion)
       VALUES ($1, $2, $3, $4, $5, $6, 'abierta', NOW())
       RETURNING *`,
      [
        cliente_id,
        titulo,
        descripcion,
        tipo_musica,
        fecha_evento || null,
        cantidad_ofertas || 1,
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error creando solicitud:", error);
    res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// GET /solicitudes/cliente/:id
// Solicitudes de un cliente específico
app.get("/solicitudes/cliente/:id", async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const result = await pool.query(
      `SELECT *
       FROM solicitudes
       WHERE cliente_id = $1
       ORDER BY fecha_creacion DESC`,
      [clienteId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error obteniendo solicitudes de cliente:", error);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// ===============================
//      SOLICITUDES ARTISTA
// ===============================

// GET /solicitudes
// Lista general con conteo de desbloqueos
app.get("/solicitudes", async (_req, res) => {
  try {
    const query = `
      SELECT 
        s.*,
        COALESCE(d.cantidad_desbloqueos, 0) AS desbloqueos
      FROM solicitudes s
      LEFT JOIN (
        SELECT solicitud_id, COUNT(*) AS cantidad_desbloqueos
        FROM desbloqueos
        GROUP BY solicitud_id
      ) d ON d.solicitud_id = s.id
      WHERE s.estado = 'abierta'
      ORDER BY s.fecha_creacion DESC
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error obteniendo solicitudes:", error);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// POST /solicitudes/desbloquear
// body: { artista_id, solicitud_id }
app.post("/solicitudes/desbloquear", async (req, res) => {
  const client = await pool.connect();
  try {
    const { artista_id, solicitud_id } = req.body;

    const artistaId = parseInt(artista_id, 10);
    const solicitudId = parseInt(solicitud_id, 10);

    if (!artistaId || !solicitudId) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    await client.query("BEGIN");

    // 1. Solicitud
    const solRes = await client.query(
      "SELECT * FROM solicitudes WHERE id = $1 FOR UPDATE",
      [solicitudId]
    );
    if (solRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    const solicitud = solRes.rows[0];
    if (solicitud.estado !== "abierta") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La solicitud no está abierta" });
    }

    // 2. ¿Ya la desbloqueó este artista?
    const yaRes = await client.query(
      "SELECT 1 FROM desbloqueos WHERE solicitud_id = $1 AND artista_id = $2",
      [solicitudId, artistaId]
    );
    if (yaRes.rows.length > 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "Ya desbloqueaste esta solicitud" });
    }

    // 3. Conteo de desbloqueos
    const countRes = await client.query(
      "SELECT COUNT(*)::int AS c FROM desbloqueos WHERE solicitud_id = $1",
      [solicitudId]
    );
    const usados = countRes.rows[0].c;
    if (usados >= solicitud.cantidad_ofertas) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Se alcanzó el máximo de ofertas para esta solicitud",
      });
    }

    // 4. Créditos del artista
    const artistaRes = await client.query(
      "SELECT id, credits FROM usuarios WHERE id = $1 FOR UPDATE",
      [artistaId]
    );
    if (artistaRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Artista no encontrado" });
    }
    const artista = artistaRes.rows[0];
    if (artista.credits <= 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "No tienes créditos suficientes" });
    }

    // 5. Insertar desbloqueo y descontar 1 crédito
    await client.query(
      "INSERT INTO desbloqueos (solicitud_id, artista_id, fecha) VALUES ($1, $2, NOW())",
      [solicitudId, artistaId]
    );
    const newCredits = artista.credits - 1;
    await client.query("UPDATE usuarios SET credits = $1 WHERE id = $2", [
      newCredits,
      artistaId,
    ]);

    // 6. Cerrar solicitud si se llenó el cupo
    const newCountRes = await client.query(
      "SELECT COUNT(*)::int AS c FROM desbloqueos WHERE solicitud_id = $1",
      [solicitudId]
    );
    const nuevoUsados = newCountRes.rows[0].c;
    if (nuevoUsados >= solicitud.cantidad_ofertas) {
      await client.query(
        "UPDATE solicitudes SET estado = 'cerrada' WHERE id = $1",
        [solicitudId]
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      nuevosCreditos: newCredits,
      mensaje: "Desbloqueo exitoso",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en /solicitudes/desbloquear:", error);
    res.status(500).json({ error: "Error al desbloquear solicitud" });
  } finally {
    client.release();
  }
});

// ===============================
//     MERCADO PAGO / CRÉDITOS
// ===============================

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

// ===============================
//           GEMINI
// ===============================

app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Falta el prompt" });
    }

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    res.json({ text: result.text });
  } catch (error) {
    console.error("❌ Error en /api/gemini:", error);
    res.status(500).json({ error: "Error al generar respuesta con Gemini" });
  }
});

// ===============================
//      ARRANCAR SERVIDOR
// ===============================

app.listen(port, () => {
  console.log(`🔥 MuseLink backend funcionando en http://localhost:${port}`);
});
