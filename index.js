// ===============================
//     MuseLink Backend (CJS)
// ===============================

// Env
require("dotenv").config();

// Dependencias
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const {
  GoogleGenerativeAI,
} = require("@google/generative-ai");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const port = process.env.PORT || 10000;

// JWT
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta_muselink";

// Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "MuseLink backend funcionando" });
});

// ===============================
//       HELPERS DB
// ===============================
async function getRoleIdByName(roleName) {
  const result = await pool.query(
    "SELECT id FROM roles WHERE LOWER(nombre)=LOWER($1)",
    [roleName]
  );
  return result.rows.length ? result.rows[0].id : null;
}

// ===============================
//       AUTH: REGISTER
// ===============================
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "Email y password requeridos" });

    // Ver si existe
    const exists = await pool.query(
      "SELECT id FROM usuarios WHERE email=$1",
      [email]
    );
    if (exists.rows.length)
      return res.status(409).json({ error: "Correo ya registrado" });

    // Hash
    const hash = await bcrypt.hash(password, 10);

    // Rol
    const desired = role || "cliente";
    let roleId = await getRoleIdByName(desired);
    if (!roleId) roleId = 3; // Cliente por defecto

    // Insertar
    const inserted = await pool.query(
      `INSERT INTO usuarios(nombre,email,password,rol_id,fecha_registro)
       VALUES ($1,$2,$3,$4,NOW())
       RETURNING id,nombre,email,rol_id`,
      [nombre, email, hash, roleId]
    );

    const user = inserted.rows[0];

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

// ===============================
//        AUTH: LOGIN
// ===============================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM usuarios WHERE email=$1",
      [email]
    );

    if (!result.rows.length)
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
    console.error("❌ Error /auth/login:", err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// ===============================
//      CREAR SOLICITUD
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
        (cliente_id,titulo,descripcion,tipo_musica,fecha_evento,cantidad_ofertas,estado,fecha_creacion)
       VALUES ($1,$2,$3,$4,NULL,$5,'abierta',NOW())
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creando solicitud:", err);
    res.status(500).json({ error: "Error creando solicitud" });
  }
});

// ===============================
//   GET SOLICITUDES (CON DESBLOQUEOS)
// ===============================
app.get("/solicitudes", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.*,
        COALESCE(d.cant_desbloqueos,0) AS desbloqueos
      FROM solicitudes s
      LEFT JOIN (
        SELECT solicitud_id, COUNT(*) AS cant_desbloqueos
        FROM desbloqueos_solicitudes
        GROUP BY solicitud_id
      ) d ON d.solicitud_id = s.id
      ORDER BY s.fecha_creacion DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes:", err);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// ===============================
//   DESBLOQUEAR SOLICITUD
// ===============================
app.post("/solicitudes/desbloquear", async (req, res) => {
  try {
    const { solicitud_id, artista_id } = req.body;

    await pool.query(
      `INSERT INTO desbloqueos_solicitudes (solicitud_id,artista_id,fecha)
       VALUES ($1,$2,NOW())`,
      [solicitud_id, artista_id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error al desbloquear:", err);
    res.status(500).json({ error: "Error al desbloquear solicitud" });
  }
});

// ===============================
//   GEMINI AI
// ===============================
app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const result = await model.generateContent(prompt);
    const text = await result.response.text();

    res.json({ text });
  } catch (err) {
    console.error("❌ Error Gemini:", err);
    res.status(500).json({ error: "Error generando IA" });
  }
});

// ===============================
//   MERCADO PAGO
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
            title: title || "Créditos MuseLink",
            quantity: Number(quantity) || 1,
            unit_price: Number(price),
            currency_id: "CLP",
          },
        ],
      },
    });

    res.json({ id: result.id });
  } catch (err) {
    console.error("❌ Error MercadoPago:", err);
    res.status(500).json({ error: "Error creando preferencia" });
  }
});

// ===============================
//   START SERVER
// ===============================
app.listen(port, () => {
  console.log(`🔥 MuseLink backend funcionando en http://localhost:${port}`);
});
