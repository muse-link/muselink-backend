import express from "express";
import cors from "cors";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 POSTGRES CONNECTION
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GENERAR TOKEN
function generarToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, rol_id: user.rol_id },
    process.env.JWT_SECRET || "secretkey",
    { expiresIn: "7d" }
  );
}

// ===========================
//      AUTH / REGISTER
// ===========================
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body;

    // Mapeo FRONT role → BD rol_id
    const roleMap = {
      cliente: 3,
      artista: 2
    };
    const rol_id = roleMap[role];

    if (!rol_id) {
      return res.status(400).json({ error: "Rol inválido" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO usuarios (nombre, email, password, rol_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id, nombre, email, rol_id
    `;

    const result = await pool.query(query, [nombre, email, hashed, rol_id]);
    const user = result.rows[0];

    return res.json({
      message: "Usuario creado correctamente",
      user,
      token: generarToken(user)
    });
  } catch (err) {
    console.error("❌ Error en /auth/register:", err);
    return res.status(500).json({ error: err.detail || "Error interno" });
  }
});

// ===========================
//      AUTH / LOGIN
// ===========================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const query = `SELECT * FROM usuarios WHERE email = $1`;
    const result = await pool.query(query, [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password);

    if (!ok)
      return res.status(401).json({ error: "Contraseña incorrecta" });

    return res.json({
      message: "Login correcto",
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol_id: user.rol_id
      },
      token: generarToken(user)
    });
  } catch (err) {
    console.error("❌ Error en /auth/login:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ===========================
//     CREAR SOLICITUD
// ===========================
app.post("/solicitudes", async (req, res) => {
  try {
    const { cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas } = req.body;

    const query = `
      INSERT INTO solicitudes (cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const result = await pool.query(query, [
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas
    ]);

    return res.json({
      message: "Solicitud creada",
      solicitud: result.rows[0]
    });
  } catch (err) {
    console.error("❌ Error creando solicitud:", err);
    return res.status(500).json({ error: "Error creando solicitud" });
  }
});

// ===========================
// LISTAR TODAS (ARTISTA)
// ===========================
app.get("/solicitudes", async (req, res) => {
  try {
    const query = `SELECT * FROM solicitudes ORDER BY id DESC`;
    const result = await pool.query(query);

    return res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ===========================
// LISTAR SOLICITUDES DEL CLIENTE
// ===========================
app.get("/solicitudes/cliente/:id", async (req, res) => {
  try {
    const cliente_id = req.params.id;

    const query = `
      SELECT * FROM solicitudes
      WHERE cliente_id = $1
      ORDER BY id DESC
    `;

    const result = await pool.query(query, [cliente_id]);
    return res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes por cliente:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ===========================
// DESBLOQUEAR SOLICITUD
// ===========================
app.post("/solicitudes/:id/unlock", async (req, res) => {
  try {
    const solicitud_id = req.params.id;
    const { artista_id } = req.body;

    // Registrar que el artista desbloqueó la solicitud
    await pool.query(
      `INSERT INTO solicitudes_desbloqueadas (solicitud_id, artista_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [solicitud_id, artista_id]
    );

    return res.json({ success: true, message: "Solicitud desbloqueada" });
  } catch (err) {
    console.error("❌ Error desbloqueando solicitud:", err);
    res.status(500).json({ error: "Error al desbloquear" });
  }
});

// ===========================
// SERVIDOR
// ===========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 MuseLink backend corriendo en http://localhost:${PORT}`)
);
