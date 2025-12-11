// Cargar variables de entorno
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 10000;

// 🔐 Clave para JWT
const JWT_SECRET =
  process.env.JWT_SECRET || "cambia_esta_clave_por_una_larga_y_secreta";

// 🔗 Conexión a Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 💳 Cliente Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Middlewares
app.use(cors());
app.use(express.json());

// Ping simple
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "MuseLink backend funcionando ✅" });
});

// =====================================================
// 🔐 Helper: obtener rol_id desde tabla roles
// =====================================================
async function getRoleIdByName(roleName) {
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)",
    [roleName]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0].id;
}

// =====================================================
// 🔐 AUTH: REGISTRO
// =====================================================
// POST /auth/register
// body: { nombre, email, password, role }  // role: 'cliente' | 'artista' | 'admin'
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email y password son obligatorios" });
    }

    // Ver si el correo ya existe
    const existing = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "El correo ya está registrado" });
    }

    const hash = await bcrypt.hash(password, 10);

    const desiredRole = role || "cliente"; // por defecto cliente
    let roleId = await getRoleIdByName(desiredRole);
    if (!roleId) {
      // fallback: 3 = cliente (ajusta a tu tabla roles real)
      roleId = 3;
    }

    // Créditos iniciales según rol
    let initialCredits = 0;
    if (desiredRole === "artista") {
      initialCredits = 3; // por ejemplo 3 créditos de bienvenida
    }

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id, credits, fecha_registro)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, nombre, email, rol_id, credits`,
      [nombre, email, hash, roleId, initialCredits]
    );

    const user = result.rows[0];

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

// =====================================================
// 🔐 AUTH: LOGIN
// =====================================================
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

// =====================================================
// 💳 CREAR PREFERENCIA MERCADO PAGO
// =====================================================
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

// =====================================================
// 🤖 /api/gemini – STUB (por ahora sin IA real)
// =====================================================
// Esto es solo para que el botón "Mejorar con IA" no rompa nada.
// Devuelve el mismo texto que recibe.
app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Falta el prompt" });
    }

    // Por ahora, devolvemos el mismo texto (sin IA real)
    return res.json({ text: prompt });
  } catch (error) {
    console.error("❌ Error en /api/gemini:", error);
    return res
      .status(500)
      .json({ error: "Error al procesar la solicitud de IA" });
  }
});

// =====================================================
// 🎵 SOLICITUDES – CREAR
// =====================================================
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
    } = req.body;

    if (!cliente_id || !titulo || !descripcion || !tipo_musica) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const result = await pool.query(
      `INSERT INTO solicitudes
       (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado, fecha_creacion)
       VALUES ($1, $2, $3, $4, NULL, $5, 'abierta', NOW())
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas || 1]
    );

    return res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error creando solicitud:", error);
    return res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// =====================================================
// 🎵 SOLICITUDES – LISTAR GENERAL (incluye cantidad de desbloqueos)
// =====================================================
// GET /solicitudes
app.get("/solicitudes", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        s.*,
        COALESCE(COUNT(d.id), 0) AS desbloqueos
      FROM solicitudes s
      LEFT JOIN desbloqueos d ON d.solicitud_id = s.id
      GROUP BY s.id
      ORDER BY s.fecha_creacion DESC
    `
    );

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error obteniendo solicitudes:", error);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// =====================================================
// 🎵 SOLICITUDES PARA ARTISTA (con info de desbloqueo)
// =====================================================
// GET /solicitudes/artista/:id
app.get("/solicitudes/artista/:id", async (req, res) => {
  try {
    const artistaId = parseInt(req.params.id, 10);

    const result = await pool.query(
      `
      SELECT 
        s.*,
        COALESCE(COUNT(d.id), 0) AS desbloqueos,
        CASE 
          WHEN EXISTS (
            SELECT 1 
            FROM desbloqueos d2 
            WHERE d2.solicitud_id = s.id 
              AND d2.artista_id = $1
          ) 
          THEN TRUE ELSE FALSE 
        END AS desbloqueada,
        u.email AS contact_email,
        NULL::text AS contact_phone
      FROM solicitudes s
      LEFT JOIN desbloqueos d ON d.solicitud_id = s.id
      JOIN usuarios u ON u.id = s.cliente_id
      GROUP BY s.id, u.email
      ORDER BY s.fecha_creacion DESC
    `,
      [artistaId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error obteniendo solicitudes para artista:", error);
    res
      .status(500)
      .json({ error: "No se pudieron obtener solicitudes para el artista" });
  }
});

// =====================================================
// 🔓 DESBLOQUEAR SOLICITUD (consume 1 crédito)
// =====================================================
// POST /solicitudes/desbloquear
// body: { artista_id, solicitud_id }
app.post("/solicitudes/desbloquear", async (req, res) => {
  const client = await pool.connect();
  try {
    const { artista_id, solicitud_id } = req.body;

    if (!artista_id || !solicitud_id) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "Faltan artista_id o solicitud_id" });
    }

    await client.query("BEGIN");

    // 1) Verificar si ya la desbloqueó este artista
    const ya = await client.query(
      `SELECT id FROM desbloqueos 
       WHERE artista_id = $1 AND solicitud_id = $2`,
      [artista_id, solicitud_id]
    );
    if (ya.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ya la desbloqueaste" });
    }

    // 2) Ver créditos actuales (columna credits en usuarios)
    const qCred = await client.query(
      "SELECT credits FROM usuarios WHERE id = $1 FOR UPDATE",
      [artista_id]
    );
    if (qCred.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Artista no encontrado" });
    }

    const creditsActuales = qCred.rows[0].credits;
    if (creditsActuales <= 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "No tienes créditos suficientes" });
    }

    // 3) Insertar desbloqueo
    await client.query(
      `INSERT INTO desbloqueos (solicitud_id, artista_id, fecha)
       VALUES ($1, $2, NOW())`,
      [solicitud_id, artista_id]
    );

    // 4) Descontar 1 crédito
    const qUpdate = await client.query(
      `UPDATE usuarios
       SET credits = credits - 1
       WHERE id = $1
       RETURNING credits`,
      [artista_id]
    );

    // 5) Obtener datos de contacto del cliente de esa solicitud
    const contactoRes = await client.query(
      `
      SELECT u.nombre, u.email
      FROM solicitudes s
      JOIN usuarios u ON u.id = s.cliente_id
      WHERE s.id = $1
      `,
      [solicitud_id]
    );

    let contacto = null;
    if (contactoRes.rows.length > 0) {
      const row = contactoRes.rows[0];
      contacto = {
        nombre: row.nombre,
        email: row.email,
        // si más adelante agregas telefono en usuarios, acá se puede sumar
        telefono: null,
      };
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      nuevosCreditos: qUpdate.rows[0].credits,
      contacto, // 👈 esto lo usará el frontend para mostrar los datos
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en /solicitudes/desbloquear:", error);
    res.status(500).json({ error: "Error al desbloquear solicitud" });
  } finally {
    client.release();
  }
});









// =====================================================
// 🚀 Levantar servidor
// =====================================================
app.listen(port, () => {
  console.log(`🔥 Backend escuchando en http://localhost:${port}`);
});


